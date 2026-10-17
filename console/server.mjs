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
import { isManager, isStandardist } from "./lib/users.mjs";
import * as vm from "./lib/voicemail.mjs";
import { parseCsv } from "./lib/contacts.mjs";
import { migrateChat, createChat } from "./lib/chat.mjs";
import { KINDS, DEST_TYPES as CF_DEST, GROUP_STRATEGIES, QUEUE_STRATEGIES, DAYS, STEP_TYPES, TERMINAL_STEPS, BRANCHES } from "./lib/callflow.mjs";
const cfOptions = { kinds: KINDS, dest_types: CF_DEST, group_strategies: GROUP_STRATEGIES, queue_strategies: QUEUE_STRATEGIES, days: DAYS, step_types: STEP_TYPES, terminal_steps: TERMINAL_STEPS, branches: BRANCHES };
import { createAdminService } from "./lib/admin.mjs";
import { CX_MODE, CX_TENANT } from "./lib/config.mjs";
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
  const admin = createAdminService({ db, ami, pbx });
  await admin.migrate();
  pbx.setExtraDialplan(() => admin.dialplanParts());

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "warn" }, trustProxy: "127.0.0.1", bodyLimit: 1_048_576 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, "public"), index: ["index.html"] });
  registerThemeRoutes(app);   // couleur, logo et fond d'écran choisis dans la console du serveur multi-tenant

  const COOKIE = "pbxm_session";
  const cookieOpts = (req) => ({ path: "/", httpOnly: true, sameSite: "strict", secure: req.protocol === "https", maxAge: 12 * 3600 });

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
  const CLIENT_DENY = /^\/api\/(outbound|outbound-order|security|shortcodes|backups|updates|license|alerts|gateways|system|accounts|audit|recording|setup|templates|routes|capture|extensions\/[^/]+\/(impersonate|secret|phone\/admin|phone\.cfg))(\/|$)/;
  const requireUser = async (req, reply) => {
    const u = currentUser(req);
    if (!u) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." });
    // Compte supprimé ou rôle modifié : pris en compte immédiatement (compte du serveur multi-tenant : rôle publié par la console du serveur)
    const hr = u.hub ? hubRole(u.email) : null;
    if (u.hub && (CX_MODE !== "tenant" || !hr)) { reply.clearCookie(COOKIE, { path: "/" }); return reply.code(401).send({ error: "Ce compte n'a plus accès au serveur." }); }
    const row = u.hub ? { role: HUB_TO_PBX_ROLE[hr] } : u.ext ? ((await pbx.consoleUserActive(u.ext)) ? { role: "client" } : null)
      : (await db.query("SELECT role FROM pbxmaison_users WHERE email = $1", [u.email])).rows[0];
    if (!row) { reply.clearCookie(COOKIE, { path: "/" }); return reply.code(401).send({ error: "Ce compte n'existe plus." }); }
    req.role = row.role;
    if (!u.mfa) return reply.code(403).send({ error: "Active d'abord la double authentification.", need_totp_setup: true });
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
        await audit(req, `Connexion à la console (utilisateur ${x.id}, accès restreint)`, true, "", email);
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
    if (u.ext) return { email: u.email, totp: true, mfa: true, recovery_left: 0, role: "client", name: "", ext: u.ext };
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
  app.post("/api/extensions", { preHandler: requireUser }, async (req) => pbx.createExtension(req.body || {}, currentUser(req).email));
  app.get("/api/extensions/:id", { preHandler: requireUser }, async (req) => ({ user: await pbx.getUser(req.params.id), server: sipServer() }));
  app.put("/api/extensions/:id", { preHandler: requireUser }, async (req) => pbx.updateUser(req.params.id, req.body || {}, currentUser(req).email));
  app.get("/api/extensions/:id/secret", { preHandler: requireUser }, async (req) => pbx.extensionSecret(req.params.id));
  app.post("/api/extensions/:id/secret", { preHandler: requireUser }, async (req) => pbx.resetSecret(req.params.id));
  const provFails = new Map(); // échecs par IP (provisioning et appli) : 30 / 10 min
  // Application mobile : QR code valable 48 h
  const appUrl = (token) => { const sv = sipServer(); return `${sv.tls ? "https" : "http"}://${sv.host}/app/provision?t=${token}`; };
  const qrSvg = (text) => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
  app.get("/api/extensions/:id/app-token", { preHandler: requireUser }, async (req) => ({ active: await pbx.appTokenStatus(req.params.id) }));
  app.post("/api/extensions/:id/app-token", { preHandler: requireUser }, async (req) => {
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
    if (!webUser(req)) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." });
  };
  const randomWebPassword = () => crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) + String(crypto.randomInt(10, 99));
  app.get("/softphone", async (req, reply) => reply.sendFile("softphone.html"));

  app.post("/api/extensions/:id/web-password", { preHandler: requireUser }, async (req) => {
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
    // Masqués : vus de personne ; groupes de visibilité : on ne voit que son groupe
    return list.filter((x) => x.id !== self && !x.disabled && !x.hidden && (x.team || "") === (me?.team || "")).map((x) => ({
      id: x.id, name: x.name, first_name: x.first_name, last_name: x.last_name, email: x.email,
      status: x.status, registered: x.registered, line: lines.get(x.id) || "",
      devices: [...new Set(x.contacts.map((c) => c.device?.kind).filter(Boolean))],
    }));
  };
  const webBy = (s) => (s.imp ? `${s.imp} (incarnation)` : `${s.ext} (softphone)`);
  const selfView = (u) => ({
    id: u.id, name: u.name, first_name: u.first_name, last_name: u.last_name, status: u.status, email: u.email,
    mobile: u.mobile, dids: u.dids, outbound_cid: u.outbound_cid,
    forwarding: u.forwarding, voicemail: { enabled: u.voicemail.enabled, pin: u.voicemail.pin, skip_pin: u.voicemail.skip_pin },
    ring_mobile: u.options.ring_mobile, manager: isManager(u), standardist: isStandardist(u),
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
    let closed = "";
    if (std) {
      const d = std.closed_dest || {}, users = await pbx.loadUsers(), objs = await pbx.listObjects();
      const uname = (id) => { const x = users.find((y) => y.id === id); return x ? `${x.first_name} ${x.last_name}`.trim() || `poste ${id}` : id; };
      closed = d.type === "hangup" ? (d.prompt ? "Annonce, puis fin d'appel" : "Fin d'appel") : d.type === "user" ? uname(d.target) : d.type === "user_vm" ? `Messagerie de ${uname(d.target)}`
        : d.type === "external" ? d.target.replace(/(\d{2})(?=\d)/g, "$1 ") : objs.find((o) => o.id === d.target)?.name || "";
    }
    return { forward: u.forwarding.always, last: u.forwarding.always_last, codes,
      standard: std && { state: std.state, target: std.target, since: std.since, by: std.by, label: std.label, closed } };
  });
  // Standard (tout le PBX) : ouvert / fermé / renvoyé, par les utilisateurs Standardiste, Responsable ou Accès console
  app.get("/api/u/standard", { preHandler: requireWebUser }, async (req) => {
    const u = await pbx.getUser(webUser(req).ext);
    if (!isStandardist(u)) throw Object.assign(new UserError("Réservé aux standardistes : demande à l'administrateur du PBX de te donner ce rôle."), { status: 403 });
    const { state, target, since, by, label } = await pbx.getStandard();
    return { state, target, since, by, label };
  });
  app.post("/api/u/standard", { preHandler: requireWebUser }, async (req) => {
    const s = webUser(req);
    const u = await pbx.getUser(s.ext);
    if (!isStandardist(u)) throw Object.assign(new UserError("Réservé aux standardistes : demande à l'administrateur du PBX de te donner ce rôle."), { status: 403 });
    const { state, target, since, by, label } = await pbx.setStandardState(req.body || {}, `poste ${s.ext} (${s.imp ? "incarnation" : "softphone / appli"})`);
    return { state, target, since, by, label };
  });
  // Plannings d'appels : modifiables par les utilisateurs « Responsable » (fiche utilisateur › Général › Rôle)
  const PLAN_FIELDS = ["scenarios", "branches", "outside", "week", "week_b", "alternate", "ref_monday", "holidays_fr", "holiday_scenario", "days", "override"];
  async function managerOf(req) {
    const u = await pbx.getUser(webUser(req).ext);
    if (!isManager(u)) throw Object.assign(new UserError("Réservé aux responsables : demande à l'administrateur du PBX de te donner ce rôle."), { status: 403 });
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
    const r = await pbx.saveObject("planning", o.id, input, `${u.id} ${u.name} (responsable)`);
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
    if (b.voicemail?.pin !== undefined) input.voicemail = { pin: b.voicemail.pin };
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
    return { enabled: u.voicemail.enabled, messages: u.voicemail.enabled ? vm.listMessages(ext) : [] };
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
  app.get("/api/phone-options", { preHandler: requireUser }, async () => ({
    ...pbx.phoneOptions(), provisioning_url: await pbx.provisioningUrl(sipServer()), timezone: pbxEnv().PBX_TIMEZONE || "Europe/Paris" }));
  app.get("/api/extensions/:id/phone.cfg", { preHandler: requireUser }, async (req, reply) => {
    // ?mac= : fichier d'un téléphone supplémentaire du poste
    const mac = String(req.query?.mac || "").toLowerCase().replace(/[^0-9a-f]/g, "") || null;
    const { user, text, format } = await pbx.phoneConfig(req.params.id, sipServer(), mac);
    const base = (mac && user.phone.mac) || user.phone.mac || "poste-" + user.id;
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
  app.delete("/api/extensions/:id", { preHandler: requireUser }, async (req) =>
    ({ ok: true, impact: await pbx.deleteExtension(req.params.id, req.query?.force === "1", currentUser(req).email) }));

  // ---------------------------------------------------------------- Gestion d'appels
  // Standard : état (ouvert / fermé / renvoyé) et réglages (destination quand fermé, numéros non concernés)
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
  app.post("/api/callflow-parse", { preHandler: requireUser }, async (req) => pbx.parseFlow(String(req.body?.text || "").slice(0, 2000)));
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
