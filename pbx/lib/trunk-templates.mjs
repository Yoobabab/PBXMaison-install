/**
 * Modèles d'opérateurs SIP (format v2) et import des modèles fournisseurs 3CX (.pv.xml).
 * Sans dépendance : fonctionne dans Node et dans le navigateur (le portail l'embarque tel quel).
 *
 * Modèle v2 :
 * {
 *   id, label, source: "builtin" | "3cx", verified: bool, notes,
 *   registrar: { host, port }, proxy: { host, port } | null, transport: "udp" | "tcp" | "tls",
 *   registration: { enabled: bool, interval: secondes },
 *   auth_username_default: "trunk_number" | "custom",   // identifiant SIP = numéro du trunk ?
 *   codecs: ["alaw", "g729", "ulaw", …],                 // ordre = priorité
 *   outbound: {
 *     from_user: "caller_id" | "auth_id" | "trunk_number", // partie utilisateur du From
 *     contact_user: "auth_id" | "trunk_number",
 *     pai: bool,                                         // envoyer P-Asserted-Identity
 *     cid_format: "national" | "e164" | "e164_plus",     // numéro présenté
 *     dial_format: "national" | "e164" | "e164_plus",    // numéro appelé
 *   },
 *   inbound: { did_from: "to" | "request_uri", caller_format: "national" | "e164" | "e164_plus" | "keep" },
 *   number_format: "national" | "e164" | "e164_plus"     // format du numéro de trunk / des SDA
 * }
 */

export const NUMBER_FORMATS = ["national", "e164", "e164_plus"];
export const CODECS = ["alaw", "ulaw", "g722", "g729", "opus", "gsm"];

const CODEC_MAP = { pcma: "alaw", pcmu: "ulaw", g729: "g729", g722: "g722", opus: "opus", gsm: "gsm" };

const slug = (s) =>
  String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "operateur";

const unxml = (s) => String(s ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  .trim();

/** Lit les <field name="…">valeur</field> et les paramètres In/Out d'un modèle 3CX. */
function parse3cx(xml) {
  const text = String(xml).replace(/<!-{2}[\s\S]*?-{2}>/g, "") /* commentaires XML (écrit ainsi pour pouvoir être embarqué dans une page HTML) */;
  const fields = {};
  const paramsIn = {};
  const paramsOut = {};
  const fieldRe = /<field\b([^>]*?)(?:\/>|>([\s\S]*?)<\/field>)/gi;
  let m;
  while ((m = fieldRe.exec(text))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = unxml(a[2]);
    const value = unxml(m[2] ?? "");
    if (attrs.name === "ParameterIn" && attrs.parameter) paramsIn[attrs.parameter] = value;
    else if (attrs.name === "ParameterOut" && attrs.parameter) paramsOut[attrs.parameter] = value;
    else if (attrs.name) fields[attrs.name] = value;
  }
  const codecs = [...text.matchAll(/<codec\b[^>]*rfcname\s*=\s*"([^"]+)"/gi)].map((c) => c[1].toLowerCase());
  const header = {};
  const h = /<header>([\s\S]*?)<\/header>/i.exec(text);
  if (h) for (const t of h[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) header[t[1].toLowerCase()] = unxml(t[2]);
  return { header, fields, paramsIn, paramsOut, codecs };
}

const userMode = (v, fallback) => {
  if (!v) return fallback;
  if (/\$AuthID/i.test(v)) return "auth_id";
  if (/\$(OriginatorCallerId|CallerNum|EnforcedOutboundCallerId)/i.test(v)) return "caller_id";
  if (/\$(TrunkNumber|MainNumber)/i.test(v)) return "trunk_number";
  return fallback;
};

/**
 * Convertit un modèle fournisseur 3CX (.pv.xml exporté depuis « Modèles des fournisseurs »).
 * Lève une erreur si le fichier n'est pas un modèle fournisseur.
 */
export function from3cx(xml, overrides = {}) {
  const { header, fields, paramsOut, codecs } = parse3cx(xml);
  if (!/gateway-template|provider/i.test(`${header.type ?? ""} ${String(xml).slice(0, 2000)}`) || !("RegistrarHost" in fields) && !("ProxyHost" in fields)) {
    throw new Error("Ce fichier n'est pas un modèle fournisseur 3CX (RegistrarHost introuvable).");
  }
  const name = fields.Name || header.name || "Opérateur";
  // Les modèles 3CX mettent parfois une consigne à la place du serveur : « [Enter Registrar provided to you by Unyc] »
  const placeholder = (v) => /^\[.*\]$/.test(String(v ?? "").trim());
  const toFill = [];
  for (const k of ["RegistrarHost", "ProxyHost"]) {
    if (placeholder(fields[k])) { toFill.push(`${k === "RegistrarHost" ? "serveur" : "proxy"} : ${fields[k].slice(1, -1)}`); fields[k] = ""; }
  }
  const tags = (header.tags ?? "").toLowerCase().split(/[,\s]+/);
  const transport = (fields.TransportRestriction ?? "").toUpperCase();
  const proxyHost = fields.ProxyHost ?? "";
  const registrarHost = fields.RegistrarHost || "";
  const interval = parseInt(fields.TimeBetweenRegistration, 10);
  const mapped = codecs.map((c) => CODEC_MAP[c]).filter(Boolean);
  const e164 = tags.includes("e164");

  const t = {
    id: slug(name),
    label: name,
    source: "3cx",
    verified: true,
    notes: [
      `Importé du modèle 3CX « ${name} »${header.version ? ` (version ${header.version})` : ""}.`,
      header.url ? `Documentation : ${header.url}` : "",
      e164 ? "Les SDA sont attendues au format E.164." : "",
      toFill.length ? `À renseigner à la création du trunk — ${toFill.join(" ; ")}.` : "",
    ].filter(Boolean).join(" "),
    registrar: { host: registrarHost, port: parseInt(fields.RegistrarPort, 10) || 5060 },
    proxy: proxyHost && proxyHost !== registrarHost ? { host: proxyHost, port: parseInt(fields.ProxyPort, 10) || parseInt(fields.RegistrarPort, 10) || 5060 } : null,
    transport: transport === "TCP" ? "tcp" : transport === "TLS" ? "tls" : "udp",
    registration: { enabled: fields.RequireAuthFor !== "0", interval: interval > 0 ? interval : 300 },
    auth_username_default: "custom",
    codecs: mapped.length ? [...new Set(mapped)] : ["alaw", "ulaw"],
    outbound: {
      from_user: userMode(paramsOut.FromUserPart, "caller_id"),
      contact_user: userMode(paramsOut.ContactUser, "auth_id") === "auth_id" ? "auth_id" : "trunk_number",
      pai: !!paramsOut["P-AssertedIdentityUserPart"],
      cid_format: "national",
      dial_format: "national",
    },
    inbound: {
      did_from: fields.DestNumberIn_TO === "1" ? "to" : "request_uri",
      caller_format: "national",
    },
    number_format: e164 ? "e164" : "national",
  };
  return validateTemplate({ ...t, ...overrides });
}

/** Vérifie et complète un modèle. Lève une erreur explicite si un champ est invalide. */
export function validateTemplate(t) {
  const err = (msg) => { throw new Error(`Modèle « ${t?.label ?? t?.id ?? "?"} » : ${msg}`); };
  if (!t || typeof t !== "object") err("objet attendu");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(t.id ?? "")) err("identifiant invalide (minuscules, chiffres, tirets)");
  if (!t.label) err("nom manquant");
  const hostOk = (h) => /^[A-Za-z0-9.-]*$/.test(h ?? "");
  if (!hostOk(t.registrar?.host)) err("serveur invalide");
  if (t.proxy && (!t.proxy.host || !hostOk(t.proxy.host))) err("proxy invalide");
  if (!["udp", "tcp", "tls"].includes(t.transport)) err("transport invalide");
  if (!Array.isArray(t.codecs) || !t.codecs.length || t.codecs.some((c) => !CODECS.includes(c))) err("codecs invalides");
  const o = t.outbound ?? err("section outbound manquante");
  if (!["caller_id", "auth_id", "trunk_number"].includes(o.from_user)) err("outbound.from_user invalide");
  if (!["auth_id", "trunk_number"].includes(o.contact_user)) err("outbound.contact_user invalide");
  if (!NUMBER_FORMATS.includes(o.cid_format) || !NUMBER_FORMATS.includes(o.dial_format)) err("format de numéro sortant invalide");
  if (!["to", "request_uri"].includes(t.inbound?.did_from)) err("inbound.did_from invalide");
  if (![...NUMBER_FORMATS, "keep"].includes(t.inbound?.caller_format)) err("inbound.caller_format invalide");
  if (!NUMBER_FORMATS.includes(t.number_format)) err("number_format invalide");
  if (!["trunk_number", "custom"].includes(t.auth_username_default)) err("auth_username_default invalide");
  return {
    id: t.id, label: t.label, source: t.source ?? "builtin", verified: !!t.verified, notes: t.notes ?? "",
    registrar: { host: t.registrar.host ?? "", port: Number(t.registrar.port) || 5060 },
    proxy: t.proxy ? { host: t.proxy.host, port: Number(t.proxy.port) || 5060 } : null,
    transport: t.transport,
    registration: { enabled: t.registration?.enabled !== false, interval: Number(t.registration?.interval) || 300 },
    auth_username_default: t.auth_username_default,
    codecs: [...t.codecs],
    outbound: { ...o },
    inbound: { ...t.inbound },
    number_format: t.number_format,
  };
}

/** Met un numéro dans le format voulu. countryCode : "33". Renvoie les chiffres (avec + pour e164_plus). */
export function formatNumber(input, format, countryCode = "33") {
  let d = String(input).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = countryCode + d.slice(1);
  switch (format) {
    case "e164": return d;
    case "e164_plus": return "+" + d;
    case "national": return d.startsWith(countryCode) ? "0" + d.slice(countryCode.length) : d;
    default: throw new Error(`Format inconnu : ${format}`);
  }
}

export const FORMAT_LABELS = {
  national: "National (0412345678)",
  e164: "E.164 sans + (33412345678)",
  e164_plus: "E.164 avec + (+33412345678)",
  keep: "Inchangé",
};
