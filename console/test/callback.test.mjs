import { test } from "node:test";
import assert from "node:assert/strict";
import { missedCallers, sameNumberKey } from "../lib/callback.mjs";

const call = (start, direction, status, number, extra = {}) => ({ id: start, start, direction, status,
  from: { number: direction === "in" ? number : "201", name: "" }, to: { number: direction === "out" ? number : "0465001540" }, did: "0465001540", ...extra });
const now = Date.parse("2026-10-21T12:00:00Z");

test("appels perdus : regroupés par numéro, classés, retirés dès qu'on a rappelé", () => {
  const calls = [
    call("2026-10-21T07:12:00Z", "in", "missed", "0612345678"),
    call("2026-10-21T08:30:00Z", "in", "missed", "+33612345678"),
    call("2026-10-21T09:05:00Z", "in", "voicemail", "0033612345678"),
    call("2026-10-21T10:00:00Z", "in", "missed", "0478000000"),
    call("2026-10-21T09:00:00Z", "in", "missed", "0499000000"),
    call("2026-10-21T09:30:00Z", "out", "answered", "0499000000"),        // rappelé : retiré
    call("2026-10-21T11:00:00Z", "in", "missed", "0611111111"),
    call("2026-10-21T11:20:00Z", "out", "failed", "0611111111"),          // rappel tenté sans réponse
    call("2026-10-21T11:00:00Z", "in", "missed", ""),                     // masqué : ignoré
  ];
  const r = missedCallers(calls, { now, voicemails: [{ caller_number: "0612345678", at: "2026-10-21T09:05", urgent: true, summary: "Devis du four, urgent." }],
    contacts: new Map([[sameNumberKey("0478000000"), "Boulangerie Dupont"]]) });
  assert.deepEqual(r.map((x) => x.number.slice(-4)), ["5678", "0000", "1111"]);
  assert.equal(r[0].attempts, 3); assert.equal(r[0].level, "high"); assert.match(r[0].why, /3 fois depuis 09 h 12 · message urgent/);
  assert.equal(r[1].name, "Boulangerie Dupont");
  assert.match(r[2].why, /rappel tenté 1 fois/);
  // marqué traité : disparaît jusqu'au prochain appel manqué
  assert.equal(missedCallers(calls, { now, done: new Map([[sameNumberKey("0478000000"), "2026-10-21T10:30:00Z"]]) }).some((x) => x.number === "0478000000"), false);
  assert.equal(missedCallers([...calls, call("2026-10-21T11:50:00Z", "in", "missed", "0478000000")], { now, done: new Map([[sameNumberKey("0478000000"), "2026-10-21T10:30:00Z"]]) }).find((x) => x.number === "0478000000").attempts, 1);
});
