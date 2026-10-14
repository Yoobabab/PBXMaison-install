/**
 * Logique téléphonique de la console : trunks, postes, routes, appels en cours.
 * Les objets PJSIP sont écrits dans les tables realtime d'Asterisk (ps_*) ;
 * Asterisk est rechargé via l'AMI.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { formatNumber, validateTemplate } from "../../pbx/lib/trunk-templates.mjs";
import { UserError, STATUSES, buildUsersDialplan, buildVoicemail, defaultUser, displayName, forwardSummary, fromRow, ringsForGroups, userOpts, validateUser } from "./users.mjs";

export const EMERGENCY = ["15", "17", "18", "112", "114", "115", "116000", "119", "191", "196", "197"];
const FORMATS = ["national", "e164", "e164_plus"];

export { UserError };

export function loadTemplates(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.templates.map(validateTemplate);
}

const genAuthId = () => crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
const genPassword = () => crypto.randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
const hostOk = (h) => /^[A-Za-z0-9.-]+$/.test(h) && h.includes(".");

export function createPbxService({ db, ami, templatesFile, routesFile, env }) {
  const templates = () => loadTemplates(templatesFile);
  const countryCode = () => env().PBX_COUNTRY_CODE || "33";
  const language = () => env().PBX_LANGUAGE || "fr";

  async function reload(...modules) {
    for (const m of modules) {
      try { await ami.command(`module reload ${m}`); } catch { /* Asterisk arrêté : rechargé au démarrage */ }
    }
  }

  // ------------------------------------------------------------------ Trunks
  async function registrationStatus() {
    const map = {};
    try {
      for (const line of await ami.command("pjsip show registrations")) {
        const m = /^\s*([A-Za-z0-9_-]+)\/sip:\S+\s+\S+\s+(\w+)(?:\s+\(exp\.\s*(\d+)s\))?/.exec(line);
        if (m) map[m[1]] = { state: m[2], expires: m[3] ? Number(m[3]) : null };
      }
    } catch { /* AMI indisponible */ }
    return map;
  }

  const STATE_FR = {
    Registered: ["Enregistré", "ok"], Unregistered: ["Non enregistré", "bad"], Rejected: ["Refusé par l'opérateur", "bad"],
    Stopped: ["Arrêté", "bad"], Retrying: ["Nouvelle tentative…", "wait"], Unknown: ["Inconnu", "wait"],
  };

  async function listTrunks() {
    const [rows, reg] = await Promise.all([
      db.query(`SELECT t.*, r.server_uri, r.client_uri, r.outbound_proxy, e.allow, e.transport
                FROM pbxmaison_trunks t
                LEFT JOIN ps_registrations r ON r.id = t.id
                LEFT JOIN ps_endpoints e ON e.id = t.id
                ORDER BY t.created_at`),
      registrationStatus(),
    ]);
    const tpl = Object.fromEntries(templates().map((t) => [t.id, t]));
    return rows.rows.map((r) => {
      const st = reg[r.id];
      const [label, cls] = st ? (STATE_FR[st.state] || [st.state, "wait"]) : ["Moteur injoignable", "wait"];
      return {
        id: r.id, template: r.template, operator: tpl[r.template]?.label || r.template,
        host: r.host, number: r.number, outbound_cid: r.outbound_cid, username: r.username,
        proxy: r.outbound_proxy ? r.outbound_proxy.replace(/^sip:/, "").replace(/;lr$/, "") : "",
        codecs: (r.allow || "").split(","), transport: (r.transport || "").replace("transport-", ""),
        cid_format: r.cid_format, dial_format: r.dial_format, caller_format: r.caller_format,
        status: { code: st?.state || "Unknown", label, cls, expires: st?.expires ?? null },
      };
    });
  }

  async function createTrunk(input) {
    const name = String(input.name || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name)) throw new UserError("Nom : lettres minuscules, chiffres, - ou _ (ex. dstny, unyc-siege).", "name");
    const t = templates().find((x) => x.id === input.template);
    if (!t) throw new UserError("Choisis un opérateur.", "template");
    const exists = await db.query("SELECT 1 FROM ps_endpoints WHERE id = $1", [name]);
    if (exists.rowCount && !input.replace) throw new UserError("Ce nom est déjà utilisé (par un trunk ou un poste).", "name");

    const digits = String(input.number || "").replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length < 9) throw new UserError("Numéro principal du trunk invalide.", "number");
    const cc = countryCode();
    const host = String(input.host || t.registrar.host || "").trim();
    if (!hostOk(host)) throw new UserError("Serveur de l'opérateur invalide.", "host");
    const port = Number(input.port || t.registrar.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("Port invalide.", "port");
    let proxy = t.proxy;
    if (input.proxy !== undefined && String(input.proxy).trim() !== "") {
      const [ph, pp] = String(input.proxy).trim().split(":");
      if (!hostOk(ph)) throw new UserError("Proxy invalide.", "proxy");
      proxy = { host: ph, port: Number(pp) || port };
    } else if (input.proxy === "") proxy = null;
    const cidFormat = input.cid_format || t.outbound.cid_format;
    const dialFormat = input.dial_format || t.outbound.dial_format;
    const callerFormat = input.caller_format || t.inbound.caller_format;
    if (!FORMATS.includes(cidFormat) || !FORMATS.includes(dialFormat) || ![...FORMATS, "keep"].includes(callerFormat)) {
      throw new UserError("Format de numéro invalide.", "cid_format");
    }

    const trunkNumber = formatNumber(digits, t.number_format, cc);
    const outboundCid = formatNumber(digits, cidFormat, cc);
    const user = String(input.username || "").trim() || (t.auth_username_default === "trunk_number" ? trunkNumber : "");
    if (!user || /\s|@/.test(user)) throw new UserError("Identifiant SIP manquant ou invalide.", "username");
    const password = String(input.password || "");
    if (!password && !input.replace) throw new UserError("Mot de passe SIP manquant.", "password");

    const fromUser = t.outbound.from_user === "auth_id" ? user : t.outbound.from_user === "trunk_number" ? trunkNumber : null;
    const contactUser = t.outbound.contact_user === "trunk_number" ? trunkNumber : user;
    const proxyUri = proxy ? `sip:${proxy.host}:${proxy.port};lr` : null;
    const transport = `transport-${t.transport}`;
    const expiration = Math.max(60, t.registration.interval);

    await db.tx(async (c) => {
      let pass = password;
      if (!pass) {
        const old = await c.query("SELECT password FROM ps_auths WHERE id = $1", [`${name}-auth`]);
        pass = old.rows[0]?.password;
        if (!pass) throw new UserError("Mot de passe SIP manquant.", "password");
      }
      for (const [table, id] of [["ps_registrations", name], ["ps_endpoint_id_ips", name], ["ps_endpoints", name],
        ["ps_aors", name], ["ps_auths", `${name}-auth`], ["pbxmaison_trunks", name]]) {
        await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      }
      await c.query("INSERT INTO ps_auths (id, auth_type, username, password) VALUES ($1, 'userpass', $2, $3)",
        [`${name}-auth`, user, pass]);
      await c.query("INSERT INTO ps_aors (id, contact, qualify_frequency) VALUES ($1, $2, 60)",
        [name, `sip:${host}:${port}`]);
      await c.query(
        `INSERT INTO ps_endpoints (id, transport, aors, outbound_auth, context, disallow, allow, from_user, from_domain,
           outbound_proxy, direct_media, rtp_symmetric, force_rport, rewrite_contact, dtmf_mode, language,
           send_pai, trust_id_inbound, set_var)
         VALUES ($1, $2, $1, $3, 'from-trunk', 'all', $4, $5, $6, $7, 'no', 'yes', 'yes', 'yes', 'rfc4733', $8, $9, 'yes', $10)`,
        [name, transport, `${name}-auth`, t.codecs.join(","), fromUser, host, proxyUri, language(),
          t.outbound.pai ? "yes" : "no", `TRUNK_OPTS=${callerFormat},${t.inbound.did_from}`],
      );
      await c.query("INSERT INTO ps_endpoint_id_ips (id, endpoint, match) VALUES ($1, $1, $2)",
        [name, proxy ? `${host},${proxy.host}` : host]);
      await c.query(
        `INSERT INTO ps_registrations (id, transport, outbound_auth, server_uri, client_uri, contact_user, outbound_proxy,
           retry_interval, forbidden_retry_interval, fatal_retry_interval, max_retries, expiration,
           auth_rejection_permanent, line, endpoint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 60, 600, 600, 10000, $8, 'no', 'yes', $1)`,
        [name, transport, `${name}-auth`, `sip:${host}:${port}`, `sip:${user}@${host}:${port}`, contactUser, proxyUri, expiration],
      );
      await c.query(
        `INSERT INTO pbxmaison_trunks (id, template, label, host, number, outbound_cid, dial_format, cid_format, caller_format, did_from, username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [name, t.id, t.label, host, trunkNumber, outboundCid, dialFormat, cidFormat, callerFormat, t.inbound.did_from, user],
      );
    });
    await reload("res_pjsip.so", "res_pjsip_endpoint_identifier_ip.so", "res_pjsip_outbound_registration.so");
    const routes = await getRoutes();
    if (routes.outbound_trunk === name) await setRoutes(routes); // numéro présenté éventuellement modifié
    return { id: name };
  }

  async function deleteTrunk(id) {
    await db.tx(async (c) => {
      for (const [table, key] of [["ps_registrations", id], ["ps_endpoint_id_ips", id], ["ps_endpoints", id],
        ["ps_aors", id], ["ps_auths", `${id}-auth`], ["pbxmaison_trunks", id]]) {
        await c.query(`DELETE FROM ${table} WHERE id = $1`, [key]);
      }
    });
    await reload("res_pjsip_outbound_registration.so", "res_pjsip.so");
    const routes = await getRoutes();
    if (routes.outbound_trunk === id) await setRoutes({ ...routes, outbound_trunk: "" });
  }

  // ------------------------------------------------------------------ Utilisateurs (postes)
  async function loadUsers() {
    const r = await db.query("SELECT * FROM pbxmaison_extensions ORDER BY id");
    return r.rows.map(fromRow);
  }

  async function registrations() {
    const r = await db.query(`
      SELECT e.id,
             (SELECT json_agg(json_build_object('uri', c.uri, 'user_agent', c.user_agent, 'via', c.via_addr,
                      'expires', c.expiration_time) ORDER BY c.expiration_time DESC)
              FROM ps_contacts c WHERE c.endpoint = e.id) AS contacts
      FROM ps_endpoints e WHERE e.context = 'from-internal'`);
    const now = Math.floor(Date.now() / 1000);
    const map = new Map();
    for (const row of r.rows) {
      const contacts = (row.contacts || []).filter((c) => !c.expires || Number(c.expires) > now);
      map.set(row.id, contacts.map((c) => ({ user_agent: c.user_agent || "", ip: c.via || (/@([^:;>]+)/.exec(c.uri || "")?.[1] ?? "") })));
    }
    return map;
  }

  /** Postes présents dans Asterisk mais sans fiche (créés avant les fiches) : fiche minimale. */
  async function adoptOrphans() {
    await db.query(`INSERT INTO pbxmaison_extensions (id, name)
      SELECT e.id, COALESCE(substring(e.callerid from '"([^"]*)"'), 'Poste ' || e.id)
      FROM ps_endpoints e WHERE e.context = 'from-internal'
        AND NOT EXISTS (SELECT 1 FROM pbxmaison_extensions x WHERE x.id = e.id)`);
  }

  async function listExtensions() {
    await adoptOrphans();
    const [users, reg] = await Promise.all([loadUsers(), registrations()]);
    return users.map((u) => {
      const contacts = reg.get(u.id) || [];
      return {
        id: u.id, name: displayName(u), first_name: u.first_name, last_name: u.last_name, email: u.email,
        status: u.status, status_label: STATUSES[u.status], disabled: u.options.disabled,
        registered: contacts.length > 0, contacts, dids: u.dids, mobile: u.mobile,
        forwards: forwardSummary(u),
      };
    });
  }

  function checkExtNumber(num) {
    if (!/^[1-9]\d{2}$/.test(num)) throw new UserError("Numéro de poste : 3 chiffres, de 100 à 999.", "number");
    if (EMERGENCY.includes(num)) throw new UserError(`${num} est un numéro d'urgence : choisis-en un autre.`, "number");
  }

  async function validationContext(selfId) {
    const users = await loadUsers();
    const didOwners = new Map();
    for (const u of users) for (const d of u.dids) didOwners.set(d, u.id);
    return { cc: countryCode(), extensions: new Set([...users.map((u) => u.id), selfId]), didOwners };
  }

  async function saveUser(c, u, by) {
    await c.query(
      `UPDATE pbxmaison_extensions SET name = $2, first_name = $3, last_name = $4, email = $5, mobile = $6,
         outbound_cid = $7, dids = $8, status = $9, forwarding = $10, options = $11, voicemail = $12,
         updated_at = now(), updated_by = $13 WHERE id = $1`,
      [u.id, displayName(u), u.first_name, u.last_name, u.email, u.mobile, u.outbound_cid, u.dids, u.status,
        JSON.stringify(u.forwarding), JSON.stringify(u.options), JSON.stringify(u.voicemail), by || ""]);
    await c.query("UPDATE ps_endpoints SET callerid = $2, set_var = $3 WHERE id = $1",
      [u.id, `"${displayName(u)}" <${u.id}>`, userOpts(u)]);
  }

  async function createExtension(input, by) {
    const num = String(input.number || "").trim();
    checkExtNumber(num);
    const exists = await db.query("SELECT 1 FROM ps_endpoints WHERE id = $1", [num]);
    if (exists.rowCount) throw new UserError(`Le poste ${num} existe déjà.`, "number");
    // Compatibilité : « name » seul (ancienne API) → prénom
    const data = { ...input };
    if (data.first_name === undefined && data.last_name === undefined) data.first_name = input.name || `Poste ${num}`;
    const u = validateUser(data, defaultUser(num), await validationContext(num));
    const password = genPassword();
    const authId = genAuthId();
    await db.tx(async (c) => {
      await c.query("INSERT INTO ps_auths (id, auth_type, username, password) VALUES ($1, 'userpass', $2, $3)", [num, authId, password]);
      await c.query("INSERT INTO ps_aors (id, max_contacts, remove_existing, qualify_frequency) VALUES ($1, 3, 'yes', 60)", [num]);
      await c.query(
        `INSERT INTO ps_endpoints (id, aors, auth, context, disallow, allow, callerid, direct_media, rtp_symmetric,
           force_rport, rewrite_contact, dtmf_mode, language, mailboxes)
         VALUES ($1, $1, $1, 'from-internal', 'all', 'g722,alaw,ulaw', '', 'no', 'yes', 'yes', 'yes', 'rfc4733', $2, $3)`,
        [num, language(), `${num}@default`],
      );
      await c.query("INSERT INTO pbxmaison_extensions (id, name) VALUES ($1, $2)", [num, displayName(u)]);
      await saveUser(c, u, by);
    });
    await applyDialplan();
    return { id: num, name: displayName(u), auth_id: authId, password };
  }

  async function getUser(num) {
    checkExtNumber(num);
    await adoptOrphans();
    const r = await db.query("SELECT * FROM pbxmaison_extensions WHERE id = $1", [num]);
    if (!r.rowCount) throw Object.assign(new UserError("Utilisateur introuvable."), { status: 404 });
    const u = fromRow(r.rows[0]);
    const reg = (await registrations()).get(num) || [];
    return { ...u, name: displayName(u), registered: reg.length > 0, contacts: reg, forwards: forwardSummary(u),
      updated_at: r.rows[0].updated_at, updated_by: r.rows[0].updated_by };
  }

  async function updateUser(num, input, by) {
    const current = await getUser(num);
    const u = validateUser(input, current, await validationContext(num));
    await db.tx((c) => saveUser(c, u, by));
    await db.query("UPDATE ps_endpoints SET mailboxes = $2 WHERE id = $1", [num, u.voicemail.enabled ? `${num}@default` : null]);
    await applyDialplan();
    return getUser(num);
  }

  async function extensionSecret(num) {
    checkExtNumber(num);
    const r = await db.query("SELECT username, password FROM ps_auths WHERE id = $1", [num]);
    if (!r.rowCount) throw Object.assign(new UserError("Poste introuvable."), { status: 404 });
    return { id: num, auth_id: r.rows[0].username, password: r.rows[0].password };
  }

  async function resetSecret(num) {
    checkExtNumber(num);
    const password = genPassword();
    const r = await db.query("UPDATE ps_auths SET password = $2 WHERE id = $1", [num, password]);
    if (!r.rowCount) throw Object.assign(new UserError("Poste introuvable."), { status: 404 });
    return extensionSecret(num);
  }

  async function deleteExtension(num) {
    checkExtNumber(num);
    const users = await loadUsers();
    const refs = users.filter((u) => u.id !== num && Object.values(u.forwarding).some((d) => d?.type === "extension" && d.target === num));
    if (refs.length) throw new UserError(`Impossible : ${refs.map((u) => `${u.id} (${displayName(u)})`).join(", ")} renvoie vers ce poste. Modifie d'abord ces renvois.`);
    await db.tx(async (c) => {
      for (const t of ["ps_endpoints", "ps_aors", "ps_auths"]) {
        await c.query(`DELETE FROM ${t} WHERE id = $1`, [num]);
      }
      await c.query("DELETE FROM ps_contacts WHERE endpoint = $1", [num]);
      await c.query("DELETE FROM pbxmaison_extensions WHERE id = $1", [num]);
    });
    const routes = await getRoutes();
    if (routes.inbound.includes(num)) await setRoutes({ ...routes, inbound: routes.inbound.filter((x) => x !== num) });
    else await applyDialplan();
  }

  // ------------------------------------------------------------------ Routes
  async function getRoutes() {
    return { inbound: [], outbound_trunk: "", ...(await db.getSetting("routes", {})) };
  }

  async function setRoutes(input) {
    const inbound = [...new Set((input.inbound || []).map(String))];
    for (const n of inbound) checkExtNumber(n);
    if (inbound.length) {
      const r = await db.query("SELECT id FROM ps_endpoints WHERE id = ANY($1) AND context = 'from-internal'", [inbound]);
      if (r.rowCount !== inbound.length) throw new UserError("Un des postes choisis n'existe pas.", "inbound");
    }
    const trunk = String(input.outbound_trunk || "");
    if (trunk) {
      const r = await db.query("SELECT 1 FROM pbxmaison_trunks WHERE id = $1", [trunk]);
      if (!r.rowCount) throw new UserError("Trunk introuvable.", "outbound_trunk");
    }
    const value = { inbound, outbound_trunk: trunk };
    await db.setSetting("routes", value);
    await applyDialplan();
    return value;
  }

  function writeAtomic(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o640 });
    fs.renameSync(tmp, file);
  }

  /** Réécrit les fichiers lus par Asterisk (routes, utilisateurs, messagerie) puis recharge. */
  async function applyDialplan() {
    const routes = await getRoutes();
    const users = await loadUsers();
    let cid = "", fmt = "national", cidFmt = "national";
    if (routes.outbound_trunk) {
      const r = await db.query("SELECT outbound_cid, dial_format, cid_format FROM pbxmaison_trunks WHERE id = $1", [routes.outbound_trunk]);
      if (r.rowCount) ({ outbound_cid: cid, dial_format: fmt, cid_format: cidFmt } = r.rows[0]);
    }
    const byId = new Map(users.map((u) => [u.id, u]));
    const ringing = routes.inbound.filter((n) => byId.has(n) ? ringsForGroups(byId.get(n)) : true);
    writeAtomic(routesFile, [
      `; Routes — écrit par la console web (${new Date().toISOString()}). Ne pas modifier à la main.`,
      `INBOUND_TARGET = ${ringing.map((n) => `PJSIP/${n}`).join("&")}`,
      `OUTBOUND_TRUNK = ${routes.outbound_trunk}`,
      `OUTBOUND_CID = ${cid}`,
      `OUTBOUND_FORMAT = ${fmt}`,
      `OUTBOUND_CID_FORMAT = ${cidFmt}`,
      "",
    ].join("\n"));
    const dir = path.dirname(routesFile);
    writeAtomic(path.join(dir, "extensions_users.conf"), buildUsersDialplan(users));
    writeAtomic(path.join(dir, "voicemail_users.conf"), buildVoicemail(users));
    try { await ami.command("dialplan reload"); } catch { /* rechargé au démarrage d'Asterisk */ }
    try { await ami.command("module reload app_voicemail.so"); } catch { /* idem */ }
  }

  // ------------------------------------------------------------------ Appels en cours
  async function listCalls() {
    let lines;
    try { lines = await ami.command("core show channels concise"); } catch { return { available: false, calls: [] }; }
    const chans = lines.map((l) => l.split("!")).filter((f) => f.length > 12 && f[0].startsWith("PJSIP/"))
      .map((f) => ({ channel: f[0], context: f[1], exten: f[2], state: f[4], app: f[5], data: f[6],
        callerid: f[7], duration: Number(f[11]) || 0, bridged: f[12] }));
    const trunkIds = new Set((await db.query("SELECT id FROM pbxmaison_trunks")).rows.map((r) => r.id));
    const endpointOf = (ch) => /^PJSIP\/(.+)-[0-9a-f]+$/.exec(ch)?.[1] || "";
    const seen = new Set();
    const calls = [];
    for (const c of chans) {
      if (seen.has(c.channel)) continue;
      seen.add(c.channel);
      const other = chans.find((o) => o.channel === c.bridged);
      if (other) seen.add(other.channel);
      const a = endpointOf(c.channel), b = other ? endpointOf(other.channel) : "";
      const inbound = c.context === "from-trunk" || c.context === "inbound" || c.context === "trunk-in";
      const trunk = trunkIds.has(a) ? a : trunkIds.has(b) ? b : "";
      calls.push({
        direction: trunk ? (inbound ? "entrant" : "sortant") : "interne",
        from: c.callerid || a,
        to: inbound
          ? (b || (c.app === "Dial" ? (c.data.split(",")[0].match(/PJSIP\/(\w+)/g) || []).map((x) => x.slice(6)).join(", ") : "") || c.exten)
          : (c.exten !== "s" ? c.exten : b),
        trunk,
        state: c.state === "Up" ? "En communication" : c.state === "Ringing" || c.state === "Ring" ? "Sonne" : c.state,
        duration: Math.max(c.duration, other?.duration || 0),
      });
    }
    return { available: true, calls };
  }

  async function nextFreeExtension() {
    const r = await db.query("SELECT id FROM ps_endpoints WHERE id ~ '^[1-9][0-9]{2}$'");
    const used = new Set(r.rows.map((x) => x.id));
    for (let n = 200; n <= 899; n++) if (!used.has(String(n)) && !EMERGENCY.includes(String(n))) return String(n);
    return "";
  }

  return {
    templates, listTrunks, createTrunk, deleteTrunk,
    listExtensions, createExtension, extensionSecret, resetSecret, deleteExtension, nextFreeExtension,
    getUser, updateUser, applyDialplan,
    getRoutes, setRoutes, listCalls, registrationStatus,
  };
}

export const routesPath = (varDir) => path.join(varDir, "extensions_routes.conf");
