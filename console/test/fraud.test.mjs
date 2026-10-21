import { test } from "node:test";
import assert from "node:assert/strict";
import { fraudSignals, countryOf } from "../lib/fraud.mjs";

const now = Date.parse("2026-10-21T01:30:00Z");   // 3 h 30 du matin à Paris
let n = 0;
const out = (iso, to, ext = "201", talk = 60) => ({ id: `c${++n}`, start: iso, direction: "out", status: "answered", talk, from: { ext }, to: { number: to } });
// Habitudes : 30 jours d'appels en journée vers la France et la Belgique
const history = [];
for (let d = 1; d <= 30; d++) for (const h of [8, 10, 14, 16]) history.push(out(new Date(now - d * 86400_000 + (h - 1.5) * 3600_000).toISOString(), d % 5 ? "0612345678" : "003225000000"));

test("anti-fraude : rien d'anormal sur une journée habituelle", () => {
  assert.deepEqual(fraudSignals(history, { now: now + 12 * 3600_000 }), []);
});

test("anti-fraude : nuit, nouveau pays, balayage, appel long", () => {
  const night = [];
  for (let i = 0; i < 9; i++) night.push(out(new Date(now - 20 * 60_000 + i * 60_000).toISOString(), `0022177${String(1000 + i)}00`, "205"));
  night.push(out(new Date(now - 30 * 60_000).toISOString(), "00675123456", "205", 25 * 60));
  const s = fraudSignals([...history, ...night], { now });
  const kinds = s.map((x) => x.kind).sort();
  assert.deepEqual([...new Set(kinds)], ["long_costly", "new_country", "odd_hours", "scan"]);
  assert.match(s.find((x) => x.kind === "new_country" && /Sénégal/.test(x.text)).text, /Premier appel vers Sénégal \(\+221\)/);
  assert.match(s.find((x) => x.kind === "scan").text, /poste 205 a appelé \d+ numéros différents/);
  assert.match(s.find((x) => x.kind === "long_costly").text, /25 min vers Papouasie/);
  // rafale : 20 appels dans l'heure alors que la moyenne de cette heure est 0
  const burst = Array.from({ length: 20 }, (_, i) => out(new Date(now - 50 * 60_000 + i * 60_000).toISOString(), "0612345678", `2${String(i % 9).padStart(2, "0")}`));
  assert.ok(fraudSignals([...history, ...burst], { now }).some((x) => x.kind === "burst"));
  assert.equal(countryOf("+33612345678").name, "France"); assert.equal(countryOf("0612345678"), null);
});
