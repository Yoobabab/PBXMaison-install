/**
 * Téléphones : modèles pris en charge, réglages, touches (BLF), génération des fichiers de
 * provisioning et reconnaissance des appareils connectés. Fonctions pures (testées dans
 * console/test/phones.test.mjs).
 */
import crypto from "node:crypto";

// ------------------------------------------------------------------ Modèles
// keys : nombre de touches programmables (toutes pages comprises) ; accounts : comptes SIP.
export const MODELS = [
  { id: "yealink-t31p", brand: "Yealink", label: "Yealink T31P", keys: 2 },
  { id: "yealink-t31g", brand: "Yealink", label: "Yealink T31G", keys: 2 },
  { id: "yealink-t33g", brand: "Yealink", label: "Yealink T33G", keys: 4, screen: "320x240" },
  { id: "yealink-t34w", brand: "Yealink", label: "Yealink T34W", keys: 4, screen: "320x240" },
  { id: "yealink-t43u", brand: "Yealink", label: "Yealink T43U", keys: 21 },
  { id: "yealink-t44u", brand: "Yealink", label: "Yealink T44U / T44W", keys: 24, screen: "320x240" },
  { id: "yealink-t46u", brand: "Yealink", label: "Yealink T46U", keys: 27, screen: "480x272" },
  { id: "yealink-t48u", brand: "Yealink", label: "Yealink T48U", keys: 29, screen: "800x480" },
  { id: "yealink-t53", brand: "Yealink", label: "Yealink T53 / T53W", keys: 21 },
  { id: "yealink-t54w", brand: "Yealink", label: "Yealink T54W", keys: 27, screen: "480x272" },
  { id: "yealink-t57w", brand: "Yealink", label: "Yealink T57W", keys: 29, screen: "800x480" },
  { id: "yealink-t58w", brand: "Yealink", label: "Yealink T58W / T58A", keys: 27, screen: "1024x600" },
  { id: "yealink-t85w", brand: "Yealink", label: "Yealink T85W", keys: 27, screen: "480x272" },
  { id: "yealink-t87w", brand: "Yealink", label: "Yealink T87W", keys: 29, screen: "800x480" },
  { id: "yealink-t88w", brand: "Yealink", label: "Yealink T88W", keys: 27, screen: "1024x600" },
];
const modelById = (id) => MODELS.find((m) => m.id === id);

// ------------------------------------------------------------------ Réglages
export const LANGUAGES = { fr: ["Français", "French"], en: ["Anglais", "English"], de: ["Allemand", "German"], es: ["Espagnol", "Spanish"], it: ["Italien", "Italian"], nl: ["Néerlandais", "Dutch"] };
export const DATE_FORMATS = { "dd/mm/yyyy": ["JJ/MM/AAAA (15/01/2027)", 3], "yyyy-mm-dd": ["AAAA-MM-JJ (2027-01-15)", 2], "dd mmm yyyy": ["JJ MMM AAAA (15 janv. 2027)", 5], "www dd mmm": ["JJJ JJ MMM (ven. 15 janv.)", 6] };
export const TIME_FORMATS = { 24: "24 heures", 12: "12 heures (AM/PM)" };
export const TIMEZONES = {
  "Europe/Paris": ["France (Paris)", "+1", "France(Paris)", 2],
  "Europe/Brussels": ["Belgique (Bruxelles)", "+1", "Belgium(Brussels)", 2],
  "Europe/Luxembourg": ["Luxembourg", "+1", "Luxembourg(Luxembourg)", 2],
  "Europe/Zurich": ["Suisse (Berne)", "+1", "Switzerland(Bern)", 2],
  "Europe/Monaco": ["Monaco", "+1", "France(Paris)", 2],
  "Indian/Reunion": ["La Réunion", "+4", "Reunion", 0],
  "Indian/Mayotte": ["Mayotte", "+3", "Mayotte", 0],
  "America/Martinique": ["Martinique / Guadeloupe", "-4", "Martinique", 0],
  "America/Cayenne": ["Guyane", "-3", "French Guiana", 0],
  "Pacific/Noumea": ["Nouvelle-Calédonie", "+11", "New Caledonia", 0],
  "Pacific/Tahiti": ["Polynésie (Tahiti)", "-10", "French Polynesia", 0],
};
export const BACKLIGHT = { 0: "Toujours allumé", 30: "30 secondes", 60: "1 minute", 300: "5 minutes", 600: "10 minutes", 1800: "30 minutes", 3600: "1 heure" };
export const SCREENSAVER = { 60: "1 minute", 300: "5 minutes", 600: "10 minutes", 1800: "30 minutes", 3600: "1 heure", 7200: "2 heures", 21600: "6 heures" };
export const TRANSFER = { attended: ["Transfert supervisé", 1], blind: ["Transfert aveugle", 2], newcall: ["Nouvel appel", 0] };
export const LED = { voicemail: "Messages vocaux uniquement", missed: "Appels manqués uniquement", both: "Messages vocaux et appels manqués", off: "Aucun" };
export const TRANSPORTS = { udp: ["UDP (5060)", 0, 5060], tcp: ["TCP (5060)", 1, 5060], tls: ["TLS chiffré (5061)", 2, 5061] };
export const KEY_TYPES = { line: "Ligne", blf: "BLF (supervision + interception)", speed: "Numérotation rapide", none: "Aucune" };

export function defaultPhone(tz = "Europe/Paris") {
  return {
    model: "", mac: "", admin_password: "",
    settings: {
      language: "fr", date_format: "dd/mm/yyyy", time_format: "24", timezone: TIMEZONES[tz] ? tz : "Europe/Paris",
      backlight: 3600, screensaver: 3600, transfer: "attended", led: "voicemail", lldp: true, transport: "udp",
    },
    keys: [{ type: "line", value: "", label: "" }],
  };
}

export function phoneFromStored(stored, tz) {
  const d = defaultPhone(tz);
  const p = stored || {};
  return {
    ...d, ...p,
    settings: { ...d.settings, ...p.settings },
    keys: Array.isArray(p.keys) && p.keys.length ? p.keys : d.keys,
  };
}

export class PhoneError extends Error {
  constructor(message, field) { super(message); this.field = field; this.status = 400; }
}

/** 44:DB:D2:29:FA:7B, 44-db-d2-29-fa-7b, 44dbd229fa7b → 44dbd229fa7b ; "" si vide ; null si invalide. */
export function normalizeMac(input) {
  const s = String(input ?? "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!String(input ?? "").trim()) return "";
  return /^[0-9a-f]{12}$/.test(s) ? s : null;
}
export const formatMac = (m) => (m || "").toUpperCase().replace(/(..)(?=.)/g, "$1:");

const pick = (table, v, fallback) => (Object.prototype.hasOwnProperty.call(table, String(v)) ? (typeof fallback === "number" ? Number(v) : String(v)) : fallback);
const cleanLabel = (s) => String(s ?? "").replace(/[\r\n=#]/g, " ").trim().slice(0, 24);

/**
 * Valide l'onglet Téléphone IP.
 * @param ctx { extensions: Map id → nom, macOwners: Map mac → poste, selfId }
 */
export function validatePhone(input, current, ctx) {
  const p = structuredClone(current);
  if (input.model !== undefined) {
    if (input.model && !modelById(input.model)) throw new PhoneError("Modèle inconnu.", "phone.model");
    p.model = input.model || "";
  }
  if (input.mac !== undefined) {
    const mac = normalizeMac(input.mac);
    if (mac === null) throw new PhoneError("Adresse MAC invalide (12 caractères hexadécimaux, ex. 44:DB:D2:29:FA:7B).", "phone.mac");
    const owner = mac && ctx.macOwners?.get(mac);
    if (owner && owner !== ctx.selfId) throw new PhoneError(`Cette adresse MAC est déjà attribuée au poste ${owner}.`, "phone.mac");
    p.mac = mac;
  }
  if (p.mac && !p.model) throw new PhoneError("Choisis le modèle du téléphone.", "phone.model");
  const s = input.settings || {};
  const st = p.settings;
  st.language = pick(LANGUAGES, s.language ?? st.language, st.language);
  st.date_format = pick(DATE_FORMATS, s.date_format ?? st.date_format, st.date_format);
  st.time_format = pick(TIME_FORMATS, s.time_format ?? st.time_format, st.time_format);
  st.timezone = pick(TIMEZONES, s.timezone ?? st.timezone, st.timezone);
  st.backlight = pick(BACKLIGHT, s.backlight ?? st.backlight, Number(st.backlight));
  st.screensaver = pick(SCREENSAVER, s.screensaver ?? st.screensaver, Number(st.screensaver));
  st.transfer = pick(TRANSFER, s.transfer ?? st.transfer, st.transfer);
  st.led = pick(LED, s.led ?? st.led, st.led);
  st.transport = pick(TRANSPORTS, s.transport ?? st.transport, st.transport);
  if (s.lldp !== undefined) st.lldp = !!s.lldp;

  if (input.keys !== undefined) {
    if (!Array.isArray(input.keys)) throw new PhoneError("Touches invalides.", "phone.keys");
    if (input.keys.length > 40) throw new PhoneError("40 touches au maximum.", "phone.keys");
    p.keys = input.keys.map((k, i) => {
      const type = KEY_TYPES[k?.type] ? k.type : "none";
      const value = String(k?.value ?? "").trim();
      const label = cleanLabel(k?.label);
      if (type === "blf") {
        if (!ctx.extensions?.has(value)) throw new PhoneError(`Touche ${i + 1} : choisis l'utilisateur à superviser.`, `phone.keys.${i}`);
        return { type, value, label: label || ctx.extensions.get(value) || value };
      }
      if (type === "speed") {
        if (!/^[0-9*#+]{2,20}$/.test(value.replace(/[\s.]/g, ""))) throw new PhoneError(`Touche ${i + 1} : numéro invalide.`, `phone.keys.${i}`);
        if (!label) throw new PhoneError(`Touche ${i + 1} : indique un libellé.`, `phone.keys.${i}`);
        return { type, value: value.replace(/[\s.]/g, ""), label };
      }
      return { type, value: "", label: type === "line" ? label : "" };
    });
    while (p.keys.length && p.keys.at(-1).type === "none") p.keys.pop();
  }
  if (p.mac && !p.admin_password) p.admin_password = randomPassword(12);
  return p;
}

export function randomPassword(n = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(n);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

// ------------------------------------------------------------------ Fichier Yealink
/**
 * @param user   fiche utilisateur (id, nom, voicemail…)
 * @param phone  phoneFromStored(...)
 * @param secret { auth_id, password }
 * @param server { host, prov_url }
 * @param names  Map poste → nom (libellés BLF)
 */
export function buildYealinkCfg(user, phone, secret, server, names = new Map()) {
  const st = phone.settings;
  const model = modelById(phone.model);
  const [, transportCode, port] = TRANSPORTS[st.transport] || TRANSPORTS.udp;
  const [, tzOffset, tzName, dst] = TIMEZONES[st.timezone] || TIMEZONES["Europe/Paris"];
  const name = `${user.first_name} ${user.last_name}`.trim() || `Poste ${user.id}`;
  const v = (k, val) => `${k} = ${String(val ?? "").replace(/[\r\n]/g, " ")}`;
  const L = [
    "#!version:1.0.0.1",
    `## Callikoe — poste ${user.id} (${name}) — ${model?.label || phone.model} — généré le ${new Date().toISOString()}`,
    "## Ne pas modifier : ce fichier est régénéré par le PBX.",
    "",
    "## Compte SIP",
    v("account.1.enable", 1),
    v("account.1.label", `${user.id} ${name}`.slice(0, 32)),
    v("account.1.display_name", name),
    v("account.1.user_name", user.id),
    v("account.1.auth_name", secret.auth_id),
    v("account.1.password", secret.password),
    v("account.1.sip_server.1.address", server.host),
    v("account.1.sip_server.1.port", port),
    v("account.1.sip_server.1.transport_type", transportCode),
    v("account.1.sip_server.1.expires", 600),
    v("account.1.sip_server.1.retry_counts", 3),
    v("account.1.nat.udp_update_enable", 1),
    v("account.1.nat.udp_update_time", 30),
    v("account.1.nat.rport", 1),
    v("account.1.subscribe_mwi", 0),
    v("voice_mail.number.1", "*97"),
    v("account.1.codec.g722.enable", 1), v("account.1.codec.g722.priority", 1),
    v("account.1.codec.pcma.enable", 1), v("account.1.codec.pcma.priority", 2),
    v("account.1.codec.pcmu.enable", 1), v("account.1.codec.pcmu.priority", 3),
    v("account.1.codec.g729.enable", 0),
    v("account.1.dtmf.type", 1),
    v("features.pickup.direct_pickup_enable", 1),
    v("features.pickup.direct_pickup_code", "**"),
    "",
    "## Langue, date et heure",
    v("lang.gui", LANGUAGES[st.language]?.[1] || "French"),
    v("lang.wui", LANGUAGES[st.language]?.[1] || "French"),
    v("local_time.time_zone", tzOffset),
    v("local_time.time_zone_name", tzName),
    v("local_time.summer_time", dst),
    v("local_time.ntp_server1", "pool.ntp.org"),
    v("local_time.date_format", DATE_FORMATS[st.date_format]?.[1] ?? 3),
    v("local_time.time_format", st.time_format === "12" ? 0 : 1),
    "",
    "## Écran, transfert, voyants",
    v("phone_setting.backlight_time", st.backlight),
    v("screensaver.wait_time", st.screensaver),
    v("transfer.dsskey_deal_type", TRANSFER[st.transfer]?.[1] ?? 1),
    v("phone_setting.mail_power_led_flash_enable", st.led === "voicemail" || st.led === "both" ? 1 : 0),
    v("phone_setting.missed_call_power_led_flash.enable", st.led === "missed" || st.led === "both" ? 1 : 0),
    v("static.network.lldp.enable", st.lldp ? 1 : 0),
    "",
    "## Sécurité et provisioning",
    v("static.security.user_password", `admin:${phone.admin_password}`),
    v("static.auto_provision.server.url", server.prov_url),
    v("static.auto_provision.repeat.enable", 1),
    v("static.auto_provision.repeat.minutes", 1440),
    v("static.auto_provision.pnp_enable", 0),
    "",
    ...(model?.screen && server.assets_url ? [
      "## Fond d'écran Callikoe",
      v("wallpaper_upload.url", `${server.assets_url}wallpaper-${model.screen}.png`),
      v("phone_setting.backgrounds", `Config:wallpaper-${model.screen}.png`),
      "",
    ] : []),
    "## Touches",
  ];
  const n = Math.max(model?.keys || 0, phone.keys.length);
  for (let i = 0; i < n; i++) {
    const k = phone.keys[i] || { type: "none" };
    const p = `linekey.${i + 1}`;
    if (k.type === "line") L.push(v(`${p}.type`, 15), v(`${p}.line`, 1), v(`${p}.value`, ""), v(`${p}.label`, k.label || ""));
    else if (k.type === "blf") L.push(v(`${p}.type`, 16), v(`${p}.line`, 1), v(`${p}.value`, k.value), v(`${p}.label`, k.label || names.get(k.value) || k.value));
    else if (k.type === "speed") L.push(v(`${p}.type`, 13), v(`${p}.line`, 1), v(`${p}.value`, k.value), v(`${p}.label`, k.label));
    else L.push(v(`${p}.type`, 0), v(`${p}.value`, ""), v(`${p}.label`, ""));
  }
  L.push("");
  return L.join("\n");
}

// ------------------------------------------------------------------ Appareils connectés
/** Reconnaît l'appareil à partir du User-Agent SIP. */
export function identifyDevice(userAgent = "") {
  const ua = String(userAgent);
  const out = { kind: "unknown", brand: "", model: "", mac: "", label: ua || "Inconnu" };
  let m;
  if ((m = /Yealink\s+(?:SIP-)?([A-Z]+[0-9]+[A-Z]*)\s+([\d.]+)(?:\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5}))?/i.exec(ua))) {
    return { kind: "phone", brand: "Yealink", model: m[1].toUpperCase(), firmware: m[2], mac: m[3] ? m[3].replace(/:/g, "").toLowerCase() : "", label: `Yealink ${m[1].toUpperCase()}` };
  }
  if ((m = /(Fanvil|Snom|Grandstream|Gigaset|Panasonic|Polycom|Poly|Cisco|Alcatel|Htek|Akuvox|Mitel|Avaya)[ /-]?([A-Za-z0-9-]*)/i.exec(ua))) {
    return { ...out, kind: "phone", brand: m[1], model: m[2], label: `${m[1]} ${m[2]}`.trim() };
  }
  if (/PBXMaison-Web|Callikoe-Web|SIP\.js|JsSIP|sipML5|WebRTC/i.test(ua)) return { ...out, kind: "web", label: "Softphone web" };
  if (/Android|iPhone|iOS|iPad|Groundwire|Acrobits|Bria Mobile|Zoiper\s*(?:iOS|Android)|Linphone(?:Android|iOS)|PBXMaison-App|Callikoe-App/i.test(ua)) return { ...out, kind: "mobile", label: ua.split(/[ /]/)[0] || "Appli mobile" };
  if (/MicroSIP|Zoiper|Linphone|PhonerLite|X-Lite|Bria|Jitsi|baresip|Blink|Telephone|3CX/i.test(ua)) return { ...out, kind: "pc", label: ua.split(/[ /]/)[0] || "Softphone" };
  return out;
}

const privateIp = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip || "");

/**
 * Type de connexion d'un appareil.
 * @param sourceIp IP vue par le PBX ; localIp IP annoncée par l'appareil (Via) ; sbcs [{name, ip}]
 */
export function connectionType(sourceIp, localIp, sbcs = []) {
  const sbc = sbcs.find((s) => s.ip === sourceIp);
  if (sbc) return { code: "sbc", label: `Via le SBC « ${sbc.name} »` };
  if (privateIp(sourceIp)) return { code: "local", label: "Réseau local" };
  if (localIp && localIp !== sourceIp && privateIp(localIp)) return { code: "nat", label: "Internet (derrière une box / NAT)" };
  return { code: "direct", label: "Internet (IP publique / STUN)" };
}
