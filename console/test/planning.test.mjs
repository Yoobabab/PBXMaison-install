import test from "node:test";
import assert from "node:assert/strict";
import { defaultUser } from "../lib/users.mjs";
import { validateObject, buildCallflowDialplan, traceNumber, referencesTo, listForwards } from "../lib/callflow.mjs";
import { resolvePlan, paintSlots, isWeekB, dayPlan, mondayOf, weekdayOf } from "../public/planning-core.js";

const user = (id) => ({ ...defaultUser(id), first_name: `U${id}` });
const users = new Map([["201", user("201")], ["202", user("202")], ["203", user("203")]]);
const ctx = (objects = [], selfId = null) => ({ users, objects, cc: "33", selfId, usedNumbers: new Map(), userDids: new Map() });
const input = () => ({
  name: "Accueil 04", dids: ["04 04 04 04 04"],
  scenarios: [{ id: "a", name: "Matin Paul", color: "#2563eb" }, { id: "b", name: "Après-midi Julie", color: "#16a34a" }, { id: "x", name: "En dehors", color: "#94a3b8" }],
  branches: {
    a: [{ type: "ring", users: ["201"], time: 20 }, { type: "external", target: "06 12 34 56 78" }],
    b: [{ type: "ring", users: ["202"], time: 25 }, { type: "user_vm", target: "202" }],
    x: [{ type: "hangup" }],
  },
  outside: "x",
  week: { mon: [{ from: "09:00", to: "12:00", s: "a" }, { from: "14:00", to: "18:00", s: "b" }], tue: [{ from: "09:00", to: "12:00", s: "b" }], wed: [], thu: [], fri: [], sat: [], sun: [] },
  alternate: true, ref_monday: "2026-10-12",
  week_b: { mon: [{ from: "08:00", to: "24:00", s: "b" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  holidays_fr: true, holiday_scenario: "x",
  days: { "2026-12-24": { slots: [{ from: "09:00", to: "12:00", s: "a" }], label: "Réveillon" } },
});

test("planning : validation et normalisation", () => {
  const v = validateObject("planning", input(), null, ctx());
  assert.deepEqual(v.data.dids, ["0404040404"]);
  assert.equal(v.data.branches.a[1].target, "0612345678");
  assert.equal(v.data.ref_monday, "2026-10-12");
  assert.equal(v.data.week.mon.length, 2);
  assert.equal(v.data.managers, true);
});

test("planning : erreurs claires", () => {
  const bad = (patch, re) => assert.throws(() => validateObject("planning", { ...input(), ...patch }, null, ctx()), re);
  bad({ week: { mon: [{ from: "09:00", to: "12:00", s: "a" }, { from: "11:00", to: "13:00", s: "b" }] } }, /chevauchent/);
  bad({ week: { mon: [{ from: "12:00", to: "09:00", s: "a" }] } }, /après l'heure de début/);
  bad({ week: { mon: [{ from: "09:00", to: "12:00", s: "zz" }] } }, /scénario inconnu/);
  bad({ outside: "zz" }, /en dehors des plages/);
  bad({ branches: { a: [], b: [{ type: "hangup" }], x: [{ type: "hangup" }] } }, /Matin Paul.*au moins une étape/);
  bad({ dids: [], is_default: false }, /au moins une SDA/);
  bad({ days: { "2026-02-30": { slots: [] } } }, /Date invalide/);
  bad({ scenarios: [] }, /au moins un scénario/);
  const other = [{ kind: "flow", id: "f1", data: { name: "Standard", dids: ["0404040404"], is_default: true } }];
  assert.throws(() => validateObject("planning", input(), null, ctx(other)), /déjà/);
});

test("planning : quel scénario, quel jour, quelle heure", () => {
  const d = validateObject("planning", input(), null, ctx()).data;
  const at = (ymd, hm) => resolvePlan(d, ymd, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))).scenario;
  assert.equal(weekdayOf("2026-10-12"), "mon");
  assert.equal(at("2026-10-12", "09:00"), "a"); // lundi semaine A
  assert.equal(at("2026-10-12", "11:59"), "a");
  assert.equal(at("2026-10-12", "12:00"), "x"); // pause : en dehors
  assert.equal(at("2026-10-12", "15:30"), "b");
  assert.equal(at("2026-10-13", "10:00"), "b"); // mardi
  assert.equal(at("2026-10-19", "07:59"), "x"); // lundi semaine B
  assert.equal(at("2026-10-19", "23:59"), "b");
  assert.equal(isWeekB(d, "2026-10-25"), true); // dimanche de la semaine B
  assert.equal(isWeekB(d, "2026-10-05"), true); // la semaine avant la référence
  assert.equal(at("2026-12-25", "10:00"), "x"); // Noël : férié
  assert.equal(dayPlan(d, "2026-12-25").source, "holiday");
  assert.equal(at("2026-12-24", "10:00"), "a"); // journée particulière
  assert.equal(dayPlan(d, "2026-12-24").label, "Réveillon");
  assert.equal(resolvePlan({ ...d, override: "b" }, "2026-10-12", 600).scenario, "b");
  assert.equal(mondayOf("2026-10-18"), "2026-10-12");
});

test("planning : peindre des plages au pinceau", () => {
  let s = paintSlots([], 540, 720, "a");
  assert.deepEqual(s, [{ from: "09:00", to: "12:00", s: "a" }]);
  s = paintSlots(s, 600, 660, "b");
  assert.deepEqual(s.map((x) => `${x.from}-${x.to}-${x.s}`), ["09:00-10:00-a", "10:00-11:00-b", "11:00-12:00-a"]);
  s = paintSlots(s, 600, 660, null);
  assert.deepEqual(s.map((x) => `${x.from}-${x.to}-${x.s}`), ["09:00-10:00-a", "11:00-12:00-a"]);
  assert.deepEqual(paintSlots([], 1380, 1440, "a"), [{ from: "23:00", to: "24:00", s: "a" }]);
});

test("planning : plan de numérotation Asterisk", () => {
  const p = { kind: "planning", id: "pl1", number: null, data: validateObject("planning", input(), null, ctx()).data };
  const dp = buildCallflowDialplan({ users, objects: [p], soundsDir: "/s", tz: "Europe/Paris", year: 2026 });
  assert.match(dp, /exten => 0404040404,1,Goto\(plan-pl1,s,1\)/);
  assert.match(dp, /GotoIf\(\$\{DIALPLAN_EXISTS\(plan-pl1-day,\$\{PLAN_D\},1\)\}\?plan-pl1-day,\$\{PLAN_D\},1\)/);
  assert.match(dp, /GotoIfTime\(09:00-11:59,mon,\*,\*,Europe\/Paris\?plan-pl1-sc,sca,1\)/);
  assert.match(dp, /GotoIfTime\(14:00-17:59,mon,\*,\*,Europe\/Paris\?plan-pl1-sc,scb,1\)/);
  assert.match(dp, /\[plan-pl1-b\][\s\S]*GotoIfTime\(08:00-23:59,mon,/);
  assert.match(dp, /\[plan-pl1-wb\]\nexten => 20260101,1,NoOp\(B\)/); // jeudi 1er janvier 2026 : semaine B (référence 12/10 = A)
  assert.match(dp, /exten => 20260112,1,NoOp\(B\)/);
  assert.doesNotMatch(dp, /exten => 20260105,1,NoOp\(B\)/);
  assert.match(dp, /\[plan-pl1-hol\][\s\S]*exten => 20261225,1,NoOp\(Noël\)/);
  assert.match(dp, /exten => 20261224,1,NoOp\(Réveillon\)\n same => n,GotoIfTime\(09:00-11:59,\*,\*,\*,Europe\/Paris\?plan-pl1-sc,sca,1\)\n same => n,Goto\(plan-pl1-sc,scx,1\)/);
  assert.match(dp, /exten => sca,1,NoOp\(Scénario Matin Paul\)[\s\S]*?Dial\(PJSIP\/201&PJSIP\/201-web,20,[\s\S]*?Goto\(user-external,0612345678,1\)/);
  // forcé : plus de calcul d'heure
  const f = buildCallflowDialplan({ users, objects: [{ ...p, data: { ...p.data, override: "b" } }], soundsDir: "/s", tz: "Europe/Paris", year: 2026 });
  assert.match(f, /\[plan-pl1\]\nexten => s,1,NoOp\(Planning Accueil 04\)\n same => n,Set\(CDR\(rule\)=Accueil 04\)\n same => n,Goto\(plan-pl1-sc,scb,1\)/);
});

test("planning : traceur, références et renvois", () => {
  const p = { kind: "planning", id: "pl1", number: null, data: validateObject("planning", input(), null, ctx()).data };
  const m = { users, objects: [p], registered: new Map(), outboundTrunk: "op", trunkDids: new Set(["0404040404"]), cc: "33", tz: "Europe/Paris", now: new Date("2026-10-12T08:30:00Z") };
  const r = traceNumber("04 04 04 04 04", m);
  const pl = r.root.children[0].node;
  assert.match(pl.title, /Planning « Accueil 04 »/);
  assert.match(pl.detail.join(" "), /Maintenant : semaine a → « Matin Paul »/);
  assert.equal(pl.children.find((c) => c.current).label, "Matin Paul ← maintenant");
  const refs = referencesTo("user", "202", [p]);
  assert.match(refs[0].where, /scénario « après-midi julie »/);
  const fw = listForwards({ ...m, objects: [{ ...p, data: { ...p.data, override: "x" } }] });
  assert.ok(fw.some((x) => x.when === "Scénario forcé" && x.to === "En dehors"));
});
