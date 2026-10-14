/**
 * Assistant d'installation : vérification du pbx-config.json, application (via pbx-configure en root),
 * création du compte administrateur.
 */
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { checkConfig } from "../../pbx/lib/verify-config.mjs";
import { ETC, VAR, TRUSTED_KEY, CONFIGURE_CMD, installState } from "./config.mjs";
import { safeEqual } from "./auth.mjs";

const TOKEN_FILE = path.join(VAR, "setup-token");

export function setupToken() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch { return null; }
}
export const tokenValid = (t) => { const real = setupToken(); return !!real && safeEqual(t, real); };
export function consumeToken() { try { fs.unlinkSync(TOKEN_FILE); } catch {} }

/** Vérifie un pbx-config.json (objet) sans rien modifier. */
export async function checkSetupConfig(cfg) {
  let key;
  try { key = fs.readFileSync(TRUSTED_KEY, "utf8"); } catch { key = ""; }
  if (!key.includes("BEGIN PUBLIC KEY")) {
    return { ok: false, problems: ["La clé publique du portail n'est pas installée sur ce PBX. Mets à jour l'installation."] };
  }
  const problems = checkConfig(cfg, key);
  if (problems.length) return { ok: false, problems };

  const st = installState();
  let dnsIp = null;
  try { dnsIp = (await dns.resolve4(cfg.pbx.fqdn))[0] || null; } catch { dnsIp = null; }
  const days = Math.floor((new Date(cfg.license.expires_at) - Date.now()) / 86400000);
  return {
    ok: true,
    pbx: {
      name: cfg.pbx.name, company: cfg.pbx.company, fqdn: cfg.pbx.fqdn, phone: cfg.pbx.phone,
      admin_email: cfg.admin.email, license: cfg.license.key, edition: cfg.license.edition,
      simultaneous_calls: cfg.license.simultaneous_calls, expires_at: cfg.license.expires_at, days_left: days,
    },
    network: {
      public_ip: st.PUBLIC_IP || null, local_ip: st.LOCAL_IP || null, behind_nat: st.BEHIND_NAT === "1",
      dns_ip: dnsIp, dns_ok: !!dnsIp && dnsIp === st.PUBLIC_IP,
    },
  };
}

/** Application en cours (une seule à la fois). */
let job = null;

export function applyStatus() {
  return job ? { running: job.running, ok: job.ok, steps: job.steps } : { running: false, ok: null, steps: [] };
}

export function startApply(cfg) {
  if (job?.running) throw Object.assign(new Error("Une configuration est déjà en cours."), { status: 409 });
  const dir = path.join(VAR, "staging");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pbx-config-${crypto.randomBytes(6).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });

  job = { running: true, ok: null, steps: [] };
  const current = job;
  const [cmd, ...args] = CONFIGURE_CMD;
  const child = spawn(cmd, [...args, "apply", file], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", err = "";
  const upsert = (s) => {
    const i = current.steps.findIndex((x) => x.step === s.step);
    if (i >= 0) current.steps[i] = s; else current.steps.push(s);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { upsert(JSON.parse(line)); } catch { /* ligne non JSON ignorée */ }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => {
    current.running = false;
    current.ok = code === 0;
    if (code !== 0 && !current.steps.some((s) => s.status === "error")) {
      current.steps.push({ step: "erreur", status: "error", message: (err.trim() || `Échec (code ${code})`).slice(-500) });
    }
  });
  child.on("error", (e) => {
    current.running = false; current.ok = false;
    current.steps.push({ step: "erreur", status: "error", message: `Impossible de lancer la configuration : ${e.message}` });
  });
}

export const etcFile = (name) => path.join(ETC, name);
