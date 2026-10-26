import { test } from "node:test";
import assert from "node:assert/strict";
import { periodOf, periodStats, delta, reportInput } from "../lib/report.mjs";

const c = (start, status, extra = {}) => ({ id: start, start, direction: "in", status, duration: 40, talk: status === "answered" ? 30 : 0, answered_by: status === "answered" ? "201" : "",
  from: { number: "0612345678" }, to: { number: "0465001540" }, ...extra });

test("bilan : période, chiffres, évolution", () => {
  const w = periodOf("week", Date.parse("2026-10-21T10:00:00Z"), { previous: true });
  assert.equal(w.from, "2026-10-11T22:00:00.000Z"); assert.equal(w.to, "2026-10-18T22:00:00.000Z");   // minuit à Paris assert.match(w.label, /semaine du 12 octobre au 18 octobre/);
  assert.equal(periodOf("month", Date.parse("2026-10-21T10:00:00Z"), { previous: true }).label, "septembre 2026");
  // passage à l'heure d'hiver (25 oct.) et lundi juste après minuit à Paris
  const o = periodOf("month", Date.parse("2026-11-05T10:00:00Z"), { previous: true });
  assert.equal(o.from, "2026-09-30T22:00:00.000Z"); assert.equal(o.to, "2026-10-31T23:00:00.000Z");
  assert.match(periodOf("week", Date.parse("2026-10-25T23:30:00Z")).label, /semaine du 26 octobre au 1er novembre/);
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

test("rapport mensuel : e-mail aux couleurs du partenaire", async () => {
  const { monthlyReportMail } = await import("../lib/report.mjs");
  const s = { inbound: 120, answered: 100, answer_rate: 83, missed: 20, voicemail: 6, avg_wait: 14, outbound: 40, busiest_hour: 9, worst_hour: { hour: 12, rate: 30 },
    days: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"].map((name, i) => ({ name, calls: i < 5 ? 24 : 0, missed: i < 5 ? 4 : 0 })), agents: [{ ext: "201", name: "Sophie <b>", answered: 60 }] };
  const m = monthlyReportMail({ label: "septembre 2026", stats: s, prev: { ...s, inbound: 100, answer_rate: 80 }, synthesis: "• Bien.\nConseils :\n→ Ajouter quelqu'un à midi.", pbxName: "Boulangerie Martin",
    brand: { color: "#1d4ed8", logoCid: "logo1", signature: "Télécom Ouest" } });
  assert.equal(m.subject, "Votre standard téléphonique en septembre 2026 — Boulangerie Martin");
  assert.match(m.html, /#1d4ed8/); assert.match(m.html, /cid:logo1/); assert.match(m.html, /\+20 %/); assert.match(m.html, /\+3 pts/); assert.match(m.html, /Télécom Ouest/);
  assert.doesNotMatch(m.html, /<b>Sophie|Sophie <b>/); assert.match(m.text, /Notre analyse/);
});
