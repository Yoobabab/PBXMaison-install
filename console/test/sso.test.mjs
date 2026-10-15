import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signTicket, verifyTicket, emailKey } from "../lib/sso.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey.export({ type: "spki", format: "pem" });

test("ticket valable une seule fois, pour un seul PBX", () => {
  const t = signTicket(priv, { aud: "clia", email: "a@irt.fr", role: "tech" });
  assert.equal(verifyTicket(t, pub, "clib"), null, "autre PBX refusé");
  const d = verifyTicket(t, pub, "clia");
  assert.equal(d.email, "a@irt.fr");
  assert.equal(d.role, "tech");
  assert.equal(verifyTicket(t, pub, "clia"), null, "deuxième utilisation refusée");
});

test("ticket modifié, expiré, rôle inconnu ou autre clé : refusé", () => {
  const t = signTicket(priv, { aud: "clia", email: "a@irt.fr", role: "lecture" });
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), role: "super" })).toString("base64url");
  assert.equal(verifyTicket(`${forged}.${sig}`, pub, "clia"), null);
  assert.equal(verifyTicket(signTicket(priv, { aud: "clia", email: "a@irt.fr", role: "lecture" }, -1), pub, "clia"), null);
  assert.equal(verifyTicket(signTicket(priv, { aud: "clia", email: "a@irt.fr", role: "root" }), pub, "clia"), null);
  const other = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(verifyTicket(signTicket(other, { aud: "clia", email: "a@irt.fr", role: "admin" }), pub, "clia"), null);
  assert.equal(verifyTicket("n'importe quoi", pub, "clia"), null);
});

test("empreinte d'e-mail insensible à la casse", () => {
  assert.equal(emailKey(" A@IRT.fr "), emailKey("a@irt.fr"));
});
