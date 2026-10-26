// Liste d'adresses IP à bloquer, importée depuis un fichier : JSON (tableau d'adresses, d'objets { ip } / { address },
// ou objet contenant un tel tableau), CSV, TXT, export fail2ban ou liste copiée : toutes les adresses trouvées sont prises.
const V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const V6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
export const IPLIST_MAX = 500;

/** Adresse IPv4 / IPv6 valide (sans masque) */
export function validIp(s) { return V4.test(s) || (V6.test(s) && s.includes("::") === (s.split(":").length < 8) && !/:::/.test(s)); }

function strings(v, out) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const k of ["ip", "address", "addr", "adresse", "host", "value"]) if (typeof v[k] === "string") { out.push(v[k]); return; }
  if (v && typeof v === "object" && !Array.isArray(v)) for (const x of Object.values(v)) if (typeof x === "object") strings(x, out);
}

/** Texte du fichier → { ips: adresses valides sans doublon, invalid: entrées refusées (aperçu), total } */
export function parseIpList(text) {
  const raw = String(text || "").replace(/^﻿/, "").trim();
  let cand = [];
  if (/^[[{]/.test(raw)) { try { strings(JSON.parse(raw), cand); } catch { cand = []; } }
  if (!cand.length) cand = raw.split(/[\s,;|"'<>()[\]{}]+/);
  const ips = [], invalid = [], seen = new Set();
  for (let c of cand) {
    c = String(c).trim().replace(/\/(32|128)$/, "");
    if (!c || !/[.:]/.test(c) || /^[a-z]+:\/\//i.test(c)) continue;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(c)) continue;          // heure (journal)
    if (validIp(c)) { const k = c.toLowerCase(); if (!seen.has(k)) { seen.add(k); ips.push(k); } }
    else if (/^[\d.]+$|^[0-9a-f:]+$/i.test(c) && c.length >= 7) invalid.push(c);
  }
  return { ips: ips.slice(0, IPLIST_MAX), invalid: invalid.slice(0, 20), total: ips.length, truncated: ips.length > IPLIST_MAX };
}
