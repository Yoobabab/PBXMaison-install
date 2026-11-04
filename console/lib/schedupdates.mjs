// Mises à jour programmées : firmware des téléphones (un ou plusieurs postes) et mise à jour du PBX.
// Fonctions pures (testées) ; l'exécution est dans createScheduler (bas du fichier).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./users.mjs";

/** Marques dont le firmware s'installe par le provisioning (paramètre ajouté à la config le temps de la tâche) */
export const FW_FORMATS = { yealink: "Yealink", grandstream: "Grandstream", snom: "Snom" };
export const FW_WINDOWS = [30, 60, 120, 240, 480];
const MAX_AHEAD = 90 * 86400_000;

/** Devine la marque et la version d'après le nom du fichier du fabricant */
export function guessFirmware(name) {
  const n = String(name || "").trim();
  const base = path.basename(n.split("?")[0]);
  let format = "", version = "";
  if (/\.rom$/i.test(base)) { format = "yealink"; version = /(\d+\.\d+\.\d+\.\d+)/.exec(base)?.[1] || ""; }
  else if (/^snom|\bsnom/i.test(base) || /-sip-r\.bin$/i.test(base)) { format = "snom"; version = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(base)?.[1] || ""; }
  else if (/^(gxp|grp|gxv|wp|dp|ht|gac)\w*fw\.bin$/i.test(base) || /fw\.bin$/i.test(base)) { format = "grandstream"; version = /(\d+\.\d+\.\d+\.\d+)/.exec(base)?.[1] || ""; }
  return { format, version, file: base };
}

/** Fiche d'un firmware de la bibliothèque (fichier envoyé ou lien direct chez le fabricant) */
export function validateFirmware(input, models) {
  const known = new Map(models.map((m) => [m.id, m]));
  const format = String(input.format || "");
  if (!FW_FORMATS[format]) throw new UserError("Marque non prise en charge pour la mise à jour programmée (Yealink, Grandstream ou Snom).", "format");
  const ids = [...new Set((Array.isArray(input.models) ? input.models : []).map(String))];
  for (const id of ids) {
    const m = known.get(id);
    if (!m) throw new UserError(`Modèle inconnu : ${id}.`, "models");
    if (m.format !== format) throw new UserError(`${m.label} n'est pas un téléphone ${FW_FORMATS[format]}.`, "models");
  }
  if (!ids.length) throw new UserError("Coche au moins un modèle de téléphone pour ce firmware.", "models");
  const version = String(input.version || "").trim().slice(0, 40);
  if (!version) throw new UserError("Indique la version (elle sert à vérifier que la mise à jour a bien eu lieu).", "version");
  let url = "";
  if (input.url) {
    url = String(input.url).trim();
    if (!/^https?:\/\/[^\s/]+\/\S+$/.test(url)) throw new UserError("Lien invalide : il doit commencer par http:// ou https:// et pointer vers le fichier.", "url");
  }
  const name = String(input.name || "").trim().slice(0, 80) || `${FW_FORMATS[format]} ${version}`;
  return { format, models: ids, version, url, name };
}

/** Date de lancement : maintenant ou plus tard (90 jours au plus) */
export function validateRunAt(value, now = Date.now()) {
  if (!value || value === "now") return new Date(now).toISOString();
  const t = Date.parse(value);
  if (isNaN(t)) throw new UserError("Date ou heure invalide.", "run_at");
  if (t < now - 5 * 60_000) throw new UserError("Cette date est déjà passée.", "run_at");
  if (t > now + MAX_AHEAD) throw new UserError("Programme la mise à jour dans les 90 prochains jours.", "run_at");
  return new Date(Math.max(t, now)).toISOString();
}

/**
 * Tâche « firmware des téléphones » : postes choisis + firmware compatible.
 * phones : [{ ext, name, mac, model }] (téléphones de bureau configurés) ; firmwares : bibliothèque.
 */
export function validatePhonesJob(input, { phones, firmwares, now = Date.now() }) {
  const fw = firmwares.find((f) => f.id === input.firmware);
  if (!fw) throw new UserError("Choisis un firmware de la bibliothèque.", "firmware");
  const wanted = [...new Set((Array.isArray(input.targets) ? input.targets : []).map(String))];
  if (!wanted.length) throw new UserError("Choisis au moins un téléphone.", "targets");
  if (wanted.length > 500) throw new UserError("500 téléphones au plus par tâche.", "targets");
  const byExt = new Map(phones.map((p) => [p.ext, p]));
  const targets = [], bad = [];
  for (const ext of wanted) {
    const p = byExt.get(ext);
    if (!p || !p.mac) { bad.push(`${ext} (pas de téléphone avec adresse MAC)`); continue; }
    if (!fw.models.includes(p.model)) { bad.push(`${ext} (${p.model_label || p.model || "modèle inconnu"})`); continue; }
    targets.push({ ext, name: p.name || "", mac: p.mac, model: p.model, status: "waiting" });
  }
  if (bad.length) throw new UserError(`Ce firmware ne convient pas à : ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? "…" : ""}.`, "targets");
  return { kind: "phones", run_at: validateRunAt(input.run_at, now), window_min: windowOf(input.window_min), wait_calls: input.wait_calls !== false,
    payload: { firmware: fw.id, firmware_name: fw.name, version: fw.version, targets } };
}

export function validatePbxJob(input, { now = Date.now(), tenant = false } = {}) {
  if (tenant) throw new UserError("Sur le serveur multi-tenant, la mise à jour se programme depuis la console du serveur.");
  return { kind: "pbx", run_at: validateRunAt(input.run_at, now), window_min: windowOf(input.window_min), wait_calls: input.wait_calls !== false, payload: {} };
}
const windowOf = (v) => FW_WINDOWS.includes(Number(v)) ? Number(v) : 120;

export const windowEnd = (job) => Date.parse(job.run_at) + job.window_min * 60_000;

/**
 * Prochaine étape pour un téléphone d'une tâche en cours.
 * ctx : { online, busy, firmware (version vue maintenant), now, end, waitCalls, version (visée) }
 * → { status, send } : send = true quand il faut lui envoyer l'ordre de redémarrer
 */
export function phoneStep(t, ctx) {
  const done = ctx.firmware && sameVersion(ctx.firmware, ctx.version);
  if (t.status === "done" || t.status === "already") return { status: t.status, send: false };
  if (done) return { status: t.status === "waiting" && !t.sent_at ? "already" : "done", send: false };
  if (ctx.now >= ctx.end) return { status: t.sent_at ? "unchanged" : ctx.online ? "busy" : "offline", send: false };
  if (t.status === "sent") {
    // Pas reconnecté avec la nouvelle version 20 min après l'ordre : on renvoie une fois
    if (!t.retried && ctx.online && ctx.now - Date.parse(t.sent_at) > 20 * 60_000 && !(ctx.waitCalls && ctx.busy)) return { status: "sent", send: true, retry: true };
    return { status: "sent", send: false };
  }
  if (!ctx.online) return { status: "waiting", send: false };
  if (ctx.waitCalls && ctx.busy) return { status: "waiting", send: false };
  return { status: "sent", send: true };
}
/** « 108.86.0.75 » vu dans l'identité du téléphone = version visée (préfixes de modèle ignorés) */
export function sameVersion(seen, want) {
  const norm = (v) => String(v || "").toLowerCase().replace(/^v/, "").trim();
  const a = norm(seen), b = norm(want);
  return !!a && !!b && (a === b || a.endsWith(`.${b}`) || a.endsWith(`-${b}`) || b.endsWith(`.${a}`));
}

export const TARGET_LABEL = { waiting: "En attente", sent: "Redémarré, installation en cours", done: "Mis à jour", already: "Déjà à jour",
  unchanged: "Pas de changement de version", offline: "Déconnecté pendant la plage", busy: "En appel pendant toute la plage", cancelled: "Annulé" };
export const JOB_LABEL = { pending: "Programmée", running: "En cours", done: "Terminée", partial: "Terminée avec des restes", failed: "Échec", skipped: "Pas lancée", cancelled: "Annulée" };

/** Bilan d'une tâche de téléphones terminée */
export function phonesOutcome(targets) {
  const ok = targets.filter((t) => t.status === "done" || t.status === "already").length;
  return { status: ok === targets.length ? "done" : ok ? "partial" : "failed", ok, total: targets.length };
}

/** Paramètres ajoutés à la configuration du téléphone pendant la tâche */
export function firmwareParams(format, fw) {
  if (!fw) return [];
  if (format === "yealink") return [["static.firmware.url", fw.url]];
  if (format === "grandstream") return [["provisioning.firmware.protocol", /^https:/.test(fw.dir) ? "HTTPS" : "HTTP"], ["provisioning.firmware.serverPath", fw.dir.replace(/^https?:\/\//, "").replace(/\/$/, "")]];
  if (format === "snom") return [["firmware_status", fw.snom_status]];
  return [];
}
/** Fichier firmware_status lu par les Snom : il pointe vers le binaire */
export const snomFirmwareStatus = (url) => `<?xml version="1.0" encoding="utf-8"?>\n<firmware-settings>\n <firmware perm="">${String(url).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</firmware>\n</firmware-settings>\n`;

// ------------------------------------------------------------------ Service : bibliothèque + tâches + exécution
export function createScheduler({ db, pbx, admin, VAR, models, tenant = false, log = () => {} }) {
  const FW_DIR = path.join(VAR, "firmware");
  const fwPath = (f) => f && !f.url && /^[0-9a-f]{12}$/.test(f.id) ? path.join(FW_DIR, f.id, f.file) : null;

  async function migrate() {
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_jobs (
      id serial PRIMARY KEY, kind text NOT NULL, run_at timestamptz NOT NULL, window_min integer NOT NULL DEFAULT 120, wait_calls boolean NOT NULL DEFAULT true,
      payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending', result jsonb NOT NULL DEFAULT '{}',
      created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz)`);
  }

  // ---------- Bibliothèque de firmwares
  const firmwares = () => db.getSetting("firmwares", []);
  async function listFirmwares() {
    const list = await firmwares();
    const used = (await db.query("SELECT payload->>'firmware' AS f FROM pbxmaison_jobs WHERE kind = 'phones' AND status IN ('pending','running')")).rows.map((r) => r.f);
    return { firmwares: list.map((f) => ({ ...f, in_use: used.includes(f.id) })), formats: FW_FORMATS,
      models: models.filter((m) => FW_FORMATS[m.format]).map((m) => ({ id: m.id, label: m.label, format: m.format })) };
  }
  /** Envoi d'un fichier (corps brut) ; meta dans l'adresse : nom du fichier, marque, modèles, version */
  async function addFirmwareFile(stream, meta, by) {
    const file = path.basename(String(meta.file || "")).replace(/[^\w.+-]/g, "_").slice(0, 120);
    if (!file || !/\.(rom|bin|zip|z)$/i.test(file)) throw new UserError("Fichier attendu : le firmware du fabricant (.rom, .bin…).");
    const g = guessFirmware(file);
    const fw = validateFirmware({ ...meta, format: meta.format || g.format, version: meta.version || g.version, url: "" }, models);
    const id = crypto.randomBytes(6).toString("hex");
    const dir = path.join(FW_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file);
    const hash = crypto.createHash("sha256");
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { mode: 0o640 });
      stream.on("data", (c) => { size += c.length; hash.update(c); });
      stream.pipe(out); out.on("finish", resolve); out.on("error", reject); stream.on("error", reject);
    });
    if (size < 1024) { fs.rmSync(dir, { recursive: true, force: true }); throw new UserError("Fichier vide ou trop petit pour être un firmware."); }
    const entry = { id, ...fw, file, size, sha256: hash.digest("hex"), added_at: new Date().toISOString(), added_by: by };
    await db.setSetting("firmwares", [...(await firmwares()), entry]);
    return entry;
  }
  async function addFirmwareUrl(input, by) {
    const fw = validateFirmware({ ...input, format: input.format || guessFirmware(input.url).format, version: input.version || guessFirmware(input.url).version }, models);
    if (!fw.url) throw new UserError("Colle le lien du fichier firmware.", "url");
    const entry = { id: crypto.randomBytes(6).toString("hex"), ...fw, file: guessFirmware(fw.url).file, size: 0, added_at: new Date().toISOString(), added_by: by };
    await db.setSetting("firmwares", [...(await firmwares()), entry]);
    return entry;
  }
  async function deleteFirmware(id) {
    const list = await firmwares();
    const f = list.find((x) => x.id === id);
    if (!f) throw new UserError("Firmware introuvable.");
    const busy = (await db.query("SELECT 1 FROM pbxmaison_jobs WHERE kind = 'phones' AND status IN ('pending','running') AND payload->>'firmware' = $1", [id])).rowCount;
    if (busy) throw new UserError("Ce firmware sert à une mise à jour programmée : annule-la d'abord.");
    const p = fwPath(f); if (p) fs.rmSync(path.dirname(p), { recursive: true, force: true });
    await db.setSetting("firmwares", list.filter((x) => x.id !== id));
    return { ok: true };
  }
  /** Fichier demandé par un téléphone : /prov/<jeton>/fw/<id>/<fichier> */
  async function firmwareFile(id, file, provUrl) {
    const f = (await firmwares()).find((x) => x.id === id);
    if (!f) return null;
    if (file === "snom-firmware.xml") return { text: snomFirmwareStatus(f.url || `${provUrl}fw/${f.id}/${f.file}`), type: "application/xml" };
    const p = fwPath(f);
    // Grandstream demande <modèle>fw.bin dans le dossier : on sert le fichier du dossier quel que soit le nom demandé
    if (!p || !fs.existsSync(p) || !/^[\w.+-]+$/.test(file)) return null;
    return { path: p, size: fs.statSync(p).size };
  }

  // ---------- Firmware à proposer au téléphone pendant une tâche (lu par la génération de config)
  async function firmwareFor(mac, provUrl) {
    if (!mac) return null;
    const a = (await db.getSetting("fw_assign", {}))[mac];
    if (!a || Date.parse(a.until) < Date.now()) return null;
    const f = (await firmwares()).find((x) => x.id === a.firmware);
    if (!f) return null;
    const dir = `${provUrl}fw/${f.id}/`;
    return { url: f.url || `${dir}${f.file}`, dir, snom_status: `${dir}snom-firmware.xml`, version: f.version };
  }
  async function assign(macs, firmware, until) {
    const cur = await db.getSetting("fw_assign", {});
    for (const m of macs) if (firmware) cur[m] = { firmware, until }; else delete cur[m];
    // Ménage : affectations expirées
    for (const [m, a] of Object.entries(cur)) if (Date.parse(a.until) < Date.now()) delete cur[m];
    await db.setSetting("fw_assign", cur);
  }

  // ---------- Tâches
  /** Téléphones de bureau configurés (pour choisir et contrôler les cibles) */
  async function deskPhones() {
    const label = new Map(models.map((m) => [m.id, m.label]));
    return (await pbx.loadUsers()).filter((u) => u.phone?.mac && u.phone?.model).map((u) => ({ ext: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.name || "", mac: u.phone.mac, model: u.phone.model, model_label: label.get(u.phone.model) || u.phone.model }));
  }
  async function listJobs() {
    const r = await db.query("SELECT * FROM pbxmaison_jobs ORDER BY (status IN ('pending','running')) DESC, created_at DESC LIMIT 60");
    return { jobs: r.rows.map(jobOut), windows: FW_WINDOWS, tenant };
  }
  const jobOut = (j) => ({ ...j, label: JOB_LABEL[j.status] || j.status, end_at: new Date(windowEnd({ ...j, run_at: new Date(j.run_at).toISOString() })).toISOString(),
    targets: (j.payload.targets || []).map((t) => ({ ...t, label: TARGET_LABEL[t.status] || t.status })) });
  async function createJob(input, by) {
    const now = Date.now();
    let job;
    if (input.kind === "pbx") {
      job = validatePbxJob(input, { now, tenant });
      const dup = await db.query("SELECT 1 FROM pbxmaison_jobs WHERE kind = 'pbx' AND status IN ('pending','running')");
      if (dup.rowCount) throw new UserError("Une mise à jour du PBX est déjà programmée : annule-la pour en choisir une autre.");
    } else {
      job = validatePhonesJob(input, { phones: await deskPhones(), firmwares: await firmwares(), now });
      const busy = await db.query("SELECT payload FROM pbxmaison_jobs WHERE kind = 'phones' AND status IN ('pending','running')");
      const taken = new Set(busy.rows.flatMap((r) => (r.payload.targets || []).map((t) => t.ext)));
      const dup = job.payload.targets.filter((t) => taken.has(t.ext)).map((t) => t.ext);
      if (dup.length) throw new UserError(`Déjà dans une autre mise à jour programmée : ${dup.slice(0, 10).join(", ")}.`, "targets");
    }
    const r = await db.query("INSERT INTO pbxmaison_jobs (kind, run_at, window_min, wait_calls, payload, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [job.kind, job.run_at, job.window_min, job.wait_calls, JSON.stringify(job.payload), by]);
    setTimeout(() => tick().catch(() => {}), 1000).unref?.();
    return jobOut(r.rows[0]);
  }
  async function cancelJob(id) {
    const j = (await db.query("SELECT * FROM pbxmaison_jobs WHERE id = $1", [Number(id) || 0])).rows[0];
    if (!j) throw new UserError("Tâche introuvable.");
    if (j.kind === "pbx" && j.status === "running") throw new UserError("La mise à jour du PBX est en cours : elle ne peut plus être arrêtée.");
    if (!["pending", "running"].includes(j.status)) throw new UserError("Cette tâche est déjà terminée.");
    if (j.kind === "phones") {
      await assign((j.payload.targets || []).map((t) => t.mac), null);
      for (const t of j.payload.targets || []) if (t.status === "waiting" || t.status === "sent") t.status = "cancelled";
    }
    await db.query("UPDATE pbxmaison_jobs SET status = 'cancelled', payload = $2, finished_at = now() WHERE id = $1", [j.id, JSON.stringify(j.payload)]);
    return { ok: true };
  }

  async function busyEndpoints() {
    try { return await pbx.busyEndpoints(); } catch { return null; }
  }
  /** Version vue sur chaque téléphone (identité SIP) : mac → firmware */
  async function seenFirmware() {
    await pbx.trackDevices().catch(() => {});
    const r = await db.query("SELECT mac, firmware, online FROM pbxmaison_device_seen WHERE mac <> '' ORDER BY online DESC, last_seen DESC");
    const m = new Map();
    for (const x of r.rows) if (!m.has(x.mac)) m.set(x.mac, x);
    return m;
  }

  async function runPhones(j, now) {
    const end = windowEnd({ ...j, run_at: new Date(j.run_at).toISOString() });
    const fw = (await firmwares()).find((f) => f.id === j.payload.firmware);
    const first = j.status === "pending";
    if (!fw) {
      await assign(j.payload.targets.map((t) => t.mac), null);
      await db.query("UPDATE pbxmaison_jobs SET status = 'failed', result = $2, finished_at = now() WHERE id = $1", [j.id, JSON.stringify({ error: "Firmware supprimé de la bibliothèque." })]);
      return;
    }
    if (first) {
      await assign(j.payload.targets.map((t) => t.mac), fw.id, new Date(end).toISOString());
      const seen = await seenFirmware();
      for (const t of j.payload.targets) t.before = seen.get(t.mac)?.firmware || "";
    }
    const [reg, busy, seen] = await Promise.all([pbx.registrations(), busyEndpoints(), seenFirmware()]);
    for (const t of j.payload.targets) {
      const online = (reg.get(t.ext) || []).length > 0 && !!seen.get(t.mac)?.online;
      const step = phoneStep(t, { online, busy: busy ? busy.has(t.ext) : true, firmware: seen.get(t.mac)?.firmware || "", now, end, waitCalls: j.wait_calls, version: fw.version });
      t.status = step.status;
      if (step.send) {
        try { await pbx.notifyPhone(t.ext, "reboot"); t.sent_at = new Date(now).toISOString(); if (step.retry) t.retried = true; t.status = "sent"; }
        catch { t.status = "waiting"; }
      }
      t.after = seen.get(t.mac)?.firmware || t.after || "";
    }
    const open = j.payload.targets.some((t) => t.status === "waiting" || t.status === "sent");
    if (!open || now >= end) {
      await assign(j.payload.targets.map((t) => t.mac), null);
      const out = phonesOutcome(j.payload.targets);
      await db.query("UPDATE pbxmaison_jobs SET status = $2, payload = $3, result = $4, started_at = COALESCE(started_at, now()), finished_at = now() WHERE id = $1",
        [j.id, out.status, JSON.stringify(j.payload), JSON.stringify(out)]);
      log(`Mise à jour firmware n°${j.id} : ${out.ok}/${out.total} téléphone(s) à jour`);
    } else {
      await db.query("UPDATE pbxmaison_jobs SET status = 'running', payload = $2, started_at = COALESCE(started_at, now()) WHERE id = $1", [j.id, JSON.stringify(j.payload)]);
    }
  }

  async function runPbx(j, now) {
    const end = windowEnd({ ...j, run_at: new Date(j.run_at).toISOString() });
    const finish = (status, result) => db.query("UPDATE pbxmaison_jobs SET status = $2, result = $3, started_at = COALESCE(started_at, now()), finished_at = now() WHERE id = $1", [j.id, status, JSON.stringify(result)]);
    if (j.status === "running") {
      const st = await admin.updateStatus().catch(() => null);
      const cur = (await admin.getUpdates().catch(() => null))?.current?.commit || "";
      if (j.result.from && cur && cur !== j.result.from) return finish("done", { ...j.result, to: cur, version: (await admin.getUpdates().catch(() => null))?.current?.version || "" });
      if (st?.done && !st.running) return finish(st.ok ? "done" : "failed", { ...j.result, error: st.ok ? "" : (st.log || []).slice(-1)[0] || "Mise à jour impossible." });
      if (now > end + 3600_000) return finish("failed", { ...j.result, error: "Pas de fin de mise à jour constatée." });
      return;
    }
    if (j.wait_calls) {
      const busy = await busyEndpoints();
      if (busy && busy.size && now < end) { await db.query("UPDATE pbxmaison_jobs SET result = $2 WHERE id = $1", [j.id, JSON.stringify({ waiting: "Des appels sont en cours : on attend qu'ils soient finis." })]); return; }
      if (busy && busy.size) return finish("skipped", { error: "Des appels étaient en cours pendant toute la plage : la mise à jour n'a pas été lancée." });
    }
    const u = await admin.getUpdates({ check: true }).catch((e) => ({ error: e.message }));
    if (u.up_to_date) return finish("skipped", { error: `Callikoe était déjà à jour (version ${u.current?.version || "?"}).` });
    const from = u.current?.commit || "";
    try {
      await admin.startUpdate();
      await db.query("UPDATE pbxmaison_jobs SET status = 'running', started_at = now(), result = $2 WHERE id = $1", [j.id, JSON.stringify({ from, target: u.available?.version || "" })]);
      log(`Mise à jour programmée n°${j.id} lancée`);
    } catch (e) { return finish("failed", { error: e.message }); }
  }

  let running = false;
  async function tick() {
    if (running) return; running = true;
    try {
      const now = Date.now();
      const due = (await db.query("SELECT * FROM pbxmaison_jobs WHERE status IN ('pending','running') AND run_at <= now() ORDER BY run_at")).rows;
      for (const j of due) {
        try { if (j.kind === "pbx") await runPbx(j, now); else await runPhones(j, now); }
        catch (e) { log(`Tâche programmée n°${j.id} : ${e.message}`); }
      }
    } finally { running = false; }
  }
  function start() {
    const t = setInterval(() => tick().catch(() => {}), 30_000); t.unref?.();
    setTimeout(() => tick().catch(() => {}), 15_000).unref?.();
  }

  return { migrate, start, tick, listFirmwares, addFirmwareFile, addFirmwareUrl, deleteFirmware, firmwareFile, firmwareFor, listJobs, createJob, cancelJob, deskPhones };
}
