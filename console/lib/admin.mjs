/**
 * Administration du PBX : règles sortantes, sécurité, enregistrements, codes raccourcis, sauvegardes,
 * mises à jour, licence, alertes, passerelles et bases DECT.
 * S'appuie sur le service téléphonique (pbx.mjs) et sur pbx-configure (sudo) pour les actions système.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { APP_DIR, CONFIGURE_CMD, VAR, CX_MODE, installState, pbxEnv, isConfigured } from "./config.mjs";
import { UserError, displayName } from "./users.mjs";
import { splitPcapFile } from "./pcap-split.mjs";
import { validateRule, describeRule, buildOutboundDialplan, rangesText, CID_MODES } from "./outbound.mjs";
import { defaultSecurity, validateSecurity, buildSecurityDialplan, securityGlobals, sipAcl, ipAllowed, checkIp, COUNTRIES } from "./security.mjs";
import { defaultShortcodes, normalizeShortcodes, validateShortcodes, buildShortcodesDialplan, shortcodesList } from "./shortcodes.mjs";
import { defaultRecording, validateRecording, recordingGlobals, recordingPath, purgeRecordings, recordingUsage, REC_DIR } from "./recording.mjs";
import { defaultBackup, validateBackup, publicBackup, backupDue, listBackups, backupPath, uploadBackup, BACKUP_DIR, SCHEDULES, PROTOCOLS } from "./backup.mjs";
import { ALERT_EVENTS, SEVERITY, CRITICAL_SERVICES, defaultAlerts, validateAlerts, publicAlerts, detectAlerts } from "./alerts.mjs";
import { GATEWAY_MODELS, GATEWAY_TYPES, validateGateway, manualGuide } from "./devices.mjs";
import { EMERGENCY } from "./pbx.mjs";
import { smtpReady, transportOf, smtpError, voicemailMail, alertMail, messagesToMail } from "./mail.mjs";
import * as vmbox from "./voicemail.mjs";
import { fraudSignals } from "./fraud.mjs";
import { periodOf, periodStats, reportInput, monthlyReportMail } from "./report.mjs";
import { readTheme, assetFile, THEME_DIR } from "./theme.mjs";

/** Lance pbx-configure et renvoie { code, out, lines (JSON par ligne) }. */
export function runConfigure(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const [cmd, ...base] = CONFIGURE_CMD;
    let child;
    try { child = spawn(cmd, [...base, ...args], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ code: -1, out: "", err: e.message, lines: [] }); return; }
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message, lines: [] }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ code, out, err, lines });
    });
  });
}
const sysError = (r, what) => new UserError(`${what} : ${(r.lines.find((l) => l.status === "error" || l.error)?.message || r.lines.find((l) => l.error)?.error || r.err || "échec").toString().trim().slice(0, 300)}`);

const readVersion = () => { try { return fs.readFileSync(path.join(APP_DIR, "VERSION"), "utf8").trim(); } catch { return "?"; } };
const readChangelog = () => { try { return fs.readFileSync(path.join(APP_DIR, "CHANGELOG.md"), "utf8"); } catch { return ""; } };

export function createAdminService({ db, ami, pbx, ai = null }) {
  const get = async (key, def) => {
    const v = await db.getSetting(key, null);
    return v && typeof v === "object" && !Array.isArray(v) ? { ...def, ...v } : v ?? def;
  };

/** Clé d'un message vocal (même calcul pour l'e-mail, l'IA et le softphone) */
  const vmKey = (box, m) => (m.msg_id ? `${box}:${m.msg_id}` : `${box}:${m.at}:${m.caller_number}`);
  async function migrate() {
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_alerts (
      id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), event text NOT NULL, severity text NOT NULL,
      title text NOT NULL, text text NOT NULL, email text NOT NULL DEFAULT 'pending')`);
    // Messages vocaux déjà envoyés par e-mail (jamais deux fois)
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_vm_mailed (key text PRIMARY KEY, box text NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
    // IA : transcription et résumé de chaque message vocal (une seule fois par message)
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_vm_ai (key text PRIMARY KEY, box text NOT NULL, text text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '',
      caller_name text NOT NULL DEFAULT '', callback text NOT NULL DEFAULT '', urgent boolean NOT NULL DEFAULT false, at timestamptz NOT NULL DEFAULT now())`);
    await db.query("ALTER TABLE pbxmaison_vm_ai ADD COLUMN IF NOT EXISTS caller_number text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS msg_at text NOT NULL DEFAULT ''");
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_ai_reports (key text PRIMARY KEY, text text NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
    // Appels perdus marqués « traité » (numéro comparable → date)
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_callback_done (key text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), by_who text NOT NULL DEFAULT '')`);
  }

  // ---------------------------------------------------------------- Règles sortantes
  async function trunkMap() {
    const r = await db.query("SELECT id, dial_format, cid_format, outbound_cid FROM pbxmaison_trunks");
    return new Map(r.rows.map((t) => [t.id, t]));
  }
  async function outboundRules() { return await db.getSetting("outbound_rules", []); }
  async function listOutbound() {
    const [rules, trunks] = await Promise.all([outboundRules(), pbx.listTrunks()]);
    const routes = await pbx.getRoutes();
    return {
      rules: rules.map((r) => ({ ...r, summary: describeRule(r), extensions_text: rangesText(r.extensions), lengths_text: rangesText(r.lengths), prefixes_text: r.prefixes.join(",") })),
      trunks: trunks.map((t) => ({ id: t.id, operator: t.operator, number: t.number, outbound_cid: t.outbound_cid, status: t.status })),
      default_trunk: routes.outbound_trunk, inbound: routes.inbound, cid_modes: CID_MODES,
    };
  }
  async function saveOutbound(id, input) {
    const trunks = await trunkMap();
    const rule = validateRule(input, { trunks: new Set(trunks.keys()), cc: pbx.countryCode() });
    const rules = await outboundRules();
    if (id) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) throw new UserError("Règle introuvable.");
      rules[i] = { ...rule, id };
    } else rules.push({ ...rule, id: crypto.randomBytes(5).toString("hex") });
    await db.setSetting("outbound_rules", rules);
    await pbx.applyDialplan();
    return listOutbound();
  }
  async function deleteOutbound(id) {
    await db.setSetting("outbound_rules", (await outboundRules()).filter((r) => r.id !== id));
    await pbx.applyDialplan();
    return listOutbound();
  }
  async function orderOutbound(ids) {
    const rules = await outboundRules();
    const pos = new Map((ids || []).map((x, i) => [x, i]));
    rules.sort((a, b) => (pos.get(a.id) ?? 999) - (pos.get(b.id) ?? 999));
    await db.setSetting("outbound_rules", rules);
    await pbx.applyDialplan();
    return listOutbound();
  }

  // ---------------------------------------------------------------- Sécurité
  const security = () => get("security", defaultSecurity());
  async function f2bStatus() {
    const r = await runConfigure(["f2b", "status"], { timeout: 20_000 });
    return r.lines[0] || { ok: false, error: "Protection anti-intrusion injoignable." };
  }
  async function getSecurity() {
    const [s, f2b] = await Promise.all([security(), CX_MODE === "tenant" ? { ok: true, active: true, auto: [], manual: [], server: true } : f2bStatus()]);
    return { settings: s, f2b, countries: COUNTRIES, tenant: CX_MODE === "tenant" };
  }
  async function setSecurity(input, clientIp) {
    const cur = await security();
    const s = validateSecurity(input, cur);
    if (s.console_allow.length && !ipAllowed(clientIp, s.console_allow)) {
      throw new UserError(`Ton adresse actuelle (${clientIp}) n'est pas dans la liste : tu perdrais l'accès à la console.`, "console_allow");
    }
    await db.setSetting("security", s);
    // Multi-tenant : réseaux autorisés appliqués par l'aiguilleur ; la protection anti-intrusion se règle dans la console du serveur
    if (CX_MODE === "tenant") { if (input.sip_allow !== undefined) await pbx.publishRoutes().catch(() => {}); }
    else if (input.f2b || input.whitelist) {
      const r = await runConfigure(["f2b", "settings", String(s.f2b.maxretry), String(s.f2b.findtime), String(s.f2b.bantime), s.whitelist.join(",")], { timeout: 30_000 });
      if (r.code !== 0 && r.code !== null) s.f2b_warning = "Réglages enregistrés, mais la protection anti-intrusion n'a pas pu être mise à jour.";
    }
    await pbx.applyDialplan();
    return { ...(await getSecurity()), warning: s.f2b_warning };
  }
  async function banIp(ip, ban) {
    if (CX_MODE === "tenant") throw new UserError("Sur ce serveur, les adresses bloquées se gèrent dans la console du serveur (Paramètres › Protection anti-intrusion).");
    const a = checkIp(ip);
    if (!a) throw new UserError("Adresse IP invalide.", "ip");
    const r = await runConfigure(["f2b", ban ? "ban" : "unban", a], { timeout: 20_000 });
    if (!r.lines[0]?.ok) throw sysError(r, ban ? "Blocage impossible" : "Déblocage impossible");
    if (ban) await logAlert("ip_banned", `L'adresse ${a} a été bloquée à la main depuis la console.`);
    return f2bStatus();
  }
  let consoleAllow = [];
  const refreshAllow = async () => { consoleAllow = (await security()).console_allow || []; };
  const consoleAllowed = (ip) => ipAllowed(ip, consoleAllow);

  // ---------------------------------------------------------------- Enregistrements
  const recording = () => get("recording", defaultRecording());
  async function promptIds() { return new Set((await pbx.loadObjects()).filter((o) => o.kind === "prompt" && o.data.file).map((o) => o.id)); }
  async function getRecording() {
    const r = await recording();
    const prompts = (await pbx.loadObjects()).filter((o) => o.kind === "prompt").map((o) => ({ id: o.id, name: o.name || o.data.name }));
    return { settings: r, prompts, usage: recordingUsage() };
  }
  async function setRecording(input) {
    const r = validateRecording(input, await recording(), await promptIds());
    await db.setSetting("recording", r);
    await pbx.applyDialplan();
    return getRecording();
  }
  async function listRecordings(q = {}) {
    const { calls } = await pbx.callLog({ days: q.days || 30, q: q.q || "", direction: q.direction || "", limit: 5000 });
    const list = calls.filter((c) => c.recording).map((c) => {
      const f = recordingPath(c.recording);
      let size = 0; try { size = fs.statSync(f).size; } catch { /* fichier purgé */ }
      return { ...c, size, available: size > 44 };
    });
    return { recordings: list.slice(0, 5000), total: list.length };
  }
  async function recordingFile(rel) {
    const f = recordingPath(rel);
    if (!f || !fs.existsSync(f)) throw Object.assign(new UserError("Enregistrement introuvable (supprimé ou purgé)."), { status: 404 });
    return f;
  }
  async function deleteRecording(rel) {
    const f = await recordingFile(rel);
    fs.rmSync(f, { force: true });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Codes raccourcis
  const shortcodes = async () => normalizeShortcodes(await get("shortcodes", defaultShortcodes()));
  async function getShortcodes() { return { codes: shortcodesList(await shortcodes()) }; }
  async function setShortcodes(input) {
    await db.setSetting("shortcodes", validateShortcodes(input, await shortcodes()));
    await pbx.applyDialplan();
    return getShortcodes();
  }
  /** Statut changé par code (*30, *31, *32) : noté par Asterisk dans sa base, appliqué ici. */
  async function pollStatusCodes() {
    let lines;
    try { lines = await ami.command("database show callikoe_status"); } catch { return; }
    const todo = [];
    for (const l of lines) {
      const m = /^\/callikoe_status\/(\d{3})\s*:\s*(\w+)/.exec(l.trim());
      if (m) todo.push([m[1], m[2]]);
    }
    if (!todo.length) return;
    try { await ami.command("database deltree callikoe_status"); } catch { /* réessaie au prochain passage */ }
    for (const [ext, status] of todo) {
      try { await pbx.updateUser(ext, { status }, "code raccourci"); } catch (e) { console.error(`Statut ${ext} :`, e.message); }
    }
  }

  // ---------------------------------------------------------------- Plan de numérotation des modules
  async function dialplanParts() {
    const [rules, trunks, sec, rec, codes, objects] = await Promise.all([outboundRules(), trunkMap(), security(), recording(), shortcodes(), pbx.loadObjects()]);
    const valid = rules.filter((r) => r.routes.every((rt) => trunks.has(rt.trunk)));
    const prompt = rec.announce && objects.find((o) => o.kind === "prompt" && o.id === rec.announce)?.data?.file;
    const announce = prompt ? path.join(pbx.soundsDir(), prompt).replace(/\.wav$/, "") : "";
    consoleAllow = sec.console_allow || [];
    return {
      globals: [...securityGlobals(sec), ...recordingGlobals(rec, announce)],
      dialplan: buildOutboundDialplan(valid, trunks) + buildSecurityDialplan(sec) + buildShortcodesDialplan(codes),
      sipAcl: sipAcl(sec),
    };
  }

  // ---------------------------------------------------------------- Sauvegardes
  const backupSettings = () => get("backup", defaultBackup());
  let backupJob = null;
  async function getBackups() {
    const b = await backupSettings();
    return { settings: publicBackup(b), backups: listBackups(), last: await db.getSetting("backup_last", null), running: !!backupJob?.running, job: backupJob, schedules: SCHEDULES, protocols: PROTOCOLS };
  }
  async function setBackups(input) {
    await db.setSetting("backup", validateBackup(input, await backupSettings()));
    return getBackups();
  }
  async function runBackup(trigger = "manual") {
    if (backupJob?.running) throw new UserError("Une sauvegarde est déjà en cours.");
    const b = await backupSettings();
    backupJob = { running: true, trigger, started: new Date().toISOString(), steps: [] };
    const job = backupJob;
    (async () => {
      const args = ["backup", "--keep", String(b.keep)];
      if (b.recordings) args.push("--recordings");
      if (!b.voicemail) args.push("--no-voicemail");
      const r = await runConfigure(args, { timeout: 1_800_000 });
      job.steps = r.lines;
      const done = r.lines.find((l) => l.step === "termine" && l.status === "ok");
      let error = done ? "" : sysError(r, "Sauvegarde impossible").message;
      if (done && b.remote.enabled) {
        job.steps.push({ step: "distant", status: "run", message: "Envoi vers le serveur distant…" });
        const up = await uploadBackup(b.remote, path.join(BACKUP_DIR(), done.message));
        job.steps[job.steps.length - 1] = up.ok ? { step: "distant", status: "ok", message: `Copie envoyée sur ${b.remote.host}` } : { step: "distant", status: "error", message: `Envoi impossible : ${up.error}` };
        if (!up.ok) error = `Copie distante impossible : ${up.error}`;
      }
      await db.setSetting("backup_last", { at: new Date().toISOString(), ok: !error, file: done?.message || "", error, trigger });
      if (error) await logAlert("backup_failed", error);
      job.running = false; job.ok = !error; job.error = error;
    })().catch((e) => { job.running = false; job.ok = false; job.error = e.message; });
    return { running: true };
  }
  async function testRemote(input) {
    const cur = await backupSettings();
    const b = validateBackup({ remote: { ...input, enabled: true } }, cur);
    const r = await uploadBackup(b.remote, null, { timeout: 30_000 });
    if (!r.ok) throw new UserError(`Connexion impossible : ${r.error}`);
    return { ok: true, listing: r.listing };
  }
  let restoreJob = null;
  async function restoreBackup(file) {
    const f = backupPath(file) || (/^upload-[0-9a-f]{12}\.tar\.gz$/.test(file) ? path.join(VAR, "staging", file) : null);
    if (!f || !fs.existsSync(f)) throw new UserError("Sauvegarde introuvable.");
    if (restoreJob?.running) throw new UserError("Une restauration est déjà en cours.");
    restoreJob = { running: true, steps: [] };
    const job = restoreJob;
    runConfigure(["restore", f], { timeout: 1_800_000 }).then((r) => { job.steps = r.lines; job.running = false; job.ok = r.lines.some((l) => l.step === "termine" && l.status === "ok"); if (!job.ok) job.error = sysError(r, "Restauration impossible").message; });
    return { running: true };
  }
  const restoreStatus = () => restoreJob || { running: false };
  async function stageUpload(stream) {
    const dir = path.join(VAR, "staging");
    fs.mkdirSync(dir, { recursive: true });
    const name = `upload-${crypto.randomBytes(6).toString("hex")}.tar.gz`;
    const file = path.join(dir, name);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file, { mode: 0o640 });
      stream.pipe(out); out.on("finish", resolve); out.on("error", reject); stream.on("error", reject);
    });
    const head = Buffer.alloc(2); const fd = fs.openSync(file, "r"); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (head[0] !== 0x1f || head[1] !== 0x8b) { fs.rmSync(file, { force: true }); throw new UserError("Ce fichier n'est pas une sauvegarde Callikoe (.tar.gz)."); }
    return { file: name, size: fs.statSync(file).size };
  }

  // ---------------------------------------------------------------- Mises à jour
  async function getUpdates({ check = false } = {}) {
    const st = installState();
    const cur = { version: readVersion(), commit: st.COMMIT || "", ref: st.REF || "main", repo: st.REPO || "Yoobabab/PBXMaison-install", installed_at: st.INSTALLED_AT || "", changelog: readChangelog() };
    let available = await db.getSetting("update_check", null);
    if (check) {
      try {
        const h = { "user-agent": "Callikoe", accept: "application/vnd.github+json" };
        const c = await fetch(`https://api.github.com/repos/${cur.repo}/commits/${encodeURIComponent(cur.ref)}`, { headers: h, signal: AbortSignal.timeout(10_000) });
        if (!c.ok) throw new Error(`GitHub ${c.status}`);
        const j = await c.json();
        const raw = (f) => fetch(`https://raw.githubusercontent.com/${cur.repo}/${j.sha}/${f}`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : ""));
        const [version, changelog] = await Promise.all([raw("VERSION"), raw("CHANGELOG.md")]);
        available = { checked_at: new Date().toISOString(), commit: j.sha, date: j.commit?.committer?.date, message: String(j.commit?.message || "").split("\n")[0].slice(0, 200), version: version.trim() || "?", changelog };
        await db.setSetting("update_check", available);
      } catch (e) {
        available = { ...(available || {}), checked_at: new Date().toISOString(), error: `Vérification impossible : ${e.message}` };
      }
    }
    const upToDate = available?.commit && cur.commit ? available.commit === cur.commit : null;
    return { current: cur, available, up_to_date: upToDate };
  }
  async function startUpdate() {
    const st = installState();
    const r = await runConfigure(["update", st.REF || "main"], { timeout: 30_000 });
    if (!r.lines[0]?.ok) throw sysError(r, "Mise à jour impossible");
    return { running: true };
  }
  async function updateStatus() {
    const r = await runConfigure(["update-status"], { timeout: 20_000 });
    return r.lines[0] || { running: false, done: false, log: [], error: r.err.trim().slice(0, 200) };
  }

  // ---------------------------------------------------------------- Licence
  async function getLicense() {
    const env = pbxEnv(), st = installState();
    const [users, calls, trunks] = await Promise.all([pbx.loadUsers(), pbx.listCalls().catch(() => ({ calls: [] })), pbx.listTrunks()]);
    const exp = env.PBX_LICENSE_EXPIRES ? new Date(env.PBX_LICENSE_EXPIRES) : null;
    return {
      key: env.PBX_LICENSE_KEY || "", edition: env.PBX_EDITION || "", max_calls: Number(env.PBX_MAX_CALLS) || 0,
      expires_at: env.PBX_LICENSE_EXPIRES || "", days_left: exp && !isNaN(exp) ? Math.ceil((exp - Date.now()) / 86400_000) : null,
      pbx: { id: env.PBX_ID || "", name: env.PBX_NAME || "", company: env.PBX_COMPANY || "", fqdn: env.PBX_FQDN || "", admin_email: env.PBX_ADMIN_EMAIL || "" },
      usage: { users: users.length, calls: calls.calls?.length || 0, trunks: trunks.length },
      system: { version: readVersion(), commit: (st.COMMIT || "").slice(0, 7), os: st.OS_NAME || "", installed_at: st.INSTALLED_AT || "" },
    };
  }

  // ---------------------------------------------------------------- Capture réseau (pcap pour Wireshark)
  const CAP_DIR = path.join(VAR, "captures");
  const capPath = (name) => /^capture-\d{8}-\d{6}-(sip|all)\.pcap$/.test(String(name || "")) ? path.join(CAP_DIR, name) : null;
  async function listCaptures() {
    const st = (await runConfigure(["capture", "status"], { timeout: 15_000 })).lines[0] || { running: false };
    let files = [];
    try {
      files = fs.readdirSync(CAP_DIR).filter((f) => capPath(f)).map((f) => {
        const s2 = fs.statSync(path.join(CAP_DIR, f));
        let ready = true; try { fs.accessSync(path.join(CAP_DIR, f), fs.constants.R_OK); } catch { ready = false; }
        return { name: f, size: s2.size, at: s2.mtime.toISOString(), mode: f.includes("-all.") ? "all" : "sip", ready, calls: ready ? captureCalls(f) : [] };
      }).sort((x, y) => y.name.localeCompare(x.name));
    } catch { /* pas encore de capture */ }
    return { running: !!st.running, files };
  }
  // Un fichier par appel (SIP + audio de l'appel), préparé une fois la capture terminée
  const callsDir = (name) => path.join(CAP_DIR, name.replace(/\.pcap$/, ".appels"));
  function captureCalls(name) {
    const dir = callsDir(name), idx = path.join(dir, "index.json");
    try { return JSON.parse(fs.readFileSync(idx, "utf8")).calls; } catch { /* pas encore découpée */ }
    try { return splitPcapFile(path.join(CAP_DIR, name), dir); } catch { return []; }
  }
  function captureCallFile(name, call) {
    if (!capPath(name) || !/^appel-\d{2,3}-[A-Za-z0-9+_-]+-vers-[A-Za-z0-9+_-]+\.pcap$/.test(String(call || ""))) throw Object.assign(new UserError("Capture introuvable."), { status: 404 });
    const f = path.join(callsDir(name), call);
    if (!fs.existsSync(f)) throw Object.assign(new UserError("Capture introuvable."), { status: 404 });
    return f;
  }
  async function startCapture({ seconds = 60, mode = "sip" } = {}) {
    const secs = Number(seconds);
    if (!Number.isInteger(secs) || secs < 5 || secs > 600) throw new UserError("Durée : entre 5 et 600 secondes.", "seconds");
    const r = await runConfigure(["capture", "start", String(secs), mode === "all" ? "all" : "sip"], { timeout: 60_000 });
    const res = r.lines[0];
    if (!res?.ok) throw new UserError(res?.error || sysError(r, "Capture impossible").message);
    return res;
  }
  async function stopCapture() { await runConfigure(["capture", "stop"], { timeout: 20_000 }); return listCaptures(); }
  function captureFile(name) {
    const f = capPath(name);
    if (!f || !fs.existsSync(f)) throw Object.assign(new UserError("Capture introuvable."), { status: 404 });
    return f;
  }
  function deleteCapture(name) { const f = captureFile(name); fs.rmSync(f, { force: true }); fs.rmSync(callsDir(name), { recursive: true, force: true }); return { ok: true }; }

  /** Nouvelle clé de licence (générée par le portail) : vérifiée et appliquée par pbx-configure (root). */
  async function setLicense(token) {
    const t = String(token || "").replace(/\s+/g, "");
    if (!/^CLK1\.[A-Za-z0-9_-]{40,4000}$/.test(t)) throw new UserError("Clé de licence illisible : copie-la en entier depuis le portail (elle commence par CLK1.).", "token");
    const dir = path.join(VAR, "staging");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `license-${crypto.randomBytes(6).toString("hex")}.txt`);
    fs.writeFileSync(file, t, { mode: 0o640 });
    const r = await runConfigure(["license", file], { timeout: 60_000 });
    try { fs.unlinkSync(file); } catch { /* déjà supprimé par pbx-configure */ }
    const res = r.lines[0];
    if (!res?.ok) throw new UserError(res?.error || sysError(r, "Licence non appliquée").message, "token");
    return getLicense();
  }

  // ---------------------------------------------------------------- Alertes
  const alertSettings = () => get("alerts", defaultAlerts());
  async function logAlert(event, text) {
    const [title, severity] = ALERT_EVENTS[event] || [event, "info"];
    const a = await alertSettings();
    if (a.events[event] === false) return;
    await db.query("INSERT INTO pbxmaison_alerts (event, severity, title, text, email) VALUES ($1, $2, $3, $4, $5)",
      [event, severity, title, text, a.recipients.length ? "pending" : "no_recipient"]);
  }
  async function getAlerts() {
    const a = await alertSettings();
    const log = (await db.query("SELECT id, at, event, severity, title, text, email FROM pbxmaison_alerts ORDER BY at DESC LIMIT 200")).rows;
    return { settings: publicAlerts(a), events: ALERT_EVENTS, severity: SEVERITY, log, sending_enabled: smtpReady(a.smtp) };
  }
  async function setAlerts(input) {
    await db.setSetting("alerts", validateAlerts(input, await alertSettings()));
    return getAlerts();
  }
  async function clearAlerts() { await db.query("DELETE FROM pbxmaison_alerts"); return getAlerts(); }

  // ---------------------------------------------------------------- E-mails (serveur d'envoi réglé dans Alertes › Réglages)
  const pbxName = () => pbxEnv().PBX_NAME || pbxEnv().PBX_COMPANY || "Callikoe";
  const tzName = () => pbxEnv().PBX_TIMEZONE || "Europe/Paris";
  async function sendMail(to, mail, attachments = []) {
    const a = await alertSettings();
    if (!smtpReady(a.smtp)) throw new UserError("Serveur d'envoi des e-mails non réglé (Administration › Alertes › Réglages).");
    try {
      await transportOf(a.smtp).sendMail({ from: { name: pbxName(), address: a.smtp.from }, to, subject: mail.subject, text: mail.text, html: mail.html, attachments });
    } catch (e) { throw new UserError(smtpError(e)); }
  }
  async function testMail(to) {
    const addr = String(to || "").trim();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) throw new UserError("Adresse du destinataire invalide.", "to");
    await sendMail(addr, { subject: `Test d'envoi — ${pbxName()}`, text: `Cet e-mail confirme que ${pbxName()} peut envoyer des e-mails (alertes et messages vocaux).`,
      html: `<p style="font-family:Arial,sans-serif">Cet e-mail confirme que <b>${pbxName().replace(/[<>&]/g, "")}</b> peut envoyer des e-mails (alertes et messages vocaux).</p>` });
    return { ok: true };
  }
  // Échec d'envoi signalé dans le journal au plus une fois toutes les 6 heures
  let mailFailAt = 0;
  const mailFailed = async (msg) => {
    if (Date.now() - mailFailAt < 6 * 3600_000) return;
    mailFailAt = Date.now();
    await db.query("INSERT INTO pbxmaison_alerts (event, severity, title, text, email) VALUES ('mail_failed', 'warning', 'Envoi d''e-mail en échec', $1, 'failed')", [msg]).catch(() => {});
  };
  /** Alertes en attente → e-mail aux destinataires (celles de plus d'une heure ne partent plus) */
  async function sendAlerts() {
    const a = await alertSettings();
    if (!smtpReady(a.smtp) || !a.recipients.length) return;
    await db.query("UPDATE pbxmaison_alerts SET email = 'skipped' WHERE email = 'pending' AND at < now() - interval '1 hour'");
    const r = await db.query("SELECT id, at, title, text, severity FROM pbxmaison_alerts WHERE email = 'pending' ORDER BY at LIMIT 10");
    for (const al of r.rows) {
      try { await sendMail(a.recipients, alertMail({ ...al, pbxName: pbxName(), tz: tzName() })); await db.query("UPDATE pbxmaison_alerts SET email = 'sent' WHERE id = $1", [al.id]); }
      catch (e) { await db.query("UPDATE pbxmaison_alerts SET email = 'failed' WHERE id = $1", [al.id]); await mailFailed(e.message); return; }
    }
  }
  /** Nouveaux messages vocaux → e-mail à l'utilisateur (option de sa fiche), puis effacés du répondeur si demandé */
  /** IA : transcrit et résume les nouveaux messages vocaux (pour le softphone, l'appli et l'e-mail) */
  async function aiVoicemails() {
    if (!ai) return;
    const st = await ai.settings();
    if (!st.enabled || !st.voicemail) return;
    let budget = 10;   // messages par passage, au plus
    for (const u of (await pbx.loadUsers()).filter((x) => x.voicemail.enabled && !x.options.disabled)) {
      const todo = vmbox.listMessages(u.id).filter((m) => m.folder === "new" && m.at && Date.now() - Date.parse(m.at) < 2 * 3600_000);
      if (!todo.length) continue;
      const known = await ai.insights(u.id);
      for (const m of todo) {
        const key = vmKey(u.id, m);
        if (known.has(key) || budget-- <= 0) continue;
        try { await ai.voicemailInsight(u.id, key, vmbox.audioPath(u.id, m.id).file, m); }
        catch (e) { if (e.status === 429 || e.status === 403 || e.status === 502) return; }   // plafond, IA coupée, relais injoignable : on réessaie plus tard
      }
    }
    await db.query("DELETE FROM pbxmaison_vm_ai WHERE at < now() - interval '90 days'");
  }
  // ---------------------------------------------------------------- Rapport mensuel envoyé au client (aux couleurs du partenaire)
  const REPORT_DEFAULT = { enabled: false, recipients: [], signature: "", ai: true };
  const reportSettings = () => get("report", REPORT_DEFAULT);
  async function setReportSettings(input) {
    const cur = await reportSettings();
    const list = (Array.isArray(input.recipients) ? input.recipients : String(input.recipients ?? cur.recipients.join(",")).split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    for (const r of list) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r)) throw new UserError(`Adresse invalide : ${r}`, "recipients");
    const next = { ...cur, recipients: [...new Set(list)].slice(0, 10), signature: String(input.signature ?? cur.signature).replace(/[<>\r\n]/g, " ").trim().slice(0, 80),
      enabled: input.enabled !== undefined ? !!input.enabled : cur.enabled, ai: input.ai !== undefined ? !!input.ai : cur.ai };
    if (next.enabled && !next.recipients.length) throw new UserError("Indique au moins un destinataire du rapport.", "recipients");
    await db.setSetting("report", next);
    return { ...next, last: await db.getSetting("report_last", null) };
  }
  async function buildMonthlyReport({ previous = true } = {}) {
    const st = await reportSettings();
    const cur = periodOf("month", Date.now(), { previous }), prev = periodOf("month", Date.parse(cur.from) - 1000);
    const { calls } = await pbx.callLog({ days: 75, limit: 5000 });
    const names = new Map((await pbx.listExtensions()).map((u) => [u.id, u.name]));
    const stats = periodStats(calls, { from: cur.from, to: cur.to, tz: tzName(), names }), before = periodStats(calls, { from: prev.from, to: prev.to, tz: tzName(), names });
    let synthesis = "";
    if (st.ai && ai && (await ai.settings()).enabled) {
      try { synthesis = await ai.text("report", reportInput("month", cur.label, stats, before)); } catch { /* rapport sans analyse */ }
    }
    const theme = (() => { try { return readTheme(THEME_DIR); } catch { return { color: "#d8141c" }; } })();
    const logo = (() => { try { const f = theme.logo ? assetFile("logo", THEME_DIR) : null; return f?.type && f.type !== "image/svg+xml" ? f : null; } catch { return null; } })();
    const mail = monthlyReportMail({ label: cur.label, stats, prev: before, synthesis, pbxName: pbxName(), brand: { color: theme.color, logoCid: logo ? "logo@callikoe" : "", signature: st.signature } });
    return { mail, label: cur.label, attachments: logo ? [{ filename: `logo.${logo.type.split("/")[1]}`, content: logo.buf, contentType: logo.type, cid: "logo@callikoe" }] : [] };
  }
  async function sendMonthlyReport({ to = null, force = false } = {}) {
    const st = await reportSettings();
    const r = await buildMonthlyReport();
    const dest = to ? [to] : st.recipients;
    if (!dest.length) throw new UserError("Aucun destinataire pour le rapport.", "recipients");
    await sendMail(dest, r.mail, r.attachments);
    if (!to && !force) await db.setSetting("report_last", { label: r.label, at: new Date().toISOString(), to: dest });
    return { ok: true, label: r.label, to: dest };
  }
  async function reportTick() {
    const st = await reportSettings();
    if (!st.enabled || !st.recipients.length || !smtpReady((await alertSettings()).smtp)) return;
    const now = new Date(), local = new Date(now.toLocaleString("en-US", { timeZone: tzName() }));
    if (local.getDate() !== 1 || local.getHours() < 8) return;   // le 1er du mois, à partir de 8 h
    const label = periodOf("month", Date.now(), { previous: true }).label;
    if ((await db.getSetting("report_last", null))?.label === label) return;
    await sendMonthlyReport().catch((e) => mailFailed(`Rapport mensuel : ${e.message}`));
  }
  /** Anti-fraude intelligent : appels sortants comparés aux habitudes du PBX (toutes les 5 minutes) */
  async function fraudWatch() {
    const { calls } = await pbx.callLog({ days: 30, direction: "out", limit: 5000 });
    for (const sig of fraudSignals(calls, { cc: pbx.countryCode(), tz: tzName() })) {
      const r = await db.query(`INSERT INTO pbxmaison_watch (key, kind, category, extension, text, detail) VALUES ($1, 'anomaly', $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
        [`fraud:${sig.key}`, sig.kind, sig.extension, sig.text, sig.detail]);
      if (r.rowCount) await logAlert("fraud_ai", sig.text);
    }
  }
  async function sendVoicemails() {
    const a = await alertSettings();
    if (!smtpReady(a.smtp)) return;
    const users = (await pbx.loadUsers()).filter((u) => u.voicemail.enabled && u.voicemail.email && u.email && !u.options.disabled);
    if (!users.length) return;
    const keyOf = (u, m) => vmKey(u.id, m);
    const aiOn = ai ? await ai.settings().then((x) => x.enabled && x.voicemail) : false;
    for (const u of users) {
      const list = vmbox.listMessages(u.id).map((m) => ({ ...m, key: keyOf(u, m) }));
      if (!list.length) continue;
      const done = new Set((await db.query("SELECT key FROM pbxmaison_vm_mailed WHERE box = $1", [u.id])).rows.map((x) => x.key));
      const todo = messagesToMail(list, done);
      for (const m of todo) {
        // IA : transcription et résumé dans l'e-mail (si le relais ne répond pas, l'e-mail part quand même, sans)
        let insight = null;
        if (aiOn) { try { insight = await ai.voicemailInsight(u.id, m.key, vmbox.audioPath(u.id, m.id).file, m); } catch { /* sans résumé */ } }
        const mail = voicemailMail({ box: u.id, boxName: displayName(u), caller: m.caller_number, callerName: m.caller_name, at: m.at, duration: m.duration, pbxName: pbxName(), tz: tzName(), attach: u.voicemail.email_attach, insight });
        let attachments = [];
        if (u.voicemail.email_attach) {
          const f = vmbox.audioPath(u.id, m.id);
          const local = m.at ? new Date(m.at).toLocaleString("sv-SE", { timeZone: tzName() }).slice(0, 16).replace(/[: ]/g, "-") : "message";
          attachments = [{ filename: `message-${local}${f.type === "audio/wav" ? ".wav" : ".gsm"}`, path: f.file, contentType: f.type }];
        }
        try { await sendMail(u.email, mail, attachments); } catch (e) { await mailFailed(`Message vocal de ${u.id} : ${e.message}`); return; }
        await db.query("INSERT INTO pbxmaison_vm_mailed (key, box) VALUES ($1, $2) ON CONFLICT DO NOTHING", [m.key, u.id]);
      }
      // Effacés du répondeur (après envoi en pièce jointe) : un par un, la liste est renumérotée à chaque suppression
      if (u.voicemail.email_delete && u.voicemail.email_attach && todo.length) {
        const sent = new Set(todo.map((m) => m.key));
        for (let i = 0; i < 50; i++) {
          const m = vmbox.listMessages(u.id).find((x) => sent.has(keyOf(u, x)));
          if (!m) break;
          try { vmbox.deleteMessage(u.id, m.id); } catch { break; }
        }
        ami.connect().then(() => ami.send({ Action: "VoicemailRefresh", Context: "default", Mailbox: u.id })).catch(() => {});
      }
    }
    await db.query("DELETE FROM pbxmaison_vm_mailed WHERE at < now() - interval '30 days'");
  }

  // Serveur multi-tenant : le moteur de CE PBX (callikoe-asterisk@<client>) et l'aiguilleur SIP commun
  const TENANT = process.env.CX_MODE === "tenant" ? (process.env.CX_TENANT || "") : "";
  const SERVICES = TENANT ? { ...CRITICAL_SERVICES, kamailio: "Aiguilleur SIP" } : CRITICAL_SERVICES;
  const unitOf = (n) => (TENANT && n === "asterisk" ? `callikoe-asterisk@${TENANT}` : n);
  const activeServices = () => new Promise((resolve) => {
    const names = Object.keys(SERVICES);
    execFile("systemctl", ["is-active", ...names.map(unitOf)], { timeout: 5000 }, (err, stdout) => {
      const lines = String(stdout || "").trim().split("\n");
      if (lines.length !== names.length) return resolve({});
      resolve(Object.fromEntries(names.map((n, i) => [n, lines[i] === "active"])));
    });
  });
  let monitorState = null;
  async function monitor() {
    const prev = monitorState || {};
    const a = await alertSettings();
    const state = { disk_threshold: a.disk_threshold };
    try { state.trunks = (await pbx.listTrunks()).filter((t) => t.status.code !== "Unknown" || t.status.label !== "Moteur injoignable").map((t) => ({ id: t.id, registered: t.status.code === "Registered" })); } catch { /* base indisponible */ }
    try { const s = fs.statfsSync(VAR); state.disk = { pct: Math.round(100 * (1 - s.bavail / s.blocks)) }; } catch { /* statfs indisponible */ }
    state.services = await activeServices();
    const f2b = await f2bStatus().catch(() => null);
    if (f2b?.ok) state.banned = f2b.auto;
    try {
      const since = prev.lastCdr || new Date(Date.now() - 60_000).toISOString();
      const r = await db.query(`SELECT calldate AT TIME ZONE 'UTC' AS at, dst, channel FROM cdr WHERE dst = ANY($1) AND calldate > ($2::timestamptz AT TIME ZONE 'UTC') ORDER BY calldate`, [EMERGENCY, since]);
      state.emergencies = r.rows.map((x) => ({ dst: x.dst, src: /PJSIP\/(\d{3})/.exec(x.channel)?.[1] || "", at: new Date(x.at).toLocaleString("fr-FR", { timeZone: pbxEnv().PBX_TIMEZONE || "Europe/Paris" }) }));
      state.lastCdr = r.rows.length ? new Date(r.rows.at(-1).at).toISOString() : since;
    } catch { state.lastCdr = prev.lastCdr; }
    try {
      const gws = await pbx.loadGateways();
      const reg = await pbx.registrations();
      state.gateways = gws.filter((g) => g.ports.length).map((g) => ({ id: g.id, name: g.name, online: g.ports.some((p) => (reg.get(p.user) || []).length) }));
    } catch { /* idem */ }
    // Plafond anti-fraude atteint (noté par Asterisk) + ménage des compteurs de plus de 2 jours
    try {
      const out = (await ami.command("database show callikoe_fraud")).join("\n");
      const m = /\/callikoe_fraud\/last\s*:\s*(\d+)\|([^|\s]*)\|(\S*)/.exec(out);
      if (m && prev.fraudLast !== undefined && m[1] !== prev.fraudLast) {
        await logAlert("fraud", `Appel vers ${m[2]} depuis ${m[3] || "?"} refusé : plafond d'appels externes atteint. Vérifie le journal des appels : si ce n'est pas normal, quelqu'un utilise peut-être un compte piraté.`);
      }
      state.fraudLast = m ? m[1] : "";
      if (!prev.rateCleaned || Date.now() - prev.rateCleaned > 6 * 3600_000) {
        const keep = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
        for (const l of await ami.command("database show callikoe_rate")) {
          const k = /\/callikoe_rate\/([hi])(\d{8})(\d{0,2})/.exec(l);
          if (k && k[2] < keep) await ami.command(`database del callikoe_rate ${k[1]}${k[2]}${k[3]}`);
        }
        state.rateCleaned = Date.now();
      } else state.rateCleaned = prev.rateCleaned;
    } catch { state.fraudLast = prev.fraudLast; state.rateCleaned = prev.rateCleaned; }
    const lic = await getLicense().catch(() => null);
    state.license_days = lic?.days_left ?? null;
    const last = await db.getSetting("backup_last", null);
    state.backup_error = last && !last.ok ? last.error : "";
    const { alerts, since } = detectAlerts(state, prev, Date.now());
    if (!monitorState) {
      // Premier passage : on mémorise l'état sans alerter pour ce qui existait déjà
      monitorState = { ...state, since };
      for (const al of alerts.filter((x) => x.event === "emergency")) await logAlert(al.event, al.text);
      return;
    }
    monitorState = { ...state, since };
    for (const al of alerts) await logAlert(al.event, al.text);
  }

  // ---------------------------------------------------------------- Passerelles et DECT
  async function listGateways() {
    const [gws, users, reg] = await Promise.all([pbx.loadGateways(), pbx.loadUsers(), pbx.registrations()]);
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      gateways: gws.map((g) => {
        const m = GATEWAY_MODELS.find((x) => x.id === g.model);
        return { ...g, model_label: m?.label || g.model, prov: m?.prov || "manual", beta: m?.status === "beta", max_ports: m?.ports || 0,
          ports: g.ports.map((p) => ({ ...p, name: byId.has(p.user) ? displayName(byId.get(p.user)) : "?", online: (reg.get(p.user) || []).length > 0 })),
          online: g.ports.some((p) => (reg.get(p.user) || []).length > 0), admin_password: undefined, has_admin_password: !!g.admin_password };
      }),
      models: GATEWAY_MODELS, types: GATEWAY_TYPES,
      users: users.map((u) => ({ id: u.id, name: displayName(u) })),
    };
  }
  async function saveGateway(id, input) {
    const gws = await pbx.loadGateways();
    const users = await pbx.loadUsers();
    const phonesMac = (await db.query("SELECT id, phone->>'mac' AS mac FROM pbxmaison_extensions WHERE coalesce(phone->>'mac', '') <> ''")).rows;
    const macOwners = new Map([...phonesMac.map((r) => [r.mac, `téléphone du poste ${r.id}`]), ...gws.filter((g) => g.mac && g.id !== id).map((g) => [g.mac, `« ${g.name} »`])]);
    const usedPorts = new Map();
    for (const g of gws) if (g.id !== id) for (const p of g.ports) usedPorts.set(p.user, `« ${g.name} »`);
    const g = validateGateway(input, { users: new Set(users.map((u) => u.id)), macOwners, selfId: id, usedPorts });
    if (id) {
      const i = gws.findIndex((x) => x.id === id);
      if (i < 0) throw new UserError("Appareil introuvable.");
      gws[i] = { ...gws[i], ...g, id };
    } else gws.push({ ...g, id: crypto.randomBytes(5).toString("hex"), admin_password: crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 12), created_at: new Date().toISOString() });
    await db.setSetting("gateways", gws);
    return listGateways();
  }
  async function deleteGateway(id) {
    await db.setSetting("gateways", (await pbx.loadGateways()).filter((g) => g.id !== id));
    return listGateways();
  }
  async function gatewaySetup(id, server) {
    const g = (await pbx.loadGateways()).find((x) => x.id === id);
    if (!g) throw new UserError("Appareil introuvable.");
    const m = GATEWAY_MODELS.find((x) => x.id === g.model);
    const { text, accounts } = await pbx.gatewayConfig(g, server);
    return {
      gateway: { id: g.id, name: g.name, model: m?.label, mac: g.mac }, admin_password: g.admin_password,
      provisioning: text ? { url: await pbx.provisioningUrl(server), file: m.prov === "gs-ht" ? `cfg${g.mac || "<mac>"}.xml` : m.prov === "snom-dect" ? `${g.mac || "<mac>"}.xml` : `${g.mac || "<mac>"}.cfg`, beta: m.status === "beta" } : null,
      guide: manualGuide(g, { host: server.host }), server: server.host,
      accounts: accounts.map((a) => ({ port: a.index, user: a.user, name: a.name, auth_id: a.auth_id, password: a.password })),
      text,
    };
  }

  // ---------------------------------------------------------------- État du système (tableau de bord)
  const dirSize = (dir) => {
    let bytes = 0;
    const walk = (p) => { let l; try { l = fs.readdirSync(p, { withFileTypes: true }); } catch { return; } for (const e of l) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { try { bytes += fs.statSync(f).size; } catch { /* supprimé */ } } } };
    walk(dir); return bytes;
  };
  async function getSystem() {
    const [b, last, upd, svc, cdr] = await Promise.all([backupSettings(), db.getSetting("backup_last", null), db.getSetting("update_check", null), activeServices(),
      db.query("SELECT pg_total_relation_size('cdr') AS bytes, count(*)::int AS n, min(calldate) AS oldest FROM cdr").then((r) => r.rows[0]).catch(() => null)]);
    let disk = null;
    try { const st = fs.statfsSync(VAR); disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; } catch { /* indisponible */ }
    const st = installState();
    return {
      updates: { current: readVersion(), commit: st.COMMIT || "", checked_at: upd?.checked_at || null, up_to_date: upd?.commit && st.COMMIT ? upd.commit === st.COMMIT : null, available: upd?.version || null },
      backup: { schedule: b.schedule, hour: b.hour, remote: b.remote.enabled ? b.remote.host : "", last },
      recordings: recordingUsage(), voicemail: { bytes: dirSize(process.env.PBXM_VM_SPOOL || "/var/spool/asterisk/voicemail") },
      cdr: cdr ? { bytes: Number(cdr.bytes), calls: cdr.n, oldest: cdr.oldest } : null,
      // Multi-tenant : le disque est celui de tout le serveur, il n'est pas montré dans la console d'un client
      disk: TENANT ? null : disk, tenant: !!TENANT, services: Object.entries(SERVICES).map(([id, label]) => ({ id, label, active: svc[id] ?? null })),
    };
  }
  async function firewallCheck() {
    const r = await runConfigure(["firewall-check"], { timeout: 20_000 });
    return r.lines[0] || { ok: false, error: "Vérification impossible." };
  }
  async function systemAction(action) {
    const r = await runConfigure([action], { timeout: 120_000 });
    const done = r.lines.find((l) => l.step === "termine");
    if (!done) throw sysError(r, "Action impossible");
    return { ok: true, message: done.message };
  }
  async function purgeCdr(days) {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 30) throw new UserError("Garde au moins 30 jours de journal.");
    const r = await db.query("DELETE FROM cdr WHERE calldate < (now() AT TIME ZONE 'UTC') - make_interval(days => $1)", [d]);
    return { deleted: r.rowCount };
  }

  // ---------------------------------------------------------------- Tâches de fond
  function start() {
    const tick = (fn, ms) => setInterval(() => { if (isConfigured()) fn().catch((e) => console.error(e.message)); }, ms).unref();
    tick(pollStatusCodes, 4000);
    tick(() => pbx.pollForwardCodes(), 4000);
    tick(() => pbx.pollStandard(), 3000);
    tick(monitor, 30_000);
    tick(async () => {
      const b = await backupSettings();
      const last = await db.getSetting("backup_last", null);
      if (backupDue(b, last?.trigger === "schedule" ? last.at : null) && !backupJob?.running) await runBackup("schedule");
    }, 60_000);
    tick(async () => { const r = await recording(); purgeRecordings(r.retention_days); }, 6 * 3600_000);
    tick(aiVoicemails, 20_000);
    tick(fraudWatch, 5 * 60_000);
    tick(reportTick, 30 * 60_000);
    tick(sendVoicemails, 15_000);
    tick(sendAlerts, 30_000);
    refreshAllow().catch(() => {});
  }

  return {
    migrate, start, dialplanParts, testMail, vmKey, reportSettings, setReportSettings, buildMonthlyReport, sendMonthlyReport, consoleAllowed, refreshAllow,
    listOutbound, saveOutbound, deleteOutbound, orderOutbound,
    getSecurity, setSecurity, banIp,
    getRecording, setRecording, listRecordings, recordingFile, deleteRecording,
    getShortcodes, setShortcodes, pollStatusCodes,
    getBackups, setBackups, runBackup, testRemote, restoreBackup, restoreStatus, stageUpload,
    getUpdates, startUpdate, updateStatus, getLicense, setLicense, listCaptures, startCapture, stopCapture, captureFile, captureCallFile, deleteCapture,
    getAlerts, setAlerts, clearAlerts, logAlert, monitor,
    listGateways, saveGateway, deleteGateway, gatewaySetup,
    getSystem, firewallCheck, systemAction, purgeCdr,
  };
}

export { REC_DIR };
