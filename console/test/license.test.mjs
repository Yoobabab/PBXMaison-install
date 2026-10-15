import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalJson } from "../../pbx/lib/verify-config.mjs";
import { encodeToken, parseToken, updateEnv } from "../../pbx/lib/license-token.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function key() {
  const body = "ABCDEFGHJKLM";
  const h = crypto.createHash("sha256").update(`PBXM:${body}`).digest();
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  let sum = ""; for (let i = 3; i >= 0; i--) sum += ALPHA[(bits >> (i * 5)) & 31];
  return `PBXM-ABCD-EFGH-JKLM-${sum}`;
}
const sign = (o) => ({ ...o, signature: crypto.sign(null, Buffer.from(canonicalJson(o)), privateKey).toString("base64") });
const lic = { pbx_id: "p-1", key: key(), edition: "enterprise", simultaneous_calls: 8, expires_at: "2099-01-01T00:00:00.000Z", issued_at: "2026-10-15T00:00:00.000Z" };

test("clé de licence : acceptée pour le bon PBX", () => {
  const r = parseToken(encodeToken(sign(lic)), pem, "p-1");
  assert.equal(r.edition, "enterprise"); assert.equal(r.simultaneous_calls, 8);
});
test("clé de licence : refusée si modifiée, autre PBX ou expirée", () => {
  const t = sign(lic);
  assert.throws(() => parseToken(encodeToken({ ...t, simultaneous_calls: 64 }), pem, "p-1"), /Signature invalide/);
  assert.throws(() => parseToken(encodeToken(t), pem, "p-2"), /autre PBX/);
  assert.throws(() => parseToken(encodeToken(sign({ ...lic, expires_at: "2020-01-01T00:00:00Z" })), pem, "p-1"), /expirée/);
  assert.throws(() => parseToken("n'importe quoi", pem, "p-1"), /illisible/);
});
test("clé de licence : pbx.env mis à jour sans toucher au reste", () => {
  const env = "PBX_ID='p-1'\nPBX_NAME='Test'\nPBX_EDITION='pro'\nPBX_MAX_CALLS='4'\n";
  const out = updateEnv(env, { key: lic.key, edition: "enterprise", simultaneous_calls: 8, expires_at: lic.expires_at });
  assert.match(out, /^PBX_NAME='Test'$/m); assert.match(out, /^PBX_EDITION='enterprise'$/m); assert.match(out, /^PBX_MAX_CALLS='8'$/m); assert.match(out, /^PBX_LICENSE_KEY='PBXM-/m);
});
