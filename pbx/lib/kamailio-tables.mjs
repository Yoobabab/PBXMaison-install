#!/usr/bin/env node
/**
 * Tables d'aiguillage de Kamailio (serveur multi-tenant), écrites à partir du registre des clients
 * et des routes publiées par chaque PBX client.
 *
 *   node kamailio-tables.mjs <registre tenants.json> <dossier db_text> [<dossier VAR des clients>]
 *
 *   dom : domaine du PBX (adresse des postes)        → sip:127.0.0.1:<6000+N>
 *   tru : compte de trunk (Contact) ou SDA appelée     → sip:127.0.0.1:<6000+N>
 *   prx : serveur de l'opérateur                       → prochain saut (proxy de l'opérateur, transport)
 *
 * Une même clé revendiquée par deux clients : le premier (numéro le plus petit) la garde, le conflit est signalé.
 * Sortie : une ligne JSON { ok, counts, conflicts }.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dns from "node:dns/promises";

export const sipPortOf = (n) => 6000 + Number(n);
export const backend = (t) => `sip:127.0.0.1:${sipPortOf(t.n)}`;

const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const USER = /^[A-Za-z0-9+._~-]{1,64}$/;

/** Formes possibles d'une SDA dans la requête de l'opérateur : 0465001540, 33465001540, +33465001540 */
export function didForms(did, cc = "33") {
  const d = String(did || "").replace(/[^\d+]/g, "");
  if (!d) return [];
  let national = d;
  if (d.startsWith("+")) national = d.startsWith(`+${cc}`) ? `0${d.slice(1 + cc.length)}` : d;
  else if (d.startsWith(cc) && d.length > 10) national = `0${d.slice(cc.length)}`;
  if (!/^0\d{6,14}$/.test(national)) return [d];
  const e164 = `${cc}${national.slice(1)}`;
  return [national, e164, `+${e164}`];
}

/**
 * tenants : [{ slug, n, fqdn, cc }] ; routes : { slug: { trunks: [{contact_user, host, port, transport, proxy}], dids: [] } }
 * → { dom: Map, tru: Map, prx: Map, conflicts: [] }
 */
export function buildTables(tenants, routes = {}, ips = {}) {
  const dom = new Map(), tru = new Map(), prx = new Map(), ops = new Map(), acl = new Map(), conflicts = [];
  const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  const claim = (map, key, value, slug, what) => {
    const k = String(key).toLowerCase();
    if (map.has(k) && map.get(k).slug !== slug) { conflicts.push({ key: k, what, kept: map.get(k).slug, refused: slug }); return; }
    map.set(k, { value, slug });
  };
  for (const t of [...tenants].sort((a, b) => a.n - b.n)) {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(t.slug) || !Number.isInteger(t.n) || t.n < 1 || t.n > 250 || t.suspended) continue;
    const be = backend(t);
    if (t.fqdn && HOST.test(t.fqdn)) claim(dom, t.fqdn, be, t.slug, "adresse");
    for (const a of t.aliases || []) if (HOST.test(a)) claim(dom, a, be, t.slug, "adresse");
    const r = routes[t.slug] || {};
    // Réseaux autorisés pour les postes de ce PBX (console du PBX › Sécurité) : les autres adresses sont refusées par l'aiguilleur
    const allow = (r.sip_allow || []).map((x) => (String(x).includes("/") ? String(x) : `${x}/32`)).filter((x) => CIDR.test(x));
    if (allow.length) for (const d of [t.fqdn, ...(t.aliases || [])].filter((x) => x && HOST.test(x))) if (dom.get(String(d).toLowerCase())?.slug === t.slug) acl.set(String(d).toLowerCase(), { value: allow.join(","), slug: t.slug });
    for (const tr of r.trunks || []) {
      if (tr.contact_user && USER.test(tr.contact_user)) {
        claim(tru, tr.contact_user, be, t.slug, "compte de trunk");
        // Adresses de l'opérateur (serveur et proxy du trunk) : seules autorisées à appeler les SDA de ce client sans le jeton
        for (const h of [tr.host, String(tr.proxy || "").split(":")[0]].filter(Boolean)) {
          for (const ip of ips[h] || []) { const k = `${ip}|${be}`; if (!ops.has(k)) ops.set(k, { value: tr.contact_user, slug: t.slug }); }
        }
      }
      if (tr.host && HOST.test(tr.host)) {
        const transport = ["udp", "tcp", "tls"].includes(tr.transport) ? tr.transport : "udp";
        const [ph, pp] = tr.proxy ? String(tr.proxy).split(":") : [tr.host, tr.port];
        if (HOST.test(ph || "") && (transport !== "udp" || tr.proxy)) {
          claim(prx, tr.host, `sip:${ph}:${Number(pp) || 5060}${transport === "udp" ? "" : `;transport=${transport}`}`, t.slug, "serveur opérateur");
        }
      }
    }
    for (const did of r.dids || []) for (const f of didForms(did, t.cc || "33")) claim(tru, f, be, t.slug, "SDA");
  }
  return { dom, tru, prx, ops, acl, conflicts };
}

/** Fichier db_text pour htable (les « : » des valeurs sont échappés). */
export function dbtext(map) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return ["key_name(str) key_type(int) value_type(int) key_value(str) expires(int)",
    ...[...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${esc(k)}:0:0:${esc(v.value)}:0`)].join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [regFile, dbDir, varRoot = "/var/lib/callikoe/t"] = process.argv.slice(2);
  let tenants = [];
  try { tenants = JSON.parse(fs.readFileSync(regFile, "utf8")).tenants || []; } catch { tenants = []; }
  const routes = {};
  for (const t of tenants) {
    try { routes[t.slug] = JSON.parse(fs.readFileSync(path.join(varRoot, t.slug, "kamailio-routes.json"), "utf8")); } catch { /* rien publié */ }
  }
  // Résolution des serveurs des opérateurs (adresses IP d'où viennent leurs appels)
  const ips = {};
  const hosts = new Set(Object.values(routes).flatMap((r) => (r.trunks || []).flatMap((x) => [x.host, String(x.proxy || "").split(":")[0]])).filter(Boolean));
  await Promise.all([...hosts].map(async (h) => {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) { ips[h] = [h]; return; }
    try { ips[h] = (await dns.lookup(h, { all: true, family: 4 })).map((a) => a.address); } catch { ips[h] = []; }
  }));
  const { dom, tru, prx, ops, acl, conflicts } = buildTables(tenants, routes, ips);
  fs.mkdirSync(dbDir, { recursive: true });
  for (const [name, map] of [["dom", dom], ["tru", tru], ["prx", prx], ["ops", ops], ["acl", acl]]) {
    fs.writeFileSync(path.join(dbDir, `${name}.new`), dbtext(map));
    fs.renameSync(path.join(dbDir, `${name}.new`), path.join(dbDir, name));
  }
  fs.writeFileSync(path.join(dbDir, "version"), "table_name(str) table_version(int)\ndom:2\ntru:2\nprx:2\nops:2\nacl:2\n");
  console.log(JSON.stringify({ ok: true, counts: { dom: dom.size, tru: tru.size, prx: prx.size, ops: ops.size, acl: acl.size }, conflicts }));
}
