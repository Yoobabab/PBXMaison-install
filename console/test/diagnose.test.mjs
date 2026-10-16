import test from "node:test";
import assert from "node:assert/strict";
import { defaultUser } from "../lib/users.mjs";
import { validateObject, traceNumber } from "../lib/callflow.mjs";
import { pathNow, ringTargets, parseContacts, deviceStates, inboundVerdict, simulateOutbound } from "../lib/diagnose.mjs";

const U = (id, extra = {}) => ({ ...defaultUser(id), first_name: `U${id}`, ...extra });
const users = new Map([["201", U("201")], ["202", U("202")], ["203", U("203", { options: { ...defaultUser("203").options, block_external: true } })]]);

test("entrant : chemin de maintenant (planning) et postes qui sonnent", () => {
  const ctx = { users, objects: [], cc: "33", selfId: null, usedNumbers: new Map(), userDids: new Map() };
  const all = (s) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ from: "00:00", to: "24:00", s }]]));
  const d = validateObject("planning", { name: "Std", dids: ["0404040404"], scenarios: [{ id: "a", name: "Jour" }, { id: "x", name: "Nuit" }],
    branches: { a: [{ type: "ring", users: ["201"], time: 20 }, { type: "external", target: "0612345678" }], x: [{ type: "ring", users: ["202"], time: 20 }] }, outside: "x", week: all("a"), holidays_fr: false }, null, ctx).data;
  const m = { users, objects: [{ kind: "planning", id: "p", number: null, data: d }], registered: new Map([["201", ["Yealink T87W"]]]), outboundTrunk: "op", trunkDids: new Set(["0404040404"]), cc: "33", tz: "Europe/Paris", now: new Date("2026-10-14T08:00:00Z") };
  const root = pathNow(traceNumber("0404040404", m).root);
  assert.deepEqual(ringTargets(root), ["201"]); // le scénario « Nuit » (202) n'est pas en vigueur
  const targets = [{ ext: "201", name: "U201", rings: true, devices: [{ label: "Yealink T87W", state: "ok" }] }];
  assert.equal(inboundVerdict(root, targets).level, "ok");
  assert.match(inboundVerdict(root, targets).text, /201 U201 \(Yealink T87W\)/);
  assert.equal(inboundVerdict(root, [{ ...targets[0], devices: [{ label: "x", state: "bad" }] }]).level, "bad");
});

test("appareils : réponse aux interrogations SIP", () => {
  const q = parseContacts([
    "  Contact:  <Aor/ContactUri..............................> <Hash....> <Status> <RTT(ms)..>",
    "  Contact:  201/sip:201@192.168.1.20:5060;ob                 c3a1e5f2b2 Avail        12.345",
    "  Contact:  201/sip:201@10.0.0.9:5062                        aa11bb22cc Unavail         nan",
    "  Contact:  201-web/sip:xyz@abc.invalid;transport=ws         dd33ee44ff NonQual         nan",
  ]);
  assert.equal(q.length, 3);
  assert.deepEqual(q[0], { aor: "201", uri: "sip:201@192.168.1.20:5060;ob", status: "Avail", rtt: 12.345 });
  const devs = deviceStates("201", [
    { uri: "sip:201@192.168.1.20:5060;ob", device: { label: "Yealink T87W", kind: "phone" } },
    { uri: "sip:201@10.0.0.9:5062", device: { label: "Yealink T46U", kind: "phone" } },
    { uri: "sip:xyz@abc.invalid;transport=ws", device: { label: "Softphone web", kind: "web" } },
  ], q);
  assert.deepEqual(devs.map((x) => [x.state, x.text]), [["ok", "répond en 12 ms"], ["bad", "ne répond plus (enregistré, mais injoignable : réseau, box, téléphone éteint ?)"], ["ok", "connecté (navigateur ou appli ouverte)"]]);
});

test("sortant : trunk par défaut, blocages, pays, règles", () => {
  const trunks = [{ id: "op", operator: "Opérateur", outbound_cid: "0465001540", dial_format: "national", cid_format: "national", status: { code: "Registered", label: "Enregistré" } },
    { id: "sec", outbound_cid: "", dial_format: "e164", cid_format: "e164", status: { code: "Rejected", label: "Refusé par l'opérateur" } }];
  const base = { users, security: { block_premium: true, intl: ["32"], out_block: [{ number: "0899", prefix: true }, { number: "0611111111", prefix: false }] }, rules: [], trunks, outboundTrunk: "op", cc: "33" };
  const run = (ext, n, extra = {}) => simulateOutbound(n, { ...base, user: users.get(ext), ...extra });
  let r = run("201", "06 12 34 56 78");
  assert.equal(r.verdict.level, "ok"); assert.match(r.verdict.text, /trunk op, en présentant le 04 65 00 15 40/);
  assert.equal(run("203", "0612345678").verdict.level, "bad"); // appels externes interdits
  assert.match(run("201", "0899123456").verdict.text, /surtaxé/);
  assert.match(run("201", "0611111111").verdict.text, /bloqués/);
  assert.match(run("201", "0033612345678").verdict.text, /Pays non autorisé/);
  assert.equal(run("201", "+32 2 123 45 67").verdict.level, "ok"); // Belgique autorisée, +32 → 0032…
  assert.equal(run("201", "+33 6 12 34 56 78").number, "0612345678");
  assert.match(run("201", "112").verdict.text, /urgence 112/);
  assert.equal(run("201", "0612345678", { outboundTrunk: "" }).verdict.level, "bad");
  // règles sortantes : préfixe, route de secours, format e164, numéro choisi
  const rules = [{ name: "Mobiles", prefixes: ["06", "07"], lengths: [], extensions: [], routes: [{ trunk: "sec", strip: 0, prepend: "", cid_mode: "custom", cid: "0465001599" }, { trunk: "op", strip: 0, prepend: "", cid_mode: "user", cid: "" }] }];
  r = run("201", "0612345678", { rules });
  assert.match(r.steps.find((s) => s.title.startsWith("Route 1")).detail, /envoyé à l'opérateur : 33612345678\. Numéro présenté : 33465001599/);
  assert.equal(r.verdict.level, "ok"); // la route 2 (op) est enregistrée
  assert.match(run("201", "0412345678", { rules }).verdict.text, /Aucune règle sortante/);
});
