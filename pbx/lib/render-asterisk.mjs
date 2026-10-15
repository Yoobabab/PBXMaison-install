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
// Serveur multi-tenant (CX_MODE=tenant) : le PBX du client écoute en local, derrière l'aiguilleur SIP (Kamailio, 5060 public).
// Ses messages vers l'aiguilleur (127.0.0.2) sont « externes » : le Contact annoncé devient <IP publique>:5060.
const tenant = env.CX_MODE === "tenant";
const localNets = (tenant ? ["127.0.0.1/32"] : ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"])
  .map((n) => `local_net = ${n}`).join("\n") + (tenant ? "\nexternal_signaling_port = 5060" : "");
const d = (k, def) => env[k] || def;

const values = {
  AST_ETC: d("AST_ETC", "/etc/asterisk"),
  AST_USER: d("AST_USER", "asterisk"),
  AST_GROUP: d("AST_GROUP", "asterisk"),
  AST_VARLIB: d("AST_VARLIB", "/var/lib/asterisk"),
  AST_SPOOL: d("AST_SPOOL", "/var/spool/asterisk"),
  AST_RUN: d("AST_RUN", "/var/run/asterisk"),
  AST_LOG: d("AST_LOG", "/var/log/asterisk"),
  CX_VAR: d("CX_VAR", "/var/lib/pbxmaison"),
  SIP_BIND: tenant ? `127.0.0.1:${need("SIP_INT_PORT")}` : "0.0.0.0:5060",
  AMI_PORT: d("AMI_PORT", "5038"),
  HTTP_PORT: d("HTTP_PORT", "8088"),
  RTP_START: d("RTP_START", "10000"),
  RTP_END: d("RTP_END", "20000"),
  ODBC_DSN: d("ODBC_DSN", "asterisk"),
  DB_USER: d("DB_USER", "asterisk"),
  PUBLIC_IP: need("PUBLIC_IP"),
  LOCAL_NETS: localNets,
  DB_PASSWORD: need("DB_PASSWORD"),
  AMI_SECRET: need("AMI_SECRET"),
  ARI_PASSWORD: need("ARI_PASSWORD"),
  LANGUAGE: env.PBX_LANGUAGE || "fr",
  MAX_CALLS: need("PBX_MAX_CALLS"),
  COUNTRY_CODE: need("PBX_COUNTRY_CODE"),
  // Machine derrière une box : le navigateur doit recevoir l'IP publique comme candidat ICE
  ICE_MAP: env.LOCAL_IP && env.LOCAL_IP !== env.PUBLIC_IP ? `\n[ice_host_candidates]\n${env.LOCAL_IP} => ${env.PUBLIC_IP}\ninclude_local_address = yes` : "",
};

for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".conf")).sort()) {
  let text = fs.readFileSync(path.join(src, f), "utf8");
  for (const [k, v] of Object.entries(values)) text = text.split(`@@${k}@@`).join(v);
  const left = text.match(/@@[A-Z_]+@@/);
  if (left) { console.error(`Variable non remplacée dans ${f} : ${left[0]}`); process.exit(1); }
  fs.writeFileSync(path.join(dst, f), text);
}
