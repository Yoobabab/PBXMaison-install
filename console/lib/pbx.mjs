/**
 * Logique téléphonique de la console : trunks, postes, routes, appels en cours.
 * Les objets PJSIP sont écrits dans les tables realtime d'Asterisk (ps_*) ;
 * Asterisk est rechargé via l'AMI.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { formatNumber, validateTemplate } from "../../pbx/lib/trunk-templates.mjs";
import { CX_MODE, KAMAILIO_URI, VAR as CX_VAR, settings as CX_SETTINGS } from "./config.mjs";
import { REC_DIR } from "./recording.mjs";
import { numberRisk, deviceCategory, CATEGORY_LABELS } from "./watch.mjs";
import { runConfigure } from "./admin.mjs";
import { RING_TYPES, RINGERS, MODELS, LANGUAGES, DATE_FORMATS, TIME_FORMATS, TIMEZONES, BACKLIGHT, SCREENSAVER, TRANSFER, LED, TRANSPORTS, KEY_TYPES, EXPANSIONS,
  phoneFromStored, validatePhone, buildYealinkCfg, randomPassword, identifyDevice, deviceKey, isPublicIp, contactSource, connectionType, modelById, addToggleKey } from "./phones.mjs";
import { buildFanvilCfg, buildSnomXml, buildGrandstreamXml, buildGatewayFile, provRequest, GATEWAY_MODELS } from "./devices.mjs";
import { parseRouting } from "./nlroute.mjs";
import { summarize, forUser } from "./cdr.mjs";
import { validateContact, yealinkPhonebook, buildPhonebookDialplan, contactName, PHONE_TYPES } from "./contacts.mjs";
import { pathNow, ringTargets, parseContacts, deviceStates, inboundVerdict, simulateOutbound } from "./diagnose.mjs";
import { defaultSecurity } from "./security.mjs";
import { KINDS, validateObject, buildCallflowDialplan, buildQueues, buildMoh, mohClasses, buildGroupVoicemail, mailboxesByUser, referencesTo, traceNumber, listForwards } from "./callflow.mjs";
import { sees, nationalNumber, UserError, STATUSES, buildUsersDialplan, buildVoicemail, defaultUser, displayName, forwardSummary, fromRow, ringsForGroups, userOpts, validateUser } from "./users.mjs";
import { readTheme, wallpaperName } from "./theme.mjs";
import { defaultStandard, parseState, stateValue, validateState, validateConfig as validateStandardConfig, buildStandardDialplan, describeState } from "./standard.mjs";

export const EMERGENCY = ["15", "17", "18", "112", "114", "115", "116000", "119", "191", "196", "197"];
const FORMATS = ["national", "e164", "e164_plus"];

export { UserError };

/** SDA du trunk : un numéro ou une tranche (0465001530-0465001539) par ligne → liste au format national. */
export function expandDids(input, cc = "33") {
  const lines = (Array.isArray(input) ? input : String(input ?? "").split(/[\n,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [a, b] = line.split(/\s*(?:-|à|→)\s*(?=[+0-9])/);
    const first = nationalNumber(a, cc);
    if (!first) throw new UserError(`SDA invalide : ${line}`, "dids");
    if (b === undefined) { out.push(first); continue; }
    const last = nationalNumber(b, cc);
    if (!last || last.length !== first.length || last.slice(0, -4) !== first.slice(0, -4) || last < first) {
      throw new UserError(`Tranche invalide : ${line} (ex. 04 65 00 15 30 - 04 65 00 15 39)`, "dids");
    }
    const n = Number(last.slice(-4)) - Number(first.slice(-4)) + 1;
    if (n > 1000) throw new UserError(`Tranche trop grande : ${line} (1000 numéros au maximum).`, "dids");
    for (let i = 0; i < n; i++) out.push(first.slice(0, -4) + String(Number(first.slice(-4)) + i).padStart(4, "0"));
  }
  return [...new Set(out)];
}

export function loadTemplates(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.templates.map(validateTemplate);
}

const genAuthId = () => crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
const genPassword = () => crypto.randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
const hostOk = (h) => /^[A-Za-z0-9.-]+$/.test(h) && h.includes(".");

const WEB_CODECS = "g722,alaw,ulaw,vp8,h264";
/** SDA d'un trunk : son numéro principal (au format national) puis les SDA ajoutées. */
const trunkDidList = (row, cc = "33") => [...new Set([nationalNumber(row.number || "", cc) || "", ...(row.dids || [])].filter(Boolean))];

export function createPbxService({ db, ami, templatesFile, routesFile, env }) {
  // Parties du plan de numérotation fournies par les autres modules (règles sortantes, sécurité, codes, enregistrement)
  let extra = async () => ({ globals: [], dialplan: "" });
  const setExtraDialplan = (fn) => { extra = fn; };
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
        host: r.host, number: r.number, outbound_cid: r.outbound_cid, username: r.username, port: Number(/:(\d+)(?:;|$)/.exec(r.server_uri || "")?.[1]) || null,
        proxy: CX_MODE === "tenant" ? (r.op_proxy || "") : r.outbound_proxy ? r.outbound_proxy.replace(/^sip:/, "").replace(/(;|\^3B)lr$/, "") : "",
        codecs: (r.allow || "").split(","), transport: (r.transport || "").replace("transport-", ""),
        cid_format: r.cid_format, dial_format: r.dial_format, caller_format: r.caller_format, dids: trunkDidList(r, countryCode()), extra_dids: r.dids || [],
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
    // Codecs choisis (ordre = priorité puis secours) ; sinon ceux conseillés pour l'opérateur
    const CODECS_OK = ["alaw", "ulaw", "g722", "gsm"];
    let codecs = t.codecs.filter((c) => CODECS_OK.includes(c));
    if (input.codecs !== undefined && String(input.codecs).trim() !== "") {
      const list = (Array.isArray(input.codecs) ? input.codecs : String(input.codecs).split(",")).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
      if (!list.length || list.some((c) => !CODECS_OK.includes(c)) || new Set(list).size !== list.length) throw new UserError("Codecs invalides : coche au moins un codec.", "codecs");
      codecs = list;
    }
    if (!codecs.length) codecs = ["alaw", "ulaw"];
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
    let dids = null;
    if (input.dids !== undefined) dids = expandDids(input.dids, cc);

    const fromUser = t.outbound.from_user === "auth_id" ? user : t.outbound.from_user === "trunk_number" ? trunkNumber : null;
    // Serveur multi-tenant : le PBX passe par l'aiguilleur SIP ; le Contact du trunk est un jeton unique (il désigne ce client)
    const tenant = CX_MODE === "tenant";
    let contactUser = t.outbound.contact_user === "trunk_number" ? trunkNumber : user;
    if (tenant) {
      const old = input.replace ? (await db.query("SELECT contact_user FROM pbxmaison_trunks WHERE id = $1", [name])).rows[0]?.contact_user : null;
      contactUser = old || `cx${crypto.randomBytes(8).toString("hex")}`;
    }
    const proxyUri = tenant ? KAMAILIO_URI : proxy ? `sip:${proxy.host}:${proxy.port}^3Blr` : null;
    // Multi-tenant : pas de transport imposé (le PBX parle en UDP à l'aiguilleur, qui passe en TCP/TLS vers l'opérateur si besoin).
    // Un transport imposé lierait aussi le son (RTP) à 127.0.0.1 : l'opérateur ne pourrait plus l'envoyer.
    const transport = tenant ? null : `transport-${t.transport}`;
    const expiration = Math.max(60, t.registration.interval);

    if (dids === null && input.replace) dids = (await db.query("SELECT dids FROM pbxmaison_trunks WHERE id = $1", [name])).rows[0]?.dids || [];
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
        [name, transport, `${name}-auth`, codecs.join(","), fromUser, host, proxyUri, language(),
          t.outbound.pai ? "yes" : "no", `TRUNK_OPTS=${callerFormat},${t.inbound.did_from}`],
      );
      // Appels entrants : reconnus par l'adresse de l'opérateur (et, en multi-tenant, par le jeton « line » du Contact)
      if (!tenant) await c.query("INSERT INTO ps_endpoint_id_ips (id, endpoint, match) VALUES ($1, $1, $2)",
        [name, proxy ? `${host},${proxy.host}` : host]);
      // Multi-tenant : l'aiguilleur SIP désigne le trunk dans l'en-tête X-CX-Trunk (jeton secret, jamais accepté depuis Internet)
      else await c.query("INSERT INTO ps_endpoint_id_ips (id, endpoint, match_header) VALUES ($1, $1, $2)", [name, `X-CX-Trunk: ${contactUser}`]);
      await c.query(
        `INSERT INTO ps_registrations (id, transport, outbound_auth, server_uri, client_uri, contact_user, outbound_proxy,
           retry_interval, forbidden_retry_interval, fatal_retry_interval, max_retries, expiration,
           auth_rejection_permanent, line, endpoint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 60, 600, 600, 10000, $8, 'no', 'yes', $1)`,
        [name, transport, `${name}-auth`, `sip:${host}:${port}`, `sip:${user}@${host}:${port}`, contactUser, proxyUri, expiration],
      );
      await c.query(
        `INSERT INTO pbxmaison_trunks (id, template, label, host, number, outbound_cid, dial_format, cid_format, caller_format, did_from, username, dids,
           op_proxy, contact_user, port, transport)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [name, t.id, t.label, host, trunkNumber, outboundCid, dialFormat, cidFormat, callerFormat, t.inbound.did_from, user, dids || [],
          proxy ? `${proxy.host}:${proxy.port}` : null, contactUser, port, t.transport],
      );
    });
    await reload("res_pjsip.so", "res_pjsip_endpoint_identifier_ip.so", "res_pjsip_outbound_registration.so");
    const published = await publishRoutes();
    const routes = await getRoutes();
    if (routes.outbound_trunk === name) await setRoutes(routes); // numéro présenté éventuellement modifié
    else if (!routes.outbound_trunk) await setRoutes({ ...routes, outbound_trunk: name }); // 1er trunk : trunk par défaut des appels sortants
    return { id: name, ...(published?.warning ? { warning: published.warning } : {}) };
  }

  /**
   * Serveur multi-tenant : publie pour l'aiguilleur SIP les comptes des trunks (Contact), leurs serveurs et les SDA de ce PBX.
   * Une SDA ou un compte déjà pris par un autre client est refusé par l'aiguilleur : signalé dans warning.
   */
  async function publishRoutes() {
    if (CX_MODE !== "tenant") return null;
    const rows = (await db.query("SELECT * FROM pbxmaison_trunks")).rows;
    const data = {
      trunks: rows.map((r) => ({ contact_user: r.contact_user, host: r.host, port: r.port || 5060, transport: r.transport || "udp", proxy: r.op_proxy || null })),
      dids: [...new Set(rows.flatMap((r) => trunkDidList(r, countryCode())))],
      // Réseaux autorisés pour les postes (Sécurité) : appliqués par l'aiguilleur SIP du serveur
      sip_allow: ((await db.getSetting("security", {})) || {}).sip_allow || [],
    };
    fs.writeFileSync(path.join(CX_VAR, "kamailio-routes.json.new"), JSON.stringify(data));
    fs.renameSync(path.join(CX_VAR, "kamailio-routes.json.new"), path.join(CX_VAR, "kamailio-routes.json"));
    const r = await runConfigure(["kamailio-sync"], { timeout: 30_000 });
    const res = r.lines[0] || {};
    const mine = (res.conflicts || []).filter((c) => c.refused === (process.env.CX_TENANT || ""));
    return mine.length ? { warning: `Déjà utilisé par un autre PBX du serveur : ${mine.map((c) => `${c.what} ${c.key}`).join(", ")}. Les appels correspondants n'arriveront pas ici.` } : { ok: true };
  }

  async function deleteTrunk(id) {
    await db.tx(async (c) => {
      for (const [table, key] of [["ps_registrations", id], ["ps_endpoint_id_ips", id], ["ps_endpoints", id],
        ["ps_aors", id], ["ps_auths", `${id}-auth`], ["pbxmaison_trunks", id]]) {
        await c.query(`DELETE FROM ${table} WHERE id = $1`, [key]);
      }
    });
    await reload("res_pjsip_outbound_registration.so", "res_pjsip.so");
    await publishRoutes();
    const routes = await getRoutes();
    if (routes.outbound_trunk === id) await setRoutes({ ...routes, outbound_trunk: "" });
  }

  // ------------------------------------------------------------------ Utilisateurs (postes)
  const tz = () => env().PBX_TIMEZONE || "Europe/Paris";
  const withPhone = (row) => ({ ...fromRow(row), phone: phoneFromStored(row.phone, tz()) });
  async function loadUsers() {
    const r = await db.query("SELECT * FROM pbxmaison_extensions ORDER BY id");
    return r.rows.map(withPhone);
  }

  async function registrations() {
    const r = await db.query(`
      SELECT e.id,
             (SELECT json_agg(json_build_object('uri', c.uri, 'user_agent', c.user_agent, 'via', c.via_addr, 'path', c.path,
                      'expires', c.expiration_time) ORDER BY c.expiration_time DESC)
              FROM ps_contacts c WHERE c.endpoint = e.id) AS contacts
      FROM ps_endpoints e WHERE e.context = 'from-internal'`);
    const now = Math.floor(Date.now() / 1000);
    const map = new Map();
    for (const row of r.rows) {
      const contacts = (row.contacts || []).filter((c) => !c.expires || Number(c.expires) > now);
      const key = row.id.replace(/-web$/, "");
      const list = map.get(key) || [];
      map.set(key, list.concat(contacts.map((c) => {
        // rewrite_contact=yes : l'hôte du contact est l'adresse vue par le PBX ; Via = adresse annoncée par l'appareil.
        // Multi-tenant : le poste passe par l'aiguilleur, qui note son adresse réelle dans le Path (received=sip:IP:port)
        const source = contactSource(c, CX_MODE === "tenant");
        const sourceIp = source?.[1] || "";
        // Multi-tenant : le Via du dessus est celui de l'aiguilleur ; l'adresse locale du poste est celle de son Contact
        const localIp = CX_MODE === "tenant" && c.path ? (/@\[?([^\]:;>]+)/.exec(c.uri || "")?.[1] || "") : c.via || "";
        return { uri: c.uri || "", user_agent: c.user_agent || "", ip: sourceIp || localIp, source_ip: sourceIp, source_port: source?.[2] || "",
          local_ip: localIp, device: row.id.endsWith("-web") ? (/Callikoe-App/i.test(c.user_agent || "") ? { ...identifyDevice(c.user_agent), kind: "mobile", label: "Appli mobile Callikoe" } : { ...identifyDevice(c.user_agent), kind: "web", label: "Softphone web" }) : identifyDevice(c.user_agent),
          connection: connectionType(sourceIp, localIp, []) };
      })));
    }
    return map;
  }

  /** Postes présents dans Asterisk mais sans fiche (créés avant les fiches) : fiche minimale. */
  async function adoptOrphans() {
    await db.query(`INSERT INTO pbxmaison_extensions (id, name)
      SELECT e.id, COALESCE(substring(e.callerid from '"([^"]*)"'), 'Poste ' || e.id)
      FROM ps_endpoints e WHERE e.context = 'from-internal' AND e.id ~ '^[1-9][0-9]{2}$'
        AND NOT EXISTS (SELECT 1 FROM pbxmaison_extensions x WHERE x.id = e.id)`);
  }

  async function listExtensions() {
    await adoptOrphans();
    const [users, reg] = await Promise.all([loadUsers(), registrations()]);
    return users.map((u) => {
      const contacts = reg.get(u.id) || [];
      return {
        id: u.id, name: displayName(u), first_name: u.first_name, last_name: u.last_name, email: u.email,
        status: u.status, status_label: STATUSES[u.status], disabled: u.options.disabled, hidden: !!u.options.hidden, team: u.options.team || "",
        registered: contacts.length > 0, contacts, dids: u.dids, mobile: u.mobile, phone_model: u.phone.model,
        forwards: forwardSummary(u), always: u.forwarding.always, vm: !!u.voicemail.enabled, role: u.options.role || "user",
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
    // SDA déjà prises par une règle, un routage, un planning, un groupe, une file ou un SVI
    for (const o of await loadObjects()) for (const d of o.data.dids || []) didOwners.set(d, `${o.kind === "rule" ? "la règle entrante" : (KINDS[o.kind] || "l'objet").toLowerCase()} « ${o.name} »`);
    return { cc: countryCode(), extensions: new Set([...users.map((u) => u.id), selfId]), didOwners };
  }

  async function saveUser(c, u, by) {
    await c.query(
      `UPDATE pbxmaison_extensions SET name = $2, first_name = $3, last_name = $4, email = $5, mobile = $6,
         outbound_cid = $7, dids = $8, status = $9, forwarding = $10, options = $11, voicemail = $12,
         updated_at = now(), updated_by = $13, phone = COALESCE($14, phone) WHERE id = $1`,
      [u.id, displayName(u), u.first_name, u.last_name, u.email, u.mobile, u.outbound_cid, u.dids, u.status,
        JSON.stringify(u.forwarding), JSON.stringify(u.options), JSON.stringify(u.voicemail), by || "",
        u.phone ? JSON.stringify(u.phone) : null]);
    await c.query("UPDATE ps_endpoints SET callerid = $2, set_var = $3 WHERE id IN ($1::text, $1::text || '-web')",
      [u.id, `"${displayName(u)}" <${u.id}>`, userOpts(u)]);
  }

  // Endpoint WebRTC du softphone web : <poste>-web (mêmes renvois, même messagerie, même numéro présenté)
  async function createWebEndpoint(c, u) {
    const id = `${u.id}-web`;
    const exists = await c.query("SELECT 1 FROM ps_endpoints WHERE id = $1", [id]);
    if (exists.rowCount) return;
    await c.query("DELETE FROM ps_auths WHERE id = $1", [id]);
    await c.query("DELETE FROM ps_aors WHERE id = $1", [id]);
    await c.query("INSERT INTO ps_auths (id, auth_type, username, password) VALUES ($1, 'userpass', $1, $2)", [id, genPassword()]);
    await c.query("INSERT INTO ps_aors (id, max_contacts, remove_existing, qualify_frequency) VALUES ($1, 5, 'yes', 0)", [id]);
    await c.query(
      `INSERT INTO ps_endpoints (id, aors, auth, context, disallow, allow, callerid, direct_media, webrtc, dtls_auto_generate_cert,
         dtmf_mode, language, mailboxes, set_var, max_video_streams)
       VALUES ($1, $1, $1, 'from-internal', 'all', '${WEB_CODECS}', $2, 'no', 'yes', 'yes', 'rfc4733', $3, $4, $5, 16)`,
      [id, `"${displayName(u)}" <${u.id}>`, language(), u.voicemail.enabled ? `${u.id}@default` : null, userOpts(u)]);
  }
  async function ensureWebEndpoints() {
    // Proxy enregistré avec « ;lr » : Asterisk coupait la valeur au « ; » (proxy refusé) → « ^3B »
    for (const t of ["ps_endpoints", "ps_registrations"]) {
      await db.query(`UPDATE ${t} SET outbound_proxy = regexp_replace(outbound_proxy, ';lr$', '^3Blr') WHERE outbound_proxy LIKE '%;lr'`);
    }
    if (CX_MODE === "tenant") {
      // PBX importé d'un serveur seul : ses trunks passent par l'aiguilleur SIP (jeton de Contact, proxy de l'opérateur gardé à part)
      const old = await db.query(`SELECT t.id, t.contact_user, r.outbound_proxy, r.server_uri, r.transport FROM pbxmaison_trunks t
        JOIN ps_registrations r ON r.id = t.id WHERE t.contact_user IS NULL OR r.outbound_proxy IS DISTINCT FROM $1`, [KAMAILIO_URI]);
      for (const r of old.rows) {
        const cu = r.contact_user || `cx${crypto.randomBytes(8).toString("hex")}`;
        const opProxy = r.outbound_proxy && r.outbound_proxy !== KAMAILIO_URI ? r.outbound_proxy.replace(/^sip:/, "").replace(/(;|\^3B)lr$/, "") : null;
        const m = /^sip:[^:;]+(?::(\d+))?/.exec(r.server_uri || "");
        await db.query(`UPDATE pbxmaison_trunks SET contact_user = $2, op_proxy = COALESCE(op_proxy, $3), port = COALESCE(port, $4), transport = COALESCE(transport, $5) WHERE id = $1`,
          [r.id, cu, opProxy, Number(m?.[1]) || 5060, String(r.transport || "transport-udp").replace("transport-", "")]);
        await db.query("UPDATE ps_registrations SET contact_user = $2, outbound_proxy = $3, line = 'yes', endpoint = $1 WHERE id = $1", [r.id, cu, KAMAILIO_URI]);
        await db.query("UPDATE ps_endpoints SET outbound_proxy = $2 WHERE id = $1", [r.id, KAMAILIO_URI]);
        await db.query("DELETE FROM ps_endpoint_id_ips WHERE id = $1", [r.id]);
      }
      if (old.rowCount) await reload("res_pjsip.so", "res_pjsip_endpoint_identifier_ip.so", "res_pjsip_outbound_registration.so").catch(() => {});
      await db.query(`UPDATE ps_aors a SET support_path = 'yes' FROM ps_endpoints e WHERE e.aors = a.id AND e.context = 'from-internal' AND e.id !~ '-web$' AND a.support_path IS DISTINCT FROM 'yes'`);
      await db.query(`UPDATE ps_endpoints SET rewrite_contact = 'no' WHERE context = 'from-internal' AND id !~ '-web$' AND rewrite_contact IS DISTINCT FROM 'no'`);
      const tr = await db.query("UPDATE ps_endpoints SET transport = NULL WHERE context = 'from-trunk' AND transport IS NOT NULL");
      const hd = await db.query(`INSERT INTO ps_endpoint_id_ips (id, endpoint, match_header)
        SELECT t.id, t.id, 'X-CX-Trunk: ' || t.contact_user FROM pbxmaison_trunks t
        WHERE t.contact_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ps_endpoint_id_ips i WHERE i.id = t.id)`);
      if (hd.rowCount) await reload("res_pjsip_endpoint_identifier_ip.so").catch(() => {});
      await db.query("UPDATE ps_registrations SET transport = NULL WHERE transport IS NOT NULL");
      if (tr.rowCount) await reload("res_pjsip.so").catch(() => {});
      try { await publishRoutes(); } catch { /* l'aiguilleur sera mis à jour au prochain changement */ }
    }
    // Plusieurs téléphones par utilisateur (+ softphone, appli) : jusqu'à 6 appareils connectés au même poste
    await db.query(`UPDATE ps_aors a SET max_contacts = 6 FROM ps_endpoints e WHERE e.aors = a.id AND e.context = 'from-internal' AND e.id !~ '-web$' AND a.max_contacts < 6`);
    // Vidéo (appels vidéo, réunions) : VP8 / H.264, jusqu'à 16 flux vidéo pour les réunions
    await db.query(`UPDATE ps_endpoints SET allow = '${WEB_CODECS}', max_video_streams = 16 WHERE id LIKE '%-web' AND (allow IS DISTINCT FROM '${WEB_CODECS}' OR max_video_streams IS DISTINCT FROM 16)`);
    // Trunks : G.729 retiré (le moteur ne sait pas le convertir, l'appel serait muet côté softphone), A-law en premier
    const tr = await db.query("SELECT id, allow FROM ps_endpoints WHERE context = 'from-trunk' AND allow LIKE '%g729%'");
    for (const r of tr.rows) {
      const list = r.allow.split(",").map((x) => x.trim()).filter((x) => x && x !== "g729");
      const fixed = ["alaw", ...list.filter((x) => x !== "alaw")];
      if (!fixed.includes("ulaw")) fixed.push("ulaw");
      await db.query("UPDATE ps_endpoints SET allow = $2 WHERE id = $1", [r.id, fixed.join(",")]);
    }
    const missing = await db.query(`SELECT x.* FROM pbxmaison_extensions x
      WHERE EXISTS (SELECT 1 FROM ps_endpoints e WHERE e.id = x.id)
        AND NOT EXISTS (SELECT 1 FROM ps_endpoints w WHERE w.id = x.id || '-web')`);
    for (const row of missing.rows) await db.tx((c) => createWebEndpoint(c, withPhone(row)));
  }
  /** Espace utilisateur : identifiant = numéro de poste ou e-mail. */
  async function findWebUser(login) {
    const l = String(login || "").trim().toLowerCase();
    if (!l) return null;
    const r = await db.query("SELECT id, web_password_hash FROM pbxmaison_extensions WHERE (id = $1 OR (email <> '' AND lower(email) = $1)) AND COALESCE((options->>'disabled')::boolean, false) = false", [l]);
    return r.rows.length === 1 ? r.rows[0] : null;
  }
  /** Utilisateur encore présent et non désactivé (sessions du softphone et de l'appli) */
  async function webUserActive(ext) {
    const r = await db.query("SELECT 1 FROM pbxmaison_extensions WHERE id = $1 AND COALESCE((options->>'disabled')::boolean, false) = false", [String(ext)]);
    return r.rows.length === 1;
  }
  /** Utilisateur avec le rôle « Accès console » : connexion à la console avec l'e-mail de sa fiche et son mot de passe du softphone. */
  async function findConsoleUser(email) {
    const l = String(email || "").trim().toLowerCase();
    if (!l || !l.includes("@")) return null;
    const r = await db.query(`SELECT id, email, first_name, last_name, web_password_hash, options->>'role' AS role FROM pbxmaison_extensions
      WHERE email <> '' AND lower(email) = $1 AND options->>'role' IN ('console', 'admin') AND COALESCE((options->>'disabled')::boolean, false) = false`, [l]);
    return r.rows.length === 1 ? r.rows[0] : null;
  }
  /** Rôle console (« console » = Gestionnaire, « admin » = Administrateur) d'un utilisateur actif, sinon null */
  async function consoleUserActive(ext) {
    const r = await db.query("SELECT options->>'role' AS role FROM pbxmaison_extensions WHERE id = $1 AND options->>'role' IN ('console', 'admin') AND COALESCE((options->>'disabled')::boolean, false) = false", [String(ext)]);
    return r.rows[0]?.role || null;
  }
  async function setWebPassword(num, hash) {
    checkExtNumber(num);
    const r = await db.query("UPDATE pbxmaison_extensions SET web_password_hash = $2 WHERE id = $1", [num, hash]);
    if (!r.rowCount) throw Object.assign(new UserError("Utilisateur introuvable."), { status: 404 });
  }
  async function webSecret(num) {
    checkExtNumber(num);
    const r = await db.query("SELECT username, password FROM ps_auths WHERE id = $1", [`${num}-web`]);
    if (!r.rowCount) throw Object.assign(new UserError("Softphone web non disponible pour ce poste."), { status: 404 });
    return { auth_id: r.rows[0].username, password: r.rows[0].password };
  }

  async function createExtension(input, by) {
    const num = String(input.number || "").trim();
    checkExtNumber(num);
    const exists = await db.query("SELECT 1 FROM ps_endpoints WHERE id = $1", [num]);
    if (exists.rowCount) throw new UserError(`Le poste ${num} existe déjà.`, "number");
    const obj = (await loadObjects()).find((o) => o.number === num);
    if (obj) throw new UserError(`Le numéro ${num} est déjà utilisé (${KINDS[obj.kind].toLowerCase()} « ${obj.name} »).`, "number");
    // Compatibilité : « name » seul (ancienne API) → prénom
    const data = { ...input };
    if (data.first_name === undefined && data.last_name === undefined) data.first_name = input.name || `Poste ${num}`;
    // Duplication : on part de la fiche source (sauf identité, SDA, MAC et mots de passe)
    let base = { ...defaultUser(num), phone: phoneFromStored(null, tz()) };
    if (input.copy_from) {
      const src = await getUser(String(input.copy_from));
      base = {
        ...defaultUser(num),
        outbound_cid: src.outbound_cid, status: src.status, forwarding: structuredClone(src.forwarding), options: { ...src.options, disabled: false, ring_mobile: src.options.ring_mobile && !!String(input.mobile || "").trim(),
          // Accès à la console jamais copié (Gestionnaire, Administrateur) : à donner exprès
          role: ["console", "admin"].includes(src.options.role) ? "user" : src.options.role },
        voicemail: { ...src.voicemail, pin: "" },
        phone: { ...structuredClone(src.phone), mac: "", admin_password: "", last_provisioned: undefined, extra: [],
          keys: src.phone.keys.filter((k) => !(k.type === "blf" && k.value === num)) },
      };
      for (const r of ["no_answer", "busy", "away", "dnd"]) if (base.forwarding[r]?.type === "extension" && base.forwarding[r].target === num) base.forwarding[r] = { type: "voicemail", target: "" };
    }
    const u = validateUser(data, base, await validationContext(num));
    u.phone = base.phone;
    const password = genPassword();
    const authId = genAuthId();
    await db.tx(async (c) => {
      await c.query("INSERT INTO ps_auths (id, auth_type, username, password) VALUES ($1, 'userpass', $2, $3)", [num, authId, password]);
      await c.query("INSERT INTO ps_aors (id, max_contacts, remove_existing, qualify_frequency, support_path) VALUES ($1, 6, 'yes', 60, $2)",
        [num, CX_MODE === "tenant" ? "yes" : "no"]);
      // Multi-tenant : le poste arrive par l'aiguilleur (Path) ; son Contact ne doit pas être remplacé par l'adresse de l'aiguilleur
      await c.query(
        `INSERT INTO ps_endpoints (id, aors, auth, context, disallow, allow, callerid, direct_media, rtp_symmetric,
           force_rport, rewrite_contact, dtmf_mode, language, mailboxes)
         VALUES ($1, $1, $1, 'from-internal', 'all', 'g722,alaw,ulaw', '', 'no', 'yes', 'yes', $4, 'rfc4733', $2, $3)`,
        [num, language(), `${num}@default`, CX_MODE === "tenant" ? "no" : "yes"],
      );
      await c.query("INSERT INTO pbxmaison_extensions (id, name) VALUES ($1, $2)", [num, displayName(u)]);
      await saveUser(c, u, by);
      await createWebEndpoint(c, u);
    });
    await applyDialplan();
    return { id: num, name: displayName(u), auth_id: authId, password };
  }

  async function getUser(num) {
    checkExtNumber(num);
    await adoptOrphans();
    const r = await db.query("SELECT * FROM pbxmaison_extensions WHERE id = $1", [num]);
    if (!r.rowCount) throw Object.assign(new UserError("Utilisateur introuvable."), { status: 404 });
    const u = withPhone(r.rows[0]);
    const reg = (await registrations()).get(num) || [];
    return { ...u, name: displayName(u), registered: reg.length > 0, contacts: reg, forwards: forwardSummary(u),
      has_web_password: !!r.rows[0].web_password_hash,
      updated_at: r.rows[0].updated_at, updated_by: r.rows[0].updated_by };
  }

  async function updateUser(num, input, by) {
    const current = await getUser(num);
    const u = validateUser(input, current, await validationContext(num));
    if (input.phone) {
      const users = await loadUsers();
      const macOwners = new Map(users.flatMap((x) => [x.phone.mac, ...(x.phone.extra || []).map((e) => e.mac)].filter(Boolean).map((m) => [m, x.id])));
      for (const g of await loadGateways()) if (g.mac) macOwners.set(g.mac, `la passerelle « ${g.name} »`);   // une passerelle a aussi un fichier de configuration à son adresse MAC
      try {
        u.phone = validatePhone(input.phone, current.phone, { selfId: num, macOwners, extensions: new Map(users.map((x) => [x.id, displayName(x)])) });
      } catch (e) { throw new UserError(e.message, e.field); }
    }
    await db.tx((c) => saveUser(c, u, by));
    await db.query("UPDATE ps_endpoints SET mailboxes = $2 WHERE id IN ($1::text, $1::text || '-web')", [num, u.voicemail.enabled ? `${num}@default` : null]);
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

  const RULE_LABELS = { no_answer: "si pas de réponse", busy: "si occupé / non connecté", away: "quand il est Absent", dnd: "en Ne pas déranger" };

  /** Ce que la suppression d'un utilisateur va changer : renvois d'autres utilisateurs, SDA, route entrante. */
  async function deleteImpact(num) {
    checkExtNumber(num);
    const users = await loadUsers();
    const self = users.find((u) => u.id === num);
    if (!self) throw Object.assign(new UserError("Utilisateur introuvable."), { status: 404 });
    const forwards = [];
    for (const u of users) {
      if (u.id === num) continue;
      const rules = Object.entries({ always: "renvoi immédiat", ...RULE_LABELS }).filter(([r]) => u.forwarding[r]?.type === "extension" && u.forwarding[r].target === num);
      if (rules.length) forwards.push({ id: u.id, name: displayName(u), rules: rules.map(([, l]) => l), replaced_by: u.voicemail.enabled ? "sa messagerie vocale" : "raccrocher" });
    }
    const routes = await getRoutes();
    const objects = await loadObjects();
    const callflow = [];
    for (const o of objects) {
      const where = [];
      if ((o.data.members || []).includes(num)) where.push("membre (retiré automatiquement)");
      for (const [f, dest] of destFields(o.data)) if ((dest?.type === "user" || dest?.type === "user_vm") && dest.target === num) where.push(`destination « ${f} » (→ raccrocher)`);
      for (const list of Object.values(o.data.branches || {})) for (const st of list || []) {
        if (st.type === "ring" && st.users.includes(num)) where.push("sonne dans une étape (retiré automatiquement)");
        if ((st.type === "user" || st.type === "user_vm") && st.target === num) where.push("destination d'une étape (étape supprimée)");
      }
      if (where.length) callflow.push({ kind: o.kind, kind_label: KINDS[o.kind], id: o.id, number: o.number, name: o.name, where });
    }
    if (callflow.some((c) => c.where.some((w) => w.startsWith("destination")))) forwards.push(...callflow.filter((c) => c.where.some((w) => w.startsWith("destination")))
      .map((c) => ({ id: c.number || "", name: `${c.kind_label} « ${c.name} »`, rules: c.where.filter((w) => w.startsWith("destination")), replaced_by: "raccrocher" })));
    return { id: num, name: displayName(self), forwards, callflow, dids: self.dids, inbound_route: routes.inbound.includes(num),
      inbound_alone: routes.inbound.length === 1 && routes.inbound[0] === num };
  }

  async function deleteExtension(num, force = false, by = "") {
    const impact = await deleteImpact(num);
    if (impact.forwards.length && !force) {
      throw Object.assign(new UserError(`Attention : ${impact.forwards.map((f) => `${f.id} (${f.name})`).join(", ")} renvoie vers ce poste.`), { status: 409, impact });
    }
    const users = await loadUsers();
    await db.tx(async (c) => {
      // Renvois vers l'utilisateur supprimé → messagerie de l'utilisateur concerné
      for (const u of users) {
        if (u.id === num) continue;
        let changed = false;
        for (const r of Object.keys(RULE_LABELS)) {
          if (u.forwarding[r]?.type === "extension" && u.forwarding[r].target === num) { u.forwarding[r] = { type: "voicemail", target: "" }; changed = true; }
        }
        // Renvoi immédiat (et sa dernière destination, reprise par la touche Renvoi) : coupé, sinon tous les appels de ce poste seraient perdus
        if (u.forwarding.always?.type === "extension" && u.forwarding.always.target === num) { u.forwarding.always = { type: "none", target: "" }; changed = true; }
        if (u.forwarding.always_last?.type === "extension" && u.forwarding.always_last.target === num) { u.forwarding.always_last = { type: "voicemail", target: "" }; changed = true; }
        if (changed) await saveUser(c, u, by);
      }
      for (const t of ["ps_endpoints", "ps_aors", "ps_auths"]) {
        await c.query(`DELETE FROM ${t} WHERE id IN ($1::text, $1::text || '-web')`, [num]);
      }
      await c.query("DELETE FROM ps_contacts WHERE endpoint IN ($1::text, $1::text || '-web')", [num]);
      await c.query("DELETE FROM pbxmaison_extensions WHERE id = $1", [num]);
      await c.query("DELETE FROM pbxmaison_app_devices WHERE extension = $1", [num]);
      await c.query("DELETE FROM pbxmaison_app_tokens WHERE extension = $1", [num]);
      await c.query("DELETE FROM pbxmaison_web_invites WHERE extension = $1", [num]);
      // Gestion d'appels : retrait des membres, destinations vers ce poste → raccrocher
      for (const o of await loadObjects(c)) {
        const d = structuredClone(o.data);
        let changed = false;
        if ((d.members || []).includes(num)) { d.members = d.members.filter((x) => x !== num); changed = true; }
        for (const [f, dest, set] of destFields(d)) if ((dest?.type === "user" || dest?.type === "user_vm") && dest.target === num) { set({ type: "hangup", target: "" }); changed = true; void f; }
        for (const b of Object.keys(d.branches || {})) {
          if (!d.branches[b]) continue;
          const kept = d.branches[b].map((st) => st.type === "ring" ? { ...st, users: st.users.filter((x) => x !== num) } : st)
            .filter((st) => !(st.type === "ring" && !st.users.length) && !((st.type === "user" || st.type === "user_vm") && st.target === num));
          if (JSON.stringify(kept) !== JSON.stringify(d.branches[b])) { d.branches[b] = kept.length || o.kind !== "planning" ? kept : [{ type: "hangup", target: "" }]; changed = true; }
        }
        if (changed) await c.query("UPDATE pbxmaison_objects SET data = $3, updated_at = now(), updated_by = $4 WHERE kind = $1 AND id = $2", [o.kind, o.id, JSON.stringify(d), by || ""]);
      }
    });
    const routes = await getRoutes();
    if (routes.inbound.includes(num)) await setRoutes({ ...routes, inbound: routes.inbound.filter((x) => x !== num) });
    else await applyDialplan();
    return impact;
  }

  // ------------------------------------------------------------------ Application mobile (QR code)
  const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
  async function createAppToken(num, by) {
    await getUser(num);
    const token = crypto.randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + 48 * 3600_000);
    await db.query("DELETE FROM pbxmaison_app_tokens WHERE expires_at < now() OR extension = $1", [num]);
    await db.query("INSERT INTO pbxmaison_app_tokens (token_hash, extension, expires_at, created_by) VALUES ($1, $2, $3, $4)",
      [hashToken(token), num, expires, by || ""]);
    return { token, expires_at: expires.toISOString() };
  }
  async function appTokenStatus(num) {
    const r = await db.query("SELECT expires_at, created_at, used_at FROM pbxmaison_app_tokens WHERE extension = $1 AND expires_at > now()", [num]);
    return r.rows[0] || null;
  }
  async function revokeAppToken(num) { await db.query("DELETE FROM pbxmaison_app_tokens WHERE extension = $1", [num]); }
  /** Identifiants pour l'appli mobile, si le jeton du QR code est valide. */
  async function appProvision(token, server, ua = "") {
    if (!token || token.length < 20) return null;
    const r = await db.query("SELECT extension FROM pbxmaison_app_tokens WHERE token_hash = $1 AND expires_at > now()", [hashToken(token)]);
    if (!r.rowCount) return null;
    const num = r.rows[0].extension;
    await db.query("UPDATE pbxmaison_app_tokens SET used_at = now() WHERE token_hash = $1", [hashToken(token)]);
    const u = await getUser(num);
    const secret = await extensionSecret(num);
    // Appareil : jeton longue durée gardé par l'appli, pour ouvrir le softphone sans mot de passe
    const device = crypto.randomBytes(32).toString("base64url");
    await db.query("INSERT INTO pbxmaison_app_devices (token_hash, extension, user_agent) VALUES ($1, $2, $3)", [hashToken(device), num, String(ua || "").slice(0, 200)]);
    const base = `${server.tls ? "https" : "http"}://${server.host}`;
    return { pbx: env().PBX_NAME || "", extension: num, name: displayName(u), auth_id: secret.auth_id, password: secret.password,
      host: server.host, fqdn: server.fqdn, ports: { udp: 5060, tcp: 5060, tls: server.tls ? 5061 : null }, voicemail: "*97",
      device_token: device, app_login_url: `${base}/app/login`, softphone_url: `${base}/softphone`, logout_url: `${base}/app/logout` };
  }
  /** Mail de bienvenue : lien (7 jours) pour choisir son mot de passe du softphone web. */
  async function createWelcome(num, by) {
    const u = await getUser(num);
    const token = crypto.randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + 7 * 86400_000);
    await db.query("DELETE FROM pbxmaison_web_invites WHERE expires_at < now() OR extension = $1", [num]);
    await db.query("INSERT INTO pbxmaison_web_invites (token_hash, extension, expires_at, created_by) VALUES ($1, $2, $3, $4)", [hashToken(token), num, expires, by || ""]);
    return { token, expires_at: expires.toISOString(), user: u };
  }
  async function welcomeInfo(token) {
    if (!token || token.length < 20) return null;
    const r = await db.query("SELECT extension FROM pbxmaison_web_invites WHERE token_hash = $1 AND expires_at > now()", [hashToken(token)]);
    if (!r.rowCount) return null;
    const u = await getUser(r.rows[0].extension);
    return { extension: u.id, name: displayName(u), first_name: u.first_name, email: u.email, pbx: env().PBX_NAME || "" };
  }
  async function useWelcome(token, hash) {
    const info = await welcomeInfo(token);
    if (!info) return null;
    await setWebPassword(info.extension, hash);
    await db.query("DELETE FROM pbxmaison_web_invites WHERE extension = $1", [info.extension]);
    return info;
  }

  /** Poste d'un appareil de l'appli mobile (jeton valide), noté comme utilisé. */
  async function appDevice(token) {
    if (!token || token.length < 30) return null;
    const r = await db.query("UPDATE pbxmaison_app_devices SET last_used_at = now() WHERE token_hash = $1 RETURNING extension", [hashToken(token)]);
    return r.rows[0]?.extension || null;
  }
  async function revokeAppDevice(token) { if (token) await db.query("DELETE FROM pbxmaison_app_devices WHERE token_hash = $1", [hashToken(String(token))]); }
  async function appDevices(num) {
    return (await db.query("SELECT created_at, last_used_at, user_agent FROM pbxmaison_app_devices WHERE extension = $1 ORDER BY created_at DESC", [num])).rows;
  }
  async function revokeAppDevices(num) { await db.query("DELETE FROM pbxmaison_app_devices WHERE extension = $1", [num]); }

  // ------------------------------------------------------------------ Téléphones connectés
  /** Note les connexions / déconnexions (appelé toutes les 20 s par le serveur). */
  async function trackDevices() {
    const reg = await registrations();
    const prev = new Map((await db.query("SELECT * FROM pbxmaison_devices")).rows.map((r) => [r.endpoint, r]));
    for (const [id, contacts] of reg) {
      const c = contacts[0];
      const p = prev.get(id);
      if (c) {
        await db.query(`INSERT INTO pbxmaison_devices (endpoint, online, since, last_seen, user_agent, source_ip, local_ip)
            VALUES ($1, true, now(), now(), $2, $3, $4)
          ON CONFLICT (endpoint) DO UPDATE SET since = CASE WHEN pbxmaison_devices.online THEN pbxmaison_devices.since ELSE now() END,
            online = true, last_seen = now(), user_agent = $2, source_ip = $3, local_ip = $4`,
        [id, c.user_agent, c.source_ip, c.local_ip]);
      } else if (p?.online) {
        await db.query("UPDATE pbxmaison_devices SET online = false, since = now() WHERE endpoint = $1", [id]);
      }
    }
    for (const id of prev.keys()) if (!reg.has(id)) await db.query("DELETE FROM pbxmaison_devices WHERE endpoint = $1", [id]);
    await trackSeen(reg).catch(() => {});
    await watchDevices(reg).catch(() => {});
    if (++watchTick % 3 === 1) await watchCalls().catch(() => {});
    return reg;
  }

  /** Appareils de chaque poste : connectés maintenant, ou déconnectés avec leur dernière adresse (gardés 90 jours) */
  async function trackSeen(reg) {
    const prev = (await db.query("SELECT ext, dkey, online FROM pbxmaison_device_seen")).rows;
    const live = new Set();
    for (const [ext, contacts] of reg) {
      for (const c of contacts) {
        const dev = c.device || identifyDevice(c.user_agent);
        const key = deviceKey(dev, c.user_agent);
        if (live.has(`${ext}|${key}`)) continue;
        live.add(`${ext}|${key}`);
        const pub = isPublicIp(c.source_ip) ? c.source_ip : "";
        await db.query(`INSERT INTO pbxmaison_device_seen (ext, dkey, kind, label, mac, firmware, user_agent, source_ip, local_ip, public_ip, public_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 = '' THEN NULL ELSE now() END)
          ON CONFLICT (ext, dkey) DO UPDATE SET kind = $3, label = $4, mac = $5, firmware = $6, user_agent = $7, source_ip = $8, local_ip = $9,
            public_ip = CASE WHEN $10 = '' THEN pbxmaison_device_seen.public_ip ELSE $10 END,
            public_at = CASE WHEN $10 = '' THEN pbxmaison_device_seen.public_at ELSE now() END,
            since = CASE WHEN pbxmaison_device_seen.online THEN pbxmaison_device_seen.since ELSE now() END, online = true, last_seen = now()`,
        [ext, key, dev.kind || "unknown", dev.label || "", dev.mac || "", dev.firmware || "", c.user_agent || "", c.source_ip || "", c.local_ip || "", pub]);
      }
    }
    for (const r of prev) {
      if (!reg.has(r.ext)) await db.query("DELETE FROM pbxmaison_device_seen WHERE ext = $1", [r.ext]);          // poste supprimé
      else if (r.online && !live.has(`${r.ext}|${r.dkey}`)) await db.query("UPDATE pbxmaison_device_seen SET online = false, since = now() WHERE ext = $1 AND dkey = $2", [r.ext, r.dkey]);
    }
    await db.query("DELETE FROM pbxmaison_device_seen WHERE NOT online AND last_seen < now() - interval '90 days'");
  }
  /** Retirer un appareil déconnecté de la liste (il revient s'il se reconnecte) */
  async function forgetDevice(ext, key) {
    await db.query("DELETE FROM pbxmaison_device_seen WHERE ext = $1 AND dkey = $2 AND NOT online", [String(ext), String(key)]);
    return { ok: true };
  }

  // ------------------------------------------------------------------ Surveillance (console du serveur)
  let watchTick = 0;
  /** Un appareil (téléphone, softphone, appli) d'un poste se connecte depuis une autre adresse IP qu'avant. */
  async function watchDevices(reg) {
    const last = new Map((await db.query("SELECT key, ip FROM pbxmaison_last_ip")).rows.map((r) => [r.key, r.ip]));
    for (const [ext, contacts] of reg) {
      for (const c of contacts) {
        const ip = c.source_ip || c.ip;
        if (!ip || /^127\./.test(ip)) continue;
        const cat = deviceCategory(c.device?.kind);
        const key = `${ext}|${cat}`;
        const before = last.get(key);
        if (before === ip) continue;
        await db.query(`INSERT INTO pbxmaison_last_ip (key, ip, at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET ip = $2, at = now()`, [key, ip]);
        last.set(key, ip);
        if (!before) continue;   // première connexion connue : rien à signaler
        const dev = c.device?.label || CATEGORY_LABELS[cat];
        await db.query(`INSERT INTO pbxmaison_watch (key, kind, category, extension, text, detail) VALUES ($1, 'ip', $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
          [`ip:${key}:${ip}:${Date.now()}`, cat, ext, `${dev} du poste ${ext} : connecté depuis une nouvelle adresse ${ip} (avant : ${before}).`,
            { ip, before, user_agent: c.user_agent || "", local_ip: c.local_ip || "" }]);
      }
    }
  }
  /** Appels sortants vers l'étranger ou un numéro surtaxé (journal du jour). */
  async function watchCalls() {
    const cc = countryCode();
    const { calls } = await callLog({ days: 1, direction: "out", limit: 5000 });
    for (const c of calls) {
      const risk = numberRisk(c.to.number, cc);
      if (!risk) continue;
      const who = c.from.ext ? `poste ${c.from.ext}` : c.from.number || "?";
      const res = c.status === "answered" ? `décroché, ${c.talk || 0} s` : "non abouti";
      await db.query(`INSERT INTO pbxmaison_watch (key, at, kind, extension, text, detail) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING`,
        [`call:${c.id}`, c.start, risk, c.from.ext || "", `${risk === "intl" ? "Appel vers l'étranger" : "Appel vers un numéro surtaxé"} : ${c.to.number} depuis le ${who} (${res}).`,
          { number: c.to.number, status: c.status, talk: c.talk || 0, from: c.from.number }]);
    }
  }

  /** Une ligne par appareil : connectés, déconnectés (dernière adresse gardée), et téléphones configurés jamais vus */
  async function listPhones() {
    await trackDevices();
    const users = await loadUsers();
    const seen = (await db.query("SELECT * FROM pbxmaison_device_seen ORDER BY ext, online DESC, last_seen DESC")).rows;
    const models = new Map(MODELS.map((m) => [m.id, m.label]));
    const out = [];
    for (const u of users) {
      const user = { id: u.id, name: displayName(u) };
      const mine = seen.filter((r) => r.ext === u.id);
      const used = new Set();
      const row = (r, extra = {}) => {
        if (r) used.add(r.dkey);
        const dev = r ? { ...identifyDevice(r.user_agent), kind: r.kind, label: r.label } : { kind: "phone", label: "" };
        return {
          user, key: r?.dkey || "", online: !!r?.online, since: r?.since || null, last_seen: r?.last_seen || null,
          model: dev.label, mac: r?.mac || "", device: dev, user_agent: r?.user_agent || "", firmware: r?.firmware || "",
          source_ip: r?.source_ip || "", local_ip: r?.local_ip || "", public_ip: r?.public_ip || "", public_at: r?.public_at || null,
          connection: r?.source_ip ? connectionType(r.source_ip, r.local_ip, []) : null, provisioned: null, configured: false, ...extra,
        };
      };
      // Téléphones de la fiche (principal + supplémentaires) : reconnus par leur adresse MAC
      const configured = [...(u.phone.mac ? [{ ...u.phone, main: true }] : []), ...(u.phone.extra || [])];
      for (const ph of configured) {
        const r = mine.find((x) => x.mac && x.mac === ph.mac);
        out.push(row(r, { configured: true, extra: !ph.main, label: ph.main ? "" : ph.label || "", mac: ph.mac,
          model: models.get(ph.model) || r?.label || "Téléphone", provisioned: ph.last_provisioned || null }));
      }
      // Les autres appareils vus sur ce poste (softphone, appli, téléphone non provisionné…)
      for (const r of mine) if (!used.has(r.dkey)) out.push(row(r));
    }
    return out;
  }

  // ------------------------------------------------------------------ Provisioning des téléphones
  async function provToken() {
    let t = await db.getSetting("prov_token", "");
    if (!t) { t = randomPassword(16); await db.setSetting("prov_token", t); }
    return t;
  }
  /** server : { host, tls } — lien que le téléphone utilise (option DHCP 66 ou saisie dans le téléphone). */
  async function provisioningUrl(server) {
    return `${server.tls ? "https" : "http"}://${server.host}/prov/${await provToken()}/`;
  }
  const phoneOptions = () => ({
    models: MODELS, languages: LANGUAGES, date_formats: DATE_FORMATS, time_formats: TIME_FORMATS, timezones: TIMEZONES,
    backlight: BACKLIGHT, screensaver: SCREENSAVER, transfer: TRANSFER, led: LED, transports: TRANSPORTS, key_types: KEY_TYPES, expansions: EXPANSIONS,
    ring_types: RING_TYPES, ringers: RINGERS,
  });

  async function phoneConfig(num, server, extraMac = null) {
    const u0 = await getUser(num);
    // Téléphone supplémentaire : même poste, avec son propre modèle et sa propre adresse MAC
    const ex = extraMac ? (u0.phone.extra || []).find((e) => e.mac === extraMac) : null;
    const u = ex ? { ...u0, phone: { ...u0.phone, model: ex.model, mac: ex.mac, modules: [] } } : u0;
    if (!u.phone.model) throw new UserError("Choisis d'abord le modèle du téléphone.", "phone.model");
    const secret = await extensionSecret(num);
    const users = await loadUsers();
    const names = new Map(users.map((x) => [x.id, displayName(x)]));
    const prov_url = await provisioningUrl(server);
    const model = modelById(u.phone.model);
    const acc = [{ index: 1, user: u.id, name: displayName(u), auth_id: secret.auth_id, password: secret.password }];
    const srv = { host: server.host, prov_url, lang: u.phone.settings.language, tz: u.phone.settings.timezone, admin_password: u.phone.admin_password };
    let text;
    if (model?.format === "fanvil") text = buildFanvilCfg(acc, srv);
    else if (model?.format === "snom") text = buildSnomXml(acc, srv);
    else if (model?.format === "grandstream") text = buildGrandstreamXml(u.phone.mac || "", acc, srv);
    else {
      // Codes de statut (Codes raccourcis) : le bouton NPD du téléphone prévient le PBX, le statut se voit partout
      const theme = readTheme();
      const codes = { st_available: "*30", st_dnd: "*32", pickup: "**", ...(await db.getSetting("shortcodes", {})) };
      text = buildYealinkCfg(u, u.phone, secret, { host: server.host, prov_url, assets_url: `${server.tls ? "https" : "http"}://${server.host}/phone/`, codes,
        wallpaper: (screen) => wallpaperName(screen, theme) }, names);
    }
    return { user: u, text, format: model?.format || "yealink" };
  }

  // ------------------------------------------------------------------ Passerelles et bases DECT
  async function loadGateways() { return await db.getSetting("gateways", []); }
  async function gatewayAccounts(g) {
    const users = new Map((await loadUsers()).map((u) => [u.id, u]));
    const out = [];
    for (const p of g.ports) {
      const u = users.get(p.user);
      if (!u) continue;
      const sec = await extensionSecret(p.user);
      out.push({ index: p.port, user: p.user, name: p.label || displayName(u), auth_id: sec.auth_id, password: sec.password });
    }
    return out;
  }
  async function gatewayConfig(g, server) {
    const srv = { host: server.host, prov_url: await provisioningUrl(server), lang: language(), admin_password: g.admin_password };
    return { text: buildGatewayFile(g, await gatewayAccounts(g), srv), accounts: await gatewayAccounts(g) };
  }

  /** Fichier demandé par un téléphone : null si inconnu. */
  async function provisionFile(token, file, server, from) {
    if (token !== (await db.getSetting("prov_token", ""))) return null;
    const pb = /^phonebook(?:-(\d{3}))?\.xml$/.exec(file);
    if (pb) {
      // Annuaire du téléphone : collègues visibles par ce poste (masqués et autres groupes de visibilité exclus) + contacts
      const all = await loadUsers();
      const viewer = all.find((u) => u.id === pb[1]) || { options: {} };
      const users = all.filter((u) => u.id !== viewer.id && sees(viewer, u)).map((u) => ({ id: u.id, name: displayName(u) }));
      return { text: yealinkPhonebook(users, await loadContacts()), type: "application/xml" };
    }
    if (/^y0{6}\d{6}\.cfg$/i.test(file)) return { text: "#!version:1.0.0.1\n## Callikoe : tout est dans <mac>.cfg\n" };
    const req = provRequest(file);
    if (!req) return null;
    const stamp = JSON.stringify({ at: new Date().toISOString(), ip: from.ip, user_agent: String(from.user_agent || "").slice(0, 120) });
    // Téléphone principal ou téléphone supplémentaire de l'utilisateur (même compte, même réglages et touches)
    const r = await db.query(`SELECT id, phone->>'mac' = $1 AS main FROM pbxmaison_extensions WHERE phone->>'mac' = $1 OR phone->'extra' @> jsonb_build_array(jsonb_build_object('mac', $1::text))`, [req.mac]);
    if (r.rowCount) {
      const id = r.rows[0].id, main = r.rows[0].main;
      const { text, format } = await phoneConfig(id, server, main ? null : req.mac);
      const want = { cfg: ["yealink", "fanvil"], gs: ["grandstream"], snom: ["snom"] }[req.kind];
      if (!want.includes(format)) return null;
      if (main) await db.query(`UPDATE pbxmaison_extensions SET phone = jsonb_set(phone, '{last_provisioned}', $2::jsonb) WHERE id = $1`, [id, stamp]);
      else await db.query(`UPDATE pbxmaison_extensions SET phone = jsonb_set(phone, '{extra}', (SELECT jsonb_agg(CASE WHEN e->>'mac' = $3 THEN e || jsonb_build_object('last_provisioned', $2::jsonb) ELSE e END) FROM jsonb_array_elements(phone->'extra') e)) WHERE id = $1`, [id, stamp, req.mac]);
      return { text, id, type: format === "snom" || format === "grandstream" ? "application/xml" : undefined };
    }
    const gws = await loadGateways();
    const g = gws.find((x) => x.mac === req.mac);
    if (!g) return null;
    const prov = GATEWAY_MODELS.find((m) => m.id === g.model)?.prov;
    const want = { cfg: ["yealink-dect"], gs: ["gs-ht"], snom: ["snom-dect"] }[req.kind];
    if (!want.includes(prov)) return null;
    const { text } = await gatewayConfig(g, server);
    g.last_provisioned = JSON.parse(stamp);
    await db.setSetting("gateways", gws);
    return { text, id: g.id, type: prov === "yealink-dect" ? undefined : "application/xml" };
  }

  async function notifyPhone(num, action) {
    checkExtNumber(num);
    const reg = (await registrations()).get(num) || [];
    if (!reg.length) throw new UserError("Le téléphone n'est pas connecté : impossible de lui envoyer l'ordre.");
    const kind = action === "reboot" ? "pbxm-reboot" : "pbxm-resync";
    try { await ami.command(`pjsip send notify ${kind} endpoint ${num}`); }
    catch { throw new UserError("Moteur téléphonique injoignable."); }
    return { ok: true };
  }

  async function resyncAll() {
    const reg = await registrations();
    let sent = 0;
    for (const [id, contacts] of reg) {
      if (!contacts.length) continue;
      try { await ami.command(`pjsip send notify pbxm-resync endpoint ${id}`); sent++; } catch { /* suivant */ }
    }
    return { sent };
  }

  async function resetPhoneAdmin(num) {
    const u = await getUser(num);
    u.phone.admin_password = randomPassword(12);
    await db.query("UPDATE pbxmaison_extensions SET phone = $2 WHERE id = $1", [num, JSON.stringify(u.phone)]);
    return { admin_password: u.phone.admin_password };
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
    await ensureWebEndpoints();
    const routes = await getRoutes();
    const users = await loadUsers();
    let cid = "", fmt = "national", cidFmt = "national";
    if (routes.outbound_trunk) {
      const r = await db.query("SELECT outbound_cid, dial_format, cid_format FROM pbxmaison_trunks WHERE id = $1", [routes.outbound_trunk]);
      if (r.rowCount) ({ outbound_cid: cid, dial_format: fmt, cid_format: cidFmt } = r.rows[0]);
    }
    const byId = new Map(users.map((u) => [u.id, u]));
    let ext = { globals: [], dialplan: "" };
    try { ext = await extra(); } catch (e) { console.error("Plan de numérotation (modules) :", e.message); }
    const ringing = routes.inbound.filter((n) => byId.has(n) ? ringsForGroups(byId.get(n)) : true);
    writeAtomic(routesFile, [
      `; Routes — écrit par la console web (${new Date().toISOString()}). Ne pas modifier à la main.`,
      `INBOUND_TARGET = ${ringing.map((n) => `PJSIP/${n}&PJSIP/${n}-web`).join("&")}`,
      `OUTBOUND_TRUNK = ${routes.outbound_trunk}`,
      `OUTBOUND_CID = ${cid}`,
      `OUTBOUND_FORMAT = ${fmt}`,
      `OUTBOUND_CID_FORMAT = ${cidFmt}`,
      ...ext.globals,
      "",
    ].join("\n"));
    const dir = path.dirname(routesFile);
    const objects = await loadObjects();
    const model = { users: byId, objects, soundsDir: soundsDir(), tz: tz(),
      // SVI qui comprend la parole : la phrase enregistrée est envoyée à la console (IA), qui répond la touche choisie
      speech: { dir: REC_DIR(), url: `http://127.0.0.1:${CX_SETTINGS.port}/internal/ivr-speech?k=${speechKey()}`,
        aiUrl: `http://127.0.0.1:${CX_SETTINGS.port}/internal/ai-call?k=${speechKey()}`, audiosocket: `127.0.0.1:${audioSocketPort()}` },
      receptionist: await db.getSetting("receptionist", null) };
    writeAtomic(path.join(dir, "extensions_users.conf"), buildUsersDialplan(users));
    const contacts = await loadContacts();
    const std = await db.getSetting("standard", defaultStandard());
    writeAtomic(path.join(dir, "extensions_callflow.conf"), buildCallflowDialplan(model) + buildStandardDialplan(std, model) + buildPhonebookDialplan(contacts) + (ext.dialplan || ""));
    writeAtomic(path.join(dir, "queues_callikoe.conf"), buildQueues(model));
    // Musiques d'attente des files : un dossier par file contenant un lien vers l'annonce choisie
    for (const c of mohClasses(model)) {
      fs.mkdirSync(c.dir, { recursive: true });
      for (const f of fs.readdirSync(c.dir)) if (f !== c.file) fs.rmSync(path.join(c.dir, f), { force: true });
      const link = path.join(c.dir, c.file);
      if (!fs.existsSync(link)) fs.symlinkSync(path.join(soundsDir(), c.file), link);
    }
    writeAtomic(path.join(dir, "musiconhold_callikoe.conf"), buildMoh(model));
    writeAtomic(path.join(dir, "voicemail_users.conf"), `${buildVoicemail(users)}${buildGroupVoicemail(model)}\n`);
    // Voyant de messagerie : boîte personnelle + messageries de groupe dont l'utilisateur est membre
    for (const [id, boxes] of mailboxesByUser(model)) {
      await db.query("UPDATE ps_endpoints SET mailboxes = $2 WHERE id IN ($1::text, $1::text || '-web') AND mailboxes IS DISTINCT FROM $2", [id, boxes]);
    }
    // Interception « n'importe quel appel » (code *8) : tous les postes dans le même groupe d'interception
    await db.query("UPDATE ps_endpoints SET call_group = '1', pickup_group = '1' WHERE context = 'from-internal' AND (call_group IS DISTINCT FROM '1' OR pickup_group IS DISTINCT FROM '1')");
    // Sécurité : postes SIP (hors softphone web, qui passe par Nginx en local) limités aux réseaux autorisés
    // Multi-tenant : tout arrive de l'aiguilleur, les réseaux autorisés se contrôlent au niveau du serveur
    if (ext.sipAcl && CX_MODE !== "tenant") {
      try {
        await db.query(`UPDATE ps_endpoints SET deny = $1, permit = $2 WHERE context = 'from-internal' AND id !~ '-web$'
          AND (deny IS DISTINCT FROM $1 OR permit IS DISTINCT FROM $2)`, [ext.sipAcl.deny, ext.sipAcl.permit]);
      } catch (e) { console.error("Restriction des postes SIP non appliquée :", e.message); }
    }
    // Voyant de la touche « Statut » de chaque téléphone (rouge = ne pas déranger ou absent)
    for (const u of users) { try { await ami.command(`devstate change Custom:dnd${u.id} ${u.status === "available" ? "NOT_INUSE" : "INUSE"}`); } catch { /* Asterisk arrêté */ } }
    // Voyant de la touche « Renvoi » (renvoi immédiat actif) et de la touche « Standard » (fermé ou renvoyé)
    for (const u of users) { try { await ami.command(`devstate change Custom:fwd${u.id} ${u.forwarding.always?.type && u.forwarding.always.type !== "none" ? "INUSE" : "NOT_INUSE"}`); } catch { /* idem */ } }
    try { await ami.command(`devstate change Custom:cxstd ${std.state === "open" ? "NOT_INUSE" : "INUSE"}`); } catch { /* idem */ }
    try { await ami.command("dialplan reload"); } catch { /* rechargé au démarrage d'Asterisk */ }
    try { await ami.command("module reload app_voicemail.so"); } catch { /* idem */ }
    try { await ami.command("moh reload"); } catch { /* idem */ }
    try { await ami.command("module reload app_queue.so"); } catch { /* idem */ }
  }

  // ------------------------------------------------------------------ Appels en cours
  /** Postes en communication ou qui sonnent (pour la présence dans le softphone). */
  async function lineStates() {
    let lines;
    try { lines = await ami.command("core show channels concise"); } catch { return new Map(); }
    const out = new Map();
    for (const l of lines) {
      const f = l.split("!");
      const m = /^PJSIP\/(\d{3})(?:-web)?-[0-9a-f]+$/.exec(f[0] || "");
      if (!m) continue;
      const st = f[4] === "Up" ? "busy" : (f[4] === "Ringing" || f[4] === "Ring") ? "ringing" : "";
      if (st && out.get(m[1]) !== "busy") out.set(m[1], st);
    }
    return out;
  }

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


  // ------------------------------------------------------------------ Gestion d'appels (groupes, files, SVI, horaires, règles)
  const soundsDir = () => path.join(path.dirname(routesFile), "sounds");
  async function loadObjects(client = db) {
    const r = await client.query("SELECT kind, id, number, name, data, updated_at, updated_by FROM pbxmaison_objects ORDER BY kind, number NULLS LAST, name");
    return r.rows.map((x) => ({ kind: x.kind, id: x.id, number: x.number, name: x.name, data: x.data, updated_at: x.updated_at, updated_by: x.updated_by }));
  }
  /** Champs « destination » d'un objet : [nom, valeur, setter] */
  function destFields(d) {
    const out = [];
    for (const f of ["no_answer", "invalid", "open", "closed", "break", "holiday"]) if (d[f]) out.push([f, d[f], (v) => { d[f] = v; }]);
    for (const k of Object.keys(d.options || {})) out.push([`touche ${k}`, d.options[k], (v) => { d.options[k] = v; }]);
    return out;
  }
  async function cfContext(selfId) {
    const [users, objects] = await Promise.all([loadUsers(), loadObjects()]);
    const usedNumbers = new Map();
    for (const u of users) usedNumbers.set(u.id, `utilisateur ${displayName(u)}`);
    for (const o of objects) if (o.number && o.id !== selfId) usedNumbers.set(o.number, `${KINDS[o.kind].toLowerCase()} « ${o.name} »`);
    const userDids = new Map();
    for (const u of users) for (const d of u.dids) userDids.set(d, u.id);
    return { users: new Map(users.map((u) => [u.id, u])), objects, cc: countryCode(), selfId, usedNumbers, userDids };
  }
  const checkKind = (kind) => { if (!KINDS[kind]) throw Object.assign(new UserError("Type inconnu."), { status: 404 }); };
  async function listObjects(kind) {
    if (kind) checkKind(kind);
    const all = await loadObjects();
    return kind ? all.filter((o) => o.kind === kind) : all;
  }
  async function getObject(kind, id) {
    checkKind(kind);
    const o = (await loadObjects()).find((x) => x.kind === kind && x.id === id);
    if (!o) throw Object.assign(new UserError("Introuvable."), { status: 404 });
    return o;
  }
  async function saveObject(kind, id, input, by) {
    checkKind(kind);
    if (kind === "prompt" && !id) throw new UserError("Ajoute une annonce en envoyant un fichier audio.");
    const current = id ? await getObject(kind, id) : null;
    const v = validateObject(kind, input || {}, current?.data, await cfContext(id));
    const newId = id || `${kind[0]}${crypto.randomBytes(4).toString("hex")}`;
    await db.query(`INSERT INTO pbxmaison_objects (kind, id, number, name, data, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (kind, id) DO UPDATE SET number = EXCLUDED.number, name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [kind, newId, v.number, v.name, JSON.stringify(v.data), by || ""]);
    // Un seul jeu d'horaires « généraux du PBX »
    if (kind === "schedule" && v.data.general) await db.query("UPDATE pbxmaison_objects SET data = jsonb_set(data, '{general}', 'false') WHERE kind = 'schedule' AND id <> $1 AND (data->>'general')::boolean IS TRUE", [newId]);
    await applyDialplan();
    return getObject(kind, newId);
  }
  async function objectImpact(kind, id) {
    await getObject(kind, id);
    const objects = await loadObjects();
    return referencesTo(kind, id, objects).map((r) => ({ ...r, kind_label: KINDS[r.kind] }));
  }
  async function deleteObject(kind, id, force = false, by = "") {
    const o = await getObject(kind, id);
    const refs = await objectImpact(kind, id);
    if (refs.length && !force) {
      throw Object.assign(new UserError(`Attention : utilisé par ${refs.map((r) => `${r.kind_label.toLowerCase()} « ${r.name} » (${r.where})`).join(", ")}.`), { status: 409, impact: { refs } });
    }
    await db.tx(async (c) => {
      for (const other of await loadObjects(c)) {
        if (other.kind === kind && other.id === id) continue;
        const d = structuredClone(other.data);
        let changed = false;
        for (const [, dest, set] of destFields(d)) {
          if (dest?.type === kind && dest.target === id) { set({ type: "hangup", target: "" }); changed = true; }
          else if (kind === "prompt" && dest?.prompt === id) { const { prompt, ...rest } = dest; void prompt; set(rest); changed = true; }
        }
        if (kind === "prompt" && d.moh === id) { d.moh = ""; changed = true; }
        if (kind === "prompt" && (d.periodic || []).includes(id)) { d.periodic = d.periodic.filter((x) => x !== id); changed = true; }
        if (kind === "prompt" && d.greeting === id) { d.greeting = ""; changed = true; }
        if (kind === "prompt" && d.prompt === id) { d.prompt = ""; changed = true; }
        if (kind === "schedule" && d.schedule === id) { d.schedule = ""; changed = true; }
        if (other.kind === "flow" || other.kind === "planning") for (const b of Object.keys(d.branches || {})) {
          if (!d.branches[b]) continue;
          const kept = d.branches[b].filter((st) => !(st.type === kind && st.target === id));
          if (kept.length !== d.branches[b].length) { d.branches[b] = kept; changed = true; }
          if (kind === "schedule" && other.kind === "flow" && b !== "open") { d.branches[b] = null; changed = true; }
          if (other.kind === "planning" && !d.branches[b].length) { d.branches[b] = [{ type: "hangup", target: "" }]; changed = true; }
        }
        if (changed) await c.query("UPDATE pbxmaison_objects SET data = $3, updated_at = now(), updated_by = $4 WHERE kind = $1 AND id = $2", [other.kind, other.id, JSON.stringify(d), by || ""]);
      }
      await c.query("DELETE FROM pbxmaison_objects WHERE kind = $1 AND id = $2", [kind, id]);
    });
    if (kind === "prompt" && o.data.file) { try { fs.unlinkSync(path.join(soundsDir(), o.data.file)); } catch { /* déjà absent */ } }
    await applyDialplan();
    return { ok: true, refs };
  }

  /** WAV PCM 16 bits mono 8 kHz (converti dans le navigateur) → durée en secondes ; sinon erreur. */
  function checkWav(buf) {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new UserError("Fichier audio invalide (WAV attendu).", "file");
    let off = 12, fmt = null, dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4), len = buf.readUInt32LE(off + 4);
      if (id === "fmt ") fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
      if (id === "data") { dataLen = Math.min(len, buf.length - off - 8); break; }
      off += 8 + len + (len % 2);
    }
    if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 8000 || fmt.bits !== 16) throw new UserError("Format audio non pris en charge : WAV PCM 16 bits mono 8 kHz attendu.", "file");
    const sec = dataLen / 16000;
    if (sec < 0.3) throw new UserError("Annonce trop courte.", "file");
    if (sec > 600) throw new UserError("Annonce trop longue (10 minutes maximum).", "file");
    return Math.round(sec * 10) / 10;
  }
  async function savePrompt(id, name, wav, by) {
    const clean = String(name || "").replace(/[\r\n"<>,;|\\()[\]{}$]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
    if (!clean) throw new UserError("Donne un nom à l'annonce.", "name");
    let data;
    if (wav) {
      const duration = checkWav(wav);
      const pid = id || `p${crypto.randomBytes(4).toString("hex")}`;
      fs.mkdirSync(soundsDir(), { recursive: true });
      const file = `${pid}-${Date.now().toString(36)}.wav`;
      writeAtomic(path.join(soundsDir(), file), wav);
      const old = id ? await getObject("prompt", id) : null;
      if (old?.data.file && old.data.file !== file) { try { fs.unlinkSync(path.join(soundsDir(), old.data.file)); } catch { /* */ } }
      data = { name: clean, file, duration };
      id = pid;
    } else {
      if (!id) throw new UserError("Envoie un fichier audio.", "file");
      const old = await getObject("prompt", id);
      data = { ...old.data, name: clean };
    }
    await db.query(`INSERT INTO pbxmaison_objects (kind, id, number, name, data, updated_by) VALUES ('prompt', $1, NULL, $2, $3, $4)
      ON CONFLICT (kind, id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`, [id, clean, JSON.stringify(data), by || ""]);
    await applyDialplan();
    return getObject("prompt", id);
  }
  async function promptFile(id) {
    const o = await getObject("prompt", id);
    const f = path.join(soundsDir(), o.data.file || "");
    if (!o.data.file || !fs.existsSync(f)) throw Object.assign(new UserError("Fichier absent."), { status: 404 });
    return f;
  }

  async function traceModel() {
    const [users, objects, reg, routes, trunks] = await Promise.all([loadUsers(), loadObjects(), registrations(), getRoutes(), db.query("SELECT number, dids FROM pbxmaison_trunks")]);
    const registered = new Map();
    for (const [id, contacts] of reg) registered.set(id, [...new Set(contacts.map((c) => c.device?.label || "appareil"))]);
    return { users: new Map(users.map((u) => [u.id, u])), objects, registered, outboundTrunk: routes.outbound_trunk,
      trunkDids: new Set(trunks.rows.flatMap((r) => trunkDidList(r, countryCode()))), legacyInbound: routes.inbound, cc: countryCode(), tz: tz(), now: new Date() };
  }
  /** Clé des appels du moteur téléphonique vers la console (SVI parlé) : dérivée du secret de session, jamais exposée */
  /** Port du pont audio du standardiste IA (AudioSocket), propre à chaque PBX : port de la console + 20000 */
  function audioSocketPort() { return Number(process.env.PBXM_AUDIOSOCKET_PORT) || CX_SETTINGS.port + 20000; }
  function speechKey() { return crypto.createHmac("sha256", String(CX_SETTINGS.sessionSecret || "cx")).update("ivr-speech").digest("hex").slice(0, 32); }
  async function parseFlow(text) {
    const [users, objects, trunks] = await Promise.all([loadUsers(), loadObjects(), db.query("SELECT number, dids FROM pbxmaison_trunks")]);
    return parseRouting(text, {
      users: users.map((u) => ({ id: u.id, name: displayName(u), first_name: u.first_name, last_name: u.last_name, mobile: u.mobile })),
      objects: objects.map((o) => ({ kind: o.kind, id: o.id, number: o.number, name: o.name })),
      trunkDids: trunks.rows.flatMap((r) => trunkDidList(r, countryCode())), cc: countryCode(),
    });
  }
  async function trace(number) { return traceNumber(number, await traceModel()); }

  // ------------------------------------------------------------------ Dépannage : tests d'appel
  /** Interroge les appareils des postes (SIP OPTIONS) puis lit leur état. */
  async function qualifyNow(exts) {
    for (const e of exts) for (const id of [e, `${e}-web`]) { try { await ami.command(`pjsip qualify ${id}`); } catch { /* AOR sans contact */ } }
    if (exts.length) await new Promise((r) => setTimeout(r, 1500));
    try { return parseContacts(await ami.command("pjsip show contacts")); } catch { return []; }
  }
  async function diagInbound(number) {
    const model = await traceModel();
    const t = traceNumber(number, model);
    const root = pathNow(t.root);
    const exts = ringTargets(root).filter((x) => model.users.has(x));
    const [reg, qual] = [await registrations(), await qualifyNow(exts)];
    const targets = exts.map((ext) => {
      const u = model.users.get(ext);
      return { ext, name: displayName(u), status: u.status, rings: !u.options.disabled && u.status === "available",
        devices: deviceStates(ext, reg.get(ext) || [], qual) };
    });
    return { query: t.query, kind: t.kind, at: new Date().toISOString(), root, targets, verdict: inboundVerdict(root, targets) };
  }
  async function diagOutbound(ext, number) {
    checkExtNumber(ext);
    const [users, routes, trunks] = await Promise.all([loadUsers(), getRoutes(), listTrunks()]);
    const security = { ...defaultSecurity(), ...((await db.getSetting("security", {})) || {}) };
    const rules = await db.getSetting("outbound_rules", []);
    const byId = new Map(users.map((u) => [u.id, u]));
    return { ext, at: new Date().toISOString(), ...simulateOutbound(number, { user: byId.get(ext), users: byId, security, rules, trunks, outboundTrunk: routes.outbound_trunk, cc: countryCode() }) };
  }
  /** Fait vraiment sonner un poste (« TEST Callikoe ») et raccroche dès que les appareils sonnent. */
  async function ringTest(ext) {
    checkExtNumber(ext);
    const u = await getUser(ext);
    if (!u.registered) throw new UserError("Aucun appareil connecté sur ce poste : rien ne peut sonner.");
    const tag = `cxt${Date.now().toString(36)}`;
    try {
      await ami.action({ Action: "Originate", Channel: `Local/${ext}@cx-ringtest/n`, Application: "Wait", Data: "12", Async: "true",
        CallerID: '"TEST Callikoe" <0>', Timeout: "15000", Variable: `CXTEST=${tag}` });
    } catch { throw new UserError("Moteur téléphonique injoignable."); }
    const rang = new Map(); let answered = false;
    const t0 = Date.now();
    const chans = async () => { try { return (await ami.command("core show channels concise")).map((l) => l.split("!")); } catch { return []; } };
    while (Date.now() - t0 < 9000) {
      await new Promise((r) => setTimeout(r, 300));
      for (const c of await chans()) {
        const m = /^PJSIP\/(\d{3})(-web)?-/.exec(c[0] || "");
        if (!m || m[1] !== ext) continue;
        if (c[4] === "Ringing") rang.set(m[2] ? "web" : "desk", true);
        if (c[4] === "Up") answered = true;
      }
      const all = (reg) => reg.every((k) => rang.has(k));
      if (answered || (rang.size && Date.now() - t0 > 1500 && all([...new Set((u.contacts || []).map((c) => (c.device?.kind === "web" || c.device?.kind === "mobile" ? "web" : "desk")))]))) break;
    }
    for (const c of await chans()) if ((c[0] || "").startsWith(`Local/${ext}@cx-ringtest`)) { try { await ami.command(`channel request hangup ${c[0]}`); } catch { /* déjà raccroché */ } }
    const kinds = [...new Set((u.contacts || []).map((c) => (c.device?.kind === "web" || c.device?.kind === "mobile" ? "web" : "desk")))];
    return { ext, name: displayName(u), at: new Date().toISOString(), answered,
      results: kinds.map((k) => ({ kind: k, label: k === "web" ? "Softphone / appli" : (u.contacts.find((c) => c.device?.kind !== "web" && c.device?.kind !== "mobile")?.device?.label || "Téléphone"), rang: rang.has(k) })) };
  }
  async function forwardsReport() { return listForwards(await traceModel()); }


  // ------------------------------------------------------------------ Journal des appels (CDR)
  const CDR_COLS = `linkedid, uniqueid, sequence, calldate AT TIME ZONE 'UTC' AS calldate, enddate AT TIME ZONE 'UTC' AS enddate,
    clid, src, dst, channel, dstchannel, lastapp, lastdata, duration, billsec, disposition, did, direction, rule, userfield`;
  const trunkSet = async () => new Set((await db.query("SELECT id FROM pbxmaison_trunks")).rows.map((r) => r.id));
  /** Journal complet (console) : jours glissants, filtres simples. */
  async function callLog({ days = 7, q = "", direction = "", status = "", limit = 500 } = {}) {
    const d = Math.min(Math.max(Number(days) || 7, 1), 366);
    const r = await db.query(`SELECT ${CDR_COLS} FROM cdr WHERE linkedid IN (
        SELECT DISTINCT linkedid FROM cdr WHERE calldate > (now() AT TIME ZONE 'UTC') - make_interval(days => $1) ORDER BY 1 LIMIT 20000)
      ORDER BY calldate`, [d]);
    let calls = summarize(r.rows, await trunkSet());
    const needle = String(q || "").replace(/[\s.]/g, "").toLowerCase();
    if (needle) calls = calls.filter((c) => [c.from.number, c.from.name, c.to.number, c.did, c.answered_by, ...c.rang, c.rule].join(" ").toLowerCase().replace(/\s/g, "").includes(needle));
    if (direction) calls = calls.filter((c) => c.direction === direction);
    if (status) calls = calls.filter((c) => c.status === status);
    return { calls: calls.slice(0, Math.min(Number(limit) || 500, 5000)), total: calls.length };
  }
  /** Historique d'un utilisateur (softphone) : ses appels passés et reçus. */
  async function userCalls(ext, limit = 100) {
    const like = [`PJSIP/${ext}-%`];
    const r = await db.query(`SELECT ${CDR_COLS} FROM cdr WHERE linkedid IN (
        SELECT linkedid FROM cdr WHERE calldate > (now() AT TIME ZONE 'UTC') - interval '90 days'
          AND (channel LIKE $1 OR dstchannel LIKE $1 OR lastdata LIKE $2) ORDER BY calldate DESC LIMIT $3)
      ORDER BY calldate`, [like[0], `${ext}@%`, limit * 4]);
    return forUser(summarize(r.rows, await trunkSet()), ext).slice(0, limit);
  }


  // ------------------------------------------------------------------ Annuaire de l'entreprise
  async function loadContacts() {
    const r = await db.query("SELECT id::text, first_name, last_name, company, email, notes, phones, updated_at FROM pbxmaison_contacts ORDER BY lower(last_name || first_name || company)");
    return r.rows.map((c) => ({ ...c, name: contactName(c) }));
  }
  async function listContacts(q = "") {
    const all = await loadContacts();
    const n = String(q || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s.]/g, "");
    if (!n) return all;
    return all.filter((c) => `${c.first_name}${c.last_name}${c.company}${c.email}${c.phones.map((p) => p.number).join("")}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s/g, "").includes(n));
  }
  async function saveContact(id, input, by) {
    const c = validateContact(input || {}, countryCode());
    let r;
    if (id) {
      r = await db.query(`UPDATE pbxmaison_contacts SET first_name=$2, last_name=$3, company=$4, email=$5, notes=$6, phones=$7, updated_at=now(), updated_by=$8 WHERE id=$1 RETURNING id::text`,
        [id, c.first_name, c.last_name, c.company, c.email, c.notes, JSON.stringify(c.phones), by || ""]);
      if (!r.rowCount) throw Object.assign(new UserError("Contact introuvable."), { status: 404 });
    } else {
      r = await db.query(`INSERT INTO pbxmaison_contacts (first_name, last_name, company, email, notes, phones, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
        [c.first_name, c.last_name, c.company, c.email, c.notes, JSON.stringify(c.phones), by || ""]);
    }
    await applyDialplan();
    return { id: r.rows[0].id, ...c, name: contactName(c) };
  }
  async function deleteContact(id) {
    const r = await db.query("DELETE FROM pbxmaison_contacts WHERE id = $1", [id]);
    if (!r.rowCount) throw Object.assign(new UserError("Contact introuvable."), { status: 404 });
    await applyDialplan();
    return { ok: true };
  }
  /** Import en masse : les lignes invalides sont ignorées et listées ; doublons (même numéro) mis à jour. */
  async function importContacts(rows, replace, by) {
    const ok = [], errors = [];
    (Array.isArray(rows) ? rows : []).slice(0, 10000).forEach((row, i) => {
      try { ok.push(validateContact(row, countryCode())); } catch (e) { errors.push({ line: i + 2, error: e.message }); }
    });
    await db.tx(async (c) => {
      if (replace) await c.query("DELETE FROM pbxmaison_contacts");
      const existing = replace ? [] : (await c.query("SELECT id, phones FROM pbxmaison_contacts")).rows;
      const byNum = new Map(); for (const e of existing) for (const p of e.phones) byNum.set(p.number, e.id);
      for (const x of ok) {
        const dup = x.phones.map((p) => byNum.get(p.number)).find(Boolean);
        if (dup) await c.query("UPDATE pbxmaison_contacts SET first_name=$2, last_name=$3, company=$4, email=$5, phones=$6, updated_at=now(), updated_by=$7 WHERE id=$1",
          [dup, x.first_name, x.last_name, x.company, x.email, JSON.stringify(x.phones), by || ""]);
        else {
          const r = await c.query("INSERT INTO pbxmaison_contacts (first_name, last_name, company, email, notes, phones, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [x.first_name, x.last_name, x.company, x.email, x.notes, JSON.stringify(x.phones), by || ""]);
          for (const p of x.phones) byNum.set(p.number, r.rows[0].id);
        }
      }
    });
    await applyDialplan();
    return { imported: ok.length, errors };
  }
  async function contactsCsv() {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = (await loadContacts()).map((c) => {
      const get = (t) => c.phones.filter((p) => p.type === t).map((p) => p.number).join(" / ");
      return [c.first_name, c.last_name, c.company, get("work"), get("mobile"), get("home"), get("other"), c.email, c.notes].map(q).join(";");
    });
    return "﻿" + ["Prénom;Nom;Société;Téléphone;Mobile;Domicile;Autre;E-mail;Notes", ...rows].join("\r\n");
  }
  void PHONE_TYPES;

  async function nextFreeExtension() {
    const r = await db.query("SELECT id FROM ps_endpoints WHERE id ~ '^[1-9][0-9]{2}$' UNION SELECT number FROM pbxmaison_objects WHERE number IS NOT NULL");
    const used = new Set(r.rows.map((x) => x.id));
    for (let n = 200; n <= 899; n++) if (!used.has(String(n)) && !EMERGENCY.includes(String(n))) return String(n);
    return "";
  }

  // ------------------------------------------------------------------ Standard (ouvert / fermé / renvoyé) et renvois immédiats par code
  const astdbGet = async (family, key) => {
    try { const out = (await ami.command(`database get ${family} ${key}`)).join("\n"); return /Value:\s*(\S+)/.exec(out)?.[1] || ""; } catch { return null; }
  };
  async function getStandard() {
    const std = await db.getSetting("standard", defaultStandard());
    return { ...defaultStandard(), ...std, label: describeState(std) };
  }
  /** Change l'état du standard (console, softphone, appli) : appliqué tout de suite par Asterisk */
  async function setStandardState(input, by) {
    const st = validateState(input);
    // Fermeture avec une destination choisie à ce moment-là (softphone, appli) : elle devient la destination « fermé »
    if (st.state === "closed" && input?.dest) await setStandardConfig({ closed_dest: input.dest }, by);
    await ami.command(`database put callikoe standard ${stateValue(st)}`);
    await ami.command(`database put callikoe standard_by console`);
    try { await ami.command(`devstate change Custom:cxstd ${st.state === "open" ? "NOT_INUSE" : "INUSE"}`); } catch { /* voyant au prochain passage */ }
    const cur = await db.getSetting("standard", defaultStandard());
    const next = { ...defaultStandard(), ...cur, ...st, since: new Date().toISOString(), by: by || "" };
    await db.setSetting("standard", next);
    await db.query("INSERT INTO pbxmaison_audit (email, ip, action, ok, detail) VALUES ($1, '', $2, true, '')", [by || "", describeState(next)]).catch(() => {});
    return getStandard();
  }
  async function setStandardConfig(input, by) {
    const cur = await db.getSetting("standard", defaultStandard());
    const next = validateStandardConfig(input || {}, cur, await cfContext(null));
    await db.setSetting("standard", next);
    await applyDialplan();
    void by;
    return getStandard();
  }
  /** État changé depuis un poste (touche « Standard », *80 / *81 / *82) : recopié dans la console (qui, depuis quand, journal) */
  async function pollStandard() {
    const v = await astdbGet("callikoe", "standard");
    if (v === null) return;
    const st = parseState(v);
    const cur = await db.getSetting("standard", defaultStandard());
    if (st.state === (cur.state || "open") && st.target === (cur.target || "")) return;
    if (!v && (cur.state || "open") !== "open") {   // base Asterisk vide (réinstallation) : on remet l'état connu de la console
      try { await ami.command(`database put callikoe standard ${stateValue(cur)}`); } catch { /* prochain passage */ }
      return;
    }
    const who = await astdbGet("callikoe", "standard_by");
    const by = who && who !== "console" ? `poste ${who}` : cur.by;
    const next = { ...defaultStandard(), ...cur, ...st, since: new Date().toISOString(), by };
    await db.setSetting("standard", next);
    await db.query("INSERT INTO pbxmaison_audit (email, ip, action, ok, detail) VALUES ($1, '', $2, true, 'depuis le téléphone')", [by || "", describeState(next)]).catch(() => {});
  }
  /** Touche « Renvoi » ou « Ouvert / Fermé » ajoutée d'un clic sur le téléphone IP du poste (fiche Renvois, softphone, appli) */
  function phoneKeyInfo(u, type) {
    const r = addToggleKey(u.phone, type);
    return r ? { model: modelById(u.phone.model)?.label || "", has: r.position === 0, full: r.position === -1 } : null;
  }
  async function addPhoneKey(ext, type, by) {
    const u = await getUser(ext);
    const r = addToggleKey(u.phone, type);
    if (!r) throw new UserError("Ce poste n'a pas de téléphone IP Yealink configuré (fiche › Téléphone IP).");
    if (r.position === -1) throw new UserError("Toutes les touches du téléphone sont déjà prises : libère-en une dans l'onglet Touches.");
    if (r.position === 0) return { position: 0, notified: false };
    await updateUser(ext, { phone: { keys: r.keys } }, by);
    let notified = false;
    try { await notifyPhone(ext, "resync"); notified = true; } catch { /* le téléphone la prendra à son prochain démarrage */ }
    return { position: r.position, notified };
  }
  /** Renvoi immédiat changé par code ou touche (*21, *22, #21, touche « Renvoi ») : appliqué comme depuis la console */
  async function pollForwardCodes() {
    let lines;
    try { lines = await ami.command("database show callikoe_fwd"); } catch { return; }
    const todo = [];
    for (const l of lines) { const m = /^\/callikoe_fwd\/(\d{3})\s*:\s*(\S+)/.exec(l.trim()); if (m) todo.push([m[1], m[2]]); }
    if (!todo.length) return;
    try { await ami.command("database deltree callikoe_fwd"); } catch { /* prochain passage */ }
    for (const [ext, v] of todo) {
      try {
        const u = await getUser(ext);
        const on = u.forwarding.always?.type && u.forwarding.always.type !== "none";
        const last = u.forwarding.always_last || { type: "voicemail", target: "" };
        const always = v.startsWith("num:") ? { type: "external", target: v.slice(4) } : v === "vm" ? { type: "voicemail", target: "" }
          : v === "on" ? last : v === "off" ? { type: "none", target: "" } : v === "toggle" ? (on ? { type: "none", target: "" } : last) : null;
        if (always) await updateUser(ext, { forwarding: { always } }, "code ou touche du téléphone");
      } catch (e) { console.error(`Renvoi ${ext} :`, e.message); try { await applyDialplan(); } catch { /* voyant remis au prochain passage */ } }
    }
  }

  return {
    getStandard, setStandardState, setStandardConfig, pollStandard, pollForwardCodes, phoneKeyInfo, addPhoneKey,
    templates, listTrunks, createTrunk, deleteTrunk,
    listExtensions, createExtension, extensionSecret, resetSecret, deleteExtension, nextFreeExtension,
    getUser, updateUser, applyDialplan, forgetDevice, deleteImpact, findConsoleUser, consoleUserActive,
    provisioningUrl, phoneOptions, phoneConfig, provisionFile, resetPhoneAdmin, notifyPhone, resyncAll, trackDevices, listPhones,
    createAppToken, appTokenStatus, revokeAppToken, appProvision, appDevice, revokeAppDevice, appDevices, revokeAppDevices, createWelcome, welcomeInfo, useWelcome, webSecret, findWebUser, setWebPassword, loadUsers, registrations,
    setExtraDialplan, loadGateways, gatewayConfig, gatewayAccounts, language, countryCode, soundsDir,
    getRoutes, setRoutes, listCalls, lineStates, registrationStatus, publishRoutes,
    speechKey, audioSocketPort, webUserActive, loadObjects, listObjects, getObject, saveObject, deleteObject, objectImpact, savePrompt, promptFile, trace, forwardsReport, diagInbound, diagOutbound, ringTest, parseFlow, callLog, userCalls, listContacts, saveContact, deleteContact, importContacts, contactsCsv,
  };
}

export const routesPath = (varDir) => path.join(varDir, "extensions_routes.conf");
