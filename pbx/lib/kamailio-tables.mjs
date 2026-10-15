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
export function buildTables(tenants, routes = {}) {
  const dom = new Map(), tru = new Map(), prx = new Map(), conflicts = [];
  const claim = (map, key, value, slug, what) => {
    const k = String(key).toLowerCase();
    if (map.has(k) && map.get(k).slug !== slug) { conflicts.push({ key: k, what, kept: map.get(k).slug, refused: slug }); return; }
    map.set(k, { value, slug });
  };
  for (const t of [...tenants].sort((a, b) => a.n - b.n)) {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(t.slug) || !Number.isInteger(t.n) || t.n < 1 || t.n > 250) continue;
    const be = backend(t);
    if (t.fqdn && HOST.test(t.fqdn)) claim(dom, t.fqdn, be, t.slug, "adresse");
    for (const a of t.aliases || []) if (HOST.test(a)) claim(dom, a, be, t.slug, "adresse");
    const r = routes[t.slug] || {};
    for (const tr of r.trunks || []) {
      if (tr.contact_user && USER.test(tr.contact_user)) claim(tru, tr.contact_user, be, t.slug, "compte de trunk");
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
  return { dom, tru, prx, conflicts };
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
  const { dom, tru, prx, conflicts } = buildTables(tenants, routes);
  fs.mkdirSync(dbDir, { recursive: true });
  for (const [name, map] of [["dom", dom], ["tru", tru], ["prx", prx]]) {
    fs.writeFileSync(path.join(dbDir, `${name}.new`), dbtext(map));
    fs.renameSync(path.join(dbDir, `${name}.new`), path.join(dbDir, name));
  }
  if (!fs.existsSync(path.join(dbDir, "version"))) fs.writeFileSync(path.join(dbDir, "version"), "table_name(str) table_version(int)\ndom:2\ntru:2\nprx:2\n");
  console.log(JSON.stringify({ ok: true, counts: { dom: dom.size, tru: tru.size, prx: prx.size }, conflicts }));
}
