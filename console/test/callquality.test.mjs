import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQos, mosOf, stepQuality, sideOf, callQuality } from "../lib/callquality.mjs";

test("qualité : lecture des statistiques RTCP d'Asterisk", () => {
  const q = parseQos("ssrc=123;themssrc=456;lp=12;rxjitter=0.004;rxcount=988;txjitter=0.012;txcount=1000;rlp=0;rtt=0.045;rxmes=92.1;txmes=88");
  assert.deepEqual(q, { rxcount: 988, lp: 12, txcount: 1000, rlp: 0, jitter_ms: 12, rtt_ms: 45, mes: 88 });
  assert.equal(parseQos(""), null); assert.equal(parseQos("n'importe quoi"), null);
});

test("qualité : note MOS", () => {
  assert.ok(mosOf({ loss: 0, jitter_ms: 5, rtt_ms: 40 }) > 4.3);
  assert.ok(mosOf({ loss: 2, jitter_ms: 20, rtt_ms: 80 }) < 4.3);
  assert.ok(mosOf({ loss: 10, jitter_ms: 60, rtt_ms: 300 }) < 3.1);
});

test("qualité : coupures de son comptées une fois, même longues", () => {
  let q = stepQuality(null, { rxcount: 250, lp: 0, txcount: 250, rlp: 0, jitter_ms: 4, rtt_ms: 30, mes: 0 });
  assert.equal(q.grade, "good"); assert.equal(q.gaps, 0);
  q = stepQuality(q, { rxcount: 500, lp: 0, txcount: 500, rlp: 0, jitter_ms: 4, rtt_ms: 30, mes: 0 });
  q = stepQuality(q, { rxcount: 500, lp: 0, txcount: 750, rlp: 0, jitter_ms: 4, rtt_ms: 30, mes: 0 });   // plus rien reçu pendant 5 s
  assert.equal(q.gaps, 1); assert.equal(q.max_gap_s, 5); assert.equal(q.grade, "bad");
  q = stepQuality(q, { rxcount: 500, lp: 0, txcount: 1000, rlp: 0, jitter_ms: 4, rtt_ms: 30, mes: 0 });  // toujours rien : même coupure
  assert.equal(q.gaps, 1); assert.equal(q.max_gap_s, 10);
  q = stepQuality(q, { rxcount: 750, lp: 0, txcount: 1250, rlp: 0, jitter_ms: 4, rtt_ms: 30, mes: 0 });
  assert.equal(q.gap_now, 0); assert.equal(q.max_gap_s, 10);
  // En sonnerie ou en attente : pas une coupure
  const r = stepQuality({ ...q, rxcount: 750 }, { rxcount: 750, lp: 0, txcount: 1300, rlp: 0, jitter_ms: 4, rtt_ms: 30 }, { held: true });
  assert.equal(r.gap_now, 0);
});

test("qualité : bilan de l'appel, côté fautif", () => {
  const trunks = new Set(["unyc"]);
  assert.equal(sideOf("unyc", trunks).kind, "trunk"); assert.equal(sideOf("201-web", trunks).label, "softphone du 201"); assert.equal(sideOf("201", trunks).label, "poste 201");
  const good = { grade: "good", mos: 4.4, rx_loss: 0, tx_loss: 0, jitter_ms: 3, rtt_ms: 30, gaps: 0, max_gap_s: 0, side_label: "poste 201", side_kind: "phone", codec: "g722" };
  const bad = { grade: "bad", mos: 3.9, rx_loss: 2.5, tx_loss: 0, jitter_ms: 45, rtt_ms: 60, gaps: 1, max_gap_s: 6, side_label: "côté opérateur (unyc)", side_kind: "trunk", codec: "alaw" };
  const c = callQuality([good, bad]);
  assert.equal(c.grade, "bad"); assert.equal(c.label, "Mauvaise");
  assert.equal(c.detail, "coupure de son de 6 s, 2,5 % de paquets perdus, gigue 45 ms — côté opérateur (unyc)");
  assert.equal(callQuality([good]).detail, "");
  assert.equal(callQuality([]), null);
});
