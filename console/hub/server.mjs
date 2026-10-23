/**
 * Console du serveur multi-tenant Callikoe (comme Omada) : comptes IRT avec rôles, liste et recherche des PBX clients,
 * création d'un PBX, passage d'un PBX à l'autre sans se reconnecter.
 * Écoute en local (127.0.0.1:8800) derrière Nginx (https://<adresse du serveur>:8822), utilisateur système « callikoe-hub ».
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import qrcode from "qrcode-generator";
import pg from "pg";
import { hashPassword, verifyPassword, passwordProblem, createSession, readSession, createToken, readToken,
  newTotpSecret, verifyTotp, otpauthUri, newRecoveryCodes, recoveryHash } from "../lib/auth.mjs";
import { signTicket, emailKey, HUB_USERS, TENANTS } from "../lib/sso.mjs";
import { canonicalJson, verifySignature } from "../../pbx/lib/verify-config.mjs";
import { encodeToken } from "../../pbx/lib/license-token.mjs";
import { listServerMusic, addServerMusic, removeServerMusic, renameServerMusic, serverMusicFile, SERVER_MUSIC_MAX } from "../lib/music.mjs";
import { registerThemeRoutes, readTheme, brandingLock, setBrandingLock, writeTheme, saveAsset, removeAsset, saveWalls, removeWalls, WALL_SIZES, PALETTE, DEFAULT_THEME, ASSETS, shades, hexToHsl } from "../lib/theme.mjs";

const ETC = process.env.HUB_ETC || "/etc/callikoe/hub";
const VAR = process.env.HUB_VAR || "/var/lib/callikoe/hub";
const HOST_CMD = (process.env.HUB_HOST_CMD || "sudo -n /opt/pbxmaison/pbx/bin/callikoe-host").split(" ");
const SERVER_CONFIG = process.env.HUB_SERVER_CONFIG || "/etc/callikoe/server-config.json";
const SIGN_KEY = path.join(VAR, "portal-key.pem");   // clé privée du portail (signature des licences des PBX créés ici)
const TRUSTED = process.env.HUB_TRUSTED_KEYS || (fs.existsSync("/etc/callikoe/trusted-key.pem") ? "/etc/callikoe/trusted-key.pem" : "/opt/pbxmaison/pbx/portal-public-key.pem");
const DNS_API = process.env.PBXM_DNS_API || "https://api.callikoe.fr";
const MANAGED = ["callikoe.fr", "callikoe.com"];
const isManaged = (f) => MANAGED.some((d) => String(f || "").endsWith("." + d));
export const EDITIONS = { basic: "Basic", pro: "Essentiel", enterprise: "Intégral" };
export const SC = [2, 4, 8, 16, 24, 32, 48, 64, 96, 128];
export const COUNTRIES = [
  { code: "FR", name: "France", dial: "33", tz: "Europe/Paris" }, { code: "BE", name: "Belgique", dial: "32", tz: "Europe/Brussels" },
  { code: "CH", name: "Suisse", dial: "41", tz: "Europe/Zurich" }, { code: "LU", name: "Luxembourg", dial: "352", tz: "Europe/Luxembourg" },
  { code: "MC", name: "Monaco", dial: "377", tz: "Europe/Monaco" }, { code: "CA", name: "Canada", dial: "1", tz: "America/Toronto" },
];
export const TIMEZONES = ["Europe/Paris", "Europe/Brussels", "Europe/Zurich", "Europe/Luxembourg", "Europe/Monaco", "America/Toronto",
  "America/Guadeloupe", "America/Martinique", "America/Cayenne", "Indian/Reunion", "Indian/Mayotte", "Pacific/Noumea", "Pacific/Tahiti"];
export const LANGUAGES = { fr: "Français", en: "English" };
export const DURATIONS = { 1: "1 mois (test)", 12: "1 an", 24: "2 ans", 36: "3 ans" };
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function licenseKey() {
  const body = [...crypto.randomBytes(12)].map((b) => ALPHABET[b & 31]).join("");
  const h = crypto.createHash("sha256").update(`PBXM:${body}`).digest();
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  let sum = ""; for (let i = 3; i >= 0; i--) sum += ALPHABET[(bits >> (i * 5)) & 31];
  return ["PBXM", ...body.match(/.{4}/g), sum].join("-");
}
function normalizePhone(input, dial) {
  let s = String(input || "").trim().replace(/[\s.\-()/]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2); else if (s.startsWith("0")) s = "+" + dial + s.slice(1); else if (!s.startsWith("+")) return null;
  if (!/^\+\d{8,15}$/.test(s)) return null;
  if (s.startsWith("+33") && !/^\+33[1-9]\d{8}$/.test(s)) return null;
  return s;
}
const isFqdn = (f) => f.length <= 253 && f.split(".").length >= 2 && f.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) && !/^\d+$/.test(f.split(".").at(-1));
const fingerprint = (pubKey) => { const x = pubKey.export({ format: "jwk" }).x; const h = crypto.createHash("sha256").update(Buffer.from(x, "base64url")).digest();
  return [...h.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(":").toUpperCase(); };
const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) { console.error("SESSION_SECRET manquant"); process.exit(1); }

export const ROLES = {
  super: "Super administrateur (tout, y compris les comptes)",
  admin: "Administrateur (crée, configure et supprime les PBX)",
  tech: "Technicien (configure les PBX)",
  lecture: "Lecture seule",
};
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
class UserError extends Error { constructor(msg, field, status = 400) { super(msg); this.field = field; this.status = status; } }
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const serverConfig = () => readJson(SERVER_CONFIG, {});
const qrSvg = (text) => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };

export async function buildApp({ db } = {}) {
  db ??= new pg.Pool({ host: "127.0.0.1", port: Number(process.env.HUB_DB_PORT || 5432), user: "callikoe_hub", database: "callikoe_hub", password: process.env.HUB_DB_PASSWORD || "", max: 5 });
  await db.query(`
    CREATE TABLE IF NOT EXISTS hub_users (email text PRIMARY KEY, name text NOT NULL DEFAULT '', role text NOT NULL, password_hash text,
      totp_secret text, totp_last_step bigint NOT NULL DEFAULT 0, recovery jsonb NOT NULL DEFAULT '[]', created_by text,
      created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz);
    CREATE TABLE IF NOT EXISTS hub_invites (token_hash text PRIMARY KEY, email text NOT NULL, name text NOT NULL DEFAULT '', role text NOT NULL,
      created_by text, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_audit (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), email text, ip text, action text, ok boolean, detail text);
  `);
  // Rôles publiés pour les consoles des PBX (empreinte de l'e-mail → rôle) : retrait d'un compte = accès coupé partout
  async function publishUsers() {
    const rows = (await db.query("SELECT email, role FROM hub_users WHERE totp_secret IS NOT NULL")).rows;
    const out = Object.fromEntries(rows.map((r) => [emailKey(r.email), r.role]));
    fs.writeFileSync(`${HUB_USERS}.new`, JSON.stringify(out), { mode: 0o644 });
    fs.renameSync(`${HUB_USERS}.new`, HUB_USERS);
  }
  await publishUsers();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "warn" }, trustProxy: "127.0.0.1", bodyLimit: 262_144 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, "public"), index: ["index.html"] });
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, "..", "public"), prefix: "/c/", decorateReply: false, allowedPath: (p) => /^\/?(style\.css|phone\/callikoe-v3-\d+x\d+\.png)$/.test(p) });
  registerThemeRoutes(app);

  const COOKIE = "cxhub_session";
  const cookieOpts = (req) => ({ path: "/", httpOnly: true, sameSite: "lax", secure: req.protocol === "https", maxAge: 12 * 3600 });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-frame-options", "DENY"); reply.header("x-content-type-options", "nosniff"); reply.header("referrer-policy", "same-origin");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UserError || err.status) return reply.code(err.status || 400).send({ error: err.message, field: err.field });
    if (err.validation || (err.statusCode >= 400 && err.statusCode < 500)) return reply.code(err.statusCode || 400).send({ error: "Requête invalide." });
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur interne. Détail dans le journal du serveur." });
  });

  const currentUser = (req) => readSession(req.cookies[COOKIE], SESSION_SECRET);
  const audit = (req, action, ok = true, detail = "", email = currentUser(req)?.email || "") =>
    db.query("INSERT INTO hub_audit (email, ip, action, ok, detail) VALUES ($1, $2, $3, $4, $5)", [email, String(req.ip || ""), action, ok, String(detail).slice(0, 300)]).catch(() => {});
  const userCount = async () => Number((await db.query("SELECT count(*) FROM hub_users WHERE totp_secret IS NOT NULL")).rows[0].count);
  const requireUser = async (req, reply) => {
    const u = currentUser(req);
    if (!u?.mfa) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." });
    const row = (await db.query("SELECT role FROM hub_users WHERE email = $1 AND totp_secret IS NOT NULL", [u.email])).rows[0];
    if (!row) { reply.clearCookie(COOKIE, { path: "/" }); return reply.code(401).send({ error: "Ce compte n'existe plus." }); }
    req.role = row.role; req.email = u.email;
    if (row.role === "lecture" && req.method !== "GET" && !/^\/api\/logout/.test(req.url)) return reply.code(403).send({ error: "Compte en lecture seule : modification impossible." });
  };
  const requireRole = (...roles) => async (req, reply) => {
    const r = await requireUser(req, reply); if (r) return r;
    if (!roles.includes(req.role)) return reply.code(403).send({ error: "Ton rôle ne permet pas cette action." });
  };
  // Code de double authentification redemandé pour les actions destructrices
  const checkCode = async (req) => {
    const row = (await db.query("SELECT totp_secret, totp_last_step FROM hub_users WHERE email = $1", [req.email])).rows[0];
    const step = row && verifyTotp(row.totp_secret, req.body?.code, Number(row.totp_last_step));
    if (step === null || step === undefined) { await audit(req, "Code de confirmation refusé", false); throw new UserError("Code de double authentification incorrect.", "code", 401); }
    await db.query("UPDATE hub_users SET totp_last_step = $2 WHERE email = $1", [req.email, step]);
  };

  // ---------------------------------------------------------------- Première connexion (jeton affiché par l'installeur)
  const TOKEN_FILE = path.join(VAR, "setup-token");
  const setupTokenOk = (t) => {
    let v; try { v = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return false; }
    const a = Buffer.from(String(t || "")), b = Buffer.from(v);
    return v.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const requireSetup = async (req, reply) => {
    if ((await userCount()) === 0 && setupTokenOk(req.headers["x-setup-token"])) return;
    return reply.code(403).send({ error: "Lien d'installation invalide : utilise l'adresse affichée à la fin de l'installation." });
  };
  let pendingSetupTotp = null;
  app.post("/api/setup/totp", { preHandler: requireSetup }, async () => {
    const email = String(serverConfig().admin?.email || "").toLowerCase();
    if (!email) throw new UserError("Configuration du serveur absente (relance l'installeur avec --serveur).");
    pendingSetupTotp ||= newTotpSecret();
    const uri = otpauthUri(pendingSetupTotp, email, `Callikoe ${serverConfig().pbx?.name || "serveur"}`);
    return { email, secret: pendingSetupTotp, uri, qr: qrSvg(uri) };
  });
  app.post("/api/setup/admin", { preHandler: requireSetup }, async (req, reply) => {
    const email = String(serverConfig().admin?.email || "").toLowerCase();
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new UserError(problem, "password");
    if (!pendingSetupTotp) throw new UserError("Scanne d'abord le QR code de double authentification.", "totp_code");
    const step = verifyTotp(pendingSetupTotp, req.body?.totp_code);
    if (step === null) throw new UserError("Code incorrect : tape le code à 6 chiffres affiché par Psono (ou ton application).", "totp_code");
    const rec = newRecoveryCodes();
    await db.query(`INSERT INTO hub_users (email, name, role, password_hash, totp_secret, totp_last_step, recovery, last_login_at)
      VALUES ($1, $2, 'super', $3, $4, $5, $6, now()) ON CONFLICT (email) DO NOTHING`,
      [email, String(req.body?.name || "").slice(0, 80), hashPassword(req.body.password), pendingSetupTotp, step, JSON.stringify(rec.hashes)]);
    pendingSetupTotp = null;
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* déjà retiré */ }
    await publishUsers();
    await audit(req, "Création du compte super administrateur du serveur", true, "", email);
    reply.setCookie(COOKIE, createSession(email, SESSION_SECRET, { mfa: true }), cookieOpts(req));
    return { ok: true, email, recovery_codes: rec.codes };
  });

  // ---------------------------------------------------------------- Connexion
  const failures = new Map();
  const tooMany = (ip) => { const f = failures.get(ip); return f && f.count >= 5 && f.until > Date.now(); };
  const fail = (ip) => { const f = failures.get(ip); const fresh = !f || f.until < Date.now(); failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60_000 }); };
  app.get("/api/state", async (req) => {
    const sc = serverConfig(), u = currentUser(req);
    const row = u?.mfa ? (await db.query("SELECT email, name, role FROM hub_users WHERE email = $1 AND totp_secret IS NOT NULL", [u.email])).rows[0] : null;
    return { server: { name: sc.pbx?.name || "Serveur Callikoe", fqdn: sc.pbx?.fqdn || "" }, setup_needed: (await userCount()) === 0,
      user: row ? { ...row, role_label: ROLES[row.role] } : null, roles: ROLES };
  });
  app.post("/api/login", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const r = await db.query("SELECT password_hash FROM hub_users WHERE email = $1 AND totp_secret IS NOT NULL", [email]);
    if (!r.rowCount || !verifyPassword(req.body?.password, r.rows[0].password_hash)) {
      fail(req.ip); await audit(req, "Connexion refusée : mauvais mot de passe", false, "", email);
      return reply.code(401).send({ error: "E-mail ou mot de passe incorrect." });
    }
    return { need_totp: true, ticket: createToken({ email, mfa_ticket: 1 }, SESSION_SECRET, 0.1) };
  });
  app.post("/api/login/totp", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const t = readToken(req.body?.ticket, SESSION_SECRET);
    if (!t?.mfa_ticket) return reply.code(401).send({ error: "Délai dépassé : reconnecte-toi." });
    const row = (await db.query("SELECT totp_secret, totp_last_step, recovery FROM hub_users WHERE email = $1", [t.email])).rows[0];
    const code = String(req.body?.code || "").trim();
    let ok = false;
    const step = row && verifyTotp(row.totp_secret, code, Number(row.totp_last_step));
    if (step !== null && step !== undefined) { ok = true; await db.query("UPDATE hub_users SET totp_last_step = $2 WHERE email = $1", [t.email, step]); }
    else if (row && code.length > 6) {
      const h = recoveryHash(code), list = row.recovery || [];
      if (list.includes(h)) { ok = true; await db.query("UPDATE hub_users SET recovery = $2 WHERE email = $1", [t.email, JSON.stringify(list.filter((x) => x !== h))]); await audit(req, "Code de secours utilisé", true, `${list.length - 1} restant(s)`, t.email); }
    }
    if (!ok) { fail(req.ip); await audit(req, "Connexion refusée : mauvais code de double authentification", false, "", t.email); return reply.code(401).send({ error: "Code incorrect." }); }
    failures.delete(req.ip);
    await db.query("UPDATE hub_users SET last_login_at = now() WHERE email = $1", [t.email]);
    reply.setCookie(COOKIE, createSession(t.email, SESSION_SECRET, { mfa: true }), cookieOpts(req));
    await audit(req, "Connexion à la console du serveur", true, "", t.email);
    return { ok: true, email: t.email };
  });
  app.post("/api/logout", async (req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });

  // ---------------------------------------------------------------- PBX clients
  const isActive = (unit) => new Promise((res) => execFile("systemctl", ["is-active", unit], (e, out) => res(String(out || "").trim() || "inconnu")));
  let etatCache = { at: 0, data: null };
  const etat = () => new Promise((res) => {
    if (etatCache.data && Date.now() - etatCache.at < 8000) return res(etatCache.data);
    execFile(HOST_CMD[0], [...HOST_CMD.slice(1), "etat"], { timeout: 30_000, maxBuffer: 4 << 20 }, (e, out) => {
      let d = null; try { d = JSON.parse(String(out || "").trim().split("\n").pop()); } catch { d = null; }
      if (d) etatCache = { at: Date.now(), data: d };
      res(d || etatCache.data);
    });
  });
  app.get("/api/pbx", { preHandler: requireUser }, async () => {
    const d = await etat();
    const reg = readJson(TENANTS, {}).tenants || [];
    const list = d?.pbx || await Promise.all(reg.map(async (t) => ({ slug: t.slug, n: t.n, name: t.name, fqdn: t.fqdn, created_at: t.created_at, suspended: !!t.suspended,
      engine: await isActive(`callikoe-asterisk@${t.slug}`), console: await isActive(`callikoe-console@${t.slug}`) })));
    const now = Date.now();
    const sum = (k) => list.reduce((a, p) => a + (Number(p[k]) || 0), 0);
    const totals = {
      pbx: list.length,
      online: list.filter((p) => !p.suspended && p.engine === "active").length,
      offline: list.filter((p) => !p.suspended && p.engine !== "active").length,
      suspended: list.filter((p) => p.suspended).length,
      calls: sum("calls"), max_calls: sum("max_calls"),
      phones: sum("phones"), phones_online: sum("phones_online"),
      trunks: sum("trunks"), trunks_ok: sum("trunks_ok"),
      expiring: list.filter((p) => p.expires_at && Date.parse(p.expires_at) - now < 30 * 86400000).length,
    };
    return { pbx: list, totals, max: 250, signing: signingInfo(), watch_pending: await watchPending() };
  });
  app.post("/api/pbx/:slug/suspendre", { preHandler: requireRole("super", "admin") }, async (req) => {
    if (!SLUG_RE.test(req.params.slug)) throw new UserError("PBX inconnu.", null, 404);
    etatCache.at = 0;
    return runHost(["suspendre", req.params.slug], `Désactivation du PBX ${req.params.slug}`, req);
  });
  app.post("/api/pbx/:slug/reactiver", { preHandler: requireRole("super", "admin") }, async (req) => {
    if (!SLUG_RE.test(req.params.slug)) throw new UserError("PBX inconnu.", null, 404);
    if (await licenseRevoked(req.params.slug)) throw new UserError("La licence de ce PBX a été supprimée : attribue-lui d'abord une licence disponible (menu Licences), puis réactive-le.");
    etatCache.at = 0;
    return runHost(["reactiver", req.params.slug], `Réactivation du PBX ${req.params.slug}`, req);
  });

  // ---------------------------------------------------------------- Surveillance : appels étranger / surtaxés, changements d'adresse des appareils
  const hostJson = (args, timeout = 60_000) => new Promise((res) => execFile(HOST_CMD[0], [...HOST_CMD.slice(1), ...args], { timeout, maxBuffer: 32 << 20 },
    (e, o, err) => { try { res({ ok: !e, data: JSON.parse(String(o || "").trim().split("\n").pop()) }); } catch { res({ ok: false, error: String(err || o || "").replace(/\x1b\[[0-9;]*m/g, "").trim() }); } }));
  let watchCache = { at: 0, pending: 0 };
  const watchPending = async () => {
    if (Date.now() - watchCache.at < 60_000) return watchCache.pending;
    watchCache.at = Date.now();
    const r = await hostJson(["surveillance", "liste", "30"]);
    if (r.ok) watchCache.pending = r.data.events.filter((e) => !e.reviewed_at).length;
    return watchCache.pending;
  };
  app.get("/api/surveillance", { preHandler: requireUser }, async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query?.days) || 30));
    const r = await hostJson(["surveillance", "liste", String(days)]);
    if (!r.ok) throw new UserError("Surveillance illisible : réessaie dans un instant.");
    watchCache = { at: Date.now(), pending: r.data.events.filter((e) => !e.reviewed_at && Date.parse(e.at) > Date.now() - 30 * 86400_000).length };
    return r.data;
  });
  app.post("/api/surveillance/ok", { preHandler: requireRole("super", "admin", "tech") }, async (req) => {
    const slug = String(req.body?.pbx || ""), id = String(req.body?.id || "");
    if (!SLUG_RE.test(slug) || !/^\d+$/.test(id)) throw new UserError("Événement inconnu.");
    const who = currentUser(req).email;
    const r = await hostJson(["surveillance", "ok", slug, id, who]);
    if (!r.ok) throw new UserError("Impossible d'enregistrer la vérification.");
    watchCache.at = 0;
    await audit(req, `Surveillance : événement ${id} de ${slug} vérifié`, true, String(req.body?.text || "").slice(0, 200));
    return { ok: true };
  });

  // ---------------------------------------------------------------- Protection anti-intrusion (fail2ban, commune à tous les PBX)
  app.get("/api/protection", { preHandler: requireUser }, async () => {
    const r = await hostJson(["protection", "etat"], 20_000);
    if (!r.ok) throw new UserError("Réglages de la protection illisibles.");
    return r.data;
  });
  app.post("/api/protection", { preHandler: requireRole("super", "admin") }, async (req) => {
    const n = (k, min, max, label) => { const v = Number(req.body?.[k]); if (!Number.isInteger(v) || v < min || v > max) throw new UserError(`${label} : entre ${min} et ${max}.`, k); return v; };
    const mx = n("maxretry", 2, 50, "Échecs autorisés"), fi = n("findtime", 1, 1440, "Fenêtre (min)"), ba = n("bantime", 1, 525600, "Blocage (min)");
    const wl = [...new Set((Array.isArray(req.body?.whitelist) ? req.body.whitelist : []).map((x) => String(x).trim()).filter(Boolean))];
    for (const a of wl) if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(a)) throw new UserError(`Adresse invalide : ${a} (IPv4, éventuellement avec /masque).`, "whitelist");
    if (wl.length > 100) throw new UserError("100 adresses au maximum dans la liste blanche.", "whitelist");
    const r = await hostJson(["protection", "regler", String(mx), String(fi), String(ba), wl.join(",") || "-"], 60_000);
    await audit(req, `Protection anti-intrusion : ${mx} échecs en ${fi} min → blocage ${ba} min`, r.ok, wl.length ? `liste blanche : ${wl.join(", ")}` : "");
    if (!r.ok) throw new UserError(r.error?.replace(/^✖\s*/, "") || "Réglage impossible.");
    return r.data;
  });

  // ---------------------------------------------------------------- Pays autorisés pour la téléphonie
  app.get("/api/pays", { preHandler: requireUser }, async () => {
    const r = await hostJson(["pays", "etat"], 20_000);
    if (!r.ok) throw new UserError("État du filtre des pays illisible.");
    return r.data;
  });
  app.post("/api/pays", { preHandler: requireRole("super", "admin") }, async (req) => {
    const countries = [...new Set((Array.isArray(req.body?.countries) ? req.body.countries : []).map((c) => String(c).toUpperCase()))].filter((c) => /^[A-Z]{2}$/.test(c));
    const always = [...new Set((Array.isArray(req.body?.always) ? req.body.always : String(req.body?.always || "").split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean))];
    for (const a of always) if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(a)) throw new UserError(`Adresse invalide : ${a} (IPv4, éventuellement avec /masque).`, "always");
    if (countries.length > 80 || always.length > 100) throw new UserError("Trop de pays ou d'adresses.");
    const r = await hostJson(["pays", "regler", countries.join(",") || "-", always.join(",") || "-"], 180_000);
    await audit(req, `Pays autorisés pour la téléphonie : ${countries.join(", ") || "tous"}`, r.ok, always.length ? `toujours : ${always.join(", ")}` : "");
    if (!r.ok) throw new UserError(r.error?.replace(/^✖\s*/, "") || "Réglage impossible.");
    return r.data;
  });

  // ---------------------------------------------------------------- Journal de la téléphonie (aiguilleur SIP, adresses bloquées)
  const IP_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]{2,39})$/;
  app.get("/api/telephonie", { preHandler: requireUser }, async (req) => {
    const min = Math.min(43200, Math.max(5, Number(req.query?.minutes) || 60));
    const out = await new Promise((res) => execFile(HOST_CMD[0], [...HOST_CMD.slice(1), "journal", String(min)], { timeout: 90_000, maxBuffer: 32 << 20 }, (e, o) => res(String(o || ""))));
    let d; try { d = JSON.parse(out.trim().split("\n").pop()); } catch { throw new UserError("Journal de la téléphonie illisible : réessaie dans un instant."); }
    return { ...d, client_ip: req.ip };
  });
  for (const action of ["debloquer", "bloquer"]) {
    app.post(`/api/telephonie/${action}`, { preHandler: requireRole("super", "admin") }, async (req) => {
      const ip = String(req.body?.ip || "").trim();
      if (!IP_RE.test(ip)) throw new UserError("Adresse IP invalide.", "ip");
      const r = await new Promise((res) => execFile(HOST_CMD[0], [...HOST_CMD.slice(1), action, ip], { timeout: 30_000 }, (e, o, err) => res({ ok: !e, text: String(o || err || "").replace(/\x1b\[[0-9;]*m/g, "").trim() })));
      await audit(req, `${action === "bloquer" ? "Blocage" : "Déblocage"} de l'adresse ${ip}`, r.ok, r.ok ? "" : r.text.slice(0, 200));
      if (!r.ok) throw new UserError(r.text.replace(/^✖\s*/, "") || "Action impossible.");
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- Apparence : couleur, logo, fond d'écran (console du serveur et tous ses PBX)
  // Thème enregistré (même quand l'option Marque blanche manque : il revient dès qu'elle est réactivée)
  const rawTheme = () => readTheme(undefined, { raw: true });
  // Serveur d'un partenaire : personnalisation réservée à l'option Marque blanche (portail pro)
  const brandingInfo = () => { const lock = brandingLock(); return { locked: !!lock, until: lock?.until || portalBranding?.until || null, price_ht: lock?.price_ht ?? portalBranding?.price_ht ?? null, order_url: lock?.order_url || portalBranding?.order_url || "" }; };
  const brandingGuard = () => { if (brandingLock()) throw new UserError("Personnalisation réservée à l'option Marque blanche : commande-la dans le portail pro (menu Marque blanche)."); };
  const themeView = () => { const t = rawTheme(); return { branding: brandingInfo(), theme: t, palette: PALETTE, default: DEFAULT_THEME.color, shades: shades(t.color), wall_sizes: WALL_SIZES,
    limits: Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [k, { max: v.max, types: v.types }])) }; };
  app.get("/api/theme", { preHandler: requireUser }, async () => themeView());
  app.put("/api/theme", { preHandler: requireRole("super", "admin") }, async (req) => {
    brandingGuard();
    const color = String(req.body?.color || "").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color) || !hexToHsl(color)) throw new UserError("Couleur invalide.", "color");
    const t = rawTheme();
    try { writeTheme({ ...t, color }); } catch { throw new UserError("Thème non enregistré : dossier du thème non accessible (relance la mise à jour du serveur)."); }
    await audit(req, "Apparence : couleur changée", true, color);
    return themeView();
  });
  app.post("/api/theme/reset", { preHandler: requireRole("super", "admin") }, async (req) => {
    for (const k of Object.keys(ASSETS)) removeAsset(k);
    removeWalls();
    writeTheme({ ...DEFAULT_THEME });
    await audit(req, "Apparence : thème Callikoe rétabli");
    return themeView();
  });
  // IA › fonds musicaux des annonces : ceux fournis d'office (portail) + ceux ajoutés ici, proposés à tous les PBX du serveur
  app.get("/api/music", { preHandler: requireUser }, async () => {
    let catalog = [], catalog_error = "";
    try {
      const r = await fetch(`${(process.env.HUB_PORTAL_URL || "https://portail.callikoe.fr").replace(/\/+$/, "")}/v1/ai/music-catalog`, { signal: AbortSignal.timeout(8000) });
      catalog = (await r.json()).music || [];
    } catch { catalog_error = "Portail injoignable : liste des musiques fournies d'office indisponible pour le moment."; }
    return { catalog, catalog_error, server: listServerMusic(), max: SERVER_MUSIC_MAX };
  });
  app.get("/api/music/:id/audio", { preHandler: requireUser }, async (req, reply) => {
    const f = serverMusicFile(req.params.id);
    if (!f) throw new UserError("Fond musical inconnu.", null, 404);
    return reply.type("audio/wav").header("cache-control", "private, max-age=3600").send(fs.createReadStream(f));
  });
  app.register(async (scope) => {
    scope.addContentTypeParser("audio/wav", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (req, body, done) => done(null, body));
    scope.post("/api/music", { preHandler: requireRole("super", "admin"), bodyLimit: 1024 * 1024 }, async (req) => {
      let m;
      try { m = addServerMusic(String(req.query?.name || ""), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)); } catch (e) { throw new UserError(e.message); }
      await audit(req, `IA : fond musical « ${m.name} » ajouté`);
      return m;
    });
  });
  app.put("/api/music/:id", { preHandler: requireRole("super", "admin") }, async (req) => {
    try { return renameServerMusic(req.params.id, req.body?.name); } catch (e) { throw new UserError(e.message); }
  });
  app.delete("/api/music/:id", { preHandler: requireRole("super", "admin") }, async (req) => {
    const m = listServerMusic().find((x) => x.id === req.params.id);
    try { removeServerMusic(req.params.id); } catch (e) { throw new UserError(e.message); }
    await audit(req, `IA : fond musical « ${m?.name || req.params.id} » retiré`);
    return { ok: true };
  });
  // Fonds d'écran des téléphones de bureau : dessinés par la page Apparence (couleur + logo), une image par taille d'écran
  app.register(async (scope) => {
    scope.post("/api/theme/walls", { preHandler: requireRole("super", "admin"), bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    brandingGuard();
      try { saveWalls(req.body?.images || {}); } catch (e) { throw new UserError(e.message); }
      writeTheme({ ...rawTheme(), walls: Date.now() });
      await audit(req, "Apparence : fonds d'écran des téléphones mis à jour");
      return themeView();
    });
  });
  app.delete("/api/theme/walls", { preHandler: requireRole("super", "admin") }, async (req) => {
    removeWalls(); writeTheme({ ...rawTheme(), walls: null });
    return themeView();
  });
  app.register(async (scope) => {
    scope.addContentTypeParser(["application/octet-stream", "image/png", "image/jpeg", "image/webp", "image/svg+xml"], { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 + 1 }, (req, body, done) => done(null, body));
    scope.post("/api/theme/:kind", { preHandler: requireRole("super", "admin"), bodyLimit: 4 * 1024 * 1024 + 1 }, async (req) => {
    brandingGuard();
      const kind = req.params.kind;
      if (!ASSETS[kind]) throw new UserError("Fichier inconnu.", null, 404);
      try { saveAsset(kind, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)); } catch (e) { throw new UserError(e.message, kind); }
      writeTheme({ ...rawTheme(), [kind]: true });
      await audit(req, kind === "logo" ? "Apparence : logo importé" : "Apparence : fond d'écran importé");
      return themeView();
    });
  });
  app.delete("/api/theme/:kind", { preHandler: requireRole("super", "admin") }, async (req) => {
    const kind = req.params.kind;
    if (!ASSETS[kind]) throw new UserError("Fichier inconnu.", null, 404);
    removeAsset(kind); writeTheme({ ...rawTheme(), [kind]: null });
    await audit(req, kind === "logo" ? "Apparence : logo retiré" : "Apparence : fond d'écran retiré");
    return themeView();
  });

  // ---------------------------------------------------------------- Clé de signature (licences des PBX créés sur ce serveur)
  let signKey = null;
  const loadSignKey = () => { try { signKey = crypto.createPrivateKey(fs.readFileSync(SIGN_KEY)); } catch { signKey = null; } return signKey; };
  loadSignKey();
  // Serveur d'un partenaire (configuration signée avec le jeton du portail pro) : licences achetées dans le portail, signées par lui
  const partnerCfg = () => { const p = serverConfig().partner; return p?.token && /^https:\/\//.test(p.portal || "") || (p?.token && process.env.HUB_PORTAL_URL) ? p : null; };
  const portalMode = () => !signKey && !!partnerCfg();
  let portalBranding = null;
  // Serveur qui signe lui-même ses licences (installateur) : jamais de verrou Marque blanche
  if (!portalMode() && brandingLock()) { try { setBrandingLock(null); } catch { /* */ } }
  const portalUrl = () => process.env.HUB_PORTAL_URL || partnerCfg()?.portal || "";
  async function portal(pathname, body) {
    const p = partnerCfg();
    let r; try { r = await fetch(`${portalUrl()}${pathname}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.token}` },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) }); }
    catch { throw new UserError("Portail pro Callikoe injoignable : réessaie dans un instant."); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new UserError(d.error || `Portail pro : erreur ${r.status}.`);
    return d;
  }
  function signingInfo() {
    if (signKey) return { configured: true, fingerprint: fingerprint(crypto.createPublicKey(signKey)) };
    const p = partnerCfg();
    return p ? { configured: true, portal: true, partner: p.name || "", buy_url: `${portalUrl()}/#/acheter`, portal_url: portalUrl() } : { configured: false };
  }
  const sign = (obj) => { const { signature, ...rest } = obj; return { ...rest, signature: crypto.sign(null, Buffer.from(canonicalJson(rest)), signKey).toString("base64") }; };
  app.get("/api/signing", { preHandler: requireUser }, async () => signingInfo());
  app.post("/api/signing", { preHandler: requireRole("super") }, async (req) => {
    await checkCode(req);
    let key;
    try { key = crypto.createPrivateKey(String(req.body?.pem || "")); } catch { throw new UserError("Ce n'est pas une clé privée valide (fichier pbx-cle-privee.pem).", "pem"); }
    if (key.asymmetricKeyType !== "ed25519") throw new UserError("Clé Ed25519 attendue (fichier pbx-cle-privee.pem du portail).", "pem");
    const probe = { probe: crypto.randomBytes(8).toString("hex") };
    const signed = { ...probe, signature: crypto.sign(null, Buffer.from(canonicalJson(probe)), key).toString("base64") };
    let trusted = ""; try { trusted = fs.readFileSync(TRUSTED, "utf8"); } catch { trusted = ""; }
    if (!verifySignature(signed, trusted)) throw new UserError(`Cette clé (empreinte ${fingerprint(crypto.createPublicKey(key))}) n'est pas reconnue par les PBX : utilise la clé d'IRT.`, "pem");
    fs.writeFileSync(`${SIGN_KEY}.new`, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.renameSync(`${SIGN_KEY}.new`, SIGN_KEY);
    loadSignKey();
    await audit(req, "Clé de signature des licences installée", true, signingInfo().fingerprint);
    return signingInfo();
  });

  // ---------------------------------------------------------------- Licences : liste, création, renouvellement, attribution, suppression
  // Une licence = numéro + édition + appels simultanés + expiration. Attribuée à un PBX (slug) ou disponible.
  // Supprimer une licence attribuée la révoque : le PBX est désactivé et ne peut plus être réactivé sans une autre licence.
  await db.query(`CREATE TABLE IF NOT EXISTS hub_licenses (key text PRIMARY KEY, edition text NOT NULL, simultaneous_calls int NOT NULL,
    expires_at timestamptz NOT NULL, slug text, pbx_id text, note text NOT NULL DEFAULT '', origin text NOT NULL DEFAULT 'hub',
    created_at timestamptz NOT NULL DEFAULT now(), created_by text, renewed_at timestamptz, assigned_at timestamptz, revoked_at timestamptz, revoked_by text)`);
  const LIC_RE = /^PBXM(-[A-Z0-9]{4}){4}$/;
  const regTenants = () => readJson(TENANTS, {}).tenants || [];
  // Rapproche la table des PBX réels : licences des PBX existants reprises, licences des PBX supprimés rendues disponibles
  let portalSync = { at: 0, error: "" }, portalEditions = null;
  const edNames = () => (portalMode() && portalEditions ? { ...EDITIONS, ...portalEditions } : EDITIONS);
  const suspending = new Map();
  setInterval(() => { if (portalMode()) syncLicenses(true).catch(() => {}); }, 5 * 60_000).unref();
  async function syncLicenses(force = false) {
    const d = await etat();
    if (portalMode()) return syncPortal(d, force);
    const reg = regTenants(), slugs = new Set(reg.map((t) => t.slug));
    for (const p of d?.pbx || []) {
      if (!LIC_RE.test(p.license || "") || !p.expires_at || isNaN(Date.parse(p.expires_at))) continue;
      const t = reg.find((x) => x.slug === p.slug) || {};
      const cur = (await db.query("SELECT key, revoked_at FROM hub_licenses WHERE key = $1", [p.license])).rows[0];
      if (!cur) await db.query(`INSERT INTO hub_licenses (key, edition, simultaneous_calls, expires_at, slug, pbx_id, origin, assigned_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pbx', now())`, [p.license, p.edition || "pro", Number(p.max_calls) || 1, p.expires_at, p.slug, t.pbx_id || null]);
      else if (!cur.revoked_at) await db.query(`UPDATE hub_licenses SET edition = $2, simultaneous_calls = $3, expires_at = $4, slug = $5, pbx_id = COALESCE($6, pbx_id)
        WHERE key = $1`, [p.license, p.edition || "pro", Number(p.max_calls) || 1, p.expires_at, p.slug, t.pbx_id || null]);
      // Le PBX utilise une autre licence (clé collée à la main) : l'ancienne redevient disponible
      await db.query(`UPDATE hub_licenses SET slug = NULL, pbx_id = NULL, assigned_at = NULL WHERE slug = $1 AND key <> $2 AND revoked_at IS NULL
        AND assigned_at < now() - interval '2 minutes'`, [p.slug, p.license]);
    }
    if (d) for (const r of (await db.query("SELECT key, slug FROM hub_licenses WHERE slug IS NOT NULL AND (assigned_at IS NULL OR assigned_at < now() - interval '15 minutes')")).rows)
      if (!slugs.has(r.slug)) await db.query("UPDATE hub_licenses SET slug = NULL, pbx_id = NULL, assigned_at = NULL WHERE key = $1", [r.key]);
  }
  // Mode portail : licences du partenaire recopiées ici ; licence supprimée dans le portail → PBX désactivé ; renouvellement → envoyé au PBX
  async function syncPortal(d, force) {
    if (!force && Date.now() - portalSync.at < 30_000) return;
    portalSync.at = Date.now();
    if (!d) return;
    const reg = regTenants();
    const pbx = (d.pbx || []).map((p) => ({ slug: p.slug, name: p.name, fqdn: p.fqdn, license: p.license, pbx_id: reg.find((t) => t.slug === p.slug)?.pbx_id || "", suspended: !!p.suspended }));
    let r; try { r = await portal("/v1/hub/sync", { pbx, version: process.env.CX_VERSION || "" }); portalSync.error = ""; }
    catch (e) { portalSync.error = e.message; return; }
    // Option Marque blanche (portail pro) : sans elle, le thème enregistré n'est pas appliqué (consoles, softphone, appli, téléphones)
    if (r.branding && typeof r.branding.active === "boolean") {
      portalBranding = { until: r.branding.until || null, price_ht: Number.isFinite(r.branding.price_ht) ? r.branding.price_ht : null, order_url: /^https:\/\//.test(r.branding.order_url || "") ? r.branding.order_url : "" };
      const was = !!brandingLock();
      try { setBrandingLock(r.branding.active ? null : portalBranding); } catch { /* dossier du thème non accessible */ }
      if (was === !!r.branding.active) await audit({ ip: "portail", cookies: {} }, r.branding.active ? "Option Marque blanche active : thème personnalisé appliqué" : "Option Marque blanche inactive : thème Callikoe appliqué", true, "", "portail").catch(() => {});
    }
    if (r.editions && typeof r.editions === "object") portalEditions = Object.fromEntries(Object.entries(r.editions).filter(([k, v]) => EDITIONS[k] && typeof v === "string").map(([k, v]) => [k, v.slice(0, 30)]));
    const keys = [];
    for (const l of r.licenses || []) {
      if (!LIC_RE.test(l.key)) continue;
      keys.push(l.key);
      const used = (d.pbx || []).find((p) => p.license === l.key);
      const slug = used?.slug || (l.assigned?.here ? l.assigned.slug : null);
      await db.query(`INSERT INTO hub_licenses (key, edition, simultaneous_calls, expires_at, slug, pbx_id, note, origin, revoked_at, assigned_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'portail', $8, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
        ON CONFLICT (key) DO UPDATE SET edition = $2, simultaneous_calls = $3, expires_at = $4, slug = $5, pbx_id = $6, note = $7, origin = 'portail', revoked_at = $8`,
        [l.key, l.edition, l.simultaneous_calls, l.expires_at, slug, slug ? (reg.find((t) => t.slug === slug)?.pbx_id || null) : null, l.note || "", l.revoked_at || null]);
      if (!used) continue;
      const pid = reg.find((t) => t.slug === used.slug)?.pbx_id;
      // Licence supprimée dans le portail : le PBX qui l'utilise est désactivé
      if (l.revoked_at && !used.suspended) {
        if (Date.now() - (suspending.get(used.slug) || 0) < 10 * 60_000) continue;
        suspending.set(used.slug, Date.now());
        runHost(["suspendre", used.slug], `Licence ${l.key} supprimée dans le portail pro : désactivation du PBX ${used.slug}`, { ip: "portail", cookies: {} });
        etatCache.at = 0;
      } else if (!l.revoked_at && pid && (used.expires_at !== l.expires_at || Number(used.max_calls) !== l.simultaneous_calls || used.edition !== l.edition)
        && Date.parse(l.expires_at) > Date.now()) {
        // Licence renouvelée ou changée dans le portail : nouvelle clé signée envoyée au PBX, sans coupure
        try { await pushLicense(used.slug, pid, l); await audit({ ip: "portail", cookies: {} }, `Licence ${l.key} mise à jour depuis le portail pro`, true, `PBX ${used.slug} · jusqu'au ${String(l.expires_at).slice(0, 10)}`, "portail"); }
        catch (e) { await audit({ ip: "portail", cookies: {} }, `Licence ${l.key} : mise à jour du PBX ${used.slug} impossible`, false, e.message, "portail"); }
      }
    }
    // Licences du portail qui ne sont plus dans le compte du partenaire (serveur retiré…) : oubliées si aucun PBX ne les utilise
    await db.query("DELETE FROM hub_licenses WHERE origin = 'portail' AND slug IS NULL AND NOT (key = ANY($1::text[]))", [keys]);
  }
  const licStatus = (l, now = Date.now()) => l.revoked_at ? "revoquee" : Date.parse(l.expires_at) <= now ? "expiree"
    : Date.parse(l.expires_at) - now < 30 * 86400000 ? "bientot" : "valide";
  const licRow = (l) => ({ key: l.key, edition: l.edition, simultaneous_calls: l.simultaneous_calls, expires_at: new Date(l.expires_at).toISOString(),
    slug: l.slug, note: l.note, origin: l.origin, created_at: l.created_at, created_by: l.created_by, renewed_at: l.renewed_at, revoked_at: l.revoked_at,
    status: licStatus(l), available: !l.slug && !l.revoked_at && Date.parse(l.expires_at) > Date.now() });
  const getLic = async (key) => {
    if (!LIC_RE.test(String(key || ""))) throw new UserError("Licence inconnue.", null, 404);
    const l = (await db.query("SELECT * FROM hub_licenses WHERE key = $1", [key])).rows[0];
    if (!l) throw new UserError("Licence inconnue.", null, 404);
    return l;
  };
  const needSign = () => {
    if (portalMode()) throw new UserError("Les licences de ce serveur s'achètent et se renouvellent dans ton portail pro Callikoe (menu Licences › Acheter).");
    if (!signKey) throw new UserError("Installe d'abord la clé de signature des licences (Super administrateur › Clé de signature).");
  };
  const needSigner = () => { if (!signKey && !portalMode()) throw new UserError("Installe d'abord la clé de signature des licences (Super administrateur › Clé de signature)."); };
  const licFields = (b, cur = null) => {
    const edition = String(b.edition ?? cur?.edition ?? "");
    if (!EDITIONS[edition]) throw new UserError("Édition invalide.", "edition");
    const sc = Number(b.simultaneous_calls ?? cur?.simultaneous_calls);
    if (!SC.includes(sc)) throw new UserError("Nombre d'appels simultanés invalide.", "simultaneous_calls");
    const months = Number(b.duration_months ?? 0);
    if (!(cur && months === 0) && !DURATIONS[months]) throw new UserError("Durée invalide.", "duration_months");
    // Renouvellement : la durée s'ajoute à la date d'expiration (ou à aujourd'hui si elle est déjà passée)
    const base = new Date(Math.max(Date.now(), cur ? Date.parse(cur.expires_at) : 0));
    const expires = new Date(base); expires.setUTCMonth(expires.getUTCMonth() + months);
    const note = String(b.note ?? cur?.note ?? "").trim().slice(0, 120);
    return { edition, sc, months, expires, note };
  };
  // Envoie la licence au PBX (clé signée appliquée sans coupure) et met à jour sa copie de configuration signée
  async function pushLicense(slug, pbxId, lic) {
    const pbxName = regTenants().find((t) => t.slug === slug)?.name || slug;
    const tok = portalMode() ? (await portal("/v1/hub/token", { key: lic.key, pbx_id: pbxId, slug, name: pbxName })).token
      : encodeToken(sign({ pbx_id: pbxId, key: lic.key, edition: lic.edition, simultaneous_calls: lic.simultaneous_calls,
        expires_at: new Date(lic.expires_at).toISOString(), issued_at: new Date().toISOString() }));
    const r = await hostJson(["licence", slug, tok]);
    if (!r.ok || !r.data?.ok) throw new UserError(`Le PBX ${slug} n'a pas accepté la licence : ${r.data?.error || r.error || "erreur inconnue"}`);
    const f = path.join(VAR, "configs", `${slug}.json`), cfg = readJson(f, null);
    if (cfg?.license) {
      cfg.license = { ...cfg.license, key: lic.key, edition: lic.edition, simultaneous_calls: lic.simultaneous_calls, expires_at: new Date(lic.expires_at).toISOString() };
      const signed = portalMode() ? await portal("/v1/hub/config", { config: cfg, slug }).then((x) => x.config).catch(() => null) : sign(cfg);
      if (signed) { fs.writeFileSync(`${f}.new`, JSON.stringify(signed, null, 2), { mode: 0o600 }); fs.renameSync(`${f}.new`, f); }
    }
    etatCache.at = 0;
  }
  const pbxIdOf = (slug) => regTenants().find((t) => t.slug === slug)?.pbx_id || "";

  app.get("/api/licenses", { preHandler: requireUser }, async () => {
    await syncLicenses(true).catch(() => {});
    const rows = (await db.query("SELECT * FROM hub_licenses ORDER BY created_at DESC")).rows.map(licRow);
    const d = await etat();
    const pbx = (d?.pbx || regTenants()).map((p) => ({ slug: p.slug, name: p.name, fqdn: p.fqdn, company: p.company || "", suspended: !!p.suspended }));
    return { licenses: rows, pbx, editions: edNames(), sc: SC, durations: DURATIONS, signing: signingInfo(), portal_error: portalMode() ? portalSync.error : "" };
  });
  app.post("/api/licenses", { preHandler: requireRole("super", "admin") }, async (req) => {
    needSign();
    const f = licFields(req.body || {});
    const key = licenseKey();
    await db.query("INSERT INTO hub_licenses (key, edition, simultaneous_calls, expires_at, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [key, f.edition, f.sc, f.expires, f.note, req.email]);
    await audit(req, `Licence créée : ${key} (${EDITIONS[f.edition]}, ${f.sc} appels, ${DURATIONS[f.months]})`, true, f.note || "disponible");
    return licRow((await db.query("SELECT * FROM hub_licenses WHERE key = $1", [key])).rows[0]);
  });
  app.post("/api/licenses/:key/renew", { preHandler: requireRole("super", "admin") }, async (req) => {
    needSign();
    const l = await getLic(req.params.key);
    if (l.revoked_at) throw new UserError("Licence supprimée : crée une nouvelle licence.");
    const f = licFields(req.body || {}, l);
    const next = { key: l.key, edition: f.edition, simultaneous_calls: f.sc, expires_at: f.expires };
    if (l.slug && pbxIdOf(l.slug)) await pushLicense(l.slug, pbxIdOf(l.slug), next);
    await db.query("UPDATE hub_licenses SET edition = $2, simultaneous_calls = $3, expires_at = $4, note = $5, renewed_at = now() WHERE key = $1",
      [l.key, f.edition, f.sc, f.expires, f.note]);
    await audit(req, `Licence renouvelée : ${l.key} (${EDITIONS[f.edition]}, ${f.sc} appels, jusqu'au ${f.expires.toISOString().slice(0, 10)})`, true, l.slug ? `appliquée au PBX ${l.slug}` : "disponible");
    return licRow((await db.query("SELECT * FROM hub_licenses WHERE key = $1", [l.key])).rows[0]);
  });
  // Attribuer une licence disponible à un PBX existant (remplace sa licence actuelle, qui redevient disponible)
  app.post("/api/licenses/:key/assign", { preHandler: requireRole("super", "admin") }, async (req) => {
    needSigner();
    const l = await getLic(req.params.key);
    if (!licRow(l).available) throw new UserError("Cette licence n'est pas disponible (déjà attribuée, expirée ou supprimée).");
    const slug = String(req.body?.slug || "");
    const id = SLUG_RE.test(slug) ? pbxIdOf(slug) : "";
    if (!id) throw new UserError("PBX inconnu.", "slug");
    await pushLicense(slug, id, l);
    await db.query("UPDATE hub_licenses SET slug = NULL, pbx_id = NULL, assigned_at = NULL WHERE slug = $1 AND key <> $2", [slug, l.key]);
    await db.query("UPDATE hub_licenses SET slug = $2, pbx_id = $3, assigned_at = now() WHERE key = $1", [l.key, slug, id]);
    await audit(req, `Licence ${l.key} attribuée au PBX ${slug}`, true, `${EDITIONS[l.edition] || l.edition}, ${l.simultaneous_calls} appels`);
    return licRow((await db.query("SELECT * FROM hub_licenses WHERE key = $1", [l.key])).rows[0]);
  });
  app.delete("/api/licenses/:key", { preHandler: requireRole("super", "admin") }, async (req) => {
    const l = await getLic(req.params.key);
    if (String(req.body?.confirm || "").trim().toUpperCase() !== l.key.slice(-4)) throw new UserError(`Tape les 4 derniers caractères de la licence (${l.key.slice(-4)}) pour confirmer.`, "confirm");
    await checkCode(req);
    if (portalMode() && l.origin === "portail") await portal("/v1/hub/revoke", { key: l.key });
    const live = l.slug && regTenants().some((t) => t.slug === l.slug);
    if (!live) {
      if (portalMode() && l.origin === "portail") await db.query("UPDATE hub_licenses SET revoked_at = now(), revoked_by = $2 WHERE key = $1", [l.key, req.email]);
      else await db.query("DELETE FROM hub_licenses WHERE key = $1", [l.key]);
      await audit(req, `Licence supprimée : ${l.key}`, true, "aucun PBX associé");
      return { ok: true, deleted: true };
    }
    await db.query("UPDATE hub_licenses SET revoked_at = now(), revoked_by = $2 WHERE key = $1", [l.key, req.email]);
    await audit(req, `Licence supprimée : ${l.key}`, true, `PBX ${l.slug} désactivé`);
    etatCache.at = 0;
    return runHost(["suspendre", l.slug], `Licence ${l.key} supprimée : désactivation du PBX ${l.slug}`, req);
  });
  const licenseRevoked = async (slug) => {
    const r = (await db.query("SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS ok, count(*) AS n FROM hub_licenses WHERE slug = $1", [slug])).rows[0];
    return Number(r.n) > 0 && Number(r.ok) === 0;
  };

  // ---------------------------------------------------------------- Création d'un PBX (licence signée ici)
  app.get("/api/pbx/options", { preHandler: requireUser }, async () => ({ editions: edNames(), sc: SC, countries: COUNTRIES, timezones: TIMEZONES,
    languages: LANGUAGES, durations: DURATIONS, domains: MANAGED, signing: signingInfo() }));
  app.get("/api/fqdn-check", { preHandler: requireUser }, async (req) => {
    const fqdn = String(req.query?.fqdn || "").toLowerCase();
    if (!isFqdn(fqdn)) return { available: false, reason: "Adresse invalide." };
    if ((readJson(TENANTS, {}).tenants || []).some((t) => t.fqdn === fqdn)) return { available: false, reason: "Déjà utilisée sur ce serveur." };
    if (!isManaged(fqdn)) return { available: true, custom: true };
    try { const r = await fetch(`${DNS_API}/v1/check?fqdn=${encodeURIComponent(fqdn)}`, { signal: AbortSignal.timeout(8000) }); return await r.json(); }
    catch { return { available: null, reason: "Service d'adresses injoignable." }; }
  });
  app.post("/api/pbx/new", { preHandler: requireRole("super", "admin") }, async (req) => {
    needSigner();
    const b = req.body || {};
    const v = (k) => String(b[k] ?? "").trim();
    const slug = v("slug").toLowerCase();
    if (!SLUG_RE.test(slug)) throw new UserError("Nom sur le serveur : 2 à 24 caractères (minuscules, chiffres, tirets).", "slug");
    if ((readJson(TENANTS, {}).tenants || []).some((t) => t.slug === slug)) throw new UserError("Ce nom est déjà utilisé sur ce serveur.", "slug");
    if (v("name").length < 2 || v("name").length > 80) throw new UserError("Nom du PBX : entre 2 et 80 caractères.", "name");
    if (v("company").length < 2 || v("company").length > 120) throw new UserError("Nom de l'entreprise : entre 2 et 120 caractères.", "company");
    const country = COUNTRIES.find((c) => c.code === v("country"));
    if (!country) throw new UserError("Pays non pris en charge.", "country");
    const phone = normalizePhone(v("phone"), country.dial);
    if (!phone) throw new UserError("Numéro invalide (ex. 04 12 34 56 78).", "phone");
    const fqdn = (v("domain") === "custom" ? v("fqdn") : `${v("label")}.${v("domain")}`).toLowerCase().replace(/\.$/, "");
    if (!isFqdn(fqdn) || (v("domain") !== "custom" && !MANAGED.includes(v("domain")))) throw new UserError("Adresse du PBX invalide.", v("domain") === "custom" ? "fqdn" : "label");
    if ((readJson(TENANTS, {}).tenants || []).some((t) => t.fqdn === fqdn)) throw new UserError("Adresse déjà utilisée sur ce serveur.", "label");
    const email = v("admin_email").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError("Adresse e-mail invalide.", "admin_email");
    if (!TIMEZONES.includes(v("timezone"))) throw new UserError("Fuseau horaire non pris en charge.", "timezone");
    if (!LANGUAGES[v("language")]) throw new UserError("Langue non prise en charge.", "language");
    // Licence : nouvelle (créée ici) ou licence disponible déjà créée (menu Licences)
    let lic = null;
    if (portalMode() && v("license_mode") !== "existing") throw new UserError("Choisis une licence dispo (achetée dans ton portail pro Callikoe).", "license_key");
    if (v("license_mode") === "existing") {
      const l = await getLic(v("license_key")).catch(() => { throw new UserError("Choisis une licence disponible.", "license_key"); });
      if (!licRow(l).available) throw new UserError("Cette licence n'est plus disponible (attribuée, expirée ou supprimée).", "license_key");
      lic = { key: l.key, edition: l.edition, simultaneous_calls: l.simultaneous_calls, expires_at: new Date(l.expires_at).toISOString(), existing: true };
    } else {
      if (!EDITIONS[v("edition")]) throw new UserError("Édition invalide.", "edition");
      const sc = Number(v("simultaneous_calls")); if (!SC.includes(sc)) throw new UserError("Nombre d'appels simultanés invalide.", "simultaneous_calls");
      const months = Number(v("duration_months")); if (!DURATIONS[months]) throw new UserError("Durée invalide.", "duration_months");
      const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + months);
      lic = { key: licenseKey(), edition: v("edition"), simultaneous_calls: sc, expires_at: exp.toISOString(), months };
    }
    const id = crypto.randomUUID(), now = new Date();
    if (isManaged(fqdn)) {
      const resv = portalMode() ? (await portal("/v1/hub/reserve", { fqdn, pbx_id: id })).reserve : sign({ action: "reserve", fqdn, pbx_id: id, ts: now.toISOString() });
      let r; try { r = await fetch(`${DNS_API}/v1/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(resv), signal: AbortSignal.timeout(15000) }); }
      catch { throw new UserError("Service d'adresses injoignable : réessaie dans un instant.", "label"); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new UserError(d.error || "Adresse refusée par le service d'adresses.", "label");
    }
    const raw = { version: 1,
      pbx: { id, name: v("name"), company: v("company"), fqdn, phone, country: country.code, country_code: country.dial, timezone: v("timezone"), language: v("language") },
      admin: { email, password: "set_on_first_login" },
      license: { key: lic.key, edition: lic.edition, simultaneous_calls: lic.simultaneous_calls, expires_at: lic.expires_at },
      issued_at: now.toISOString() };
    const cfg = portalMode() ? (await portal("/v1/hub/config", { config: raw, slug })).config : sign(raw);
    // Copie du fichier de configuration signé (réinstallation, portail) : téléchargeable depuis la console du serveur
    fs.mkdirSync(path.join(VAR, "configs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(VAR, "configs", `${slug}.json`), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    etatCache.at = 0;
    if (lic.existing) {
      await db.query("UPDATE hub_licenses SET slug = $2, pbx_id = $3, assigned_at = now() WHERE key = $1", [lic.key, slug, id]);
      await audit(req, `Licence ${lic.key} attribuée au nouveau PBX ${slug}`, true, `${EDITIONS[lic.edition] || lic.edition}, ${lic.simultaneous_calls} appels`);
    } else {
      await db.query(`INSERT INTO hub_licenses (key, edition, simultaneous_calls, expires_at, slug, pbx_id, note, created_by, assigned_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`, [lic.key, lic.edition, lic.simultaneous_calls, lic.expires_at, slug, id, v("company").slice(0, 120), req.email]);
      await audit(req, `Licence créée : ${lic.key} (${EDITIONS[lic.edition]}, ${lic.simultaneous_calls} appels, ${DURATIONS[lic.months]})`, true, `${slug} · ${fqdn}`);
    }
    // Création ratée avant l'inscription du PBX : licence neuve effacée, licence existante rendue disponible
    return runHost(["creer", slug, Buffer.from(JSON.stringify(cfg)).toString("base64")], `Création du PBX ${slug} (${fqdn})`, req, async (ok) => {
      if (ok || regTenants().some((t) => t.slug === slug)) return;
      if (lic.existing) await db.query("UPDATE hub_licenses SET slug = NULL, pbx_id = NULL, assigned_at = NULL WHERE key = $1 AND slug = $2", [lic.key, slug]);
      else await db.query("DELETE FROM hub_licenses WHERE key = $1 AND slug = $2", [lic.key, slug]);
    });
  });
  // Import d'une sauvegarde de PBX (PBX installé seul, ou PBX supprimé de ce serveur) comme nouveau PBX client
  app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", { bodyLimit: 4 * 1024 ** 3 }, (req, payload, done) => done(null, payload));
    scope.post("/api/pbx/import", { preHandler: requireRole("super", "admin"), bodyLimit: 4 * 1024 ** 3 }, async (req) => {
      const slug = String(req.query?.slug || "").trim().toLowerCase();
      if (!SLUG_RE.test(slug)) throw new UserError("Nom sur le serveur : 2 à 24 caractères (minuscules, chiffres, tirets).", "slug");
      if ((readJson(TENANTS, {}).tenants || []).some((t) => t.slug === slug)) throw new UserError("Ce nom est déjà utilisé sur ce serveur.", "slug");
      const dir = path.join(VAR, "uploads"); fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const file = path.join(dir, `import-${crypto.randomBytes(8).toString("hex")}.tar.gz`);
      await new Promise((resolve, reject) => { const out = fs.createWriteStream(file, { mode: 0o640 }); req.body.pipe(out); out.on("finish", resolve); out.on("error", reject); req.body.on("error", reject); });
      const head = Buffer.alloc(2); const fd = fs.openSync(file, "r"); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
      if (head[0] !== 0x1f || head[1] !== 0x8b) { fs.rmSync(file, { force: true }); throw new UserError("Ce fichier n'est pas une sauvegarde Callikoe (.tar.gz).", "file"); }
      etatCache.at = 0;
      return runHost(["importer", slug, file], `Import du PBX ${slug} depuis une sauvegarde`, req);
    });
  });
  app.get("/api/pbx/:slug/config", { preHandler: requireRole("super", "admin") }, async (req, reply) => {
    if (!SLUG_RE.test(req.params.slug)) throw new UserError("PBX inconnu.", null, 404);
    let txt; try { txt = fs.readFileSync(path.join(VAR, "configs", `${req.params.slug}.json`), "utf8"); } catch { throw new UserError("Fichier de configuration non conservé pour ce PBX.", null, 404); }
    return reply.header("content-disposition", `attachment; filename="pbx-config-${req.params.slug}.json"`).type("application/json").send(txt);
  });

  // Tâches longues (création, suppression) : sortie de callikoe-host suivie par la page
  const jobs = new Map();
  function runHost(args, label, req, onDone = null) {
    const id = crypto.randomBytes(8).toString("hex");
    const job = { id, label, lines: [], running: true, ok: null, started_at: new Date().toISOString() };
    jobs.set(id, job);
    const p = spawn(HOST_CMD[0], [...HOST_CMD.slice(1), ...args], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
    const take = (b) => { for (const l of String(b).split("\n")) { const s = l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(); if (s) job.lines.push(s.slice(0, 300)); } };
    p.stdout.on("data", take); p.stderr.on("data", take);
    p.on("close", async (code) => { job.running = false; job.ok = code === 0; await audit(req, label, job.ok, job.lines.filter((l) => /✖/.test(l)).join(" ").slice(0, 300));
      if (onDone) await onDone(job.ok).catch(() => {}); });
    for (const [k, j] of jobs) if (!j.running && Date.parse(j.started_at) < Date.now() - 3600_000) jobs.delete(k);
    return job;
  }
  app.get("/api/jobs/:id", { preHandler: requireUser }, async (req) => {
    const j = jobs.get(req.params.id); if (!j) throw new UserError("Tâche inconnue.", null, 404); return j;
  });
  app.delete("/api/pbx/:slug", { preHandler: requireRole("super", "admin") }, async (req) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug) || !(readJson(TENANTS, {}).tenants || []).some((t) => t.slug === slug)) throw new UserError("PBX inconnu.", null, 404);
    if (req.body?.confirm !== slug) throw new UserError(`Tape « ${slug} » pour confirmer.`, "confirm");
    await checkCode(req);
    return runHost(["supprimer", slug, "--confirmer"], `Suppression du PBX ${slug}`, req);
  });

  // Ouvrir la console d'un PBX (sans se reconnecter) : ticket signé valable 60 s, pour ce seul PBX
  let ssoKey = null;
  app.get("/ouvrir/:slug", async (req, reply) => {
    const r = await requireUser(req, reply); if (r) return reply.redirect("/");
    const t = (readJson(TENANTS, {}).tenants || []).find((x) => x.slug === req.params.slug);
    if (!t) return reply.code(404).type("text/html").send("PBX introuvable.");
    ssoKey ||= fs.readFileSync(path.join(ETC, "sso-key.pem"), "utf8");
    const ticket = signTicket(ssoKey, { aud: t.slug, email: req.email, role: req.role });
    await audit(req, `Ouverture du PBX ${t.slug}`);
    // Certificat du PBX (dossier lisible par root seulement : état fourni par callikoe-host). Toujours la console d'administration (port 8822).
    const st = (await etat())?.pbx?.find((x) => x.slug === t.slug);
    const tls = st ? !!st.tls : fs.existsSync(`/etc/letsencrypt/live/${t.fqdn}/fullchain.pem`);
    const base = process.env.HUB_PBX_URL_TEMPLATE ? process.env.HUB_PBX_URL_TEMPLATE.replace("{fqdn}", t.fqdn) : tls ? `https://${t.fqdn}:8822` : `http://${t.fqdn}`;
    const page = /^[a-z-]{2,30}$/.test(String(req.query?.page || "")) ? `&page=${req.query.page}` : "";
    return reply.redirect(`${base}/api/sso?t=${encodeURIComponent(ticket)}${page}`);
  });

  // ---------------------------------------------------------------- Comptes du serveur (super administrateur)
  app.get("/api/accounts", { preHandler: requireRole("super") }, async () => ({
    roles: ROLES,
    accounts: (await db.query("SELECT email, name, role, created_by, created_at, last_login_at FROM hub_users WHERE totp_secret IS NOT NULL ORDER BY created_at")).rows,
    invites: (await db.query("SELECT email, name, role, created_by, expires_at FROM hub_invites WHERE expires_at > now() ORDER BY expires_at")).rows,
  }));
  app.post("/api/accounts", { preHandler: requireRole("super") }, async (req) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError("Adresse e-mail invalide.", "email");
    const role = ROLES[req.body?.role] ? req.body.role : null;
    if (!role) throw new UserError("Choisis un rôle.", "role");
    if ((await db.query("SELECT 1 FROM hub_users WHERE email = $1 AND totp_secret IS NOT NULL", [email])).rowCount) throw new UserError("Ce compte existe déjà.", "email");
    const token = crypto.randomBytes(24).toString("hex");
    await db.query("DELETE FROM hub_invites WHERE email = $1", [email]);
    await db.query("INSERT INTO hub_invites (token_hash, email, name, role, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '48 hours')",
      [crypto.createHash("sha256").update(token).digest("hex"), email, String(req.body?.name || "").slice(0, 80), role, req.email]);
    await audit(req, `Invitation créée pour ${email} (${ROLES[role]})`);
    return { ok: true, path: `/#/invitation/${token}`, expires_in_hours: 48 };
  });
  app.put("/api/accounts/:email", { preHandler: requireRole("super") }, async (req) => {
    const email = req.params.email.toLowerCase(), role = req.body?.role;
    if (!ROLES[role]) throw new UserError("Rôle inconnu.");
    if (email === req.email) throw new UserError("Tu ne peux pas changer ton propre rôle.");
    await db.query("UPDATE hub_users SET role = $2 WHERE email = $1", [email, role]);
    await publishUsers();
    await audit(req, `Rôle de ${email} : ${ROLES[role]}`);
    return { ok: true };
  });
  app.delete("/api/accounts/:email", { preHandler: requireRole("super") }, async (req) => {
    const email = req.params.email.toLowerCase();
    if (email === req.email) throw new UserError("Tu ne peux pas supprimer ton propre compte.");
    await db.query("DELETE FROM hub_users WHERE email = $1", [email]);
    await db.query("DELETE FROM hub_invites WHERE email = $1", [email]);
    await publishUsers();
    await audit(req, `Compte supprimé : ${email}`);
    return { ok: true };
  });
  const invite = async (token) => (await db.query("SELECT * FROM hub_invites WHERE token_hash = $1 AND expires_at > now()",
    [crypto.createHash("sha256").update(String(token || "")).digest("hex")])).rows[0];
  const invTotp = new Map();
  app.get("/api/invite/:token", async (req) => {
    const inv = await invite(req.params.token);
    if (!inv) throw new UserError("Invitation expirée ou déjà utilisée : demande un nouveau lien.", null, 404);
    const secret = invTotp.get(inv.token_hash) || newTotpSecret(); invTotp.set(inv.token_hash, secret);
    const uri = otpauthUri(secret, inv.email, "Callikoe serveur");
    return { email: inv.email, name: inv.name, role: ROLES[inv.role], secret, uri, qr: qrSvg(uri) };
  });
  app.post("/api/invite/:token", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const inv = await invite(req.params.token);
    if (!inv) throw new UserError("Invitation expirée ou déjà utilisée : demande un nouveau lien.", null, 404);
    const problem = passwordProblem(req.body?.password); if (problem) throw new UserError(problem, "password");
    const secret = invTotp.get(inv.token_hash);
    const step = secret && verifyTotp(secret, req.body?.totp_code);
    if (step === null || step === undefined) { fail(req.ip); throw new UserError("Code incorrect.", "totp_code"); }
    const rec = newRecoveryCodes();
    await db.query(`INSERT INTO hub_users (email, name, role, password_hash, totp_secret, totp_last_step, recovery, created_by, last_login_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role,
      password_hash = EXCLUDED.password_hash, totp_secret = EXCLUDED.totp_secret, totp_last_step = EXCLUDED.totp_last_step, recovery = EXCLUDED.recovery`,
      [inv.email, inv.name, inv.role, hashPassword(req.body.password), secret, step, JSON.stringify(rec.hashes), inv.created_by]);
    await db.query("DELETE FROM hub_invites WHERE token_hash = $1", [inv.token_hash]); invTotp.delete(inv.token_hash);
    await publishUsers();
    await audit(req, "Compte activé (invitation)", true, ROLES[inv.role], inv.email);
    reply.setCookie(COOKIE, createSession(inv.email, SESSION_SECRET, { mfa: true }), cookieOpts(req));
    return { ok: true, email: inv.email, recovery_codes: rec.codes };
  });
  app.get("/api/audit", { preHandler: requireRole("super", "admin") }, async () =>
    ({ entries: (await db.query("SELECT at, email, ip, action, ok, detail FROM hub_audit ORDER BY id DESC LIMIT 300")).rows }));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT || 8800), host: process.env.HOST || "127.0.0.1" });
}
