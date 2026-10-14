/**
 * Administration du PBX : règles sortantes, sécurité, enregistrements, codes raccourcis, sauvegardes,
 * mises à jour, licence, alertes, passerelles et bases DECT.
 * S'appuie sur le service téléphonique (pbx.mjs) et sur pbx-configure (sudo) pour les actions système.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { APP_DIR, CONFIGURE_CMD, VAR, installState, pbxEnv, isConfigured } from "./config.mjs";
import { UserError, displayName } from "./users.mjs";
import { validateRule, describeRule, buildOutboundDialplan, rangesText, CID_MODES } from "./outbound.mjs";
import { defaultSecurity, validateSecurity, buildSecurityDialplan, securityGlobals, ipAllowed, checkIp, COUNTRIES } from "./security.mjs";
import { defaultShortcodes, validateShortcodes, buildShortcodesDialplan, shortcodesList } from "./shortcodes.mjs";
import { defaultRecording, validateRecording, recordingGlobals, recordingPath, purgeRecordings, recordingUsage, REC_DIR } from "./recording.mjs";
import { defaultBackup, validateBackup, publicBackup, backupDue, listBackups, backupPath, uploadBackup, BACKUP_DIR, SCHEDULES, PROTOCOLS } from "./backup.mjs";
import { ALERT_EVENTS, SEVERITY, CRITICAL_SERVICES, defaultAlerts, validateAlerts, publicAlerts, detectAlerts } from "./alerts.mjs";
import { GATEWAY_MODELS, GATEWAY_TYPES, validateGateway, manualGuide } from "./devices.mjs";
import { EMERGENCY } from "./pbx.mjs";

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

export function createAdminService({ db, ami, pbx }) {
  const get = async (key, def) => {
    const v = await db.getSetting(key, null);
    return v && typeof v === "object" && !Array.isArray(v) ? { ...def, ...v } : v ?? def;
  };

  async function migrate() {
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_alerts (
      id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), event text NOT NULL, severity text NOT NULL,
      title text NOT NULL, text text NOT NULL, email text NOT NULL DEFAULT 'pending')`);
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
      default_trunk: routes.outbound_trunk, cid_modes: CID_MODES,
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
    const [s, f2b] = await Promise.all([security(), f2bStatus()]);
    return { settings: s, f2b, countries: COUNTRIES };
  }
  async function setSecurity(input, clientIp) {
    const cur = await security();
    const s = validateSecurity(input, cur);
    if (s.console_allow.length && !ipAllowed(clientIp, s.console_allow)) {
      throw new UserError(`Ton adresse actuelle (${clientIp}) n'est pas dans la liste : tu perdrais l'accès à la console.`, "console_allow");
    }
    await db.setSetting("security", s);
    if (input.f2b || input.whitelist) {
      const r = await runConfigure(["f2b", "settings", String(s.f2b.maxretry), String(s.f2b.findtime), String(s.f2b.bantime), s.whitelist.join(",")], { timeout: 30_000 });
      if (r.code !== 0 && r.code !== null) s.f2b_warning = "Réglages enregistrés, mais la protection anti-intrusion n'a pas pu être mise à jour.";
    }
    await pbx.applyDialplan();
    return { ...(await getSecurity()), warning: s.f2b_warning };
  }
  async function banIp(ip, ban) {
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
    return { recordings: list.slice(0, 1000), total: list.length };
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
  const shortcodes = () => get("shortcodes", defaultShortcodes());
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
    return { settings: publicAlerts(a), events: ALERT_EVENTS, severity: SEVERITY, log, sending_enabled: false };
  }
  async function setAlerts(input) {
    await db.setSetting("alerts", validateAlerts(input, await alertSettings()));
    return getAlerts();
  }
  async function clearAlerts() { await db.query("DELETE FROM pbxmaison_alerts"); return getAlerts(); }

  const activeServices = () => new Promise((resolve) => {
    const names = Object.keys(CRITICAL_SERVICES);
    execFile("systemctl", ["is-active", ...names], { timeout: 5000 }, (err, stdout) => {
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

  // ---------------------------------------------------------------- Tâches de fond
  function start() {
    const tick = (fn, ms) => setInterval(() => { if (isConfigured()) fn().catch((e) => console.error(e.message)); }, ms).unref();
    tick(pollStatusCodes, 4000);
    tick(monitor, 30_000);
    tick(async () => {
      const b = await backupSettings();
      const last = await db.getSetting("backup_last", null);
      if (backupDue(b, last?.trigger === "schedule" ? last.at : null) && !backupJob?.running) await runBackup("schedule");
    }, 60_000);
    tick(async () => { const r = await recording(); purgeRecordings(r.retention_days); }, 6 * 3600_000);
    refreshAllow().catch(() => {});
  }

  return {
    migrate, start, dialplanParts, consoleAllowed, refreshAllow,
    listOutbound, saveOutbound, deleteOutbound, orderOutbound,
    getSecurity, setSecurity, banIp,
    getRecording, setRecording, listRecordings, recordingFile, deleteRecording,
    getShortcodes, setShortcodes, pollStatusCodes,
    getBackups, setBackups, runBackup, testRemote, restoreBackup, restoreStatus, stageUpload,
    getUpdates, startUpdate, updateStatus, getLicense,
    getAlerts, setAlerts, clearAlerts, logAlert, monitor,
    listGateways, saveGateway, deleteGateway, gatewaySetup,
  };
}

export { REC_DIR };
