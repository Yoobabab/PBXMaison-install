/**
 * Logique téléphonique de la console : trunks, postes, routes, appels en cours.
 * Les objets PJSIP sont écrits dans les tables realtime d'Asterisk (ps_*) ;
 * Asterisk est rechargé via l'AMI.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { formatNumber, validateTemplate } from "../../pbx/lib/trunk-templates.mjs";

export const EMERGENCY = ["15", "17", "18", "112", "114", "115", "116000", "119", "191", "196", "197"];
const FORMATS = ["national", "e164", "e164_plus"];

export class UserError extends Error {
  constructor(message, field) { super(message); this.field = field; this.status = 400; }
}

export function loadTemplates(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.templates.map(validateTemplate);
}

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

  // ------------------------------------------------------------------ Postes
  async function listExtensions() {
    const r = await db.query(`
      SELECT e.id, x.name, e.callerid,
             (SELECT json_agg(json_build_object('uri', c.uri, 'user_agent', c.user_agent, 'via', c.via_addr,
                      'expires', c.expiration_time) ORDER BY c.expiration_time DESC)
              FROM ps_contacts c WHERE c.endpoint = e.id) AS contacts
      FROM ps_endpoints e LEFT JOIN pbxmaison_extensions x ON x.id = e.id
      WHERE e.context = 'from-internal'
      ORDER BY e.id`);
    const now = Math.floor(Date.now() / 1000);
    return r.rows.map((row) => {
      const contacts = (row.contacts || []).filter((c) => !c.expires || Number(c.expires) > now);
      return {
        id: row.id,
        name: row.name || (/"([^"]*)"/.exec(row.callerid || "")?.[1] ?? `Poste ${row.id}`),
        registered: contacts.length > 0,
        contacts: contacts.map((c) => ({ user_agent: c.user_agent || "", ip: c.via || (/@([^:;>]+)/.exec(c.uri || "")?.[1] ?? "") })),
      };
    });
  }

  function checkExtNumber(num) {
    if (!/^[1-9]\d{2}$/.test(num)) throw new UserError("Numéro de poste : 3 chiffres, de 100 à 999.", "number");
    if (EMERGENCY.includes(num)) throw new UserError(`${num} est un numéro d'urgence : choisis-en un autre.`, "number");
  }

  async function createExtension(input) {
    const num = String(input.number || "").trim();
    checkExtNumber(num);
    const name = String(input.name || "").replace(/["<>]/g, "").trim().slice(0, 40) || `Poste ${num}`;
    const exists = await db.query("SELECT 1 FROM ps_endpoints WHERE id = $1", [num]);
    if (exists.rowCount) throw new UserError(`Le poste ${num} existe déjà.`, "number");
    const password = genPassword();
    await db.tx(async (c) => {
      await c.query("INSERT INTO ps_auths (id, auth_type, username, password) VALUES ($1, 'userpass', $1, $2)", [num, password]);
      await c.query("INSERT INTO ps_aors (id, max_contacts, remove_existing, qualify_frequency) VALUES ($1, 3, 'yes', 60)", [num]);
      await c.query(
        `INSERT INTO ps_endpoints (id, aors, auth, context, disallow, allow, callerid, direct_media, rtp_symmetric,
           force_rport, rewrite_contact, dtmf_mode, language)
         VALUES ($1, $1, $1, 'from-internal', 'all', 'g722,alaw,ulaw', $2, 'no', 'yes', 'yes', 'yes', 'rfc4733', $3)`,
        [num, `"${name}" <${num}>`, language()],
      );
      await c.query("INSERT INTO pbxmaison_extensions (id, name) VALUES ($1, $2)", [num, name]);
    });
    return { id: num, name, password };
  }

  async function extensionSecret(num) {
    checkExtNumber(num);
    const r = await db.query("SELECT password FROM ps_auths WHERE id = $1", [num]);
    if (!r.rowCount) throw Object.assign(new UserError("Poste introuvable."), { status: 404 });
    return { id: num, password: r.rows[0].password };
  }

  async function deleteExtension(num) {
    checkExtNumber(num);
    await db.tx(async (c) => {
      for (const t of ["ps_endpoints", "ps_aors", "ps_auths"]) {
        await c.query(`DELETE FROM ${t} WHERE id = $1`, [num]);
      }
      await c.query("DELETE FROM ps_contacts WHERE endpoint = $1", [num]);
      await c.query("DELETE FROM pbxmaison_extensions WHERE id = $1", [num]);
    });
    const routes = await getRoutes();
    if (routes.inbound.includes(num)) await setRoutes({ ...routes, inbound: routes.inbound.filter((x) => x !== num) });
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
    let cid = "", fmt = "national";
    if (trunk) {
      const r = await db.query("SELECT outbound_cid, dial_format FROM pbxmaison_trunks WHERE id = $1", [trunk]);
      if (!r.rowCount) throw new UserError("Trunk introuvable.", "outbound_trunk");
      cid = r.rows[0].outbound_cid; fmt = r.rows[0].dial_format;
    }
    const value = { inbound, outbound_trunk: trunk };
    await db.setSetting("routes", value);
    const conf = [
      `; Routes — écrit par la console web (${new Date().toISOString()}). Ne pas modifier à la main.`,
      `INBOUND_TARGET = ${inbound.map((n) => `PJSIP/${n}`).join("&")}`,
      `OUTBOUND_TRUNK = ${trunk}`,
      `OUTBOUND_CID = ${cid}`,
      `OUTBOUND_FORMAT = ${fmt}`,
      "",
    ].join("\n");
    const tmp = `${routesFile}.tmp`;
    fs.writeFileSync(tmp, conf, { mode: 0o640 });
    fs.renameSync(tmp, routesFile);
    try { await ami.command("dialplan reload"); } catch { /* rechargé au démarrage d'Asterisk */ }
    return value;
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
    listExtensions, createExtension, extensionSecret, deleteExtension, nextFreeExtension,
    getRoutes, setRoutes, listCalls, registrationStatus,
  };
}

export const routesPath = (varDir) => path.join(varDir, "extensions_routes.conf");
