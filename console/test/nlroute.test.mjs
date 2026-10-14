import test from "node:test";
import assert from "node:assert/strict";
import { parseRouting } from "../lib/nlroute.mjs";

const ctx = {
  users: [
    { id: "201", name: "Marine Dubois", first_name: "Marine", last_name: "Dubois", mobile: "0611111111" },
    { id: "202", name: "Paul Martin", first_name: "Paul", last_name: "Martin", mobile: "" },
    { id: "203", name: "Julie Moreau", first_name: "Julie", last_name: "Moreau", mobile: "" },
    { id: "204", name: "Accueil", first_name: "Accueil", last_name: "", mobile: "" },
  ],
  objects: [
    { kind: "group", id: "g1", number: "600", name: "Commercial" },
    { kind: "queue", id: "q1", number: "700", name: "Support" },
    { kind: "ivr", id: "i1", number: "800", name: "Standard" },
    { kind: "prompt", id: "p1", name: "Fermé" },
    { kind: "prompt", id: "p2", name: "Bienvenue" },
    { kind: "groupvm", id: "v1", number: "900", name: "Accueil général" },
    { kind: "schedule", id: "s1", name: "Bureau" },
  ],
  trunkDids: ["0465001540"], cc: "33",
};

test("exemple de l'utilisateur : sonne, groupe avec, messagerie de", () => {
  const r = parseRouting("Accueil sonne 30s puis groupe d'appel avec Paul et Julie pendant 15s puis messagerie vocale de Marine", ctx);
  assert.deepEqual(r.proposal.branches.open, [
    { type: "ring", users: ["204"], strategy: "all", time: 30 },
    { type: "ring", users: ["202", "203"], strategy: "all", time: 15 },
    { type: "user_vm", target: "201" },
  ]);
  assert.ok(r.warnings.some((w) => /Aucune SDA/.test(w)));
});

test("SDA en tête, horaires, branche fermée, annonce, groupe existant, l'un après l'autre", () => {
  const r = parseRouting("Quand on appelle le 04 65 00 15 40 : annonce Bienvenue puis le groupe Commercial 20 secondes, ensuite Paul et Julie l'un après l'autre 10s, sinon la messagerie de groupe. En dehors des horaires : annonce Fermé puis raccrocher", ctx);
  const p = r.proposal;
  assert.deepEqual(p.dids, ["0465001540"]);
  assert.equal(p.schedule, "s1");
  assert.deepEqual(p.branches.open, [
    { type: "prompt", target: "p2" },
    { type: "group", target: "g1", time: 20 },
    { type: "ring", users: ["202", "203"], strategy: "hunt", time: 10 },
    { type: "groupvm", target: "v1" },
  ]);
  assert.deepEqual(p.branches.closed, [{ type: "prompt", target: "p1" }, { type: "hangup" }]);
  assert.equal(r.warnings.length, 0, r.warnings.join(" / "));
});

test("file, SVI, mobile, numéro externe, incompris", () => {
  let r = parseRouting("sda 04 65 00 15 99 : file Support puis renvoi vers 06 22 33 44 55", ctx);
  assert.deepEqual(r.proposal.dids, ["0465001599"]);
  assert.deepEqual(r.proposal.branches.open, [{ type: "queue", target: "q1" }, { type: "external", target: "0622334455" }]);
  r = parseRouting("le SVI Standard", ctx);
  assert.deepEqual(r.proposal.branches.open, [{ type: "ivr", target: "i1" }]);
  r = parseRouting("Marine sonne 20 s puis son mobile, puis messagerie", ctx);
  assert.deepEqual(r.proposal.branches.open, [{ type: "ring", users: ["201"], strategy: "all", time: 20 }, { type: "external", target: "0611111111" }]);
  assert.ok(r.warnings.some((w) => /rien ne peut suivre/.test(w)));
  r = parseRouting("Paul sonne puis le chien aboie", ctx);
  assert.ok(r.warnings.some((w) => /pas compris « le chien aboie »/.test(w)));
  r = parseRouting("tout le monde sonne en même temps 25 s puis messagerie de Paul", ctx);
  assert.equal(r.proposal.branches.open[0].users.length, 4);
  assert.deepEqual(r.proposal.branches.open[1], { type: "user_vm", target: "202" });
});
