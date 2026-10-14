/**
 * Messages vocaux d'un utilisateur, lus directement dans le spool d'Asterisk
 * (/var/spool/asterisk/voicemail/default/<poste>/{INBOX,Old}/msgNNNN.{txt,wav}).
 * La console fait partie du groupe « asterisk » et Asterisk crée ses fichiers en 0660 (UMask=0007).
 */
import fs from "node:fs";
import path from "node:path";

export const VM_SPOOL = process.env.PBXM_VM_SPOOL || "/var/spool/asterisk/voicemail";
const FOLDERS = { INBOX: "new", Old: "old" };
const MSG = /^msg(\d{4})\.txt$/;

function boxDir(spool, ext, folder) {
  if (!/^\d{2,6}$/.test(String(ext)) || !FOLDERS[folder]) throw Object.assign(new Error("Message introuvable."), { status: 404 });
  return path.join(spool, "default", String(ext), folder);
}

/** Lit un fichier msgNNNN.txt (format ini d'Asterisk). */
export function parseInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** "Jean Dupont" <0612345678> → { name, number } */
export function parseCallerId(cid) {
  const s = String(cid || "").trim();
  const m = s.match(/^"?([^"<]*)"?\s*<([^>]*)>$/);
  if (m) return { name: m[1].trim(), number: m[2].trim() };
  return { name: "", number: s.replace(/^"|"$/g, "") };
}

function listFolder(spool, ext, folder) {
  const dir = boxDir(spool, ext, folder);
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(MSG);
    if (!m) continue;
    const audio = ["wav", "WAV", "gsm"].map((x) => `msg${m[1]}.${x}`).find((x) => files.includes(x));
    if (!audio) continue;
    let info = {};
    try { info = parseInfo(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const caller = parseCallerId(info.callerid);
    out.push({
      id: `${folder}/${m[1]}`, folder: FOLDERS[folder], index: Number(m[1]),
      caller_name: caller.name, caller_number: caller.number === "Unknown" ? "" : caller.number,
      at: info.origtime ? new Date(Number(info.origtime) * 1000).toISOString() : null,
      duration: Number(info.duration) || 0, msg_id: info.msg_id || "", audio,
    });
  }
  return out;
}

export function listMessages(ext, spool = VM_SPOOL) {
  return [...listFolder(spool, ext, "INBOX"), ...listFolder(spool, ext, "Old")]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function parseId(id) {
  const m = String(id || "").match(/^(INBOX|Old)\/(\d{4})$/);
  if (!m) throw Object.assign(new Error("Message introuvable."), { status: 404 });
  return { folder: m[1], num: m[2] };
}

/** Chemin du fichier audio d'un message (pour l'écoute). */
export function audioPath(ext, id, spool = VM_SPOOL) {
  const { folder, num } = parseId(id);
  const dir = boxDir(spool, ext, folder);
  for (const x of ["wav", "WAV", "gsm"]) {
    const p = path.join(dir, `msg${num}.${x}`);
    if (fs.existsSync(p)) return { file: p, type: x === "gsm" ? "audio/x-gsm" : "audio/wav" };
  }
  throw Object.assign(new Error("Message introuvable."), { status: 404 });
}

const filesOf = (dir, num) => { try { return fs.readdirSync(dir).filter((f) => f.startsWith(`msg${num}.`)); } catch { return []; } };

/** Renumérote un dossier (msg0000, msg0001…) : app_voicemail attend une suite sans trou. */
function resequence(dir) {
  let files; try { files = fs.readdirSync(dir); } catch { return; }
  const nums = [...new Set(files.map((f) => f.match(/^msg(\d{4})\./)?.[1]).filter(Boolean))].sort();
  nums.forEach((num, i) => {
    const want = String(i).padStart(4, "0");
    if (num === want) return;
    for (const f of filesOf(dir, num)) fs.renameSync(path.join(dir, f), path.join(dir, f.replace(`msg${num}.`, `msg${want}.`)));
  });
}

function nextIndex(dir) {
  let files; try { files = fs.readdirSync(dir); } catch { return 0; }
  const nums = files.map((f) => Number(f.match(/^msg(\d{4})\./)?.[1] ?? -1));
  return Math.max(-1, ...nums) + 1;
}

/** Marque un message comme écouté (INBOX → Old). Renvoie le nouvel identifiant. */
export function markRead(ext, id, spool = VM_SPOOL) {
  const { folder, num } = parseId(id);
  if (folder === "Old") return id;
  const src = boxDir(spool, ext, "INBOX"), dst = boxDir(spool, ext, "Old");
  const files = filesOf(src, num);
  if (!files.length) throw Object.assign(new Error("Message introuvable."), { status: 404 });
  if (!fs.existsSync(dst)) { fs.mkdirSync(dst, { recursive: true }); try { fs.chmodSync(dst, 0o2770); } catch { /* */ } }
  const to = String(nextIndex(dst)).padStart(4, "0");
  for (const f of files) fs.renameSync(path.join(src, f), path.join(dst, f.replace(`msg${num}.`, `msg${to}.`)));
  resequence(src);
  return `Old/${to}`;
}

export function deleteMessage(ext, id, spool = VM_SPOOL) {
  const { folder, num } = parseId(id);
  const dir = boxDir(spool, ext, folder);
  const files = filesOf(dir, num);
  if (!files.length) throw Object.assign(new Error("Message introuvable."), { status: 404 });
  for (const f of files) fs.unlinkSync(path.join(dir, f));
  resequence(dir);
}
