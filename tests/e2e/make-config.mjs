#!/usr/bin/env node
/**
 * Crée une clé de test et un pbx-config.json signé avec elle (tests automatiques uniquement).
 *   node make-config.mjs <dossier>   → <dossier>/test-key.pem, <dossier>/pbx-config.json
 * Même format que le portail (JSON canonique + Ed25519, licence avec somme de contrôle).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = process.argv[2] || ".";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const canonical = (v) => JSON.stringify((function sort(x) {
  return Array.isArray(x) ? x.map(sort) : x && typeof x === "object"
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
})(v));

function licenseKey() {
  const body = [...crypto.randomBytes(12)].map((b) => ALPHABET[b & 31]).join("");
  const h = crypto.createHash("sha256").update(`PBXM:${body}`).digest();
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  let sum = "";
  for (let i = 3; i >= 0; i--) sum += ALPHABET[(bits >> (i * 5)) & 31];
  return ["PBXM", ...body.match(/.{4}/g), sum].join("-");
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const cfg = {
  version: 1,
  pbx: {
    id: crypto.randomUUID(), name: "PBX de test", company: "Test automatique", fqdn: "e2e.pbxmaison.invalid",
    phone: "+33412345678", country: "FR", country_code: "33", timezone: "Europe/Paris", language: "fr",
  },
  admin: { email: "admin@test.invalid", password: "set_on_first_login" },
  license: { key: licenseKey(), edition: "pro", simultaneous_calls: 4, expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
  issued_at: new Date().toISOString(),
};
cfg.signature = crypto.sign(null, Buffer.from(canonical(cfg)), privateKey).toString("base64");
fs.writeFileSync(path.join(dir, "test-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
fs.writeFileSync(path.join(dir, "pbx-config.json"), JSON.stringify(cfg, null, 2));
// Clé de licence « changement d'édition » (comme le portail : Pro 4 appels → Entreprise 8 appels)
const lic = { pbx_id: cfg.pbx.id, key: cfg.license.key, edition: "enterprise", simultaneous_calls: 8, expires_at: new Date(Date.now() + 400 * 86400000).toISOString(), issued_at: new Date().toISOString() };
lic.signature = crypto.sign(null, Buffer.from(canonical(lic)), privateKey).toString("base64");
fs.writeFileSync(path.join(dir, "license-token.txt"), `CLK1.${Buffer.from(JSON.stringify(lic)).toString("base64url")}`);
console.log(`Config de test : ${cfg.pbx.fqdn} · ${cfg.license.key}`);
