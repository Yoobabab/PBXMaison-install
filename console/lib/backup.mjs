/**
 * Sauvegardes : réglages (fréquence, conservation, contenu, copie FTP/FTPS/SFTP) et envoi du fichier.
 * L'archive est créée par « pbx-configure backup » (droits root : base de données, configuration).
 * Fonctions pures + envoi via curl, testées dans console/test/backup.test.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { UserError } from "./users.mjs";

export const BACKUP_DIR = () => process.env.PBXM_BACKUP_DIR || "/var/lib/pbxmaison/backups";
export const SCHEDULES = { off: "Jamais (manuelle seulement)", daily: "Tous les jours", weekly: "Toutes les semaines (lundi)" };
export const PROTOCOLS = { ftp: "FTP", ftps: "FTPS (FTP chiffré)", sftp: "SFTP (SSH)" };

export function defaultBackup() {
  return {
    schedule: "daily", hour: 3, keep: 7, recordings: false, voicemail: true,
    remote: { enabled: false, protocol: "sftp", host: "", port: 22, user: "", password: "", path: "/" },
  };
}

export function validateBackup(input, current = defaultBackup()) {
  const b = { ...defaultBackup(), ...current, remote: { ...defaultBackup().remote, ...(current.remote || {}) } };
  if (input.schedule !== undefined) b.schedule = SCHEDULES[input.schedule] ? input.schedule : "daily";
  if (input.hour !== undefined) {
    const h = Number(input.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new UserError("Heure : entre 0 et 23.", "hour");
    b.hour = h;
  }
  if (input.keep !== undefined) {
    const k = Number(input.keep);
    if (!Number.isInteger(k) || k < 1 || k > 60) throw new UserError("Sauvegardes conservées : entre 1 et 60.", "keep");
    b.keep = k;
  }
  for (const k of ["recordings", "voicemail"]) if (input[k] !== undefined) b[k] = !!input[k];
  const r = input.remote;
  if (r) {
    if (r.enabled !== undefined) b.remote.enabled = !!r.enabled;
    if (r.protocol !== undefined) b.remote.protocol = PROTOCOLS[r.protocol] ? r.protocol : "sftp";
    if (r.host !== undefined) {
      const h = String(r.host).trim();
      if (h && !/^[A-Za-z0-9.-]+$/.test(h)) throw new UserError("Serveur invalide (nom ou adresse IP, sans ftp://).", "remote.host");
      b.remote.host = h;
    }
    if (r.port !== undefined && r.port !== "") {
      const p = Number(r.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new UserError("Port invalide.", "remote.port");
      b.remote.port = p;
    }
    if (r.user !== undefined) b.remote.user = String(r.user).trim().slice(0, 120);
    if (r.password) b.remote.password = String(r.password).slice(0, 200);
    if (r.path !== undefined) {
      let p = String(r.path || "/").trim();
      if (!p.startsWith("/")) p = `/${p}`;
      if (!p.endsWith("/")) p += "/";
      if (p.includes("..") || /[\s"'`$\\]/.test(p)) throw new UserError("Dossier distant invalide.", "remote.path");
      b.remote.path = p;
    }
    if (b.remote.enabled && (!b.remote.host || !b.remote.user)) throw new UserError("Renseigne le serveur et l'identifiant de la copie distante.", "remote.host");
  }
  return b;
}
export const publicBackup = (b) => ({ ...b, remote: { ...b.remote, password: "", has_password: !!b.remote.password } });

/** URL de destination (sans identifiants : ils passent par un fichier netrc). */
export function remoteUrl(r, file = "") {
  return `${r.protocol}://${r.host}:${r.port}${r.path}${file}`;
}

/** L'archive doit-elle être faite maintenant ? (appelé chaque minute) */
export function backupDue(b, last, now = new Date()) {
  if (b.schedule === "off" || now.getHours() !== b.hour) return false;
  if (b.schedule === "weekly" && now.getDay() !== 1) return false;
  return !last || now.getTime() - new Date(last).getTime() > 20 * 3600_000;
}

const NAME = /^callikoe-\d{8}-\d{6}\.tar\.gz$/;
export function listBackups(dir = BACKUP_DIR()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => NAME.test(f)); } catch { return []; }
  return files.map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: f, size: st.size, at: st.mtime.toISOString() }; })
    .sort((a, b) => (a.file < b.file ? 1 : -1));
}
export const backupPath = (f, dir = BACKUP_DIR()) => (NAME.test(String(f)) ? path.join(dir, f) : null);

/** Envoie (ou teste avec file = null) vers le serveur distant avec curl. */
export function uploadBackup(r, file, { timeout = 600_000 } = {}) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbk-"));
    const netrc = path.join(tmp, "netrc");
    fs.writeFileSync(netrc, `machine ${r.host} login ${r.user} password ${r.password}\n`, { mode: 0o600 });
    const args = ["-sS", "--netrc-file", netrc, "--ftp-create-dirs", "--connect-timeout", "15"];
    if (r.protocol === "ftps") args.push("--ssl-reqd");
    if (r.protocol === "sftp") args.push("--insecure"); // clé d'hôte SSH non connue à l'avance
    if (file) args.push("-T", file, remoteUrl(r, path.basename(file)));
    else args.push("--list-only", remoteUrl(r));
    execFile("curl", args, { timeout }, (err, stdout, stderr) => {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (err) resolve({ ok: false, error: (stderr || err.message).trim().replace(/^curl: \(\d+\)\s*/, "").slice(0, 300) });
      else resolve({ ok: true, listing: file ? undefined : stdout.split("\n").filter(Boolean).slice(0, 50) });
    });
  });
}
