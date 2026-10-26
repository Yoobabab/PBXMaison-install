/**
 * Console web du PBX PBXMaison.
 * Écoute en local (127.0.0.1:8080) derrière Nginx, sous l'utilisateur système « pbxmaison ».
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import qrcode from "qrcode-generator";
import { settings, VAR, TEMPLATES_FILE, pbxEnv, installState, setupState, isConfigured, activationCode } from "./lib/config.mjs";
import { createDb } from "./lib/db.mjs";
import { Ami } from "./lib/ami.mjs";
import { hashPassword, verifyPassword, passwordProblem, createSession, readSession, createToken, readToken,
  newTotpSecret, verifyTotp, otpauthUri, newRecoveryCodes, recoveryHash } from "./lib/auth.mjs";
import { createPbxService, routesPath, UserError } from "./lib/pbx.mjs";
import { isManager, isStandardist, consoleRoleOf, USER_ROLES } from "./lib/users.mjs";
import * as vm from "./lib/voicemail.mjs";
import { parseCsv } from "./lib/contacts.mjs";
import { migrateChat, createChat } from "./lib/chat.mjs";
import { scheduleState, KINDS, DEST_TYPES as CF_DEST, GROUP_STRATEGIES, QUEUE_STRATEGIES, DAYS, STEP_TYPES, TERMINAL_STEPS, BRANCHES } from "./lib/callflow.mjs";
const cfOptions = { kinds: KINDS, dest_types: CF_DEST, group_strategies: GROUP_STRATEGIES, queue_strategies: QUEUE_STRATEGIES, days: DAYS, step_types: STEP_TYPES, terminal_steps: TERMINAL_STEPS, branches: BRANCHES };
import { createAdminService } from "./lib/admin.mjs";
import { createTransfer, KINDS as TRANSFER_KINDS, INSTALLER_KINDS } from "./lib/transfer.mjs";
import { parseQueueShow, queueStats } from "./lib/supervision.mjs";
import { CX_MODE, CX_TENANT, ETC } from "./lib/config.mjs";
import { createAi, diagnosisInput, VOICES as AI_VOICES } from "./lib/ai.mjs";
import { createAppPush } from "./lib/apppush.mjs";
import { missedCallers, sameNumberKey } from "./lib/callback.mjs";
import { periodOf, periodStats, reportInput } from "./lib/report.mjs";
import { ivrOptions, localMatch } from "./lib/ivrspeech.mjs";
import { createReceptionist, validateReceptionist, RT_VOICES } from "./lib/receptionist.mjs";
import { REC_DIR } from "./lib/recording.mjs";
import { registerThemeRoutes } from "./lib/theme.mjs";
import { verifyTicket, hubRole, hubInfo, tenantList, readHubPublicKey, HUB_TO_PBX_ROLE } from "./lib/sso.mjs";
import { tokenValid, consumeToken, checkSetupConfig, startApply, applyStatus, setupToken, etcFile } from "./lib/setup.mjs";

if (!settings.sessionSecret) { console.error("SESSION_SECRET manquant"); process.exit(1); }

export async function buildApp({ db, ami } = {}) {
  db ??= createDb(settings.db);
  ami ??= new Ami(settings.ami);
  await db.migrate();
  await migrateChat(db);
  const pbx = createPbxService({ db, ami, templatesFile: TEMPLATES_FILE, routesFile: routesPath(VAR), env: pbxEnv });
  const chat = createChat(db, { users: () => pbx.loadUsers() });
  const ai = createAi({ db, etcDir: ETC });
  const admin = createAdminService({ db, ami, pbx, ai });
  const transfer = createTransfer({ pbx, admin });
  await admin.migrate();
  pbx.setExtraDialplan(() => admin.dialplanParts());

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "warn" }, trustProxy: "127.0.0.1", bodyLimit: 1_048_576 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, "public"), index: ["index.html"] });
  registerThemeRoutes(app);   // couleur, logo et fond d'écran choisis dans la console du serveur multi-tenant

  const COOKIE = "pbxm_session";
  const cookieOpts = (req) => ({ path: "/", httpOnly: true, sameSite: "strict", secure: req.protocol === "https", maxAge: 12 * 3600 });

  // Adresses déguisées (/api/securit%79, //api/…) : refusées avant tout, sinon elles passeraient à côté des contrôles d'accès par chemin
  app.addHook("onRequest", async (req, reply) => {
    const p = req.url.split("?")[0];
    if (/\/\/|\/\.\.?(\/|$)/.test(p) || /%(?:2[DEFdef]|3[0-9]|[46][1-9A-Fa-f]|[57][0-9Aa]|5[Ff]|7[Ee])/.test(p)) return reply.code(400).send({ error: "Adresse invalide." });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-frame-options", "DENY");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  // Erreurs : message en français pour l'utilisateur, détail dans le journal
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UserError || err.status) {
      return reply.code(err.status || 400).send({ error: err.message, field: err.field, impact: err.impact });
    }
    if (err.validation || (err.statusCode >= 400 && err.statusCode < 500)) return reply.code(err.statusCode || 400).send({ error: "Requête invalide." });
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur interne. Détail dans le journal du serveur." });
  });

  const userCount = async () => Number((await db.query("SELECT count(*) FROM pbxmaison_users")).rows[0].count);
  const currentUser = (req) => readSession(req.cookies[COOKIE], settings.sessionSecret);
  // Console : session valide ET double authentification faite (sinon seule la mise en place de la double authentification est permise)
  const ROLES = { admin: "Accès complet (administrateur)", tech: "Technicien (tout sauf les comptes)", client: "Accès restreint (utilisateurs, téléphones, routage, annuaire)", lecture: "Accès visuel (lecture seule)" };
  // Accès restreint (client) : pas de trunks, règles sortantes, sécurité, codes, sauvegardes, mises à jour, licence, alertes, passerelles, système, comptes
  const CLIENT_DENY = /^\/api\/(ai-settings|outbound|outbound-order|security|shortcodes|backups|updates|license|alerts|gateways|system|accounts|audit|recording|setup|templates|routes|capture|extensions\/[^/]+\/(impersonate|secret|phone\/admin|phone\.cfg))(\/|$)/;
  // Rôles qu'un utilisateur du PBX connecté à la console peut donner
  const PBX_USER_ROLES = ["user", "standard", "manager"];
  const requireUser = async (req, reply) => {
    const u = currentUser(req);
    if (!u) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." });
    // Compte supprimé ou rôle modifié : pris en compte immédiatement (compte du serveur multi-tenant : rôle publié par la console du serveur)
    const hr = u.hub ? hubRole(u.email) : null;
    if (u.hub && (CX_MODE !== "tenant" || !hr)) { reply.clearCookie(COOKIE, { path: "/" }); return reply.code(401).send({ error: "Ce compte n'a plus accès au serveur." }); }
    const row = u.hub ? { role: HUB_TO_PBX_ROLE[hr] } : u.ext ? await pbx.consoleUserActive(u.ext).then((r) => (consoleRoleOf(r) ? { role: consoleRoleOf(r) } : null))
      : (await db.query("SELECT role FROM pbxmaison_users WHERE email = $1", [u.email])).rows[0];
    if (!row) { reply.clearCookie(COOKIE, { path: "/" }); return reply.code(401).send({ error: "Ce compte n'existe plus." }); }
    req.role = row.role;
    if (!u.mfa) return reply.code(403).send({ error: "Active d'abord la double authentification.", need_totp_setup: true });
    // Lecture seule : jamais les mots de passe (SIP des postes, fichiers des téléphones et passerelles, sauvegardes complètes)
    if (row.role === "lecture" && /^\/api\/(extensions\/[^/]+\/(secret|phone\.cfg)|gateways\/[^/]+\/setup|backups\/file)(\/|$|\?)/.test(req.url))
      return reply.code(403).send({ error: "Compte en lecture seule : les mots de passe ne sont pas visibles." });
    if (row.role === "lecture" && req.method !== "GET" && !/^\/api\/(reauth|logout|totp\/|diag\/(inbound|outbound))/.test(req.url)) return reply.code(403).send({ error: "Compte en lecture seule : modification impossible." });
    const path = req.url.split("?")[0];
    if (row.role === "client" && (CLIENT_DENY.test(path) || (req.method !== "GET" && /^\/api\/trunks(\/|$)/.test(path))))
      return reply.code(403).send({ error: "Accès restreint : cette partie est réservée à l'installateur." });
  };
  const requireAdmin = async (req, reply) => {
    const r = await requireFreshMfa(req, reply); if (r) return r;
    if (req.role !== "admin") return reply.code(403).send({ error: "Réservé aux administrateurs." });
  };
  const requireLogin = async (req, reply) => { if (!currentUser(req)) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." }); };
  // Actions sensibles (sécurité, trunks, règles sortantes, restauration, mise à jour) : code de double authentification de moins de 15 min
  const MFA_FRESH = 15 * 60_000;
  // (Code redemandé pour les actions sensibles : retiré à la demande d'IRT NETWORK ; la double authentification reste exigée à la connexion)
  const requireFreshMfa = requireUser;
  const audit = (req, action, ok = true, detail = "", email = currentUser(req)?.email || "") =>
    db.query("INSERT INTO pbxmaison_audit (email, ip, action, ok, detail) VALUES ($1, $2, $3, $4, $5)", [email, String(req.ip || ""), action, ok, String(detail).slice(0, 300)]).catch(() => {});
  // Assistant : jeton d'installation tant qu'aucun administrateur n'existe, session ensuite
  const requireSetup = async (req, reply) => {
    if (CX_MODE === "tenant") return reply.code(403).send({ error: "Sur le serveur multi-tenant, ce PBX se configure depuis la console du serveur." });
    if (currentUser(req)) return;
    const token = req.headers["x-setup-token"];
    if ((await userCount()) === 0 && tokenValid(token)) return;
    return reply.code(403).send({ error: "Lien d'installation invalide : utilise l'adresse affichée à la fin de l'installation." });
  };

  // Accès à la console limité à certaines adresses IP (Sécurité) ; le softphone et le provisioning restent accessibles
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/u/") || req.url === "/api/health") return;
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    if (!admin.consoleAllowed(ip)) return reply.code(403).send({ error: `Accès à la console refusé depuis ${ip} (Sécurité › Accès à la console).` });
  });
  // Journal d'audit : toute modification faite depuis la console (qui, quand, d'où, quoi)
  const AUDIT_LABEL = [[/^\/api\/security/, "Sécurité"], [/^\/api\/outbound/, "Règles sortantes"], [/^\/api\/trunks/, "Trunks"], [/^\/api\/extensions/, "Utilisateurs"],
    [/^\/api\/callflow/, "Gestion d'appels"], [/^\/api\/routes/, "Routes"], [/^\/api\/backups/, "Sauvegardes"], [/^\/api\/updates/, "Mise à jour"], [/^\/api\/shortcodes/, "Codes raccourcis"],
    [/^\/api\/recording/, "Enregistrement"], [/^\/api\/gateways/, "Passerelles"], [/^\/api\/contacts/, "Annuaire"], [/^\/api\/alerts/, "Alertes"], [/^\/api\/setup/, "Configuration"], [/^\/api\/totp/, "Double authentification"], [/^\/api\/license/, "Licence"], [/^\/api\/capture/, "Capture réseau"]];
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || !req.url.startsWith("/api/") || reply.statusCode >= 400) return;
    if (/^\/api\/(login|logout|reauth|u\/|invite\/|accounts|diag\/|setup\/(totp|admin)|totp\/(setup|confirm))/.test(req.url)) return;
    const u = currentUser(req); if (!u) return;
    const path = req.url.split("?")[0];
    const label = AUDIT_LABEL.find(([re]) => re.test(path))?.[1] || "Console";
    const verb = { POST: "ajout / action", PUT: "modification", DELETE: "suppression" }[req.method] || req.method;
    await audit(req, `${label} : ${verb}`, true, path);
  });
  const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();

  // ---------------------------------------------------------------- État général
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/state", async (req) => {
    const env = pbxEnv();
    return {
      configured: isConfigured(),
      // Serveur multi-tenant : pas de compte à créer ici (comptes IRT de la console du serveur, comptes clients invités)
      has_admin: CX_MODE === "tenant" || (await userCount()) > 0,
      tenant: CX_MODE === "tenant", hub_url: CX_MODE === "tenant" ? (hubInfo().url || "") : "",
      setup_token_present: !!setupToken(),
      logged_in: !!currentUser(req),
      pbx: env.PBX_ID ? { name: env.PBX_NAME, fqdn: env.PBX_FQDN } : null,
    };
  });

  // ---------------------------------------------------------------- Assistant
  app.post("/api/setup/check", { preHandler: requireSetup }, async (req) => {
    const cfg = req.body?.config;
    if (!cfg || typeof cfg !== "object") throw new UserError("Fichier pbx-config.json manquant ou illisible.");
    return checkSetupConfig(cfg);
  });

  app.post("/api/setup/apply", { preHandler: requireSetup }, async (req) => {
    const cfg = req.body?.config;
    const check = await checkSetupConfig(cfg || {});
    if (!check.ok) throw new UserError(check.problems.join(" "));
    const env = pbxEnv();
    if (env.PBX_ID && env.PBX_ID !== cfg.pbx.id) throw new UserError("Ce serveur est déjà configuré pour un autre PBX.");
    startApply(cfg);
    return { started: true };
  });

  // Relance depuis la console (certificat après correction du DNS, etc.) avec le fichier déjà installé
  app.post("/api/setup/reapply", { preHandler: requireUser }, async () => {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(etcFile("pbx-config.json"), "utf8")); }
    catch { throw new UserError("Fichier de configuration introuvable sur le serveur."); }
    startApply(cfg);
    return { started: true };
  });

  app.get("/api/setup/progress", { preHandler: requireSetup }, async () => ({
    ...applyStatus(), activation_code: activationCode(), setup: setupState(),
  }));

  // Mot de passe administrateur + double authentification, en une seule étape
  let pendingSetupTotp = null;
  app.post("/api/setup/totp", { preHandler: requireSetup }, async () => {
    if (!isConfigured()) throw new UserError("Termine d'abord la configuration.");
    const email = pbxEnv().PBX_ADMIN_EMAIL.toLowerCase();
    pendingSetupTotp = pendingSetupTotp || newTotpSecret();
    const uri = otpauthUri(pendingSetupTotp, email, `Callikoe ${pbxEnv().PBX_NAME || ""}`.trim());
    return { secret: pendingSetupTotp, uri, qr: qrSvg(uri) };
  });
  app.post("/api/setup/admin", { preHandler: requireSetup }, async (req, reply) => {
    if (!isConfigured()) throw new UserError("Termine d'abord la configuration.");
    if ((await userCount()) > 0) throw new UserError("Le compte administrateur existe déjà.");
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new UserError(problem, "password");
    if (!pendingSetupTotp) throw new UserError("Scanne d'abord le QR code de double authentification.", "totp_code");
    const step = verifyTotp(pendingSetupTotp, req.body?.totp_code);
    if (step === null) throw new UserError("Code incorrect : tape le code à 6 chiffres affiché par Psono (ou ton application).", "totp_code");
    const email = pbxEnv().PBX_ADMIN_EMAIL.toLowerCase();
    const rec = newRecoveryCodes();
    await db.query("INSERT INTO pbxmaison_users (email, password_hash, last_login_at, totp_secret, totp_last_step, recovery, role) VALUES ($1, $2, now(), $3, $4, $5, 'admin')",
      [email, hashPassword(req.body.password), pendingSetupTotp, step, JSON.stringify(rec.hashes)]);
    pendingSetupTotp = null;
    consumeToken();
    await audit(req, "Création du compte administrateur (double authentification activée)", true, "", email);
    reply.setCookie(COOKIE, createSession(email, settings.sessionSecret, { mfa: true, mfa_at: Date.now() }), cookieOpts(req));
    return { ok: true, email, recovery_codes: rec.codes };
  });

  // ---------------------------------------------------------------- Connexion (mot de passe puis code de double authentification)
  const failures = new Map();
  const tooMany = (ip) => { const f = failures.get(ip); return f && f.count >= 5 && f.until > Date.now(); };
  const fail = (ip) => { const f = failures.get(ip); const fresh = !f || f.until < Date.now(); failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60_000 }); };
  const seenIp = async (email, ip) => (await db.query("SELECT 1 FROM pbxmaison_audit WHERE email = $1 AND ip = $2 AND ok AND action LIKE 'Connexion%' LIMIT 1", [email, ip])).rowCount > 0;
  async function openSession(req, reply, email, mfa) {
    const known = await seenIp(email, String(req.ip));
    await db.query("UPDATE pbxmaison_users SET last_login_at = now() WHERE email = $1", [email]);
    await audit(req, mfa ? "Connexion à la console" : "Connexion à la console (double authentification à activer)", true, "", email);
    if (!known) admin.logAlert("admin_login", `Connexion à la console de ${email} depuis une nouvelle adresse : ${req.ip}. Si ce n'est pas toi, change le mot de passe et la double authentification tout de suite.`).catch(() => {});
    reply.setCookie(COOKIE, createSession(email, settings.sessionSecret, mfa ? { mfa: true, mfa_at: Date.now() } : {}), cookieOpts(req));
  }
  app.post("/api/login", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const r = await db.query("SELECT password_hash, totp_secret FROM pbxmaison_users WHERE email = $1", [email]);
    // Client : utilisateur du PBX avec le rôle « Accès console » (e-mail de sa fiche + mot de passe du softphone) → accès restreint
    if (!r.rowCount) {
      const x = await pbx.findConsoleUser(email);
      if (x?.web_password_hash && verifyPassword(req.body?.password, x.web_password_hash)) {
        failures.delete(req.ip);
        await audit(req, `Connexion à la console (utilisateur ${x.id}, rôle ${USER_ROLES[x.role] || x.role})`, true, "", email);
        reply.setCookie(COOKIE, createSession(email, settings.sessionSecret, { mfa: true, mfa_at: Date.now(), ext: x.id }), cookieOpts(req));
        return { ok: true, email };
      }
    }
    if (!r.rowCount || !verifyPassword(req.body?.password, r.rows[0].password_hash)) {
      fail(req.ip); await audit(req, "Connexion refusée : mauvais mot de passe", false, "", email);
      return reply.code(401).send({ error: "E-mail ou mot de passe incorrect." });
    }
    if (r.rows[0].totp_secret) return { need_totp: true, ticket: createToken({ email, mfa_ticket: 1 }, settings.sessionSecret, 0.1) };
    failures.delete(req.ip);
    await openSession(req, reply, email, false);
    return { ok: true, email, need_totp_setup: true };
  });
  app.post("/api/login/totp", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const t = readToken(req.body?.ticket, settings.sessionSecret);
    if (!t?.mfa_ticket) return reply.code(401).send({ error: "Délai dépassé : reconnecte-toi." });
    const r = await db.query("SELECT totp_secret, totp_last_step, recovery FROM pbxmaison_users WHERE email = $1", [t.email]);
    const row = r.rows[0];
    const code = String(req.body?.code || "").trim();
    let ok = false;
    const step = row && verifyTotp(row.totp_secret, code, Number(row.totp_last_step));
    if (step !== null && step !== undefined) { ok = true; await db.query("UPDATE pbxmaison_users SET totp_last_step = $2 WHERE email = $1", [t.email, step]); }
    else if (row && code.length > 6) {
      const h = recoveryHash(code), list = row.recovery || [];
      if (list.includes(h)) { ok = true; await db.query("UPDATE pbxmaison_users SET recovery = $2 WHERE email = $1", [t.email, JSON.stringify(list.filter((x) => x !== h))]); await audit(req, "Code de secours utilisé", true, `${list.length - 1} restant(s)`, t.email); }
    }
    if (!ok) { fail(req.ip); await audit(req, "Connexion refusée : mauvais code de double authentification", false, "", t.email); return reply.code(401).send({ error: "Code incorrect." }); }
    failures.delete(req.ip);
    await openSession(req, reply, t.email, true);
    return { ok: true, email: t.email };
  });
  // Nouveau code pour une action sensible
  app.post("/api/reauth", { preHandler: requireUser }, async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const email = currentUser(req).email;
    const row = (await db.query("SELECT totp_secret, totp_last_step FROM pbxmaison_users WHERE email = $1", [email])).rows[0];
    const step = row && verifyTotp(row.totp_secret, req.body?.code, Number(row.totp_last_step));
    if (step === null || step === undefined) { fail(req.ip); await audit(req, "Code de confirmation refusé", false); return reply.code(401).send({ error: "Code incorrect." }); }
    await db.query("UPDATE pbxmaison_users SET totp_last_step = $2 WHERE email = $1", [email, step]);
    reply.setCookie(COOKIE, createSession(email, settings.sessionSecret, { mfa: true, mfa_at: Date.now() }), cookieOpts(req));
    return { ok: true };
  });
  // Mise en place (ou remplacement) de la double authentification
  const pendingTotp = new Map();
  app.post("/api/totp/setup", { preHandler: requireLogin }, async (req, reply) => {
    const u = currentUser(req);
    const secret = newTotpSecret(); pendingTotp.set(u.email, secret);
    const uri = otpauthUri(secret, u.email, `Callikoe ${pbxEnv().PBX_NAME || ""}`.trim());
    return { secret, uri, qr: qrSvg(uri) };
  });
  app.post("/api/totp/confirm", { preHandler: requireLogin }, async (req, reply) => {
    const u = currentUser(req), secret = pendingTotp.get(u.email);
    if (!secret) throw new UserError("Recommence la mise en place.");
    const step = verifyTotp(secret, req.body?.code);
    if (step === null) throw new UserError("Code incorrect : tape le code à 6 chiffres affiché par Psono (ou ton application).", "code");
    const rec = newRecoveryCodes();
    await db.query("UPDATE pbxmaison_users SET totp_secret = $2, totp_last_step = $3, recovery = $4 WHERE email = $1", [u.email, secret, step, JSON.stringify(rec.hashes)]);
    pendingTotp.delete(u.email);
    await audit(req, "Double authentification activée");
    reply.setCookie(COOKIE, createSession(u.email, settings.sessionSecret, { mfa: true, mfa_at: Date.now() }), cookieOpts(req));
    return { ok: true, recovery_codes: rec.codes };
  });
  // ---------------------------------------------------------------- Comptes de la console (un par technicien)
  const inviteLink = (req, token) => `${req.protocol}://${req.headers.host}/#/invitation/${token}`;
  app.get("/api/accounts", { preHandler: requireUser }, async (req) => ({
    me: currentUser(req).email, role: req.role, roles: ROLES,
    accounts: (await db.query(`SELECT email, name, role, invited_by, created_at, last_login_at, totp_secret IS NOT NULL AS totp FROM pbxmaison_users ORDER BY created_at`)).rows,
    invites: (await db.query("SELECT email, name, role, created_by, expires_at FROM pbxmaison_invites WHERE expires_at > now() ORDER BY expires_at")).rows,
  }));
  app.post("/api/accounts", { preHandler: requireAdmin }, async (req) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new UserError("Adresse e-mail invalide.", "email");
    const role = ROLES[req.body?.role] ? req.body.role : "tech";
    const name = String(req.body?.name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 60);
    if ((await db.query("SELECT 1 FROM pbxmaison_users WHERE email = $1", [email])).rowCount) throw new UserError("Ce compte existe déjà.", "email");
    const token = crypto.randomBytes(24).toString("base64url");
    await db.query("DELETE FROM pbxmaison_invites WHERE email = $1", [email]);
    await db.query("INSERT INTO pbxmaison_invites (token_hash, email, name, role, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '48 hours')",
      [crypto.createHash("sha256").update(token).digest("hex"), email, name, role, currentUser(req).email]);
    await audit(req, `Invitation créée pour ${email} (${ROLES[role]})`);
    return { link: inviteLink(req, token), expires_in_hours: 48 };
  });
  app.put("/api/accounts/:email", { preHandler: requireAdmin }, async (req) => {
    const email = req.params.email.toLowerCase(), role = req.body?.role;
    if (!ROLES[role]) throw new UserError("Rôle inconnu.");
    if (email === currentUser(req).email) throw new UserError("Tu ne peux pas changer ton propre rôle.");
    await db.query("UPDATE pbxmaison_users SET role = $2 WHERE email = $1", [email, role]);
    await audit(req, `Rôle de ${email} : ${ROLES[role]}`);
    return { ok: true };
  });
  app.delete("/api/accounts/:email", { preHandler: requireAdmin }, async (req) => {
    const email = req.params.email.toLowerCase();
    if (email === currentUser(req).email) throw new UserError("Tu ne peux pas supprimer ton propre compte.");
    const r = await db.query("DELETE FROM pbxmaison_users WHERE email = $1", [email]);
    await db.query("DELETE FROM pbxmaison_invites WHERE email = $1", [email]);
    if (r.rowCount) await audit(req, `Compte supprimé : ${email}`);
    return { ok: true };
  });
  // Invitation : le technicien choisit son mot de passe et active sa double authentification
  const inviteOf = async (token) => (await db.query("SELECT * FROM pbxmaison_invites WHERE token_hash = $1 AND expires_at > now()", [crypto.createHash("sha256").update(String(token || "")).digest("hex")])).rows[0];
  const pendingInviteTotp = new Map();
  app.get("/api/invite/:token", async (req) => {
    const inv = await inviteOf(req.params.token);
    if (!inv) throw Object.assign(new UserError("Invitation invalide ou expirée : demande-en une nouvelle."), { status: 404 });
    const secret = pendingInviteTotp.get(req.params.token) || newTotpSecret(); pendingInviteTotp.set(req.params.token, secret);
    const uri = otpauthUri(secret, inv.email, `Callikoe ${pbxEnv().PBX_NAME || ""}`.trim());
    return { email: inv.email, name: inv.name, role: ROLES[inv.role], secret, uri, qr: qrSvg(uri) };
  });
  app.post("/api/invite/:token", async (req, reply) => {
    const inv = await inviteOf(req.params.token), secret = pendingInviteTotp.get(req.params.token);
    if (!inv || !secret) throw Object.assign(new UserError("Invitation invalide ou expirée : demande-en une nouvelle."), { status: 404 });
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new UserError(problem, "password");
    const step = verifyTotp(secret, req.body?.totp_code);
    if (step === null) throw new UserError("Code incorrect : tape le code à 6 chiffres affiché par Psono (ou ton application).", "totp_code");
    const rec = newRecoveryCodes();
    await db.query(`INSERT INTO pbxmaison_users (email, password_hash, last_login_at, totp_secret, totp_last_step, recovery, role, name, invited_by)
      VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)`, [inv.email, hashPassword(req.body.password), secret, step, JSON.stringify(rec.hashes), inv.role, inv.name, inv.created_by]);
    await db.query("DELETE FROM pbxmaison_invites WHERE email = $1", [inv.email]);
    pendingInviteTotp.delete(req.params.token);
    await audit(req, `Compte activé (invité par ${inv.created_by})`, true, "", inv.email);
    reply.setCookie(COOKIE, createSession(inv.email, settings.sessionSecret, { mfa: true, mfa_at: Date.now() }), cookieOpts(req));
    return { ok: true, email: inv.email, recovery_codes: rec.codes };
  });
  app.get("/api/audit", { preHandler: requireUser }, async () => ({
    entries: (await db.query("SELECT at, email, ip, action, ok, detail FROM pbxmaison_audit ORDER BY id DESC LIMIT 200")).rows,
  }));
  app.post("/api/logout", async (req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });
  // Serveur multi-tenant : arrivée depuis la console du serveur (ticket signé, valable 60 s, pour ce PBX seulement)
  app.get("/api/sso", async (req, reply) => {
    const key = CX_MODE === "tenant" ? readHubPublicKey() : null;
    const t = key ? verifyTicket(req.query?.t, key, CX_TENANT) : null;
    if (!t || hubRole(t.email) !== t.role) {
      await audit(req, "Ouverture depuis la console du serveur refusée (lien expiré ou invalide)", false, "", t?.email || "");
      return reply.code(403).type("text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif">Lien expiré ou invalide : rouvre ce PBX depuis la console du serveur.</p>`);
    }
    await audit(req, "Connexion depuis la console du serveur", true, t.role, t.email);
    reply.setCookie(COOKIE, createSession(t.email, settings.sessionSecret, { mfa: true, mfa_at: Date.now(), hub: true }), cookieOpts(req));
    const page = String(req.query?.page || "");
    return reply.redirect(/^[a-z-]{2,30}$/.test(page) ? `/#/${page}` : "/");
  });
  app.get("/api/me", { preHandler: requireLogin }, async (req) => {
    const u = currentUser(req);
    if (u.hub) {
      const hr = hubRole(u.email);
      return { email: u.email, totp: true, mfa: true, recovery_left: 8, role: HUB_TO_PBX_ROLE[hr] || "lecture", name: "", hub: true,
        hub_url: hubInfo().url || "", current: CX_TENANT, pbx_list: tenantList() };
    }
    if (u.ext) return { email: u.email, totp: true, mfa: true, recovery_left: 0, role: consoleRoleOf(await pbx.consoleUserActive(u.ext)) || "client", name: "", ext: u.ext };
    const row = (await db.query("SELECT totp_secret IS NOT NULL AS totp, jsonb_array_length(recovery) AS recovery_left FROM pbxmaison_users WHERE email = $1", [u.email])).rows[0];
    const role = (await db.query("SELECT role, name FROM pbxmaison_users WHERE email = $1", [u.email])).rows[0];
    return { email: u.email, totp: !!row?.totp, mfa: u.mfa, recovery_left: row?.recovery_left ?? 0, role: role?.role || "admin", name: role?.name || "" };
  });

  // ---------------------------------------------------------------- Console
  app.get("/api/dashboard", { preHandler: requireUser }, async () => {
    const env = pbxEnv(), st = installState(), ss = setupState();
    const [trunks, exts, calls] = await Promise.all([pbx.listTrunks(), pbx.listExtensions(), pbx.listCalls()]);
    return {
      pbx: { name: env.PBX_NAME, company: env.PBX_COMPANY, fqdn: env.PBX_FQDN, phone: env.PBX_PHONE,
        license: env.PBX_LICENSE_KEY, edition: env.PBX_EDITION, max_calls: Number(env.PBX_MAX_CALLS),
        expires_at: env.PBX_LICENSE_EXPIRES },
      network: { public_ip: st.PUBLIC_IP, local_ip: st.LOCAL_IP, behind_nat: st.BEHIND_NAT === "1",
        dns_ok: ss.DNS_OK === "1", tls: ss.TLS === "1" },
      trunks: { total: trunks.length, registered: trunks.filter((t) => t.status.code === "Registered").length },
      extensions: { total: exts.length, registered: exts.filter((e) => e.registered).length },
      calls: { available: calls.available, active: calls.calls.length },
      activation_code: activationCode(),
      standard: await pbx.getStandard().then(async ({ state, target, since, by, label }) => ({ state, target, since, by, label,
        user: (await pbx.loadUsers()).find(isStandardist)?.id || null })).catch(() => null),
      // Horaires généraux du PBX : ouvert / fermé / pause / férié en ce moment
      hours: await pbx.listObjects("schedule").then((list) => {
        const g = list.find((o) => o.data.general);
        return g ? { id: g.id, name: g.name, state: scheduleState(g.data, new Date(), env.PBX_TIMEZONE || "Europe/Paris") } : null;
      }).catch(() => null),
    };
  });

  function sipServer() {
    const env = pbxEnv(), st = installState(), ss = setupState();
    return { fqdn: env.PBX_FQDN, dns_ok: ss.DNS_OK === "1", tls: ss.TLS === "1", public_ip: st.PUBLIC_IP,
      local_ip: st.LOCAL_IP, behind_nat: st.BEHIND_NAT === "1", host: ss.DNS_OK === "1" ? env.PBX_FQDN : st.PUBLIC_IP };
  }

  app.get("/api/templates", { preHandler: requireUser }, async () => pbx.templates());
  app.get("/api/trunks", { preHandler: requireUser }, async () => pbx.listTrunks());
  app.post("/api/trunks", { preHandler: requireFreshMfa }, async (req) => pbx.createTrunk(req.body || {}));
  app.put("/api/trunks/:id", { preHandler: requireFreshMfa }, async (req) =>
    pbx.createTrunk({ ...(req.body || {}), name: req.params.id, replace: true }));
  app.delete("/api/trunks/:id", { preHandler: requireFreshMfa }, async (req) => { await pbx.deleteTrunk(req.params.id); return { ok: true }; });

  app.get("/api/extensions", { preHandler: requireUser }, async () => ({
    extensions: await pbx.listExtensions(), next: await pbx.nextFreeExtension(),
    server: sipServer(),
  }));
  app.post("/api/extensions", { preHandler: requireUser }, async (req) => {
    if (currentUser(req)?.ext && req.body?.options?.role !== undefined && !PBX_USER_ROLES.includes(req.body.options.role))
      throw Object.assign(new UserError("Seul l'installateur peut donner les rôles Gestionnaire et Administrateur.", "options.role"), { status: 403 });
    return pbx.createExtension(req.body || {}, currentUser(req).email);
  });
  app.get("/api/extensions/:id", { preHandler: requireUser }, async (req) => {
    const user = await pbx.getUser(req.params.id);
    return { user, server: sipServer(), key_offer: { fwd: pbx.phoneKeyInfo(user, "fwd"), standard: pbx.phoneKeyInfo(user, "standard") } };
  });
  // Accès restreint (Gestionnaire…) : ne touche pas aux utilisateurs qui ont accès à la console (Gestionnaire, Administrateur),
  // sinon il pourrait changer leur mot de passe ou leur e-mail et se connecter à leur place avec plus de droits
  const guardTarget = async (req, id) => {
    if (req.role === "admin" || req.role === "tech") return;
    if (currentUser(req)?.ext && String(currentUser(req).ext) === String(id)) return;   // sa propre fiche
    const t = await pbx.getUser(id);
    if (!PBX_USER_ROLES.includes(t.options?.role || "user"))
      throw Object.assign(new UserError(`Le poste ${t.id} a accès à la console : seul l'installateur peut modifier ses accès.`), { status: 403 });
  };
  app.put("/api/extensions/:id", { preHandler: requireUser }, async (req) => {
    await guardTarget(req, req.params.id);
    // Utilisateur du PBX connecté à la console (Gestionnaire, Administrateur) : donne seulement Utilisateur, Pilote ou Superviseur,
    // et ne touche pas au rôle d'un Gestionnaire ou d'un Administrateur (réservé à l'installateur)
    const role = req.body?.options?.role;
    if (currentUser(req)?.ext && role !== undefined && (!PBX_USER_ROLES.includes(role) || !PBX_USER_ROLES.includes((await pbx.getUser(req.params.id)).options.role || "user")))
      throw Object.assign(new UserError("Seul l'installateur peut donner ou retirer les rôles Gestionnaire et Administrateur.", "options.role"), { status: 403 });
    return pbx.updateUser(req.params.id, req.body || {}, currentUser(req).email);
  });
  app.get("/api/extensions/:id/secret", { preHandler: requireUser }, async (req) => pbx.extensionSecret(req.params.id));
  app.post("/api/extensions/:id/secret", { preHandler: requireUser }, async (req) => { await guardTarget(req, req.params.id); return pbx.resetSecret(req.params.id); });
  const provFails = new Map(); // échecs par IP (provisioning et appli) : 30 / 10 min
  // Application mobile : QR code valable 48 h
  const appUrl = (token) => { const sv = sipServer(); return `${sv.tls ? "https" : "http"}://${sv.host}/app/provision?t=${token}`; };
  const qrSvg = (text) => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
  app.get("/api/extensions/:id/app-token", { preHandler: requireUser }, async (req) => ({ active: await pbx.appTokenStatus(req.params.id) }));
  app.post("/api/extensions/:id/app-token", { preHandler: requireUser }, async (req) => {
    await guardTarget(req, req.params.id);
    const t = await pbx.createAppToken(req.params.id, currentUser(req).email);
    const url = appUrl(t.token);
    return { ...t, url, qr_svg: qrSvg(url) };
  });
  app.delete("/api/extensions/:id/app-token", { preHandler: requireUser }, async (req) => { await pbx.revokeAppToken(req.params.id); return { ok: true }; });
  app.get("/app/provision", async (req, reply) => {
    const wantsJson = req.query?.format === "json" || String(req.headers.accept || "").includes("application/json");
    if (!wantsJson) {
      // QR code scanné avec l'appareil photo (ou lien reçu par mail) : page qui ouvre l'appli sur ce poste
      const t = String(req.query?.t || "");
      const self = `${appUrl("")}${encodeURIComponent(t)}`;
      const deep = `callikoe://provision?url=${encodeURIComponent(self)}`;
      const pbxName = String(pbxEnv().PBX_NAME || "").replace(/[<>&"]/g, "");
      return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Callikoe · application mobile</title>
        <style>body{margin:0;min-height:100vh;background:#16141a;color:#fff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
        main{max-width:400px;padding:32px 20px;text-align:center}.dot{width:64px;height:64px;border-radius:50%;margin:0 auto 18px;background:linear-gradient(120deg,#f26b4f,#d8141c 50%,#e0006e);box-shadow:0 0 0 10px rgba(255,255,255,.06)}
        h1{font-size:24px;margin:0 0 6px}p{color:#c9c4cf;margin:0 0 18px}a.btn{display:block;padding:14px 18px;border-radius:12px;background:linear-gradient(120deg,#f26b4f,#d8141c 55%,#e0006e);color:#fff;text-decoration:none;font-weight:700;margin:0 0 12px}
        a.ghost{background:none;border:1px solid #3a3540}.s{font-size:13px;color:#8d8794}ol{text-align:left;color:#c9c4cf;padding-left:20px}</style>
        <main><div class="dot"></div><h1>Callikoe</h1><p>Configure ton poste${pbxName ? ` de <strong>${pbxName}</strong>` : ""} sur ton mobile, sans rien saisir.</p>
        <a class="btn" href="${deep}">Ouvrir dans l'application Callikoe</a>
        <ol><li>Installe l'application Callikoe sur ton téléphone (bientôt sur l'App Store et Google Play).</li><li>Reviens sur cette page et touche « Ouvrir dans l'application », ou scanne le QR code depuis l'application.</li></ol>
        <p class="s">Ce lien est personnel et valable 48 h. Ne le transfère à personne.</p></main></html>`);
    }
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const f = provFails.get(ip);
    if (f && f.count >= 30 && f.until > Date.now()) return reply.code(429).send({ error: "Trop de tentatives." });
    const out = await pbx.appProvision(String(req.query?.t || ""), sipServer(), req.headers["user-agent"]);
    if (!out) {
      const fresh = !f || f.until < Date.now();
      provFails.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60_000 });
      return reply.code(404).send({ error: "QR code invalide ou expiré : demande-en un nouveau à l'administrateur." });
    }
    return reply.header("cache-control", "no-store").send(out);
  });

  // Actions groupées sur les utilisateurs : mail de bienvenue (lien pour choisir son mot de passe du softphone), QR code de l'appli
  const bulkIds = (req) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].filter((x) => /^[1-9]\d{2}$/.test(x));
    if (!ids.length) throw new UserError("Sélectionne au moins un utilisateur.");
    if (ids.length > 300) throw new UserError("300 utilisateurs au plus à la fois.");
    return ids;
  };
  const baseUrl = () => { const sv = sipServer(); return `${sv.tls ? "https" : "http"}://${sv.host}`; };
  const firstName = (u) => u.first_name || u.name || "";
  app.post("/api/extensions/bulk/welcome", { preHandler: requireUser }, async (req) => {
    const out = [];
    const pbxName = pbxEnv().PBX_NAME || "";
    for (const id of bulkIds(req)) {
      try {
        await guardTarget(req, id);
        const w = await pbx.createWelcome(id, currentUser(req).email);
        const u = w.user, name = u.first_name || u.last_name ? `${u.first_name} ${u.last_name}`.trim() : `Poste ${u.id}`;
        const link = `${baseUrl()}/softphone?bienvenue=${w.token}`;
        const login = u.email || u.id;
        out.push({ id, name, email: u.email, link, expires_at: w.expires_at,
          subject: `Bienvenue sur ton poste téléphonique${pbxName ? ` ${pbxName}` : ""}`,
          body: `Bonjour ${firstName(u) || name},\n\nTon poste téléphonique ${u.id} est prêt. Tu peux appeler et recevoir tes appels depuis ton ordinateur (softphone web).\n\n`
            + `1. Ouvre ce lien et choisis ton mot de passe (lien personnel, valable 7 jours) :\n${link}\n\n`
            + `2. Ensuite, connecte-toi à tout moment sur ${baseUrl()}/softphone avec ton identifiant : ${login}\n\n`
            + `Ta messagerie vocale : *97 depuis ton poste.\n\nBonne journée !` });
      } catch (e) { out.push({ id, error: e.message }); }
    }
    return { results: out, smtp: false };
  });
  app.post("/api/extensions/bulk/app-tokens", { preHandler: requireUser }, async (req) => {
    const out = [];
    for (const id of bulkIds(req)) {
      try {
        await guardTarget(req, id);
        const u = await pbx.getUser(id);
        const t = await pbx.createAppToken(id, currentUser(req).email);
        const url = appUrl(t.token), name = u.first_name || u.last_name ? `${u.first_name} ${u.last_name}`.trim() : `Poste ${u.id}`;
        out.push({ id, name, email: u.email, url, qr_svg: qrSvg(url), expires_at: t.expires_at,
          subject: "Configure l'application Callikoe sur ton mobile",
          body: `Bonjour ${firstName(u) || name},\n\nPour avoir ton poste ${u.id} sur ton téléphone mobile :\n\n1. Installe l'application Callikoe.\n2. Ouvre ce lien depuis ton mobile et touche « Ouvrir dans l'application » (ou scanne le QR code depuis l'application) :\n${url}\n\nLe lien est personnel et valable 48 h : ne le transfère à personne.\n\nBonne journée !` });
      } catch (e) { out.push({ id, error: e.message }); }
    }
    return { results: out, smtp: false };
  });
  app.get("/api/u/welcome/:token", async (req, reply) => {
    const info = await pbx.welcomeInfo(String(req.params.token));
    if (!info) return reply.code(404).send({ error: "Lien expiré ou déjà utilisé : demande un nouveau mail de bienvenue à ton administrateur." });
    return info;
  });
  app.post("/api/u/welcome/:token", async (req, reply) => {
    const pw = req.body?.password;
    const problem = passwordProblem(pw);
    if (problem) throw new UserError(problem, "password");
    const info = await pbx.useWelcome(String(req.params.token), hashPassword(pw));
    if (!info) return reply.code(404).send({ error: "Lien expiré ou déjà utilisé : demande un nouveau mail de bienvenue à ton administrateur." });
    reply.setCookie(UCOOKIE, createToken({ ext: info.extension }, settings.sessionSecret, 12), cookieOpts(req));
    return { ok: true, login: info.email || info.extension };
  });

  // Appli mobile : ouverture du softphone avec le jeton de l'appareil (gardé par l'appli), déconnexion de l'appareil
  app.get("/app/login", async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const f = provFails.get(ip);
    if (f && f.count >= 30 && f.until > Date.now()) return reply.code(429).type("text/html; charset=utf-8").send("<p>Trop de tentatives : réessaie dans 10 minutes.</p>");
    const ext = await pbx.appDevice(String(req.query?.d || ""));
    if (!ext) {
      const fresh = !f || f.until < Date.now();
      provFails.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60_000 });
      return reply.code(401).type("text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font:16px system-ui;background:#16141a;color:#fff;text-align:center;padding:18vh 20px"><h1 style="font-size:20px">Ce téléphone n'est plus relié au poste</h1>
        <p style="color:#c9c4cf">Demande un nouveau QR code à ton administrateur, puis déconnecte ce téléphone dans les réglages de l'application et scanne-le.</p></body>`);
    }
    reply.setCookie(UCOOKIE, createToken({ ext, app: true }, settings.sessionSecret, 12), cookieOpts(req));
    return reply.redirect("/softphone?app=1");
  });
  app.post("/app/logout", async (req) => { await pbx.revokeAppDevice(req.body?.device_token); return { ok: true }; });
  app.get("/api/extensions/:id/app-devices", { preHandler: requireUser }, async (req) => ({ devices: await pbx.appDevices(req.params.id) }));
  app.delete("/api/extensions/:id/app-devices", { preHandler: requireUser }, async (req) => { await pbx.revokeAppDevices(req.params.id); return { ok: true }; });

  // ---------------------------------------------------------------- Espace utilisateur / softphone web
  const UCOOKIE = "callikoe_user";
  const webUser = (req) => readToken(req.cookies[UCOOKIE], settings.sessionSecret);
  const requireWebUser = async (req, reply) => {
    const s = webUser(req);
    if (!s) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." });
    // Utilisateur supprimé ou désactivé : sa session s'arrête tout de suite (sauf incarnation par l'installateur)
    if (!s.imp && !(await pbx.webUserActive(s.ext))) { reply.clearCookie(UCOOKIE, { path: "/" }); return reply.code(401).send({ error: "Ce poste est désactivé : connexion impossible." }); }
  };
  const randomWebPassword = () => crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) + String(crypto.randomInt(10, 99));
  app.get("/softphone", async (req, reply) => reply.sendFile("softphone.html"));

  app.post("/api/extensions/:id/web-password", { preHandler: requireUser }, async (req) => {
    await guardTarget(req, req.params.id);
    const password = randomWebPassword();
    await pbx.setWebPassword(req.params.id, hashPassword(password));
    return { password };
  });
  app.post("/api/extensions/:id/impersonate", { preHandler: requireUser }, async (req, reply) => {
    const u = await pbx.getUser(req.params.id);
    req.log.info({ admin: currentUser(req).email, ext: u.id }, "incarnation");
    reply.setCookie(UCOOKIE, createToken({ ext: u.id, imp: currentUser(req).email }, settings.sessionSecret, 2), cookieOpts(req));
    return { url: "/softphone" };
  });

  const uFailures = new Map();
  app.post("/api/u/login", async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const f = uFailures.get(ip);
    if (f && f.count >= 8 && f.until > Date.now()) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const row = await pbx.findWebUser(req.body?.login);
    if (!row || !row.web_password_hash || !verifyPassword(req.body?.password, row.web_password_hash)) {
      const fresh = !f || f.until < Date.now();
      uFailures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60_000 });
      return reply.code(401).send({ error: "Identifiant ou mot de passe incorrect." });
    }
    uFailures.delete(ip);
    reply.setCookie(UCOOKIE, createToken({ ext: row.id }, settings.sessionSecret, 12), cookieOpts(req));
    return { ok: true, ext: row.id };
  });
  app.post("/api/u/logout", async (req, reply) => { reply.clearCookie(UCOOKIE, { path: "/" }); return { ok: true }; });
  const team = async (self) => {
    const [list, lines] = await Promise.all([pbx.listExtensions(), pbx.lineStates()]);
    const me = list.find((x) => x.id === self);
    const pilot = isStandardist({ options: { role: me?.role, disabled: me?.disabled } });
    // Masqués : vus de personne ; groupes de visibilité : on ne voit que son groupe
    return list.filter((x) => x.id !== self && !x.disabled && !x.hidden && (x.team || "") === (me?.team || "")).map((x) => ({
      id: x.id, name: x.name, first_name: x.first_name, last_name: x.last_name, email: x.email,
      status: x.status, registered: x.registered, line: lines.get(x.id) || "",
      devices: [...new Set(x.contacts.map((c) => c.device?.kind).filter(Boolean))],
      // Pilote : voit et change le renvoi immédiat de ses collègues
      ...(pilot ? { fwd: x.always?.type && x.always.type !== "none" ? x.always : null, vm: x.vm } : {}),
    }));
  };
  const webBy = (s) => (s.imp ? `${s.imp} (incarnation)` : `${s.ext} (softphone)`);
  const selfView = (u) => ({
    id: u.id, name: u.name, first_name: u.first_name, last_name: u.last_name, status: u.status, email: u.email,
    mobile: u.mobile, dids: u.dids, outbound_cid: u.outbound_cid,
    forwarding: u.forwarding, voicemail: { enabled: u.voicemail.enabled, pin: u.voicemail.pin, skip_pin: u.voicemail.skip_pin, email: !!u.voicemail.email, email_attach: u.voicemail.email_attach !== false },
    ring_mobile: u.options.ring_mobile, manager: isManager(u), standardist: isStandardist(u), phone_model: u.phone.model || "",
  });
  app.get("/api/u/me", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const u = await pbx.getUser(s.ext);
    const secret = await pbx.webSecret(s.ext);
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    const https = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    return {
      pbx: { name: pbxEnv().PBX_NAME || "" }, impersonated_by: s.imp || null,
      user: selfView(u),
      sip: { ws_url: `${https ? "wss" : "ws"}://${host}/ws`, domain: sipServer().fqdn || host, user: `${u.id}-web`,
        auth_user: secret.auth_id, password: secret.password, display_name: u.name,
        // Micro autorisé par le navigateur : HTTPS, ou accès local (tests)
        secure: https || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) },
      server: { host: sipServer().host, voicemail: "*97" },
      contacts: await team(u.id),
      rooms: (await pbx.listObjects("conf")).map((o) => ({ number: o.number, name: o.name, pin: !!o.data.pin })),
      standard: isStandardist(u) ? await pbx.getStandard().then(({ state, target, since, by, label }) => ({ state, target, since, by, label })) : null,
    };
  });
  // Touches « Renvoi » et « Standard » du softphone / de l'appli : état actuel (peut changer depuis un poste avec *21, *80…)
  app.get("/api/u/keys", { preHandler: requireWebUser }, async (req) => {
    const u = await pbx.getUser(webUser(req).ext);
    const std = isStandardist(u) ? await pbx.getStandard() : null;
    const codes = Object.fromEntries((await admin.getShortcodes()).codes.filter((c) => /^(fwd|std)_/.test(c.id)).map((c) => [c.id, c.code]));
    const out = { forward: u.forwarding.always, last: u.forwarding.always_last, codes,
      phone: { fwd: pbx.phoneKeyInfo(u, "fwd"), standard: std ? pbx.phoneKeyInfo(u, "standard") : null }, standard: null };
    if (std) {
      const users = (await pbx.loadUsers()).filter((x) => !x.options.disabled), objs = await pbx.listObjects();
      const uname = (x) => `${x.first_name} ${x.last_name}`.trim() || `Poste ${x.id}`;
      const oname = (o) => `${o.number ? o.number + " · " : ""}${o.name}`;
      const d = std.closed_dest || {};
      const ux = users.find((x) => x.id === d.target), ox = objs.find((o) => o.id === d.target);
      const closed = d.type === "hangup" ? (d.prompt ? `Annonce « ${objs.find((o) => o.id === d.prompt)?.name || "?"} »` : "Fin d'appel") : d.type === "user" ? (ux ? uname(ux) : d.target)
        : d.type === "user_vm" ? `Messagerie de ${ux ? uname(ux) : d.target}` : d.type === "external" ? d.target.replace(/(\d{2})(?=\d)/g, "$1 ") : ox ? oname(ox) : "";
      // Où envoyer les appels en fermant : choix proposés dans le softphone et l'appli
      const pick = (kind) => objs.filter((o) => o.kind === kind).map((o) => ({ id: o.id, name: oname(o) }));
      out.standard = { state: std.state, target: std.target, since: std.since, by: std.by, label: std.label, closed, dest: { type: d.type, target: d.target || "", prompt: d.prompt || "" },
        targets: { user: users.map((x) => ({ id: x.id, name: `${x.id} · ${uname(x)}`, vm: !!x.voicemail.enabled })),
          group: pick("group"), queue: pick("queue"), ivr: pick("ivr"), groupvm: pick("groupvm"), prompt: objs.filter((o) => o.kind === "prompt").map((o) => ({ id: o.id, name: o.name })) } };
    }
    return out;
  });
  // Superviseur : appels en cours, journal de l'équipe (avec enregistrements), files d'attente
  async function supervisorOf(req) {
    const u = await pbx.getUser(webUser(req).ext);
    if (!isManager(u)) throw Object.assign(new UserError("Réservé au rôle Superviseur : demande à l'administrateur du PBX de te le donner."), { status: 403 });
    return u;
  }
  app.get("/api/u/supervision", { preHandler: requireWebUser }, async (req) => {
    await supervisorOf(req);
    const [calls, objs, lines] = await Promise.all([pbx.listCalls(), pbx.listObjects("queue"), ami.command("queue show").catch(() => null)]);
    return { calls: calls.calls, available: calls.available, queues: lines ? queueStats(parseQueueShow(lines), objs) : [] };
  });
  app.get("/api/u/supervision/log", { preHandler: requireWebUser }, async (req) => {
    await supervisorOf(req);
    const days = [1, 7, 30].includes(Number(req.query?.days)) ? Number(req.query.days) : 1;
    const { calls, total } = await pbx.callLog({ days, q: String(req.query?.q || "").slice(0, 40), limit: 300 });
    return { calls: calls.reverse(), total };
  });
  // Bilan de la semaine / du mois (chiffres + synthèse IA à la demande, gardée pour les périodes terminées)
  async function periodReport(kind, previous) {
    const k = kind === "month" ? "month" : "week";
    const tzp = pbxEnv().PBX_TIMEZONE || "Europe/Paris";
    const cur = periodOf(k, Date.now(), { previous, tz: tzp }), prev = periodOf(k, Date.parse(cur.from) - 1000, { tz: tzp });
    const { calls } = await pbx.callLog({ days: k === "month" ? 75 : 22, limit: 5000 });
    const names = new Map((await pbx.listExtensions()).map((u) => [u.id, u.name]));
    const tz = pbxEnv().PBX_TIMEZONE || "Europe/Paris";
    const stats = periodStats(calls, { from: cur.from, to: cur.to, tz, names }), before = periodStats(calls, { from: prev.from, to: prev.to, tz, names });
    const key = `${k}:${cur.from}`;
    const saved = (await db.query("SELECT text, at FROM pbxmaison_ai_reports WHERE key = $1", [key]).catch(() => ({ rows: [] }))).rows[0];
    return { kind: k, label: cur.label, from: cur.from, to: cur.to, done: Date.parse(cur.to) <= Date.now(), stats, previous: before, previous_label: prev.label,
      ai: (await ai.settings()).enabled, synthesis: saved?.text || "", synthesis_at: saved?.at || null, key };
  }
  async function reportSynthesis(r) {
    const vms = (await db.query("SELECT summary FROM pbxmaison_vm_ai WHERE msg_at >= $1 AND msg_at < $2 AND summary <> ''", [r.from.slice(0, 19), r.to.slice(0, 19)]).catch(() => ({ rows: [] }))).rows.map((x) => x.summary);
    const text = await ai.text("report", reportInput(r.kind, r.label, r.stats, r.previous, vms));
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_ai_reports (key text PRIMARY KEY, text text NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
    if (r.done) await db.query("INSERT INTO pbxmaison_ai_reports (key, text) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET text = $2, at = now()", [r.key, text]);
    return text;
  }
  app.get("/api/u/supervision/report", { preHandler: requireWebUser }, async (req) => { await supervisorOf(req); return periodReport(req.query?.kind, req.query?.previous === "1"); });
  app.post("/api/u/supervision/report/ai", { preHandler: requireWebUser }, async (req) => {
    await supervisorOf(req);
    const r = await periodReport(req.body?.kind, !!req.body?.previous);
    return { synthesis: await reportSynthesis(r) };
  });
  app.get("/api/u/recordings/file", { preHandler: requireWebUser }, async (req, reply) => {
    await supervisorOf(req);
    const f = await admin.recordingFile(String(req.query?.f || ""));
    return reply.type("audio/wav").header("cache-control", "no-store").send(fs.createReadStream(f));
  });
  // Pilote : renvoyer les appels d'un collègue absent (ou annuler son renvoi)
  async function pilotOf(req) {
    const u = await pbx.getUser(webUser(req).ext);
    if (!isStandardist(u)) throw Object.assign(new UserError("Réservé au rôle Pilote : demande à l'administrateur du PBX de te le donner."), { status: 403 });
    return u;
  }
  app.put("/api/u/team/:ext/forward", { preHandler: requireWebUser }, async (req) => {
    const me = await pilotOf(req);
    const ext = String(req.params.ext);
    // Seulement les collègues que le Pilote voit (pas les postes masqués, d'une autre équipe, ni ceux qui ont accès à la console)
    if (!(await team(me.id)).some((x) => x.id === ext) || !PBX_USER_ROLES.includes((await pbx.getUser(ext)).options?.role || "user"))
      throw Object.assign(new UserError("Ce poste ne fait pas partie de ton équipe."), { status: 403 });
    const dest = req.body?.dest;
    const fw = dest ? { always: dest, always_last: dest } : { always: { type: "none", target: "" } };
    const u = await pbx.updateUser(ext, { forwarding: fw }, `Pilote ${me.id} ${me.name}`);
    return { id: u.id, fwd: u.forwarding.always.type !== "none" ? u.forwarding.always : null };
  });
  // Pilote : annonces (écouter, remplacer ou créer au micro)
  app.get("/api/u/prompts", { preHandler: requireWebUser }, async (req) => {
    await pilotOf(req);
    const aiOn = (await ai.settings()).enabled;
    return { ai: aiOn, voices: AI_VOICES, musics: aiOn ? await ai.musics().catch(() => []) : [], prompts: (await pbx.listObjects("prompt")).map((o) => ({ id: o.id, name: o.name, duration: o.data.duration || 0, updated_at: o.updated_at, updated_by: o.updated_by })) };
  });
  app.get("/api/u/prompts/:id/audio", { preHandler: requireWebUser }, async (req, reply) => {
    await pilotOf(req);
    return reply.type("audio/wav").header("cache-control", "no-store").send(fs.createReadStream(await pbx.promptFile(req.params.id)));
  });
  app.post("/api/u/prompts", { preHandler: requireWebUser, bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const me = await pilotOf(req);
    return pbx.savePrompt(null, req.body?.name, wavOf(req.body), `Pilote ${me.id} ${me.name}`);
  });
  app.post("/api/u/ai/speech", { preHandler: requireWebUser }, async (req) => {
    await pilotOf(req);
    const wav = await ai.speech(String(req.body?.text || ""), req.body?.voice, req.body?.music || "");
    return { wav: wav.toString("base64"), seconds: Math.round(((wav.length - 44) / 16000) * 10) / 10 };
  });
  app.get("/api/u/ai/music/:id", { preHandler: requireWebUser }, async (req, reply) => { await pilotOf(req); return reply.type("audio/wav").header("cache-control", "private, max-age=3600").send(await ai.music(req.params.id)); });
  app.post("/api/u/ai/announce-text", { preHandler: requireWebUser }, async (req) => { await pilotOf(req); return { text: await ai.text("announce", String(req.body?.idea || "").slice(0, 1000)) }; });
  app.put("/api/u/prompts/:id", { preHandler: requireWebUser, bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const me = await pilotOf(req);
    const cur = await pbx.getObject("prompt", req.params.id);
    return pbx.savePrompt(req.params.id, req.body?.name || cur.name, wavOf(req.body), `Pilote ${me.id} ${me.name}`);
  });
  // Ajouter la touche « Renvoi » (tout le monde) ou « Ouvert / Fermé » (postes autorisés) sur son téléphone IP
  // Touches de son propre téléphone IP (tout le monde) : même éditeur que la console
  app.get("/api/u/phone/keys", { preHandler: requireWebUser }, async (req) => {
    const u = await pbx.getUser(webUser(req).ext);
    if (!u.phone.model) return { phone: null };
    const users = (await pbx.listExtensions()).filter((x) => !x.disabled && !x.hidden).map((x) => ({ id: x.id, name: x.name }));
    return { phone: { model: u.phone.model, keys: u.phone.keys, modules: u.phone.modules || [], mac: !!u.phone.mac }, user: { id: u.id, name: u.name }, users, opts: pbx.phoneOptions() };
  });
  app.put("/api/u/phone/keys", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const u = await pbx.getUser(s.ext);
    if (!u.phone.model) throw new UserError("Aucun téléphone IP n'est associé à ton poste.");
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.slice(0, 200) : [];
    const mods = Array.isArray(req.body?.mods) ? req.body.mods.slice(0, 3) : [];
    // Touche « Ouvert / Fermé » : seulement pour les postes autorisés (comme dans la console)
    const all = [...keys, ...mods.flat()];
    if (!isStandardist(u) && all.some((k) => k?.type === "standard") && !u.phone.keys.some((k) => k.type === "standard")) throw new UserError("La touche Ouvert / Fermé est réservée au rôle Pilote.");
    await pbx.updateUser(s.ext, { phone: { keys, modules: mods.map((k) => ({ keys: Array.isArray(k) ? k.slice(0, 200) : [] })) } }, webBy(s));
    let sent = false;
    try { await pbx.notifyPhone(s.ext, "resync"); sent = true; } catch { /* au prochain démarrage du téléphone */ }
    return { ok: true, sent };
  });
  app.post("/api/u/phone/key", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const type = req.body?.type;
    if (type !== "fwd" && type !== "standard") throw new UserError("Touche inconnue.");
    if (type === "standard" && !isStandardist(await pbx.getUser(s.ext))) throw Object.assign(new UserError("Réservé aux postes autorisés à ouvrir et fermer."), { status: 403 });
    return pbx.addPhoneKey(s.ext, type, webBy(s));
  });
  // Standard (tout le PBX) : ouvert / fermé / renvoyé, par les utilisateurs Pilote, Responsable ou Accès console
  app.get("/api/u/standard", { preHandler: requireWebUser }, async (req) => {
    const u = await pbx.getUser(webUser(req).ext);
    if (!isStandardist(u)) throw Object.assign(new UserError("Réservé au rôle Pilote : demande à l'administrateur du PBX de te le donner."), { status: 403 });
    const { state, target, since, by, label } = await pbx.getStandard();
    return { state, target, since, by, label };
  });
  app.post("/api/u/standard", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const u = await pbx.getUser(s.ext);
    if (!isStandardist(u)) throw Object.assign(new UserError("Réservé au rôle Pilote : demande à l'administrateur du PBX de te le donner."), { status: 403 });
    const { state, target, since, by, label } = await pbx.setStandardState(req.body || {}, `poste ${s.ext} (${s.imp ? "incarnation" : "softphone / appli"})`);
    return { state, target, since, by, label };
  });
  // Plannings d'appels : modifiables par les utilisateurs « Responsable » (fiche utilisateur › Général › Rôle)
  const PLAN_FIELDS = ["scenarios", "branches", "outside", "week", "week_b", "alternate", "ref_monday", "holidays_fr", "holiday_scenario", "days", "override"];
  async function managerOf(req) {
    const u = await pbx.getUser(webUser(req).ext);
    if (!isManager(u)) throw Object.assign(new UserError("Réservé au rôle Superviseur : demande à l'administrateur du PBX de te le donner."), { status: 403 });
    return u;
  }
  app.get("/api/u/plannings", { preHandler: requireWebUser }, async (req) => {
    await managerOf(req);
    const all = await pbx.listObjects();
    const light = (o) => ({ kind: o.kind, id: o.id, number: o.number, name: o.name, data: o.kind === "planning" ? o.data : { name: o.data.name, ring_time: o.data.ring_time, dids: o.data.dids || [] } });
    return {
      plannings: all.filter((o) => o.kind === "planning" && o.data.managers).map(light),
      objects: all.filter((o) => ["group", "queue", "prompt", "ivr", "groupvm", "conf", "planning"].includes(o.kind)).map(light),
      users: (await pbx.listExtensions()).map((u) => ({ id: u.id, name: u.name, status: u.status, disabled: u.disabled, dids: [] })),
      timezone: pbxEnv().PBX_TIMEZONE || "Europe/Paris", trunk_dids: [],
    };
  });
  app.put("/api/u/plannings/:id", { preHandler: requireWebUser }, async (req) => {
    const u = await managerOf(req);
    const o = await pbx.getObject("planning", req.params.id);
    if (!o.data.managers) throw Object.assign(new UserError("Ce planning n'est modifiable que depuis la console du PBX."), { status: 403 });
    const input = Object.fromEntries(PLAN_FIELDS.filter((k) => req.body?.[k] !== undefined).map((k) => [k, req.body[k]]));
    const r = await pbx.saveObject("planning", o.id, input, `${u.id} ${u.name} (superviseur)`);
    return { id: r.id, name: r.name, data: r.data };
  });
  app.get("/api/u/calls", { preHandler: requireWebUser }, async (req) => ({ calls: await pbx.userCalls(webUser(req).ext, 150) }));
  app.get("/api/u/contacts", { preHandler: requireWebUser }, async () => ({ contacts: (await pbx.listContacts()).map(({ notes, ...c }) => (void notes, c)) }));
  // Temps réel (chat, …) : Server-Sent Events, gardé ouvert ; Nginx ne doit pas mettre en tampon (X-Accel-Buffering)
  app.get("/api/u/events", { preHandler: requireWebUser }, (req, reply) => {
    const s = webUser(req);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write("retry: 3000\n\n");
    const unsub = chat.subscribe(s.ext, reply.raw);
    const ka = setInterval(() => { try { reply.raw.write(": ping\n\n"); } catch { /* fermé */ } }, 25_000);
    req.raw.on("close", () => { clearInterval(ka); unsub(); });
  });
  app.get("/api/u/chats", { preHandler: requireWebUser }, async (req) => ({ chats: await chat.list(webUser(req).ext), online: [...chat.online()] }));
  app.post("/api/u/chats", { preHandler: requireWebUser }, async (req) => chat.open(webUser(req).ext, req.body?.members, req.body?.name));
  app.get("/api/u/chats/:id/messages", { preHandler: requireWebUser }, async (req) => chat.messages(webUser(req).ext, req.params.id, req.query?.before || null));
  app.post("/api/u/chats/:id/messages", { preHandler: requireWebUser }, async (req) => chat.send(webUser(req).ext, req.params.id, req.body?.body));
  app.post("/api/u/chats/:id/read", { preHandler: requireWebUser }, async (req) => chat.markRead(webUser(req).ext, req.params.id, req.body?.last));
  app.put("/api/u/chats/:id", { preHandler: requireWebUser }, async (req) => chat.rename(webUser(req).ext, req.params.id, req.body?.name));
  app.delete("/api/u/chats/:id/me", { preHandler: requireWebUser }, async (req) => chat.leave(webUser(req).ext, req.params.id));
  app.get("/api/u/team", { preHandler: requireWebUser }, async (req) => ({ contacts: await team(webUser(req).ext) }));
  app.put("/api/u/status", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const u = await pbx.updateUser(s.ext, { status: req.body?.status }, webBy(s));
    return { status: u.status };
  });
  // Réglages que l'utilisateur peut changer lui-même : mobile, renvois, code PIN de messagerie
  app.put("/api/u/settings", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const b = req.body || {};
    const input = {};
    if (b.mobile !== undefined) input.mobile = b.mobile;
    if (b.forwarding) input.forwarding = b.forwarding;
    if (b.voicemail) {
      input.voicemail = {};
      for (const k of ["pin", "email", "email_attach"]) if (b.voicemail[k] !== undefined) input.voicemail[k] = b.voicemail[k];
    }
    if (b.ring_mobile !== undefined) input.options = { ring_mobile: !!b.ring_mobile };
    if (b.status !== undefined) input.status = b.status;
    const u = await pbx.updateUser(s.ext, input, webBy(s));
    return { user: selfView(u) };
  });
  app.get("/api/u/app-token", { preHandler: requireWebUser }, async (req) => ({ active: await pbx.appTokenStatus(webUser(req).ext) }));
  app.post("/api/u/app-token", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const t = await pbx.createAppToken(s.ext, webBy(s));
    const url = appUrl(t.token);
    return { ...t, url, qr_svg: qrSvg(url) };
  });
  app.delete("/api/u/app-token", { preHandler: requireWebUser }, async (req) => { await pbx.revokeAppToken(webUser(req).ext); return { ok: true }; });

  // Messagerie vocale : liste, écoute, lu, suppression
  const vmRefresh = (ext) => ami.connect().then(() => ami.send({ Action: "VoicemailRefresh", Context: "default", Mailbox: ext })).catch(() => {});
  app.get("/api/u/voicemail", { preHandler: requireWebUser }, async (req) => {
    const ext = webUser(req).ext;
    const u = await pbx.getUser(ext);
    if (!u.voicemail.enabled) return { enabled: false, messages: [] };
    const known = await ai.insights(ext).catch(() => new Map());
    return { enabled: true, messages: vm.listMessages(ext).map((m) => ({ ...m, ai: known.get(admin.vmKey(ext, m)) || null })) };
  });
  app.get("/api/u/voicemail/:folder/:num/audio", { preHandler: requireWebUser }, async (req, reply) => {
    const { file, type } = vm.audioPath(webUser(req).ext, `${req.params.folder}/${req.params.num}`);
    return reply.type(type).header("cache-control", "private, no-store").send(fs.createReadStream(file));
  });
  app.post("/api/u/voicemail/:folder/:num/read", { preHandler: requireWebUser }, async (req) => {
    const ext = webUser(req).ext;
    const id = vm.markRead(ext, `${req.params.folder}/${req.params.num}`);
    await vmRefresh(ext);
    return { id };
  });
  app.delete("/api/u/voicemail/:folder/:num", { preHandler: requireWebUser }, async (req) => {
    const ext = webUser(req).ext;
    vm.deleteMessage(ext, `${req.params.folder}/${req.params.num}`);
    await vmRefresh(ext);
    return { ok: true };
  });

  app.get("/api/phones", { preHandler: requireUser }, async () => ({
    phones: await pbx.listPhones(), provisioning_url: await pbx.provisioningUrl(sipServer()) }));
  app.post("/api/phones/resync", { preHandler: requireUser }, async () => pbx.resyncAll());
  app.post("/api/phones/forget", { preHandler: requireUser }, async (req) => pbx.forgetDevice(req.body?.ext, req.body?.key));
  app.get("/api/phone-options", { preHandler: requireUser }, async () => ({
    ...pbx.phoneOptions(), provisioning_url: await pbx.provisioningUrl(sipServer()), timezone: pbxEnv().PBX_TIMEZONE || "Europe/Paris" }));
  app.get("/api/extensions/:id/phone.cfg", { preHandler: requireUser }, async (req, reply) => {
    // ?mac= : fichier d'un téléphone supplémentaire du poste
    const mac = String(req.query?.mac || "").toLowerCase().replace(/[^0-9a-f]/g, "") || null;
    const { user, text, format } = await pbx.phoneConfig(req.params.id, sipServer(), mac);
    const base = mac || user.phone.mac || "poste-" + user.id;   // téléphone supplémentaire : son propre fichier
    const fname = format === "grandstream" ? `cfg${base}.xml` : format === "snom" ? `${base}.xml` : `${base}.cfg`;
    reply.header("content-disposition", `attachment; filename="${fname}"`);
    return reply.type("text/plain; charset=utf-8").send(text);
  });
  app.post("/api/extensions/:id/phone/notify", { preHandler: requireUser }, async (req) => pbx.notifyPhone(req.params.id, req.body?.action));
  app.post("/api/extensions/:id/phone/admin", { preHandler: requireUser }, async (req) => pbx.resetPhoneAdmin(req.params.id));

  // Provisioning : fichiers demandés par les téléphones (sans session ; jeton secret dans l'URL)
  app.get("/prov/:token/:file", async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const f = provFails.get(ip);
    if (f && f.count >= 30 && f.until > Date.now()) return reply.code(429).send("Trop de requêtes");
    const out = await pbx.provisionFile(req.params.token, req.params.file, sipServer(), { ip, user_agent: req.headers["user-agent"] });
    if (!out) {
      const fresh = !f || f.until < Date.now();
      provFails.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60_000 });
      return reply.code(404).type("text/plain").send("Introuvable");
    }
    return reply.type(out.type ? `${out.type}; charset=utf-8` : "text/plain; charset=utf-8").header("cache-control", "no-store").send(out.text);
  });

  app.get("/api/extensions/:id/impact", { preHandler: requireUser }, async (req) => pbx.deleteImpact(req.params.id));
  app.delete("/api/extensions/:id", { preHandler: requireUser }, async (req) => {
    await guardTarget(req, req.params.id);
    return { ok: true, impact: await pbx.deleteExtension(req.params.id, req.query?.force === "1", currentUser(req).email) };
  });

  // ---------------------------------------------------------------- Gestion d'appels
  // Standard : état (ouvert / fermé / renvoyé) et réglages (destination quand fermé, numéros non concernés)
  app.post("/api/extensions/:id/phone/key", { preHandler: requireUser }, async (req) => {
    const type = req.body?.type;
    if (type !== "fwd" && type !== "standard") throw new UserError("Touche inconnue.");
    return pbx.addPhoneKey(req.params.id, type, currentUser(req)?.email || "console");
  });
  app.get("/api/standard", { preHandler: requireUser }, async () => {
    const users = await pbx.loadUsers();
    return { ...(await pbx.getStandard()), standardists: users.filter(isStandardist).map((u) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`.trim() || `Poste ${u.id}`, role: u.options.role })) };
  });
  app.post("/api/standard/state", { preHandler: requireUser }, async (req) => pbx.setStandardState(req.body || {}, currentUser(req)?.email || "console"));
  app.put("/api/standard", { preHandler: requireUser }, async (req) => pbx.setStandardConfig(req.body || {}, currentUser(req)?.email || ""));
  app.get("/api/callflow", { preHandler: requireUser }, async () => ({
    objects: await pbx.listObjects(), users: (await pbx.listExtensions()).map((u) => ({ id: u.id, name: u.name, status: u.status, disabled: u.disabled, registered: u.registered, voicemail: true, dids: u.dids || [] })),
    options: cfOptions, timezone: pbxEnv().PBX_TIMEZONE || "Europe/Paris",
    trunk_dids: (await pbx.listTrunks()).flatMap((t) => (t.dids || []).map((d) => ({ did: d, trunk: t.id }))),
  }));
  app.get("/api/callflow/:kind/:id", { preHandler: requireUser }, async (req) => pbx.getObject(req.params.kind, req.params.id));
  app.get("/api/callflow/:kind/:id/impact", { preHandler: requireUser }, async (req) => ({ refs: await pbx.objectImpact(req.params.kind, req.params.id) }));
  app.post("/api/callflow/:kind", { preHandler: requireUser }, async (req) => pbx.saveObject(req.params.kind, null, req.body || {}, currentUser(req).email));
  app.put("/api/callflow/:kind/:id", { preHandler: requireUser }, async (req) => pbx.saveObject(req.params.kind, req.params.id, req.body || {}, currentUser(req).email));
  app.delete("/api/callflow/:kind/:id", { preHandler: requireUser }, async (req) => pbx.deleteObject(req.params.kind, req.params.id, req.query?.force === "1", currentUser(req).email));
  // Annonces : WAV 8 kHz mono 16 bits, converti dans le navigateur, envoyé en base64
  const wavOf = (b) => (b?.wav ? Buffer.from(String(b.wav), "base64") : null);
  app.post("/api/prompts", { preHandler: requireUser, bodyLimit: 16 * 1024 * 1024 }, async (req) => pbx.savePrompt(null, req.body?.name, wavOf(req.body), currentUser(req).email));
  app.put("/api/prompts/:id", { preHandler: requireUser, bodyLimit: 16 * 1024 * 1024 }, async (req) => pbx.savePrompt(req.params.id, req.body?.name, wavOf(req.body), currentUser(req).email));
  app.get("/api/prompts/:id/audio", { preHandler: requireUser }, async (req, reply) =>
    reply.type("audio/wav").header("cache-control", "no-store").send(fs.createReadStream(await pbx.promptFile(req.params.id))));
  // Routage écrit en français : analyse sans IA ; si l'IA est activée, elle réécrit d'abord le texte libre dans les tournures comprises
  app.post("/api/callflow-parse", { preHandler: requireUser }, async (req) => {
    const text = String(req.body?.text || "").slice(0, 2000);
    const plain = await pbx.parseFlow(text);
    if (!(await ai.settings()).enabled || (plain.proposal && !plain.warnings.length)) return plain;
    try {
      const [users, objects] = await Promise.all([pbx.listExtensions(), pbx.loadObjects()]);
      const names = { utilisateurs: users.map((u) => `${u.name} (${u.id})`), ...Object.fromEntries(Object.entries({ group: "groupes", queue: "files", ivr: "svi", prompt: "annonces", groupvm: "messageries_de_groupe", schedule: "horaires" })
        .map(([k, l]) => [l, objects.filter((o) => o.kind === k).map((o) => o.name)])) };
      const rewritten = (await ai.text("flow", JSON.stringify({ texte: text, noms: names }))).trim();
      const smart = await pbx.parseFlow(rewritten.slice(0, 2000));
      const score = (r) => (r.proposal ? 0 : 100) + r.warnings.length;
      return score(smart) <= score(plain) ? { ...smart, ai_text: rewritten } : plain;
    } catch { return plain; }
  });
  app.get("/api/cdr", { preHandler: requireUser }, async (req) => pbx.callLog(req.query || {}));
  app.get("/api/cdr.csv", { preHandler: requireUser }, async (req, reply) => {
    const { calls } = await pbx.callLog({ ...(req.query || {}), limit: 5000 });
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Date", "Sens", "Statut", "De", "Nom", "Vers", "SDA", "Règle", "Répondu par", "Durée totale (s)", "Conversation (s)"].join(";"),
      ...calls.map((c) => [new Date(c.start).toLocaleString("fr-FR", { timeZone: pbxEnv().PBX_TIMEZONE || "Europe/Paris" }),
        { in: "Entrant", out: "Sortant", internal: "Interne" }[c.direction] || c.direction,
        { answered: "Répondu", missed: "Manqué", voicemail: "Messagerie", busy: "Occupé", failed: "Échec" }[c.status] || c.status, c.from.number, c.from.name, c.to.number, c.did, c.rule, c.answered_by, c.duration, c.talk].map(q).join(";"))];
    return reply.type("text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="journal-appels.csv"').send("\ufeff" + lines.join("\r\n"));
  });
  // Annuaire de l'entreprise
  app.get("/api/contacts", { preHandler: requireUser }, async (req) => ({ contacts: await pbx.listContacts(req.query?.q) }));
  app.post("/api/contacts", { preHandler: requireUser }, async (req) => pbx.saveContact(null, req.body, currentUser(req).email));
  app.put("/api/contacts/:id", { preHandler: requireUser }, async (req) => pbx.saveContact(req.params.id, req.body, currentUser(req).email));
  app.delete("/api/contacts/:id", { preHandler: requireUser }, async (req) => pbx.deleteContact(req.params.id));
  app.post("/api/contacts/import", { preHandler: requireUser, bodyLimit: 16 * 1024 * 1024 }, async (req) =>
    pbx.importContacts(req.body?.rows || parseCsv(req.body?.csv), !!req.body?.replace, currentUser(req).email));
  app.get("/api/contacts.csv", { preHandler: requireUser }, async (req, reply) =>
    reply.type("text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="annuaire.csv"').send(await pbx.contactsCsv()));
  // Import / export (CSV Callikoe ou 3CX) : trunks et règles sortantes réservés à l'installateur, comme leurs pages
  const transferGuard = (req) => {
    if (!TRANSFER_KINDS[req.params.kind]) throw Object.assign(new UserError("Type inconnu."), { status: 404 });
    if (req.role === "client" && INSTALLER_KINDS.includes(req.params.kind)) throw Object.assign(new UserError("Accès restreint : cette partie est réservée à l'installateur."), { status: 403 });
  };
  app.get("/api/transfer", { preHandler: requireUser }, async (req) => ({
    kinds: Object.entries(TRANSFER_KINDS).filter(([k]) => req.role !== "client" || !INSTALLER_KINDS.includes(k)).map(([id, k]) => ({ id, ...k })) }));
  app.get("/api/transfer/:kind", { preHandler: requireUser }, async (req) => { transferGuard(req); return { items: await transfer.items(req.params.kind) }; });
  app.post("/api/transfer/:kind/export", { preHandler: requireUser }, async (req) => {
    transferGuard(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const r = await transfer.exportKind(req.params.kind, { format: req.body?.format === "3cx" ? "3cx" : "callikoe", ids });
    audit(req, `export ${req.params.kind}`, true, `${r.count} ligne(s)`);
    return r;
  });
  app.post("/api/transfer/:kind/import", { preHandler: requireUser, bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    transferGuard(req);
    const apply = !!req.body?.apply;
    const r = await transfer.importKind(req.params.kind, String(req.body?.text || ""), { apply, consoleRoles: !currentUser(req)?.ext, by: currentUser(req).email });
    if (apply) audit(req, `import ${req.params.kind}`, true, `${r.lines.filter((l) => l.done).length} ligne(s) importée(s), ${r.counts.error} erreur(s)`);
    return r;
  });
  // ---------------------------------------------------------------- Appels perdus à rappeler (classés par priorité)
  async function callbacks() {
    const [log, vms, done, contacts] = await Promise.all([
      pbx.callLog({ days: 3, limit: 5000 }),
      db.query("SELECT box, caller_number, msg_at AS at, summary, urgent FROM pbxmaison_vm_ai WHERE at > now() - interval '4 days'").then((r) => r.rows).catch(() => []),
      db.query("SELECT key, at FROM pbxmaison_callback_done WHERE at > now() - interval '4 days'").then((r) => new Map(r.rows.map((x) => [x.key, new Date(x.at).toISOString()]))).catch(() => new Map()),
      pbx.listContacts().catch(() => []),
    ]);
    const aiMsgs = await db.query("SELECT caller AS caller_number, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS at, 'Standardiste IA : ' || message AS summary, urgent FROM pbxmaison_ai_messages WHERE at > now() - interval '4 days'")
      .then((r) => r.rows).catch(() => []);
    vms.push(...aiMsgs);
    const names = new Map();
    for (const c of contacts) for (const p of c.phones) names.set(sameNumberKey(p.number), c.name);
    return missedCallers(log.calls, { done, voicemails: vms, contacts: names, tz: pbxEnv().PBX_TIMEZONE || "Europe/Paris" });
  }
  const markDone = async (number, by) => {
    const key = sameNumberKey(number);
    if (key.length < 9) throw new UserError("Numéro invalide.");
    await db.query("INSERT INTO pbxmaison_callback_done (key, at, by_who) VALUES ($1, now(), $2) ON CONFLICT (key) DO UPDATE SET at = now(), by_who = $2", [key, by]);
    return { ok: true };
  };
  app.get("/api/callbacks", { preHandler: requireUser }, async () => ({ callbacks: await callbacks() }));
  app.post("/api/callbacks/done", { preHandler: requireUser }, async (req) => markDone(req.body?.number, currentUser(req).email));
  app.get("/api/u/callbacks", { preHandler: requireWebUser }, async (req) => { await pilotOf(req); return { callbacks: await callbacks() }; });
  app.post("/api/u/callbacks/done", { preHandler: requireWebUser }, async (req) => { const me = await pilotOf(req); return markDone(req.body?.number, `Pilote ${me.id} ${me.name}`); });

  // ---------------------------------------------------------------- Standardiste IA
  const receptionist = createReceptionist({ db, ami, ai, sendMail: (to, mail) => admin.sendMail(to, mail), tz: () => pbxEnv().PBX_TIMEZONE || "Europe/Paris", log: app.log });
  receptionist.listen(pbx.audioSocketPort());
  const localKeyOk = (req) => {
    const ipOk = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"];
    const k = String(req.query?.k || ""), want = pbx.speechKey();
    return ipOk && k.length === want.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want));
  };
  // ---------------------------------------------------------------- Appli mobile : sonnerie même fermée (notifications)
  const appPush = createAppPush({ db, relay: (p, body) => ai.relay(p, body), log: app.log, pbxName: () => pbxEnv().PBX_NAME || "" });
  // Postes qui ont un téléphone joignable par notification : notés dans Asterisk (cxapp/<poste>), seuls ceux-là passent par [cx-app]
  const syncAppFlags = async () => {
    try {
      await ami.connect();
      await ami.send({ Action: "DBDelTree", Family: "cxapp" }).catch(() => {});
      for (const ext of await appPush.appExtensions()) await ami.send({ Action: "DBPut", Family: "cxapp", Key: ext, Val: "1" });
    } catch (e) { app.log.warn({ err: e.message }, "Appli : postes avec notification non transmis au moteur"); }
  };
  setTimeout(syncAppFlags, 5000).unref();
  setInterval(syncAppFlags, 10 * 60_000).unref();
  app.get("/internal/app-call", async (req, reply) => {
    reply.type("text/plain; charset=utf-8");
    if (!localKeyOk(req)) return reply.code(403).send("");
    const q = req.query || {};
    try {
      if (q.poll) return appPush.poll(q.call);
      if (q.end) { appPush.endCall(q.call); return "ok"; }
      return await appPush.startCall({ ext: q.ext, call: q.call, num: q.num, name: q.name });
    } catch (e) { app.log.warn({ err: e.message }, "Appli : réveil impossible"); return ""; }
  });
  // Appels de l'appli : identifiée par le jeton de l'appareil (pas de session web)
  const appExt = async (req) => {
    const ext = await appPush.deviceExt(String(req.body?.device_token || req.query?.d || ""));
    if (!ext) throw Object.assign(new UserError("Ce téléphone n'est plus relié au poste : scanne un nouveau QR code."), { status: 401 });
    if (!(await pbx.webUserActive(ext))) throw Object.assign(new UserError("Ce poste est désactivé."), { status: 401 });
    return ext;
  };
  app.post("/app/push", async (req) => {
    const ext = await appPush.setPushToken(String(req.body?.device_token || ""), { token: req.body?.push_token, type: req.body?.push_type, env: req.body?.apns_env });
    if (!ext) throw Object.assign(new UserError("Ce téléphone n'est plus relié au poste."), { status: 401 });
    syncAppFlags();
    return { ok: true };
  });
  app.post("/app/sip", async (req) => {
    const ext = await appExt(req);
    const acc = await pbx.appSipAccount(ext);
    const sv = sipServer(), https = sv.tls, host = sv.host;
    return { ...acc, ws_url: `${https ? "wss" : "ws"}://${host}/ws`, domain: sv.fqdn || host };
  });
  app.post("/app/presence", async (req) => { appPush.presence(await appExt(req), req.body?.state === "background" ? "background" : "active"); return { ok: true }; });
  app.post("/app/ready", async (req) => ({ ok: appPush.ready(await appExt(req), req.body?.call) }));
  app.get("/app/call", async (req) => ({ state: appPush.callState(await appExt(req), req.query?.call) }));
  app.get("/internal/ai-call", async (req, reply) => {
    reply.type("text/plain; charset=utf-8");
    if (!localKeyOk(req)) return reply.code(403).send("");
    const q = req.query || {};
    try { return await receptionist.register({ from: q.from, name: q.name, chan: q.chan, did: q.did, mode: q.mode }); } catch { return ""; }
  });
  app.get("/api/ai-settings/receptionist", { preHandler: requireUser }, async () => {
    const [cfg, cf] = await Promise.all([receptionist.settings(), pbx.listObjects()]);
    const users = (await pbx.listExtensions()).map((u) => ({ id: u.id, name: u.name, vm: u.vm }));
    return { settings: cfg, voices: RT_VOICES, users, objects: cf.filter((o) => ["group", "queue", "ivr", "groupvm"].includes(o.kind)).map((o) => ({ kind: o.kind, id: o.id, number: o.number, name: o.name })) };
  });
  app.put("/api/ai-settings/receptionist", { preHandler: requireUser }, async (req) => {
    let next;
    try { next = validateReceptionist(req.body || {}, await receptionist.settings()); } catch (e) { throw new UserError(e.message, e.field); }
    await db.setSetting("receptionist", next);
    await pbx.applyDialplan();
    return { settings: next };
  });

  // ---------------------------------------------------------------- SVI parlé : appelé par le moteur téléphonique (CURL du dialplan), jamais depuis l'extérieur
  app.get("/internal/ivr-speech", async (req, reply) => {
    reply.type("text/plain; charset=utf-8");
    // Seulement en direct depuis le serveur : une requête relayée par Nginx (venue d'Internet) porte ses en-têtes de relais
    const ipOk = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"];
    const k = String(req.query?.k || ""), want = pbx.speechKey();
    if (!ipOk || k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return reply.code(403).send("");
    const u = String(req.query?.u || ""), id = String(req.query?.ivr || "");
    if (!/^[\w.-]{1,80}$/.test(u)) return "";
    const file = path.join(REC_DIR(), `svi-${u}.wav`);
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < 44 + 8000 * 2 * 0.4) return "";   // moins de 0,4 s : l'appelant n'a rien dit
      if (!(await ai.settings()).enabled) return "";
      const o = (await pbx.listObjects("ivr")).find((x) => x.id === id);
      if (!o?.data.speech) return "";
      const users = new Map((await pbx.loadUsers()).map((x) => [x.id, x]));
      const options = ivrOptions(o.data, { objects: await pbx.loadObjects(), users });
      const said = (await ai.transcribe(file)).trim();
      let key = localMatch(said, options);
      if (!key && said) {
        const a = String(await ai.text("ivr", JSON.stringify({ phrase: said, choix: options.map((x) => ({ touche: x.key, service: x.label, mots_cles: x.keywords })) }))).trim();
        key = options.find((x) => x.key === a.replace(/[^0-9*#]/g, "").slice(0, 1))?.key || "";
      }
      app.log.info({ ivr: o.number, said, key }, "SVI parlé");
      return key;
    } catch (e) { app.log.warn({ err: e.message }, "SVI parlé : échec"); return ""; }
    finally { fs.rm(file, { force: true }, () => {}); }
  });

  // ---------------------------------------------------------------- IA (relais du portail pro : la clé OpenAI n'est jamais sur le PBX)
  app.get("/api/ai-settings", { preHandler: requireUser }, async () => ({ ...(await ai.status()), voices: AI_VOICES }));
  app.put("/api/ai-settings", { preHandler: requireUser }, async (req) => ({ ...(await ai.saveSettings(req.body || {})), voices: AI_VOICES }));
  // Rapport mensuel au client (réglé par l'installateur)
  app.get("/api/ai-settings/report", { preHandler: requireUser }, async () => ({ ...(await admin.reportSettings()), last: await db.getSetting("report_last", null) }));
  app.put("/api/ai-settings/report", { preHandler: requireUser }, async (req) => admin.setReportSettings(req.body || {}));
  app.get("/api/ai-settings/report/preview", { preHandler: requireUser }, async (req, reply) => {
    const r = await admin.buildMonthlyReport({ previous: req.query?.current !== "1" });
    const html = r.attachments.length ? r.mail.html.replace(/cid:logo@callikoe/g, "/theme/logo") : r.mail.html;
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(`<!doctype html><meta charset="utf-8"><title>${r.mail.subject.replace(/[<>&]/g, "")}</title><body style="margin:0">${html}</body>`);
  });
  app.post("/api/ai-settings/report/test", { preHandler: requireUser }, async (req) => admin.sendMonthlyReport({ to: String(req.body?.to || "").trim() || null, force: true }));
  app.get("/api/ai", { preHandler: requireUser }, async () => {
    const s = await ai.settings();
    let musics = [], musics_error = "";
    if (s.enabled) { try { musics = await ai.musics(); } catch (e) { musics_error = e.message; } }
    return { enabled: s.enabled, voices: AI_VOICES, musics, musics_error };
  });
  app.get("/api/ai/music/:id", { preHandler: requireUser }, async (req, reply) => reply.type("audio/wav").header("cache-control", "private, max-age=3600").send(await ai.music(req.params.id)));
  app.post("/api/ai/speech", { preHandler: requireUser }, async (req) => {
    const wav = await ai.speech(String(req.body?.text || ""), req.body?.voice, req.body?.music || "");
    return { wav: wav.toString("base64"), seconds: Math.round(((wav.length - 44) / 16000) * 10) / 10 };
  });
  app.post("/api/ai/announce-text", { preHandler: requireUser }, async (req) => ({ text: await ai.text("announce", String(req.body?.idea || "").slice(0, 1000)) }));
  app.post("/api/ai/diagnose", { preHandler: requireUser }, async (req) => {
    const question = String(req.body?.question || "").trim();
    if (question.length < 5) throw new UserError("Décris le problème en une phrase (ex. « le poste 203 ne sonne pas quand on appelle le standard »).", "question");
    const facts = await diagnosisFacts(question);
    const answer = await ai.text("diagnose", diagnosisInput(question, facts));
    audit(req, "diagnostic IA", true, question.slice(0, 200));
    return { answer, used: Object.keys(facts).filter((k) => facts[k] != null) };
  });
  /** État du PBX utile au diagnostic : postes, trunks, Ouvert / Fermé, renvois, traceur des numéros cités, dernières alertes */
  async function diagnosisFacts(question) {
    const safe = (p) => p.catch(() => null);
    const nums = [...new Set((question.match(/\+?\d[\d .]{1,16}\d/g) || []).map((x) => x.replace(/[\s.]/g, "")))].slice(0, 3);
    const [ext, trunks, std, fw, alerts, routes] = await Promise.all([safe(pbx.listExtensions()), safe(pbx.listTrunks()), safe(pbx.getStandard()), safe(pbx.forwardsReport()),
      safe(admin.getAlerts()), safe(pbx.getRoutes())]);
    const traces = {};
    for (const n of nums) traces[n] = await safe(pbx.trace(n));
    return {
      "Postes (utilisateurs)": ext?.map((u) => ({ poste: u.id, nom: u.name, connecte: u.registered, appareils: u.contacts?.map((c) => c.device?.label), statut: u.status_label, desactive: u.disabled, renvois: u.forwards?.map((f) => f.text), role: u.role })),
      "Trunks (lignes opérateur)": trunks?.map((t) => ({ nom: t.id, operateur: t.operator, numero: t.number, etat: t.status?.label, sda: t.dids })),
      "Trunk des appels sortants": routes?.outbound_trunk || "aucun",
      "Ouvert / Fermé": std,
      "Renvois actifs": fw,
      "Traceur des numéros cités": nums.length ? traces : null,
      "Dernières alertes": alerts?.log?.slice(0, 15).map((a) => ({ le: a.at, titre: a.title, detail: a.text })),
    };
  }
  app.get("/api/trace", { preHandler: requireUser }, async (req) => pbx.trace(req.query?.n));
  app.get("/api/forwards", { preHandler: requireUser }, async () => ({ forwards: await pbx.forwardsReport() }));
  // Dépannage : tests d'appel (journalisés comme toute action de la console)
  app.post("/api/diag/inbound", { preHandler: requireUser }, async (req) => {
    const r = await pbx.diagInbound(String(req.body?.number || "").slice(0, 30));
    await audit(req, `Dépannage : test d'appel entrant vers ${r.query}`, r.verdict.level !== "bad", r.verdict.text);
    return r;
  });
  app.post("/api/diag/outbound", { preHandler: requireUser }, async (req) => {
    const r = await pbx.diagOutbound(String(req.body?.ext || ""), String(req.body?.number || "").slice(0, 30));
    await audit(req, `Dépannage : test d'appel sortant ${r.ext} → ${r.number}`, r.verdict.level !== "bad", r.verdict.text);
    return r;
  });
  app.post("/api/diag/ring", { preHandler: requireUser }, async (req) => {
    const r = await pbx.ringTest(String(req.body?.ext || ""));
    await audit(req, `Dépannage : test de sonnerie du poste ${r.ext}`, r.results.some((x) => x.rang), r.results.map((x) => `${x.label} : ${x.rang ? "a sonné" : "n'a pas sonné"}`).join(", "));
    return r;
  });

  app.get("/api/routes", { preHandler: requireUser }, async () => pbx.getRoutes());
  app.put("/api/routes", { preHandler: requireUser }, async (req) => pbx.setRoutes(req.body || {}));

  // ---------------------------------------------------------------- Règles sortantes
  app.get("/api/outbound", { preHandler: requireUser }, async () => admin.listOutbound());
  app.post("/api/outbound", { preHandler: requireFreshMfa }, async (req) => admin.saveOutbound(null, req.body || {}));
  app.put("/api/outbound/:id", { preHandler: requireFreshMfa }, async (req) => admin.saveOutbound(req.params.id, req.body || {}));
  app.delete("/api/outbound/:id", { preHandler: requireFreshMfa }, async (req) => admin.deleteOutbound(req.params.id));
  app.put("/api/outbound-order", { preHandler: requireFreshMfa }, async (req) => admin.orderOutbound(req.body?.ids));

  // ---------------------------------------------------------------- Sécurité
  app.get("/api/security", { preHandler: requireUser }, async () => admin.getSecurity());
  app.put("/api/security", { preHandler: requireFreshMfa }, async (req) => admin.setSecurity(req.body || {}, clientIp(req)));
  app.post("/api/security/ban", { preHandler: requireUser }, async (req) => admin.banIp(req.body?.ip, true));
  app.post("/api/security/unban", { preHandler: requireFreshMfa }, async (req) => admin.banIp(req.body?.ip, false));

  // ---------------------------------------------------------------- Enregistrements
  app.get("/api/recording", { preHandler: requireUser }, async () => admin.getRecording());
  app.put("/api/recording", { preHandler: requireUser }, async (req) => admin.setRecording(req.body || {}));
  app.get("/api/recordings", { preHandler: requireUser }, async (req) => admin.listRecordings(req.query || {}));
  app.get("/api/recordings/file", { preHandler: requireUser }, async (req, reply) => {
    const f = await admin.recordingFile(req.query?.f);
    if (req.query?.dl === "1") reply.header("content-disposition", `attachment; filename="appel-${path.basename(f)}"`);
    return reply.type("audio/wav").header("cache-control", "private, no-store").send(fs.createReadStream(f));
  });
  app.delete("/api/recordings/file", { preHandler: requireUser }, async (req) => admin.deleteRecording(req.query?.f));

  // ---------------------------------------------------------------- Capture réseau (pcap)
  app.get("/api/capture", { preHandler: requireUser }, async () => admin.listCaptures());
  app.post("/api/capture/start", { preHandler: requireUser }, async (req) => admin.startCapture(req.body || {}));
  app.post("/api/capture/stop", { preHandler: requireUser }, async () => admin.stopCapture());
  app.get("/api/capture/file/:name", { preHandler: requireUser }, async (req, reply) => {
    const f = admin.captureFile(req.params.name);
    return reply.type("application/vnd.tcpdump.pcap").header("content-disposition", `attachment; filename="${path.basename(f)}"`).header("cache-control", "private, no-store").send(fs.createReadStream(f));
  });
  app.get("/api/capture/file/:name/:call", { preHandler: requireUser }, async (req, reply) => {
    const f = admin.captureCallFile(req.params.name, req.params.call);
    return reply.type("application/vnd.tcpdump.pcap").header("content-disposition", `attachment; filename="${req.params.name.replace(/\.pcap$/, "")}-${path.basename(f)}"`).header("cache-control", "private, no-store").send(fs.createReadStream(f));
  });
  app.delete("/api/capture/file/:name", { preHandler: requireUser }, async (req) => admin.deleteCapture(req.params.name));

  // ---------------------------------------------------------------- Codes raccourcis
  app.get("/api/shortcodes", { preHandler: requireUser }, async () => admin.getShortcodes());
  app.put("/api/shortcodes", { preHandler: requireUser }, async (req) => admin.setShortcodes(req.body || {}));
  app.get("/api/u/shortcodes", { preHandler: requireWebUser }, async () => admin.getShortcodes());

  // ---------------------------------------------------------------- Sauvegardes
  app.get("/api/backups", { preHandler: requireUser }, async () => admin.getBackups());
  app.put("/api/backups", { preHandler: requireFreshMfa }, async (req) => admin.setBackups(req.body || {}));
  app.post("/api/backups/run", { preHandler: requireUser }, async () => admin.runBackup("manual"));
  app.post("/api/backups/test-remote", { preHandler: requireUser }, async (req) => admin.testRemote(req.body || {}));
  app.post("/api/backups/restore", { preHandler: requireFreshMfa }, async (req) => admin.restoreBackup(String(req.body?.file || "")));
  app.get("/api/backups/restore", { preHandler: requireUser }, async () => admin.restoreStatus());
  app.get("/api/backups/file/:file", { preHandler: requireUser }, async (req, reply) => {
    const f = (await import("./lib/backup.mjs")).backupPath(req.params.file);
    if (!f || !fs.existsSync(f)) return reply.code(404).send({ error: "Sauvegarde introuvable." });
    return reply.type("application/gzip").header("content-disposition", `attachment; filename="${req.params.file}"`).send(fs.createReadStream(f));
  });
  app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", { bodyLimit: 4 * 1024 ** 3 }, (req, payload, done) => done(null, payload));
    scope.post("/api/backups/upload", { preHandler: requireUser, bodyLimit: 4 * 1024 ** 3 }, async (req) => admin.stageUpload(req.body));
  });

  // ---------------------------------------------------------------- Mises à jour, licence
  app.get("/api/updates", { preHandler: requireUser }, async (req) => admin.getUpdates({ check: req.query?.check === "1" }));
  app.post("/api/updates/start", { preHandler: requireFreshMfa }, async () => admin.startUpdate());
  app.get("/api/updates/status", { preHandler: requireUser }, async () => admin.updateStatus());
  app.get("/api/system", { preHandler: requireUser }, async () => admin.getSystem());
  app.post("/api/system/firewall-check", { preHandler: requireUser }, async () => admin.firewallCheck());
  app.post("/api/system/restart-services", { preHandler: requireAdmin }, async () => admin.systemAction("restart-services"));
  app.post("/api/system/reboot", { preHandler: requireAdmin }, async () => admin.systemAction("reboot"));
  app.post("/api/system/purge-cdr", { preHandler: requireFreshMfa }, async (req) => admin.purgeCdr(req.body?.days));
  app.get("/api/license", { preHandler: requireUser }, async () => admin.getLicense());
  app.post("/api/license", { preHandler: requireAdmin }, async (req) => admin.setLicense(req.body?.token));

  // ---------------------------------------------------------------- Alertes
  app.get("/api/alerts", { preHandler: requireUser }, async () => admin.getAlerts());
  app.put("/api/alerts", { preHandler: requireUser }, async (req) => admin.setAlerts(req.body || {}));
  app.delete("/api/alerts/log", { preHandler: requireUser }, async () => admin.clearAlerts());
  app.post("/api/alerts/check", { preHandler: requireUser }, async () => { await admin.monitor(); return admin.getAlerts(); });
  app.post("/api/alerts/test-mail", { preHandler: requireUser }, async (req) => admin.testMail(req.body?.to));

  // ---------------------------------------------------------------- Passerelles et DECT
  app.get("/api/gateways", { preHandler: requireUser }, async () => admin.listGateways());
  app.post("/api/gateways", { preHandler: requireUser }, async (req) => admin.saveGateway(null, req.body || {}));
  app.put("/api/gateways/:id", { preHandler: requireUser }, async (req) => admin.saveGateway(req.params.id, req.body || {}));
  app.delete("/api/gateways/:id", { preHandler: requireUser }, async (req) => admin.deleteGateway(req.params.id));
  app.get("/api/gateways/:id/setup", { preHandler: requireUser }, async (req) => admin.gatewaySetup(req.params.id, sipServer()));

  app.get("/api/calls", { preHandler: requireUser }, async () => pbx.listCalls());

  // Application monopage : toute autre route renvoie index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Introuvable." });
    return reply.sendFile("index.html");
  });

  app.decorate("pbx", pbx);
  app.decorate("admin", admin);
  app.addHook("onClose", async () => { ami.close(); await db.end(); });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const app = await buildApp();
  await app.listen({ port: settings.port, host: settings.host });
  console.log(`Console Callikoe sur http://${settings.host}:${settings.port}`);
  // Après une mise à jour : régénère les fichiers lus par Asterisk (nouveau format éventuel)
  if (isConfigured()) app.pbx.applyDialplan().catch((e) => console.error("Plan de numérotation non régénéré :", e.message));
  // Suivi des connexions des téléphones (« connecté depuis… »)
  setInterval(() => { if (isConfigured()) app.pbx.trackDevices().catch(() => {}); }, 20_000).unref();
  // Codes de statut, surveillance (alertes), sauvegardes programmées, purge des enregistrements
  app.admin.start();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.close().then(() => process.exit(0)));
}
