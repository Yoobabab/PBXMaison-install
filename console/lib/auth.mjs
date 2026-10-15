/** Mots de passe (scrypt) et sessions signées (HMAC, sans stockage serveur). */
import crypto from "node:crypto";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  const [algo, s, h] = String(stored || "").split(":");
  if (algo !== "scrypt" || !s || !h) return false;
  const expected = Buffer.from(h, "base64url");
  const actual = crypto.scryptSync(String(password), Buffer.from(s, "base64url"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "10 caractères minimum.";
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return "Le mot de passe doit contenir des lettres et des chiffres.";
  return null;
}

const SESSION_HOURS = 8;

/** extra : { mfa: true si la double authentification a été faite, mfa_at: horodatage du dernier code } */
export function createSession(email, secret, extra = {}) {
  const payload = Buffer.from(JSON.stringify({ email, ...extra, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readSession(token, secret) {
  if (!token || !secret) return null;
  const [payload, mac] = String(token).split(".");
  if (!payload || !mac) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d.exp > Date.now() ? { email: d.email, mfa: !!d.mfa, mfa_at: d.mfa_at || 0, ...(d.hub ? { hub: true } : {}) } : null;
  } catch { return null; }
}

/** Jeton signé générique (espace utilisateur / softphone) : { ...data, exp }. */
export function createToken(data, secret, hours = 12) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + hours * 3600_000 })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", `u:${secret}`).update(payload).digest("base64url")}`;
}
export function readToken(token, secret) {
  if (!token || !secret) return null;
  const [payload, mac] = String(token).split(".");
  if (!payload || !mac) return null;
  const expected = crypto.createHmac("sha256", `u:${secret}`).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try { const d = JSON.parse(Buffer.from(payload, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}

/** Comparaison à temps constant de deux chaînes (jeton d'installation). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ Double authentification (TOTP, RFC 6238)
// Compatible avec Psono, Google Authenticator, Microsoft Authenticator, 1Password… (code à 6 chiffres, 30 s)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const c of s) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totpCode(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
/** Renvoie le pas de temps accepté (pour refuser la réutilisation du même code), ou null. Tolérance ±1 pas (30 s). */
export function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const exp = Buffer.from(totpCode(secret, s)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(exp, got)) return s;
  }
  return null;
}
export const otpauthUri = (secret, account, issuer = "Callikoe") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
/** Codes de secours : affichés une fois, stockés hachés. */
export function newRecoveryCodes(n = 8) {
  const codes = Array.from({ length: n }, () => crypto.randomBytes(5).toString("hex").toUpperCase().replace(/(.{5})/, "$1-"));
  return { codes, hashes: codes.map((c) => crypto.createHash("sha256").update(c.replace(/-/g, "")).digest("hex")) };
}
export const recoveryHash = (code) => crypto.createHash("sha256").update(String(code || "").toUpperCase().replace(/[^0-9A-F]/g, "")).digest("hex");
