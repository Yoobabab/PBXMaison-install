/**
 * Console web du PBX PBXMaison.
 * Écoute en local (127.0.0.1:8080) derrière Nginx, sous l'utilisateur système « pbxmaison ».
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import qrcode from "qrcode-generator";
import { settings, VAR, TEMPLATES_FILE, pbxEnv, installState, setupState, isConfigured, activationCode } from "./lib/config.mjs";
import { createDb } from "./lib/db.mjs";
import { Ami } from "./lib/ami.mjs";
import { hashPassword, verifyPassword, passwordProblem, createSession, readSession } from "./lib/auth.mjs";
import { createPbxService, routesPath, UserError } from "./lib/pbx.mjs";
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
