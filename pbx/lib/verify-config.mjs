#!/usr/bin/env node
/**
 * Vérifie un pbx-config.json avant installation, sans aucune dépendance (Node 18+).
 *
 *   node verify-config.mjs <pbx-config.json> <public-key.pem> [--env <fichier.env>] [--now <ISO>]
 *
 * Contrôles : signature Ed25519, somme de contrôle de la licence, expiration, champs obligatoires.
 * Avec --env, écrit les valeurs utiles à l'installeur (format shell, valeurs entre apostrophes).
 * Code de sortie : 0 = OK, 1 = config refusée, 2 = erreur d'utilisation.
 *
 * Les algorithmes sont identiques à shared/license.ts et portal/portail.html.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function canonicalJson(value) {
  const sort = (v) =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
    : v;
  return JSON.stringify(sort(value));
}

export function isValidLicenseKey(key) {
  const m = /^PBXM-([A-Z2-9]{4})-([A-Z2-9]{4})-([A-Z2-9]{4})-([A-Z2-9]{4})$/.exec(String(key));
  if (!m) return false;
  const body = m[1] + m[2] + m[3];
  if ([...body + m[4]].some((c) => !ALPHABET.includes(c))) return false;
  const h = crypto.createHash("sha256").update(`PBXM:${body}`).digest();
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  let sum = "";
  for (let i = 3; i >= 0; i--) sum += ALPHABET[(bits >> (i * 5)) & 31];
  return sum === m[4];
}

export function verifySignature(obj, publicKeyPem) {
  const { signature, ...rest } = obj ?? {};
  if (typeof signature !== "string") return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(rest)), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Renvoie la liste des problèmes (vide = config valide). */
export function checkConfig(cfg, publicKeyPem, now = new Date()) {
  const problems = [];
  if (!verifySignature(cfg, publicKeyPem)) {
    problems.push("Signature invalide : le fichier a été modifié, ou il a été signé avec une autre clé que celle de l'installeur.");
    return problems; // le reste n'est pas fiable si la signature est fausse
  }
  if (cfg.version !== 1) problems.push(`Version de fichier non prise en charge : ${cfg.version}.`);
  if (cfg.kind === "server") { problems.push("Ce fichier configure un serveur multi-tenant, pas un PBX."); return problems; }
  const p = cfg.pbx ?? {}, l = cfg.license ?? {}, a = cfg.admin ?? {};
  for (const [k, v] of Object.entries({
    "pbx.id": p.id, "pbx.name": p.name, "pbx.fqdn": p.fqdn, "pbx.phone": p.phone,
    "pbx.country_code": p.country_code, "pbx.timezone": p.timezone, "admin.email": a.email,
    "license.key": l.key, "license.expires_at": l.expires_at,
  })) if (!v) problems.push(`Champ manquant : ${k}.`);
  if (l.key && !isValidLicenseKey(l.key)) problems.push("Numéro de licence invalide.");
  if (l.expires_at && !(new Date(l.expires_at) > now)) problems.push(`Licence expirée le ${l.expires_at}.`);
  if (!Number.isInteger(l.simultaneous_calls) || l.simultaneous_calls < 1) problems.push("Nombre d'appels simultanés invalide.");
  return problems;
}

const shq = (v) => `'${String(v ?? "").replace(/'/g, `'\\''`)}'`;

export function envFile(cfg) {
  const vars = {
    PBX_ID: cfg.pbx.id,
    PBX_NAME: cfg.pbx.name,
    PBX_COMPANY: cfg.pbx.company,
    PBX_FQDN: cfg.pbx.fqdn,
    PBX_PHONE: cfg.pbx.phone,
    PBX_COUNTRY: cfg.pbx.country,
    PBX_COUNTRY_CODE: cfg.pbx.country_code,
    PBX_TIMEZONE: cfg.pbx.timezone,
    PBX_LANGUAGE: cfg.pbx.language,
    PBX_ADMIN_EMAIL: cfg.admin.email,
    PBX_LICENSE_KEY: cfg.license.key,
    PBX_EDITION: cfg.license.edition,
    PBX_MAX_CALLS: cfg.license.simultaneous_calls,
    PBX_LICENSE_EXPIRES: cfg.license.expires_at,
  };
  return "# Généré par verify-config.mjs — ne pas modifier à la main\n" +
    Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n";
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const envOut = opt("--env");
  const nowArg = opt("--now");
  const [cfgPath, keyPath] = args;
  if (!cfgPath || !keyPath) {
    console.error("Usage : node verify-config.mjs <pbx-config.json> <public-key.pem> [--env fichier.env]");
    process.exit(2);
  }
  let cfg, key;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch (e) { console.error(`❌ Impossible de lire ${cfgPath} : ${e.message}`); process.exit(1); }
  try { key = fs.readFileSync(keyPath, "utf8"); }
  catch (e) { console.error(`❌ Clé publique introuvable (${keyPath}).`); process.exit(2); }
  if (!key.includes("BEGIN PUBLIC KEY")) {
    console.error(`❌ ${keyPath} ne contient pas de clé publique. Colle la clé publique affichée dans le portail (page « Clés & sauvegarde »).`);
    process.exit(2);
  }

  const problems = checkConfig(cfg, key, nowArg ? new Date(nowArg) : new Date());
  if (problems.length) {
    console.error("❌ Fichier de configuration refusé :");
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
  }
  const days = Math.floor((new Date(cfg.license.expires_at) - Date.now()) / 86400000);
  console.log(`✅ Configuration valide : ${cfg.pbx.name} (${cfg.pbx.fqdn})`);
  console.log(`   Licence ${cfg.license.key} · ${cfg.license.edition} · ${cfg.license.simultaneous_calls} appels simultanés · expire dans ${days} jours`);
  if (envOut) fs.writeFileSync(envOut, envFile(cfg), { mode: 0o640 });
}
