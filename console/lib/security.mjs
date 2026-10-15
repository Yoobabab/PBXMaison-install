/**
 * Sécurité du PBX : numéros bloqués (entrants / sortants), pays autorisés, surtaxés, appels anonymes,
 * limites par utilisateur, durée maximale, accès à la console par adresse IP, réglages anti-intrusion.
 * Fonctions pures, testées dans console/test/security.test.mjs.
 */
import { UserError } from "./users.mjs";

export const COUNTRIES = [
  ["32", "Belgique"], ["41", "Suisse"], ["352", "Luxembourg"], ["377", "Monaco"], ["49", "Allemagne"], ["34", "Espagne"], ["39", "Italie"],
  ["44", "Royaume-Uni"], ["351", "Portugal"], ["31", "Pays-Bas"], ["43", "Autriche"], ["353", "Irlande"], ["45", "Danemark"], ["46", "Suède"],
  ["47", "Norvège"], ["358", "Finlande"], ["48", "Pologne"], ["420", "Tchéquie"], ["30", "Grèce"], ["40", "Roumanie"], ["36", "Hongrie"],
  ["376", "Andorre"], ["1", "États-Unis et Canada"], ["212", "Maroc"], ["213", "Algérie"], ["216", "Tunisie"], ["221", "Sénégal"],
  ["225", "Côte d'Ivoire"], ["237", "Cameroun"], ["90", "Turquie"], ["972", "Israël"], ["971", "Émirats arabes unis"], ["86", "Chine"],
  ["81", "Japon"], ["91", "Inde"], ["61", "Australie"], ["55", "Brésil"], ["7", "Russie"], ["380", "Ukraine"],
];
const COUNTRY = Object.fromEntries(COUNTRIES);

export function defaultSecurity() {
  return {
    block_premium: true, block_anonymous: false, intl: [], in_block: [], out_block: [],
    max_user_calls: 2, max_duration: 240, max_per_hour: 100, max_intl_day: 20, console_allow: [], whitelist: [], sip_allow: [],
    f2b: { maxretry: 5, findtime: 10, bantime: 60 }, banned: [],
  };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** Adresse IPv4 / IPv6, avec masque facultatif. */
export function checkIp(raw, { cidr = true } = {}) {
  const s = String(raw || "").trim();
  const [ip, mask, extra] = s.split("/");
  if (extra !== undefined || !ip) return null;
  const v4 = IPV4.test(ip), v6 = !v4 && /^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && ip.split(":").length <= 8;
  if (!v4 && !v6) return null;
  if (mask !== undefined) {
    if (!cidr || !/^\d{1,3}$/.test(mask) || Number(mask) > (v4 ? 32 : 128)) return null;
  }
  return s.toLowerCase();
}

/** Numéro bloqué : chiffres (national), « * » final = tous les numéros qui commencent ainsi. */
function blockEntry(e, field) {
  const raw = String(e?.number ?? e ?? "").replace(/[\s.\-()]/g, "");
  let n = raw.replace(/^\+33/, "0").replace(/^0033/, "0");
  const prefix = n.endsWith("*");
  if (prefix) n = n.slice(0, -1);
  if (!/^\d{2,15}$/.test(n)) throw new UserError(`Numéro invalide : ${raw || "(vide)"}.`, field);
  return { number: n, prefix, label: String(e?.label || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 40) };
}
const int = (v, min, max, label, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} : entre ${min} et ${max}.`, field);
  return n;
};

export function validateSecurity(input, current = defaultSecurity()) {
  const s = { ...defaultSecurity(), ...current, f2b: { ...defaultSecurity().f2b, ...(current.f2b || {}) } };
  if (input.block_premium !== undefined) s.block_premium = !!input.block_premium;
  if (input.block_anonymous !== undefined) s.block_anonymous = !!input.block_anonymous;
  if (input.intl !== undefined) {
    const list = [];
    for (const cc of (Array.isArray(input.intl) ? input.intl : String(input.intl).split(/[\s,;]+/)).map((x) => String(x).replace(/^\+|^00/, "").trim()).filter(Boolean)) {
      if (!/^\d{1,4}$/.test(cc)) throw new UserError(`Indicatif pays invalide : ${cc}.`, "intl");
      if (cc === "33") continue;
      if (!list.includes(cc)) list.push(cc);
    }
    s.intl = list;
  }
  for (const k of ["in_block", "out_block"]) {
    if (input[k] === undefined) continue;
    const seen = new Set();
    s[k] = (Array.isArray(input[k]) ? input[k] : []).filter((e) => String(e?.number ?? e ?? "").trim()).map((e) => blockEntry(e, k))
      .filter((e) => { const key = `${e.number}${e.prefix ? "*" : ""}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 2000);
  }
  if (input.max_user_calls !== undefined) s.max_user_calls = int(input.max_user_calls, 0, 50, "Appels externes simultanés par utilisateur", "max_user_calls");
  if (input.max_per_hour !== undefined) s.max_per_hour = int(input.max_per_hour, 0, 10000, "Appels externes par heure (tout le PBX)", "max_per_hour");
  if (input.max_intl_day !== undefined) s.max_intl_day = int(input.max_intl_day, 0, 10000, "Appels internationaux par jour", "max_intl_day");
  if (input.max_duration !== undefined) s.max_duration = int(input.max_duration, 0, 1440, "Durée maximale d'un appel externe (minutes)", "max_duration");
  for (const k of ["console_allow", "whitelist", "sip_allow"]) {
    if (input[k] === undefined) continue;
    const list = [];
    for (const raw of (Array.isArray(input[k]) ? input[k] : String(input[k]).split(/[\s,;]+/)).filter((x) => String(x).trim())) {
      const ip = checkIp(raw);
      if (!ip) throw new UserError(`Adresse IP invalide : ${raw}.`, k);
      if (!list.includes(ip)) list.push(ip);
    }
    s[k] = list.slice(0, 200);
  }
  if (input.f2b) {
    s.f2b = {
      maxretry: int(input.f2b.maxretry ?? s.f2b.maxretry, 2, 50, "Tentatives avant blocage", "f2b.maxretry"),
      findtime: int(input.f2b.findtime ?? s.f2b.findtime, 1, 1440, "Fenêtre d'observation (minutes)", "f2b.findtime"),
      bantime: int(input.f2b.bantime ?? s.f2b.bantime, 1, 525600, "Durée du blocage (minutes)", "f2b.bantime"),
    };
  }
  return s;
}

/** Contextes Asterisk : numéros bloqués, pays autorisés. */
export function buildSecurityDialplan(s) {
  const pat = (e) => e.prefix ? `_${e.number}.` : e.number;
  const L = ["", "; Sécurité — écrit par la console web", "[blocked-in]"];
  for (const e of s.in_block) L.push(`exten => ${pat(e)},1,Return()`);
  L.push("", "[blocked-out]");
  for (const e of s.out_block) L.push(`exten => ${pat(e)},1,Return()`);
  L.push("", "; Pays autorisés en sortie (composés en 00 + indicatif)", "[intl-allowed]");
  for (const cc of s.intl) L.push(`exten => _00${cc}.,1,Return()`);
  L.push("");
  return L.join("\n");
}

/** Variables globales lues par extensions.conf. */
export const securityGlobals = (s) => [
  `SEC_BLOCK_PREMIUM = ${s.block_premium ? 1 : 0}`, `SEC_BLOCK_ANON = ${s.block_anonymous ? 1 : 0}`,
  `SEC_MAX_USER_CALLS = ${s.max_user_calls}`, `SEC_MAX_DURATION = ${s.max_duration}`,
  `SEC_MAX_PER_HOUR = ${s.max_per_hour ?? 100}`, `SEC_MAX_INTL_DAY = ${s.max_intl_day ?? 20}`,
];

/** Postes SIP (téléphones, DECT, applis) limités à certains réseaux : valeurs deny / permit des endpoints, ou null. */
export function sipAcl(s) {
  const list = (s.sip_allow || []).map((x) => (x.includes("/") ? x : `${x}/32`)).filter((x) => !x.includes(":"));
  return list.length ? { deny: "0.0.0.0/0.0.0.0", permit: ["127.0.0.1/32", ...list].join(",") } : { deny: null, permit: null };
}

/** L'IP du visiteur est-elle autorisée sur la console ? (liste vide = tout le monde) */
export function ipAllowed(ip, allow) {
  if (!allow?.length) return true;
  const a = String(ip || "").replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  return allow.some((rule) => {
    const [net, bits] = rule.split("/");
    if (!bits) return net === a;
    if (!IPV4.test(net) || !IPV4.test(a)) return false;
    const n = (x) => x.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const m = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n(net) & m) === (n(a) & m);
  });
}

export const countryName = (cc) => COUNTRY[cc] || `+${cc}`;
