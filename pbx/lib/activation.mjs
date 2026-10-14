/**
 * Code d'installation : résumé de l'installation, généré par le PBX et collé dans le portail.
 * Format : PBXACT1.<JSON en base64url>.<CRC32 en hexa>
 * La somme de contrôle détecte un copier-coller incomplet ou abîmé.
 *
 * Fonctionne dans Node (installeur) et dans le navigateur (portail, qui embarque ce fichier).
 *
 * CLI (installeur) : node activation.mjs encode-env
 *   lit les variables ACT_* de l'environnement et affiche le code.
 */

export const ACTIVATION_PREFIX = "PBXACT1";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const toB64url = (bytes) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

export function encodeActivation(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return `${ACTIVATION_PREFIX}.${toB64url(bytes)}.${crc32(bytes).toString(16).padStart(8, "0")}`;
}

/** Renvoie { ok: true, data } ou { ok: false, error } (message en français). */
export function decodeActivation(input) {
  const code = String(input ?? "").replace(/\s+/g, "");
  const m = /^PBXACT1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8})$/.exec(code);
  if (!m) return { ok: false, error: "Ce n'est pas un code d'installation (il commence par PBXACT1.)." };
  let bytes;
  try { bytes = fromB64url(m[1]); } catch { return { ok: false, error: "Code illisible : il a peut-être été coupé." }; }
  if (crc32(bytes).toString(16).padStart(8, "0") !== m[2]) {
    return { ok: false, error: "Code incomplet ou modifié : recopie-le en entier." };
  }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { ok: false, error: "Contenu du code invalide." }; }
  for (const k of ["pbx_id", "license_key", "fqdn", "installed_at"]) {
    if (!data?.[k]) return { ok: false, error: `Information manquante dans le code : ${k}.` };
  }
  return { ok: true, data };
}

// ---------- CLI (installeur) ----------
const isMain = typeof process !== "undefined" && process.argv?.[1] &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;

if (isMain && process.argv[2] === "encode-env") {
  const e = process.env;
  const data = {
    v: 1,
    pbx_id: e.ACT_PBX_ID,
    license_key: e.ACT_LICENSE_KEY,
    fqdn: e.ACT_FQDN,
    installed_at: new Date().toISOString(),
    public_ip: e.ACT_PUBLIC_IP || null,
    local_ip: e.ACT_LOCAL_IP || null,
    behind_nat: e.ACT_BEHIND_NAT === "1",
    dns_ok: e.ACT_DNS_OK === "1",
    tls: e.ACT_TLS === "1",
    wsl: e.ACT_WSL === "1",
    os: e.ACT_OS || null,
    asterisk: e.ACT_ASTERISK || null,
    machine: e.ACT_MACHINE || null,
  };
  process.stdout.write(encodeActivation(data) + "\n");
}
