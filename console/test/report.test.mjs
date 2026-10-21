import { test } from "node:test";
import assert from "node:assert/strict";
import { periodOf, periodStats, delta, reportInput } from "../lib/report.mjs";

const c = (start, status, extra = {}) => ({ id: start, start, direction: "in", status, duration: 40, talk: status === "answered" ? 30 : 0, answered_by: status === "answered" ? "201" : "",
  from: { number: "0612345678" }, to: { number: "0465001540" }, ...extra });

test("bilan : période, chiffres, évolution", () => {
  const w = periodOf("week", Date.parse("2026-10-21T10:00:00Z"), { previous: true });
  assert.equal(w.from, "2026-10-12T00:00:00.000Z"); assert.equal(w.to, "2026-10-19T00:00:00.000Z"); assert.match(w.label, /semaine du 12 octobre au 18 octobre/);
  assert.equal(periodOf("month", Date.parse("2026-10-21T10:00:00Z"), { previous: true }).label, "septembre 2026");
  const calls = [c("2026-10-13T07:00:00Z", "answered"), c("2026-10-13T07:20:00Z", "missed"), c("2026-10-13T07:40:00Z", "missed"), c("2026-10-14T13:00:00Z", "voicemail", { from: { number: "0478000000" } }),
    c("2026-10-14T14:00:00Z", "answered"), { id: "o", start: "2026-10-14T15:00:00Z", direction: "out", status: "answered", talk: 60, from: { ext: "201" }, to: { number: "0478000000" } }];
  const s = periodStats(calls, { from: w.from, to: w.to, names: new Map([["201", "Sophie"]]) });
  assert.equal(s.inbound, 5); assert.equal(s.answered, 2); assert.equal(s.answer_rate, 40); assert.equal(s.voicemail, 1); assert.equal(s.avg_wait, 10);
  assert.equal(s.busiest_hour, 9); assert.deepEqual(s.worst_hour, { hour: 9, rate: 67, missed: 2 });
  assert.equal(s.days[1].calls, 3); assert.equal(s.agents[0].name, "Sophie");
  assert.equal(s.not_called_back, 0);   // 0612… a été pris ensuite, 0478… a été rappelé
  assert.equal(delta(120, 100), "+20 %"); assert.equal(delta(40, 45, { points: true }), "−5 pts"); assert.equal(delta(3, 0), "nouveau");
  assert.doesNotMatch(reportInput("week", w.label, s, null, ["Devis"]), /0612345678/);
});
