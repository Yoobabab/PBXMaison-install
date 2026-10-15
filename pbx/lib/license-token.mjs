#!/usr/bin/env node
/**
 * Changement de licence sans réinstaller : le portail génère une « clé de licence » signée
 * (édition, appels simultanés, expiration) que l'on colle dans la console du PBX (page Licence).
 *
 *   Format : CLK1.<base64url du JSON signé>
 *   JSON    : { pbx_id, key, edition, simultaneous_calls, expires_at, issued_at, signature }
 *   Signature Ed25519 sur le JSON canonique sans « signature » (même clé et même algorithme que pbx-config.json).
 *
 *   node license-token.mjs <fichier-clé> <clé-publique.pem> <pbx.env>
 *     → vérifie la clé, puis réécrit PBX_LICENSE_KEY, PBX_EDITION, PBX_MAX_CALLS, PBX_LICENSE_EXPIRES dans pbx.env.
 *   Sortie : une ligne JSON { ok, edition, max_calls, expires_at } ou { ok:false, error }.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { verifySignature, isValidLicenseKey } from "./verify-config.mjs";

export const EDITIONS = ["basic", "start", "pro", "enterprise"];

export function encodeToken(signed) {
  return `CLK1.${Buffer.from(JSON.stringify(signed)).toString("base64url")}`;
}

/** Vérifie une clé de licence ; renvoie la licence ou lève une erreur lisible. */
export function parseToken(token, publicKeyPem, pbxId, now = new Date()) {
  const t = String(token || "").replace(/\s+/g, "");
  const m = /^CLK1\.([A-Za-z0-9_-]+)$/.exec(t);
  if (!m) throw new Error("Clé de licence illisible : copie-la en entier depuis le portail (elle commence par CLK1.).");
  let obj;
  try { obj = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { throw new Error("Clé de licence illisible (incomplète ?)."); }
  if (!verifySignature(obj, publicKeyPem)) throw new Error("Signature invalide : cette clé n'a pas été générée par le portail Callikoe.");
  if (obj.pbx_id !== pbxId) throw new Error("Cette clé a été générée pour un autre PBX.");
  if (!isValidLicenseKey(obj.key)) throw new Error("Numéro de licence invalide.");
  if (!EDITIONS.includes(obj.edition)) throw new Error("Édition inconnue.");
  if (!Number.isInteger(obj.simultaneous_calls) || obj.simultaneous_calls < 1 || obj.simultaneous_calls > 1000) throw new Error("Nombre d'appels simultanés invalide.");
  if (!(new Date(obj.expires_at) > now)) throw new Error(`Licence expirée le ${obj.expires_at}.`);
  return { key: obj.key, edition: obj.edition, simultaneous_calls: obj.simultaneous_calls, expires_at: obj.expires_at, issued_at: obj.issued_at || "" };
}

const shq = (v) => `'${String(v ?? "").replace(/'/g, `'\\''`)}'`;
/** Remplace les variables de licence dans le contenu d'un pbx.env (les autres lignes sont gardées). */
export function updateEnv(content, lic) {
  const vars = { PBX_LICENSE_KEY: lic.key, PBX_EDITION: lic.edition, PBX_MAX_CALLS: lic.simultaneous_calls, PBX_LICENSE_EXPIRES: lic.expires_at };
  const seen = new Set();
  const lines = content.split("\n").map((l) => {
    const k = /^([A-Z_]+)=/.exec(l)?.[1];
    if (k && k in vars) { seen.add(k); return `${k}=${shq(vars[k])}`; }
    return l;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [k, v] of Object.entries(vars)) if (!seen.has(k)) lines.push(`${k}=${shq(v)}`);
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tokenFile, keyFile, envFile] = process.argv.slice(2);
  const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
  try {
    const env = fs.readFileSync(envFile, "utf8");
    const pbxId = /^PBX_ID='?([^'\n]*)'?$/m.exec(env)?.[1] || "";
    const lic = parseToken(fs.readFileSync(tokenFile, "utf8"), fs.readFileSync(keyFile, "utf8"), pbxId);
    fs.writeFileSync(`${envFile}.new`, updateEnv(env, lic), { mode: 0o644 });
    fs.renameSync(`${envFile}.new`, envFile);
    out({ ok: true, edition: lic.edition, max_calls: lic.simultaneous_calls, expires_at: lic.expires_at, key: lic.key });
  } catch (e) { out({ ok: false, error: e.message }); }
}
