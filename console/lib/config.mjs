/** Chemins et paramètres de la console (surchargeables par variables d'environnement pour les tests). */
import fs from "node:fs";
import path from "node:path";

export const APP_DIR = path.resolve(import.meta.dirname, "..", "..");
export const ETC = process.env.PBXM_ETC || "/etc/pbxmaison";
export const VAR = process.env.PBXM_VAR || "/var/lib/pbxmaison";
/** Serveur multi-tenant : ce PBX est un client derrière l'aiguilleur SIP (Kamailio, 127.0.0.2:5060). */
export const CX_MODE = process.env.CX_MODE === "tenant" ? "tenant" : "single";
export const CX_TENANT = process.env.CX_TENANT || "";
// « ; » s'écrit ^3B dans les tables realtime d'Asterisk (sinon la valeur est coupée)
export const KAMAILIO_URI = "sip:127.0.0.2:5060^3Blr";
export const TEMPLATES_FILE = path.join(APP_DIR, "pbx/trunk-templates.json");
export const CONFIGURE_CMD = (process.env.PBXM_CONFIGURE_CMD || `sudo -n ${path.join(APP_DIR, "pbx/bin/pbx-configure")}`).split(" ");
export const TRUSTED_KEY = fs.existsSync(path.join(ETC, "trusted-key.pem"))
  ? path.join(ETC, "trusted-key.pem")
  : path.join(APP_DIR, "pbx/portal-public-key.pem");

export const settings = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "127.0.0.1",
  sessionSecret: process.env.SESSION_SECRET || "",
  db: {
    host: process.env.PBXM_DB_HOST || "127.0.0.1",
    port: Number(process.env.PBXM_DB_PORT || 5432),
    user: process.env.PBXM_DB_USER || "asterisk",
    database: process.env.PBXM_DB_NAME || "asterisk",
    password: process.env.DB_PASSWORD || "",
  },
  ami: {
    host: process.env.PBXM_AMI_HOST || "127.0.0.1",
    port: Number(process.env.PBXM_AMI_PORT || 5038),
    user: "pbxmaison",
    secret: process.env.AMI_SECRET || "",
  },
};

/** Lit un fichier KEY='valeur' (format écrit par l'installeur). Renvoie {} s'il n'existe pas. */
export function readEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return {}; }
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2];
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
    else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export const pbxEnv = () => readEnvFile(path.join(ETC, "pbx.env"));
export const installState = () => readEnvFile(path.join(ETC, "install.state"));
export const setupState = () => readEnvFile(path.join(ETC, "setup.state"));
export const isConfigured = () => !!pbxEnv().PBX_ID;
export function activationCode() {
  try { return fs.readFileSync(path.join(ETC, "activation.txt"), "utf8").trim(); } catch { return null; }
}
