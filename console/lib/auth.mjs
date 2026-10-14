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

const SESSION_HOURS = 12;

export function createSession(email, secret) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
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
    return d.exp > Date.now() ? { email: d.email } : null;
  } catch { return null; }
}

/** Comparaison à temps constant de deux chaînes (jeton d'installation). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
