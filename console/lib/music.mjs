/**
 * Fonds musicaux propres à un serveur multi-tenant (ajoutés dans la console du serveur › IA), proposés à tous ses PBX
 * en plus de ceux fournis d'office par le portail. Dossier lisible par les consoles des PBX : /var/lib/callikoe/music
 * (index.json + srv-<nom>.wav, WAV 8 kHz mono 16 bits, converti par le navigateur avant l'envoi).
 */
import fs from "node:fs";
import path from "node:path";

export const MUSIC_DIR = process.env.CX_MUSIC_DIR || "/var/lib/callikoe/music";
export const SERVER_MUSIC_MAX = 30;
const ID = /^srv-[a-z0-9-]{1,40}$/;

export function listServerMusic(dir = MUSIC_DIR) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    return (Array.isArray(idx) ? idx : []).filter((m) => ID.test(m.id) && fs.existsSync(path.join(dir, `${m.id}.wav`)));
  } catch { return []; }
}
export function serverMusicFile(id, dir = MUSIC_DIR) {
  if (!ID.test(String(id))) return null;
  const f = path.join(dir, `${id}.wav`);
  return fs.existsSync(f) ? f : null;
}
/** Vérifie un WAV 8 kHz mono 16 bits de 5 à 90 s ; renvoie sa durée */
export function checkMusicWav(buf) {
  const b = Buffer.from(buf);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Fichier audio illisible (WAV attendu).");
  if (b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 8000 || b.readUInt16LE(34) !== 16) throw new Error("Format inattendu : WAV 8 kHz mono 16 bits attendu.");
  const seconds = (b.length - 44) / 16000;
  if (seconds < 5 || seconds > 90) throw new Error("Fond musical : entre 5 et 90 secondes.");
  return Math.round(seconds * 10) / 10;
}
export function addServerMusic(name, buf, dir = MUSIC_DIR) {
  const clean = String(name || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) throw new Error("Nom du fond musical manquant.");
  const seconds = checkMusicWav(buf);
  const idx = listServerMusic(dir);
  if (idx.length >= SERVER_MUSIC_MAX) throw new Error(`${SERVER_MUSIC_MAX} fonds musicaux au maximum : retires-en un d'abord.`);
  const base = `srv-${clean.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30).replace(/-$/, "") || "musique"}`;
  let id = base; for (let i = 2; idx.some((m) => m.id === id); i++) id = `${base}-${i}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.wav`), Buffer.from(buf), { mode: 0o644 });
  const item = { id, name: clean, seconds, added_at: new Date().toISOString() };
  writeIndex([...idx, item], dir);
  return item;
}
export function removeServerMusic(id, dir = MUSIC_DIR) {
  const idx = listServerMusic(dir);
  if (!idx.some((m) => m.id === id)) throw new Error("Fond musical inconnu.");
  writeIndex(idx.filter((m) => m.id !== id), dir);
  fs.rmSync(path.join(dir, `${id}.wav`), { force: true });
}
export function renameServerMusic(id, name, dir = MUSIC_DIR) {
  const idx = listServerMusic(dir), m = idx.find((x) => x.id === id);
  if (!m) throw new Error("Fond musical inconnu.");
  m.name = String(name || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || m.name;
  writeIndex(idx, dir);
  return m;
}
function writeIndex(idx, dir) {
  const tmp = path.join(dir, `.index-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 1), { mode: 0o644 });
  fs.renameSync(tmp, path.join(dir, "index.json"));
}
