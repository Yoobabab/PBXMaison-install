import { test } from "node:test";
import assert from "node:assert/strict";
import { validateShield, shieldGlobals, buildShieldDialplan, spoofSignals, DEFAULT_SHIELD } from "../lib/shield.mjs";

test("bouclier : réglages, variables, contexte [shield]", () => {
  assert.deepEqual(validateShield({}), DEFAULT_SHIELD);
  assert.equal(validateShield({ mode: "block" }).mode, "block");
  assert.throws(() => validateShield({ mode: "x" }), /inconnu/);
  assert.deepEqual(shieldGlobals({ enabled: false, mode: "block" }), ["SHIELD_MODE = off"]);
  assert.deepEqual(shieldGlobals({ enabled: true, mode: "mark" }), ["SHIELD_MODE = mark"]);
  const d = buildShieldDialplan(["0611111111", "0622222222", "442079460958", "abc", "0611111111"], new Set(["622222222"]));
  assert.match(d, /\[shield\]\nexten => 0611111111,1,Return\(\)\nexten => 33611111111,1,Return\(\)\nexten => 442079460958,1,Return\(\)\n/);
  assert.doesNotMatch(d, /0622222222|abc/);   // contact de l'annuaire jamais filtré
});

test("bouclier : alerte numéro usurpé", () => {
  const now = Date.parse("2026-10-27T15:00:00Z");
  const C = (min, num, did = "0412345678") => ({ start: new Date(now - min * 60_000).toISOString(), direction: "in", status: "missed", from: { number: num }, to: { number: "" }, did });
  const calls = [];
  for (let i = 0; i < 12; i++) calls.push(C(5 + i * 3, `06000000${String(i).padStart(2, "0")}`));   // 12 inconnus en une heure
  calls.push(C(10, "0699999999"), C(60 * 24 * 3, "0699999999"));                                    // déjà connu avant : pas compté
  calls.push(C(20, "0711111111", "0499000000"));                                                    // autre SDA, calme
  const s = spoofSignals(calls, { now, contacts: new Set(["600000011"]) });
  assert.deepEqual(s, [{ did: "0412345678", callers: 11, usual: 0 }]);
  // D'habitude beaucoup d'appels à cette heure : pas d'alerte
  // (les 2 derniers jours seulement : avant le 25 octobre, l'heure d'été décale l'heure locale)
  for (let d = 1; d <= 2; d++) for (let i = 0; i < 40; i++) calls.push(C(60 * 24 * d + 20, `0711${d}${String(i).padStart(5, "0")}`));
  assert.deepEqual(spoofSignals(calls, { now, contacts: new Set(["600000011"]) }), []);
  assert.deepEqual(spoofSignals(calls, { now, minCallers: 20 }), []);
});
