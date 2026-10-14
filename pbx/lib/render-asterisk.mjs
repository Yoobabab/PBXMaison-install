#!/usr/bin/env node
/**
 * Écrit la configuration d'Asterisk à partir des modèles pbx/asterisk/*.conf.
 *   node render-asterisk.mjs <dossier-modèles> <dossier-destination>
 * Les valeurs viennent de l'environnement (PUBLIC_IP, DB_PASSWORD, AMI_SECRET, ARI_PASSWORD,
 * PBX_LANGUAGE, PBX_MAX_CALLS, PBX_COUNTRY_CODE). Échoue si une variable @@…@@ reste.
 */
import fs from "node:fs";
import path from "node:path";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error("Usage : render-asterisk.mjs <modèles> <destination>"); process.exit(2); }

const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`Variable manquante : ${k}`); process.exit(2); } return env[k]; };
const localNets = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]
  .map((n) => `local_net = ${n}`).join("\n");

const values = {
  PUBLIC_IP: need("PUBLIC_IP"),
  LOCAL_NETS: localNets,
  DB_PASSWORD: need("DB_PASSWORD"),
  AMI_SECRET: need("AMI_SECRET"),
  ARI_PASSWORD: need("ARI_PASSWORD"),
  LANGUAGE: env.PBX_LANGUAGE || "fr",
  MAX_CALLS: need("PBX_MAX_CALLS"),
  COUNTRY_CODE: need("PBX_COUNTRY_CODE"),
};

for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".conf")).sort()) {
  let text = fs.readFileSync(path.join(src, f), "utf8");
  for (const [k, v] of Object.entries(values)) text = text.split(`@@${k}@@`).join(v);
  const left = text.match(/@@[A-Z_]+@@/);
  if (left) { console.error(`Variable non remplacée dans ${f} : ${left[0]}`); process.exit(1); }
  fs.writeFileSync(path.join(dst, f), text);
}
