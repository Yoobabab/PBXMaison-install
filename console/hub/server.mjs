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

const ETC = process.env.HUB_ETC || "/etc/callikoe/hub";
const VAR = process.env.HUB_VAR || "/var/lib/callikoe/hub";
const HOST_CMD = (process.env.HUB_HOST_CMD || "sudo -n /opt/pbxmaison/pbx/bin/callikoe-host").split(" ");
const SERVER_CONFIG = process.env.HUB_SERVER_CONFIG || "/etc/callikoe/server-config.json";
const SIGN_KEY = path.join(VAR, "portal-key.pem");   // clé privée du portail (signature des licences des PBX créés ici)
const TRUSTED = process.env.HUB_TRUSTED_KEYS || (fs.existsSync("/etc/callikoe/trusted-key.pem") ? "/etc/callikoe/trusted-key.pem" : "/opt/pbxmaison/pbx/portal-public-key.pem");
const DNS_API = process.env.PBXM_DNS_API || "https://api.callikoe.fr";
const MANAGED = ["callikoe.fr", "callikoe.com"];
const isManaged = (f) => MANAGED.some((d) => String(f || "").endsWith("." + d));
export const EDITIONS = { basic: "Basic", pro: "Pro", enterprise: "Enterprise" };
export const SC = [4, 8, 16, 24, 32, 48, 64, 96, 128];
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
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, "..", "public"), prefix: "/c/", decorateReply: false, allowedPath: (p) => /^\/?style\.css$/.test(p) });

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
    return { pbx: list, totals, max: 250, signing: signingInfo() };
  });
  app.post("/api/pbx/:slug/suspendre", { preHandler: requireRole("super", "admin") }, async (req) => {
    if (!SLUG_RE.test(req.params.slug)) throw new UserError("PBX inconnu.", null, 404);
    etatCache.at = 0;
    return runHost(["suspendre", req.params.slug], `Désactivation du PBX ${req.params.slug}`, req);
  });
  app.post("/api/pbx/:slug/reactiver", { preHandler: requireRole("super", "admin") }, async (req) => {
    if (!SLUG_RE.test(req.params.slug)) throw new UserError("PBX inconnu.", null, 404);
    etatCache.at = 0;
    return runHost(["reactiver", req.params.slug], `Réactivation du PBX ${req.params.slug}`, req);
  });

  // ---------------------------------------------------------------- Clé de signature (licences des PBX créés sur ce serveur)
  let signKey = null;
  const loadSignKey = () => { try { signKey = crypto.createPrivateKey(fs.readFileSync(SIGN_KEY)); } catch { signKey = null; } return signKey; };
  loadSignKey();
  function signingInfo() { return signKey ? { configured: true, fingerprint: fingerprint(crypto.createPublicKey(signKey)) } : { configured: false }; }
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

  // ---------------------------------------------------------------- Création d'un PBX (licence signée ici)
  app.get("/api/pbx/options", { preHandler: requireUser }, async () => ({ editions: EDITIONS, sc: SC, countries: COUNTRIES, timezones: TIMEZONES,
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
    if (!signKey) throw new UserError("Installe d'abord la clé de signature des licences (Super administrateur › Clé de signature).");
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
    if (!EDITIONS[v("edition")]) throw new UserError("Édition invalide.", "edition");
    const sc = Number(v("simultaneous_calls")); if (!SC.includes(sc)) throw new UserError("Nombre d'appels simultanés invalide.", "simultaneous_calls");
    const months = Number(v("duration_months")); if (!DURATIONS[months]) throw new UserError("Durée invalide.", "duration_months");
    const id = crypto.randomUUID(), now = new Date();
    if (isManaged(fqdn)) {
      const resv = sign({ action: "reserve", fqdn, pbx_id: id, ts: now.toISOString() });
      let r; try { r = await fetch(`${DNS_API}/v1/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(resv), signal: AbortSignal.timeout(15000) }); }
      catch { throw new UserError("Service d'adresses injoignable : réessaie dans un instant.", "label"); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new UserError(d.error || "Adresse refusée par le service d'adresses.", "label");
    }
    const expires = new Date(now); expires.setUTCMonth(expires.getUTCMonth() + months);
    const cfg = sign({ version: 1,
      pbx: { id, name: v("name"), company: v("company"), fqdn, phone, country: country.code, country_code: country.dial, timezone: v("timezone"), language: v("language") },
      admin: { email, password: "set_on_first_login" },
      license: { key: licenseKey(), edition: v("edition"), simultaneous_calls: sc, expires_at: expires.toISOString() },
      issued_at: now.toISOString() });
    // Copie du fichier de configuration signé (réinstallation, portail) : téléchargeable depuis la console du serveur
    fs.mkdirSync(path.join(VAR, "configs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(VAR, "configs", `${slug}.json`), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    etatCache.at = 0;
    await audit(req, `Licence créée : ${cfg.license.key} (${EDITIONS[cfg.license.edition]}, ${sc} appels, ${DURATIONS[months]})`, true, `${slug} · ${fqdn}`);
    return runHost(["creer", slug, Buffer.from(JSON.stringify(cfg)).toString("base64")], `Création du PBX ${slug} (${fqdn})`, req);
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
  function runHost(args, label, req) {
    const id = crypto.randomBytes(8).toString("hex");
    const job = { id, label, lines: [], running: true, ok: null, started_at: new Date().toISOString() };
    jobs.set(id, job);
    const p = spawn(HOST_CMD[0], [...HOST_CMD.slice(1), ...args], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
    const take = (b) => { for (const l of String(b).split("\n")) { const s = l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(); if (s) job.lines.push(s.slice(0, 300)); } };
    p.stdout.on("data", take); p.stderr.on("data", take);
    p.on("close", async (code) => { job.running = false; job.ok = code === 0; await audit(req, label, job.ok, job.lines.filter((l) => /✖/.test(l)).join(" ").slice(0, 300)); });
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
    const tls = fs.existsSync(`/etc/letsencrypt/live/${t.fqdn}/fullchain.pem`);
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
