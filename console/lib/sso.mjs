/**
 * Serveur multi-tenant : passage de la console du serveur vers la console d'un PBX client (comme Omada).
 * La console du serveur signe un ticket court (Ed25519) ; la console du PBX le vérifie avec la clé publique,
 * lisible par tous les PBX du serveur. Seule la console du serveur détient la clé privée.
 */
import fs from "node:fs";
import crypto from "node:crypto";

export const HUB_PUBLIC_KEY = process.env.CX_HUB_PUBLIC_KEY || "/etc/callikoe/hub-sso.pem";
export const HUB_USERS = process.env.CX_HUB_USERS || "/var/lib/callikoe/hub/users.json";
export const HUB_INFO = process.env.CX_HUB_INFO || "/etc/callikoe/hub.json";
export const TENANTS = process.env.CX_TENANTS || "/etc/callikoe/tenants.json";

/** Rôle sur le serveur → rôle dans la console d'un PBX */
export const HUB_TO_PBX_ROLE = { super: "admin", admin: "admin", tech: "tech", lecture: "lecture" };
export const emailKey = (email) => crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");

const b64u = (b) => Buffer.from(b).toString("base64url");

export function signTicket(privateKeyPem, data, seconds = 60) {
  const body = b64u(JSON.stringify({ ...data, exp: Date.now() + seconds * 1000, nonce: crypto.randomBytes(12).toString("hex") }));
  const sig = crypto.sign(null, Buffer.from(body), privateKeyPem);
  return `${body}.${b64u(sig)}`;
}

const seen = new Map(); // tickets déjà utilisés (une seule utilisation)
export function verifyTicket(ticket, publicKeyPem, audience) {
  const [body, sig] = String(ticket || "").split(".");
  if (!body || !sig) return null;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(body), publicKeyPem, Buffer.from(sig, "base64url")); } catch { ok = false; }
  if (!ok) return null;
  let d; try { d = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!d || d.aud !== audience || !(d.exp > Date.now()) || !d.email || !HUB_TO_PBX_ROLE[d.role]) return null;
  for (const [k, exp] of seen) if (exp < Date.now()) seen.delete(k);
  if (seen.has(d.nonce)) return null;
  seen.set(d.nonce, d.exp);
  return d;
}

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
/** Rôle actuel d'un compte du serveur (null si supprimé ou désactivé) : un compte retiré perd l'accès à tous les PBX aussitôt. */
export const hubRole = (email) => readJson(HUB_USERS, {})[emailKey(email)] || null;
export const hubInfo = () => readJson(HUB_INFO, {});
export const tenantList = () => (readJson(TENANTS, {}).tenants || []).map((t) => ({ slug: t.slug, name: t.name, fqdn: t.fqdn }));
export const readHubPublicKey = () => { try { return fs.readFileSync(HUB_PUBLIC_KEY, "utf8"); } catch { return null; } };
