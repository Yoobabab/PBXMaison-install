#!/usr/bin/env node
/**
 * Journal de la téléphonie du serveur multi-tenant (console du serveur › Téléphonie).
 * Lancé par « callikoe-host journal <minutes> » (root) : lit le journal de l'aiguilleur SIP (Kamailio),
 * les adresses bloquées par fail2ban et celles ignorées par l'anti-flood, et rend un JSON en français.
 *
 *   node sip-journal.mjs <registre tenants.json> <minutes>
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const [reg, minArg] = process.argv.slice(2);
const minutes = Math.min(43200, Math.max(1, Number(minArg) || 60));
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return String(e.stdout || ""); } };

// PBX du serveur : adresse (FQDN) → nom
const tenants = (() => { try { return JSON.parse(fs.readFileSync(reg, "utf8")).tenants || []; } catch { return []; } })();
const byDomain = new Map(tenants.filter((t) => t.fqdn).map((t) => [String(t.fqdn).toLowerCase(), t]));
const pbxOf = (domain) => { const t = byDomain.get(String(domain || "").toLowerCase()); return t ? { slug: t.slug, name: t.name || t.slug } : null; };
const uriParts = (uri) => { const m = /^(?:sips?:)?(?:([^@;>]+)@)?([^:;>]+)/.exec(String(uri || "").replace(/^<|>$/g, "")); return { user: m?.[1] || "", host: m?.[2] || "" }; };
const METHOD = { REGISTER: "Enregistrement", INVITE: "Appel", SUBSCRIBE: "Abonnement (voyants BLF)", OPTIONS: "Test de présence", MESSAGE: "Message", NOTIFY: "Notification", REFER: "Transfert" };
const meth = (m) => METHOD[m] || m;

// ------------------------------------------------------------------ Journal de l'aiguilleur
const raw = run("journalctl", ["-u", "kamailio", "--since", `-${minutes}min`, "-o", "short-iso", "--no-pager"]);
const events = [];
const errSeen = new Set();
for (const line of raw.split(/\r?\n/)) {
  if (!/CALLIKOE-|ERROR:/.test(line)) continue;
  const at = (() => { const d = Date.parse(line.slice(0, 24).replace(/([+-]\d\d)(\d\d)$/, "$1:$2")); return Number.isNaN(d) ? null : new Date(d).toISOString(); })();
  let m;
  if ((m = /CALLIKOE-UNKNOWN (\S+) REGISTER (\S+)/.exec(line))) {
    events.push({ at, kind: "refus", ip: m[1], text: `Enregistrement refusé : « ${m[2]} » n'est l'adresse d'aucun PBX de ce serveur (ancien réglage ou robot).` });
  } else if ((m = /CALLIKOE-UNKNOWN (\S+) (\S+) (\S+) \(SDA hors opérateur\)/.exec(line))) {
    events.push({ at, kind: "refus", ip: m[1], text: `${meth(m[2])} vers ${uriParts(m[3]).user || m[3]} refusé : le numéro existe mais l'appel ne vient pas de l'opérateur du trunk.` });
  } else if ((m = /CALLIKOE-UNKNOWN (\S+) (\S+) (\S+)/.exec(line))) {
    const u = uriParts(m[3]);
    events.push({ at, kind: "robot", ip: m[1], text: `${meth(m[2])} vers ${u.user || m[3]} refusé : aucun PBX ne correspond (souvent un robot qui tente des appels frauduleux).` });
  } else if ((m = /CALLIKOE-AUTHFAIL (\S+) (\S+) (\S+)/.exec(line))) {
    const u = uriParts(m[3]), p = pbxOf(u.host);
    events.push({ at, kind: "auth", ip: m[1], pbx: p?.slug || "", text: `${meth(m[2])} : mot de passe refusé pour ${u.user ? `le poste ${u.user}` : m[3]}${p ? ` (${p.name})` : u.host ? ` (${u.host})` : ""}.` });
  } else if ((m = /CALLIKOE-RELAYFAIL (\S+) (\S+) (\S+)/.exec(line))) {
    // Échec de transmission (le téléphone reçoit une erreur) : complète l'erreur interne notée juste avant avec l'adresse
    const k = /\{[^ ]* [^ ]* (\S+) ([^}]*)\}/.exec(line), key = k ? `${k[1]}|${k[2]}` : "";
    const prev = key && events.find((e) => e.key === key);
    const p = pbxOf(uriParts(m[3]).host);
    const text = `${meth(m[2])}${p ? ` vers ${p.name}` : ""} : l'aiguilleur n'a pas pu transmettre la demande${prev?.why ? ` (${prev.why})` : ""}. L'appareil reçoit une erreur.`;
    if (prev) Object.assign(prev, { ip: m[1], text, pbx: p?.slug || "" }); else events.push({ at, kind: "erreur", ip: m[1], pbx: p?.slug || "", text });
  } else if ((m = /CALLIKOE-ACL (\S+) (\S+) (\S+)/.exec(line))) {
    const p = pbxOf(m[3]);
    events.push({ at, kind: "refus", ip: m[1], pbx: p?.slug || "", text: `${meth(m[2])} refusé : l'adresse n'est pas dans les réseaux autorisés de ${p ? p.name : m[3]} (console du PBX › Sécurité).` });
  } else if ((m = /CALLIKOE-FLOOD (\S+)/.exec(line))) {
    events.push({ at, kind: "flood", ip: m[1], text: "Trop de messages d'un coup : adresse ignorée 1 minute par l'aiguilleur." });
  } else if ((m = /ERROR: \{[^ ]* [^ ]* (\S+) ([^}]*)\}\s*(.*)$/.exec(line))) {
    // Une erreur interne s'étale sur plusieurs lignes : une seule entrée par message SIP
    const key = `${m[1]}|${m[2]}`;
    if (errSeen.has(key)) continue;
    errSeen.add(key);
    const msg = m[3];
    const why = /no corresponding socket|no socket found/.test(msg) ? "adresse interne introuvable"
      : /dns|resolve/i.test(msg) ? "adresse introuvable (DNS)" : /timeout|timer/i.test(msg) ? "pas de réponse" : "";
    const text = why ? `${meth(m[1])} : l'aiguilleur n'a pas pu transmettre la demande (${why}).`
      : `${meth(m[1])} : erreur de l'aiguilleur — ${msg.replace(/^.*?\]:\s*/, "").slice(0, 160)}`;
    events.push({ at, kind: "erreur", ip: "", text, key, why });
  }
}
for (const e of events) { delete e.key; delete e.why; }
events.reverse();

// ------------------------------------------------------------------ Adresses bloquées / ignorées
const JAILS = { "callikoe-sip": "Mots de passe refusés à répétition", "callikoe-sip-unknown": "Appels ou enregistrements vers des PBX inconnus", "callikoe-manual": "Bloquée à la main (permanent)", sshd: "Connexions SSH refusées" };
const banned = [];
for (const [jail, label] of Object.entries(JAILS)) {
  const out = run("fail2ban-client", ["status", jail]);
  const list = (/Banned IP list:\s*(.*)/.exec(out)?.[1] || "").trim().split(/\s+/).filter(Boolean);
  for (const ip of list) banned.push({ ip, jail, label });
}
const ignored = run("kamcmd", ["-s", "unix:/run/kamailio/kamailio_ctl", "htable.dump", "ban"]).split("\n")
  .map((l) => /name:\s*(\S+)/.exec(l)?.[1]).filter(Boolean);

// ------------------------------------------------------------------ Résumé par adresse
const ips = new Map();
for (const e of events) {
  if (!e.ip) continue;
  const x = ips.get(e.ip) || { ip: e.ip, count: 0, kinds: {}, last: e.at };
  x.count++; x.kinds[e.kind] = (x.kinds[e.kind] || 0) + 1;
  ips.set(e.ip, x);
}
const bannedSet = new Set(banned.map((b) => b.ip)), ignoredSet = new Set(ignored);
const by_ip = [...ips.values()].sort((a, b) => b.count - a.count).slice(0, 30)
  .map((x) => ({ ...x, banned: bannedSet.has(x.ip), ignored: ignoredSet.has(x.ip) }));
const counts = events.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {});

process.stdout.write(JSON.stringify({ minutes, counts, events: events.slice(0, 3000), total: events.length, by_ip, banned, ignored }) + "\n");
