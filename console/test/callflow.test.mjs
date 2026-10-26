import test from "node:test";
import assert from "node:assert/strict";
import { defaultUser } from "../lib/users.mjs";
import {
  mohClasses, validateObject, buildCallflowDialplan, buildQueues, traceNumber, listForwards, frenchHolidays, scheduleState, closedDays,
  mailboxesByUser, referencesTo, describeWeek,
} from "../lib/callflow.mjs";

const user = (id, extra = {}) => ({ ...defaultUser(id), first_name: `U${id}`, ...extra });
function model() {
  const users = new Map([
    ["201", user("201", { dids: ["0465001530"] })],
    ["202", user("202")],
    ["203", user("203", { status: "away", forwarding: { ...defaultUser("203").forwarding, away: { type: "external", target: "0612345678" } } })],
  ]);
  const objects = [
    { kind: "prompt", id: "p1", number: null, data: { name: "Accueil", file: "p1.wav", duration: 4 } },
    { kind: "group", id: "g1", number: "600", data: { name: "Accueil", number: "600", strategy: "all", members: ["201", "202", "203"], ring_time: 20, cid_prefix: "[Acc]", no_answer: { type: "groupvm", target: "v1" } } },
    { kind: "queue", id: "q1", number: "700", data: { name: "Support", number: "700", strategy: "rrmemory", members: ["202"], member_timeout: 15, max_wait: 120, wrapup: 5, announce_position: true, greeting: "p1", no_answer: { type: "user_vm", target: "201" } } },
    { kind: "ivr", id: "i1", number: "800", data: { name: "Standard", number: "800", prompt: "p1", timeout: 5, retries: 2, direct_dial: true, options: { 1: { type: "group", target: "g1" }, 2: { type: "queue", target: "q1" }, 9: { type: "external", target: "0612345678" } }, invalid: { type: "group", target: "g1" } } },
    { kind: "groupvm", id: "v1", number: "900", data: { name: "Accueil", number: "900", pin: "1234", members: ["201", "202"] } },
    { kind: "schedule", id: "s1", number: null, data: { name: "Bureau", week: { mon: [["09:00", "12:00"], ["14:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [], thu: [], fri: [], sat: [], sun: [] }, holidays_fr: true, holidays: [{ from: "2026-08-03", to: "2026-08-21", label: "Congés d'été" }], override: "auto" } },
    { kind: "rule", id: "r1", number: null, data: { name: "Standard", dids: ["0465001540"], is_default: false, schedule: "s1", open: { type: "ivr", target: "i1" }, closed: { type: "prompt", target: "p1" }, holiday: null } },
    { kind: "rule", id: "r2", number: null, data: { name: "Défaut", dids: [], is_default: true, schedule: "", open: { type: "group", target: "g1" }, closed: { type: "hangup", target: "" }, holiday: null } },
  ];
  return { users, objects, soundsDir: "/var/lib/pbxmaison/sounds", tz: "Europe/Paris", year: 2026,
    registered: new Map([["201", ["Yealink T54W"]], ["202", ["Softphone web"]]]), outboundTrunk: "dstny", trunkDids: new Set(["0465001530", "0465001540", "0465001541"]), legacyInbound: [], cc: "33",
    now: new Date("2026-10-12T08:30:00Z") }; // lundi 10:30 à Paris
}
const ctx = (m, selfId) => ({ users: m.users, objects: m.objects, cc: "33", selfId, usedNumbers: new Map([["201", "utilisateur"], ["600", "groupe Accueil"]]), userDids: new Map([["0465001530", "201"]]) });

test("jours fériés : Pâques et dates mobiles", () => {
  const h = Object.fromEntries(frenchHolidays(2026));
  assert.equal(h["2026-04-06"], "Lundi de Pâques");
  assert.equal(h["2026-05-14"], "Ascension");
  assert.equal(h["2026-05-25"], "Lundi de Pentecôte");
  assert.equal(Object.fromEntries(frenchHolidays(2027))["2027-03-29"], "Lundi de Pâques");
});

test("état des horaires : ouvert, fermé, férié, congés, forcé", () => {
  const s = model().objects.find((o) => o.id === "s1").data;
  assert.equal(scheduleState(s, new Date("2026-10-12T08:30:00Z")), "open");     // lun 10:30
  assert.equal(scheduleState(s, new Date("2026-10-12T10:30:00Z")), "break");    // lun 12:30 : pause déjeuner
  assert.equal(scheduleState(s, new Date("2026-10-12T17:30:00Z")), "closed");   // lun 19:30
  assert.equal(scheduleState(s, new Date("2026-10-14T08:30:00Z")), "closed");   // mercredi
  assert.equal(scheduleState(s, new Date("2026-05-25T08:30:00Z")), "holiday");  // Pentecôte (lundi)
  assert.equal(scheduleState(s, new Date("2026-08-10T08:30:00Z")), "holiday");  // congés
  assert.equal(scheduleState({ ...s, override: "closed" }, new Date("2026-10-12T08:30:00Z")), "closed");
  assert.equal(closedDays(s, 2026, 2026).get("2026-08-21"), "Congés d'été");
  assert.equal(describeWeek(s.week), "lun 09:00-12:00, 14:00-18:00 ; mar 09:00-18:00");
});

test("validation : numéros, SDA, destinations", () => {
  const m = model();
  assert.throws(() => validateObject("group", { name: "X", number: "600" }, null, ctx(m)), /déjà utilisé/);
  assert.throws(() => validateObject("group", { name: "X", number: "112" }, null, ctx(m)), /3 chiffres|urgence/);
  assert.throws(() => validateObject("group", { name: "X", number: "601", members: ["999"] }, null, ctx(m)), /Membre inconnu/);
  const g = validateObject("group", { name: "Vente", number: "601", members: "201, 202", no_answer: { type: "user", target: "201" } }, null, ctx(m));
  assert.deepEqual(g.data.members, ["201", "202"]);
  assert.throws(() => validateObject("rule", { name: "R", dids: "04 65 00 15 30", open: { type: "hangup" } }, null, ctx(m)), /attribuée directement/);
  assert.throws(() => validateObject("rule", { name: "R", dids: "04 65 00 15 40", open: { type: "hangup" } }, null, ctx(m)), /déjà dans la règle/);
  assert.throws(() => validateObject("rule", { name: "R", is_default: true, open: { type: "hangup" } }, null, ctx(m)), /déjà la règle par défaut/);
  assert.throws(() => validateObject("ivr", { name: "I", number: "801", options: { 1: { type: "external", target: "0899123456" } } }, null, ctx(m)), /non autorisé/);
  assert.throws(() => validateObject("schedule", { name: "S", week: { mon: [["09:00", "12:00"], ["11:00", "13:00"]] } }, null, ctx(m)), /chevauchent/);
  assert.throws(() => validateObject("group", { name: "G", number: "602", no_answer: { type: "group", target: "g1" } }, { name: "G", number: "602" }, { ...ctx(m), selfId: "g1" }), /lui-même/);
});

test("plan de numérotation généré", () => {
  const m = model();
  const t = buildCallflowDialplan(m);
  assert.match(t, /exten => 600,1,NoOp\(Groupe 600 Accueil\)/);
  assert.match(t, /Dial\(PJSIP\/201&PJSIP\/201-web&Local\/201@cx-app\/n&PJSIP\/202&PJSIP\/202-web&Local\/202@cx-app\/n,20,tb\(pickup-mark\^s\^1\)\)/); // 203 absent : exclu
  assert.match(t, /Set\(__CID_ORIG=\$\{CALLERID\(name\)\}\)\n same => n\(cidok\),Set\(CALLERID\(name\)=\[Acc\] \$\{CID_ORIG\}\)/);   // préfixe devant le nom d'origine
  assert.match(t, /Goto\(callflow,900,1\)/);
  assert.match(t, /Queue\(q700,t,,,120\)/);
  assert.match(t, /\[ivr-800\][\s\S]*Background\(\/var\/lib\/pbxmaison\/sounds\/p1\)[\s\S]*exten => 1,1,NoOp/);
  assert.match(t, /exten => 9,1,NoOp\(SVI 800 : touche 9\)\n same => n,Goto\(user-external,0612345678,1\)/);
  assert.match(t, /GotoIfTime\(09:00-11:59,mon,\*,\*,Europe\/Paris\?open\)/);
  assert.match(t, /exten => 20260525,1,NoOp\(Lundi de Pentecôte\)/);
  assert.match(t, /exten => 20260810,1,NoOp\(Congés d'été\)/);
  assert.match(t, /exten => 0465001540,1,Goto\(rule-r1,s,1\)/);
  assert.match(t, /exten => default,1,Goto\(rule-r2,s,1\)/);
  assert.match(t, /\[rule-r1\][\s\S]*n\(closed\),Answer\(\)\n same => n,Playback\(\/var\/lib\/pbxmaison\/sounds\/p1\)/);
  assert.doesNotMatch(t, /\$\{\w+\}\)\)\)/); // pas de parenthèse orpheline évidente
  const q = buildQueues(m);
  assert.match(q, /\[q700\]\nstrategy = rrmemory/);
  assert.match(q, /member => Local\/202@queue-ring\/n,0,U202,hint:202@users-hints/);
  assert.equal(mailboxesByUser(m).get("201"), "201@default,900@default");
  assert.equal(mailboxesByUser(m).get("203"), "203@default");
});

test("traceur : SDA avec horaires, SVI, groupe, boucle", () => {
  const m = model();
  const r = traceNumber("04 65 00 15 40", m);
  assert.equal(r.root.type, "did");
  const rule = r.root.children[0].node;
  assert.equal(rule.type, "rule");
  assert.equal(rule.children[0].current, true); // lundi 10:30 → ouvert
  const ivr = rule.children[0].node;
  assert.equal(ivr.type, "ivr");
  const grp = ivr.children.find((c) => c.label === "Touche 1").node;
  assert.equal(grp.type, "group");
  assert.match(grp.children.find((c) => c.node.title.startsWith("203")).node.detail[0], /Absent/);
  // SVI : choix invalide → groupe ; groupe sans réponse → messagerie de groupe : pas de boucle
  assert.ok(!JSON.stringify(r).includes("Boucle"));
  // Boucle volontaire : groupe → SVI → groupe
  m.objects.find((o) => o.id === "g1").data.no_answer = { type: "ivr", target: "i1" };
  const r2 = traceNumber("600", m);
  assert.ok(JSON.stringify(r2).includes("Boucle"));
  // SDA directe
  assert.equal(traceNumber("0465001530", m).root.children[0].node.type, "user");
  // SDA inconnue → règle par défaut
  assert.match(traceNumber("0465001541", m).root.children[0].label, /par défaut/);
  // Numéro externe : qui renvoie vers lui
  const ext = traceNumber("06 12 34 56 78", m);
  assert.equal(ext.root.type, "external-refs");
  assert.equal(ext.root.children.length, 2); // 203 en absent + SVI touche 9
});

test("renvois actifs et références", () => {
  const m = model();
  const rows = listForwards(m);
  assert.equal(rows[0].id, "203");
  assert.equal(rows[0].active, true);
  assert.match(rows[0].to, /06 12 34 56 78/);
  assert.deepEqual(referencesTo("group", "g1", m.objects).map((x) => x.id).sort(), ["i1", "r2"]);
  assert.deepEqual(referencesTo("user", "202", m.objects).map((x) => x.id).sort(), ["g1", "q1", "v1"]);
});

test("groupe cyclique, heures de bureau d'un groupe, SDA directe, file avancée", () => {
  const m = model();
  const g = m.objects.find((o) => o.id === "g1");
  Object.assign(g.data, { strategy: "rotate", dids: ["0465001541"], schedule: "s1", closed: { type: "prompt", target: "p1" }, break: null, holiday: { type: "groupvm", target: "v1", prompt: "p1" } });
  const q = m.objects.find((o) => o.id === "q1");
  Object.assign(q.data, { moh: "p1", periodic: ["p1"], periodic_freq: 40, announce_holdtime: true });
  const t = buildCallflowDialplan(m);
  assert.match(t, /Set\(MEMBERS=201&202\)/);
  assert.match(t, /Set\(GLOBAL\(RR_600\)=\$\[\$\{I\} \+ 1\]\)/);
  assert.match(t, /Dial\(PJSIP\/\$\{M\}&PJSIP\/\$\{M\}-web&Local\/\$\{M\}@cx-app\/n,20/);
  assert.match(t, /exten => 600,1[\s\S]*Gosub\(sched-s1,s,1\)[\s\S]*GotoIf\(\$\["\$\{GOSUB_RETVAL\}" = "closed"\]\?of-closed\)/);
  assert.doesNotMatch(t, /\?of-break/); // pause : accepter quand même
  assert.match(t, /n\(of-holiday\),Answer\(\)\n same => n,Playback\(\/var\/lib\/pbxmaison\/sounds\/p1\)\n same => n,Goto\(callflow,900,1\)/);
  assert.match(t, /exten => 0465001541,1,Goto\(callflow,600,1\)/);
  assert.match(t, /GotoIfTime\(09:00-17:59,mon,\*,\*,Europe\/Paris\?break\)/);
  const qs = buildQueues(m);
  // Champs d'annonce vides : pas d'erreur
  const m2 = model(); Object.assign(m2.objects.find((o) => o.id === "q1").data, { greeting: "", moh: "", periodic: [] });
  Object.assign(m2.objects.find((o) => o.id === "i1").data, { prompt: "" });
  assert.doesNotThrow(() => { buildCallflowDialplan(m2); buildQueues(m2); mohClasses(m2); });
  assert.match(qs, /musicclass = q700/);
  assert.match(qs, /periodic-announce = \/var\/lib\/pbxmaison\/sounds\/p1\nperiodic-announce-frequency = 40/);
  assert.match(qs, /announce-holdtime = yes/);
  assert.deepEqual(mohClasses(m), [{ cls: "q700", dir: "/var/lib/pbxmaison/sounds/moh-q700", file: "p1.wav" }]);
  // Traceur : SDA directe vers le groupe, branches d'horaires
  const r = traceNumber("0465001541", m);
  const grp = r.root.children[0].node;
  assert.equal(grp.type, "group");
  assert.ok(grp.children.some((c) => c.label.startsWith("Bureau fermé")));
  assert.ok(grp.children.some((c) => c.label.startsWith("Jour férié")));
  // Validation : SDA déjà prise par le groupe
  assert.throws(() => validateObject("ivr", { name: "I", number: "801", dids: "04 65 00 15 41" }, null, ctx(m)), /déjà attribuée à : groupe/);
  assert.equal(validateObject("ivr", { name: "I", number: "801", closed: { type: "hangup", prompt: "p1" } }, null, ctx(m)).data.closed.prompt, "p1");
});

test("routage (éditeur visuel) : validation, génération, traceur", () => {
  const m = model();
  const c = { ...ctx(m), selfId: null };
  const v = validateObject("flow", { name: "Accueil", dids: "04 65 00 15 45", schedule: "s1", branches: {
    open: [{ type: "prompt", target: "p1" }, { type: "ring", users: ["201"], time: 30 }, { type: "group", target: "g1", time: 15 }, { type: "queue", target: "q1" }, { type: "user_vm", target: "201" }],
    closed: [{ type: "prompt", target: "p1" }, { type: "hangup" }], break: null, holiday: [] } }, null, c);
  assert.equal(v.data.branches.open.length, 5);
  assert.equal(v.data.branches.break, null);
  assert.throws(() => validateObject("flow", { name: "X", dids: "04 65 00 15 46", branches: { open: [{ type: "hangup" }, { type: "user_vm", target: "201" }] } }, null, c), /rien ne peut suivre/);
  assert.throws(() => validateObject("flow", { name: "X", dids: "04 65 00 15 40", branches: { open: [{ type: "hangup" }] } }, null, c), /déjà dans la règle/);
  assert.throws(() => validateObject("flow", { name: "X", is_default: true, branches: { open: [{ type: "hangup" }] } }, null, c), /déjà la règle par défaut|par défaut/);
  m.objects.push({ kind: "flow", id: "f1", number: null, data: v.data });
  const t = buildCallflowDialplan(m);
  assert.match(t, /\[did-rules\]\nexten => 0465001545,1,Goto\(flow-f1,s,1\)/);
  assert.match(t, /\[flow-f1\][\s\S]*GotoIf\(\$\["\$\{GOSUB_RETVAL\}" = "closed"\]\?b-closed\)/);
  assert.match(t, /n\(b-open\),NoOp[\s\S]*Playback\(\/var\/lib\/pbxmaison\/sounds\/p1\)\n same => n,Dial\(PJSIP\/201&PJSIP\/201-web&Local\/201@cx-app\/n,30/);
  assert.match(t, /Dial\(PJSIP\/201&PJSIP\/201-web&Local\/201@cx-app\/n&PJSIP\/202&PJSIP\/202-web&Local\/202@cx-app\/n,15/); // groupe : 203 absent exclu
  assert.match(t, /Queue\(q700,t,,,120\)\n same => n,VoiceMail\(201@default,u\)/);
  assert.match(t, /n\(b-closed\),NoOp\(Bureau fermé\)[\s\S]*Hangup\(\)/);
  assert.doesNotMatch(t, /b-break/);
  const r = traceNumber("0465001545", m);
  assert.equal(r.root.children[0].label, "Routage");
  assert.match(JSON.stringify(r), /Étape 2 · Sonne 30 s/);
  assert.deepEqual(referencesTo("queue", "q1", m.objects).map((x) => x.id), ["i1", "f1"]);
});

test("horaires : pauses en plus (après la fermeture), validées, dans le dialplan et l'état", () => {
  const ctx = { users: new Map(), objects: [], cc: "33" };
  const r = validateObject("schedule", { name: "Bureau", week: { mon: [["08:00", "18:00"]] }, pauses: { mon: [["18:00", "18:30"]], tue: [] } }, null, ctx);
  const sched = r.data || r;
  assert.deepEqual(sched.pauses, { mon: [["18:00", "18:30"]] });
  const at = (iso) => scheduleState(sched, new Date(iso));
  assert.equal(at("2026-10-26T17:10:00Z"), "break");    // lundi 18 h 10 à Paris
  assert.equal(at("2026-10-26T17:40:00Z"), "closed");   // 18 h 40
  assert.equal(at("2026-10-26T10:00:00Z"), "open");
  assert.throws(() => validateObject("schedule", { name: "X", pauses: { mon: [["18:30", "18:00"]] } }, null, ctx), /pause invalide/);
});
