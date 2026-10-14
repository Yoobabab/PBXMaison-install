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
import { hashPassword, verifyPassword, passwordProblem, createSession, readSession, createToken, readToken } from "./lib/auth.mjs";
import { createPbxService, routesPath, UserError } from "./lib/pbx.mjs";
import * as vm from "./lib/voicemail.mjs";
import { KINDS, DEST_TYPES as CF_DEST, GROUP_STRATEGIES, QUEUE_STRATEGIES, DAYS, STEP_TYPES, TERMINAL_STEPS, BRANCHES } from "./lib/callflow.mjs";
const cfOptions = { kinds: KINDS, dest_types: CF_DEST, group_strategies: GROUP_STRATEGIES, queue_strategies: QUEUE_STRATEGIES, days: DAYS, step_types: STEP_TYPES, terminal_steps: TERMINAL_STEPS, branches: BRANCHES };
import { tokenValid, consumeToken, checkSetupConfig, startApply, applyStatus, setupToken, etcFile } from "./lib/setup.mjs";

if (!settings.sessionSecret) { console.error("SESSION_SECRET manquant"); process.exit(1); }

export async function buildApp({ db, ami } = {}) {
  db ??= createDb(settings.db);
  ami ??= new Ami(settings.ami);
  await db.migrate();
  const pbx = createPbxService({ db, ami, templatesFile: TEMPLATES_FILE, routesFile: routesPath(VAR), env: pbxEnv });

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "warn" }, trustProxy: "127.0.0.1", bodyLimit: 1_048_576 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, "public"), index: ["index.html"] });

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
  const requireUser = async (req, reply) => {
    if (!currentUser(req)) return reply.code(401).send({ error: "Session expirée : reconnecte-toi." });
  };
  // Assistant : jeton d'installation tant qu'aucun administrateur n'existe, session ensuite
  const requireSetup = async (req, reply) => {
    if (currentUser(req)) return;
    const token = req.headers["x-setup-token"];
    if ((await userCount()) === 0 && tokenValid(token)) return;
    return reply.code(403).send({ error: "Lien d'installation invalide : utilise l'adresse affichée à la fin de l'installation." });
  };

  // ---------------------------------------------------------------- État général
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/state", async (req) => {
    const env = pbxEnv();
    return {
      configured: isConfigured(),
      has_admin: (await userCount()) > 0,
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

  app.post("/api/setup/admin", { preHandler: requireSetup }, async (req, reply) => {
    if (!isConfigured()) throw new UserError("Termine d'abord la configuration.");
    if ((await userCount()) > 0) throw new UserError("Le compte administrateur existe déjà.");
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new UserError(problem, "password");
    const email = pbxEnv().PBX_ADMIN_EMAIL.toLowerCase();
    await db.query("INSERT INTO pbxmaison_users (email, password_hash, last_login_at) VALUES ($1, $2, now())",
      [email, hashPassword(req.body.password)]);
    consumeToken();
    reply.setCookie(COOKIE, createSession(email, settings.sessionSecret), cookieOpts(req));
    return { ok: true, email };
  });

  // ---------------------------------------------------------------- Connexion
  const failures = new Map();
  app.post("/api/login", async (req, reply) => {
    const f = failures.get(req.ip);
    if (f && f.count >= 5 && f.until > Date.now()) return reply.code(429).send({ error: "Trop de tentatives : réessaie dans 15 minutes." });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const r = await db.query("SELECT password_hash FROM pbxmaison_users WHERE email = $1", [email]);
    if (!r.rowCount || !verifyPassword(req.body?.password, r.rows[0].password_hash)) {
      const fresh = !f || f.until < Date.now();
      failures.set(req.ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60_000 });
      return reply.code(401).send({ error: "E-mail ou mot de passe incorrect." });
    }
    failures.delete(req.ip);
    await db.query("UPDATE pbxmaison_users SET last_login_at = now() WHERE email = $1", [email]);
    reply.setCookie(COOKIE, createSession(email, settings.sessionSecret), cookieOpts(req));
    return { ok: true, email };
  });
  app.post("/api/logout", async (req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });
  app.get("/api/me", { preHandler: requireUser }, async (req) => ({ email: currentUser(req).email }));

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
    };
  });

  function sipServer() {
    const env = pbxEnv(), st = installState(), ss = setupState();
    return { fqdn: env.PBX_FQDN, dns_ok: ss.DNS_OK === "1", tls: ss.TLS === "1", public_ip: st.PUBLIC_IP,
      local_ip: st.LOCAL_IP, behind_nat: st.BEHIND_NAT === "1", host: ss.DNS_OK === "1" ? env.PBX_FQDN : st.PUBLIC_IP };
  }

  app.get("/api/templates", { preHandler: requireUser }, async () => pbx.templates());
  app.get("/api/trunks", { preHandler: requireUser }, async () => pbx.listTrunks());
  app.post("/api/trunks", { preHandler: requireUser }, async (req) => pbx.createTrunk(req.body || {}));
  app.put("/api/trunks/:id", { preHandler: requireUser }, async (req) =>
    pbx.createTrunk({ ...(req.body || {}), name: req.params.id, replace: true }));
  app.delete("/api/trunks/:id", { preHandler: requireUser }, async (req) => { await pbx.deleteTrunk(req.params.id); return { ok: true }; });

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
      return reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Callikoe</title><body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 16px;text-align:center">
        <h1 style="font-size:20px">Application Callikoe</h1><p>Ce QR code se scanne depuis l'application mobile Callikoe pour configurer ton poste automatiquement.</p></body></html>`);
    }
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const f = provFails.get(ip);
    if (f && f.count >= 30 && f.until > Date.now()) return reply.code(429).send({ error: "Trop de tentatives." });
    const out = await pbx.appProvision(String(req.query?.t || ""), sipServer());
    if (!out) {
      const fresh = !f || f.until < Date.now();
      provFails.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60_000 });
      return reply.code(404).send({ error: "QR code invalide ou expiré : demande-en un nouveau à l'administrateur." });
    }
    return reply.header("cache-control", "no-store").send(out);
  });

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
    return list.filter((x) => x.id !== self && !x.disabled).map((x) => ({
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
    ring_mobile: u.options.ring_mobile,
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
    };
  });
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
    const { user, text } = await pbx.phoneConfig(req.params.id, sipServer());
    reply.header("content-disposition", `attachment; filename="${user.phone.mac || "poste-" + user.id}.cfg"`);
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
    return reply.type("text/plain; charset=utf-8").header("cache-control", "no-store").send(out.text);
  });

  app.get("/api/extensions/:id/impact", { preHandler: requireUser }, async (req) => pbx.deleteImpact(req.params.id));
  app.delete("/api/extensions/:id", { preHandler: requireUser }, async (req) =>
    ({ ok: true, impact: await pbx.deleteExtension(req.params.id, req.query?.force === "1", currentUser(req).email) }));

  // ---------------------------------------------------------------- Gestion d'appels
  app.get("/api/callflow", { preHandler: requireUser }, async () => ({
    objects: await pbx.listObjects(), users: (await pbx.listExtensions()).map((u) => ({ id: u.id, name: u.name, status: u.status, disabled: u.disabled, registered: u.registered, voicemail: true })),
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
  app.get("/api/trace", { preHandler: requireUser }, async (req) => pbx.trace(req.query?.n));
  app.get("/api/forwards", { preHandler: requireUser }, async () => ({ forwards: await pbx.forwardsReport() }));

  app.get("/api/routes", { preHandler: requireUser }, async () => pbx.getRoutes());
  app.put("/api/routes", { preHandler: requireUser }, async (req) => pbx.setRoutes(req.body || {}));

  app.get("/api/calls", { preHandler: requireUser }, async () => pbx.listCalls());

  // Application monopage : toute autre route renvoie index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Introuvable." });
    return reply.sendFile("index.html");
  });

  app.decorate("pbx", pbx);
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
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.close().then(() => process.exit(0)));
}
