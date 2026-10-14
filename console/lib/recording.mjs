/**
 * Enregistrement des appels : réglages, variables du plan de numérotation, liste et purge des fichiers.
 * Les fichiers sont écrits par Asterisk (MixMonitor) sous <dir>/AAAA/MM/JJ/<heure>-<sens>-<id>.wav ;
 * le chemin relatif est gardé dans le journal des appels (CDR userfield).
 */
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./users.mjs";

export const REC_DIR = () => process.env.PBXM_REC_DIR || "/var/spool/asterisk/monitor/callikoe";

export function defaultRecording() {
  // Par défaut tous les appels externes sont enregistrés, avec annonce à l'appelant (obligation d'information).
  return { enabled: true, in: true, out: true, announce: "", retention_days: 90 };
}

export function validateRecording(input, current = defaultRecording(), prompts = new Set()) {
  const r = { ...defaultRecording(), ...current };
  for (const k of ["enabled", "in", "out"]) if (input[k] !== undefined) r[k] = !!input[k];
  if (input.announce !== undefined) {
    const a = String(input.announce || "");
    if (a && !prompts.has(a)) throw new UserError("Annonce introuvable.", "announce");
    r.announce = a;
  }
  if (input.retention_days !== undefined) {
    const n = Number(input.retention_days);
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw new UserError("Durée de conservation : entre 0 (illimitée) et 3650 jours.", "retention_days");
    r.retention_days = n;
  }
  return r;
}

/** announcePath : chemin de l'annonce sans extension (ou "") */
export const recordingGlobals = (r, announcePath = "") => [
  `REC_ENABLED = ${r.enabled && (r.in || r.out) ? 1 : 0}`,
  `REC_DIRS = ${[r.in && "in", r.out && "out"].filter(Boolean).join(",")}`,
  `REC_ANNOUNCE = ${r.announce ? announcePath : ""}`,
];

/** Chemin absolu d'un enregistrement d'après la valeur du CDR, ou null si elle est suspecte. */
export function recordingPath(rel, dir = REC_DIR()) {
  if (!/^\d{4}\/\d{2}\/\d{2}\/\d{6}-(in|out)-[\w.-]+\.wav$/.test(String(rel || "")) || rel.includes("..")) return null;
  return path.join(dir, rel);
}

/** Supprime les enregistrements plus anciens que N jours (dossiers par jour). Renvoie le nombre de fichiers supprimés. */
export function purgeRecordings(days, dir = REC_DIR(), now = new Date()) {
  if (!days) return 0;
  const limit = new Date(now.getTime() - days * 86400_000);
  const key = (y, m, d) => `${y}${m}${d}`;
  const lim = key(limit.getUTCFullYear(), String(limit.getUTCMonth() + 1).padStart(2, "0"), String(limit.getUTCDate()).padStart(2, "0"));
  let n = 0;
  const ls = (p) => { try { return fs.readdirSync(p).filter((x) => /^\d+$/.test(x)); } catch { return []; } };
  for (const y of ls(dir)) for (const m of ls(path.join(dir, y))) for (const d of ls(path.join(dir, y, m))) {
    if (key(y, m, d) >= lim) continue;
    const p = path.join(dir, y, m, d);
    n += fs.readdirSync(p).length;
    fs.rmSync(p, { recursive: true, force: true });
  }
  return n;
}

/** Espace occupé par les enregistrements (octets) et nombre de fichiers. */
export function recordingUsage(dir = REC_DIR()) {
  let bytes = 0, files = 0;
  const walk = (p) => {
    let list; try { list = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith(".wav")) { files++; try { bytes += fs.statSync(f).size; } catch { /* supprimé entre-temps */ } }
    }
  };
  walk(dir);
  return { bytes, files };
}
