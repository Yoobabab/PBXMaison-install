import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, describeChanges, hashOf } from "../lib/history.mjs";

const base = () => ({
  objects: [{ kind: "group", id: "g1", number: "600", name: "Accueil", data: { members: ["201", "202"] }, updated_at: "x" },
    { kind: "rule", id: "r1", number: null, name: "SDA principale", data: { did: "0412345678" } }],
  settings: { routes: { inbound: [] }, outbound_rules: [], receptionist: null, shortcodes: {} },
  standard: { state: "closed", closed_dest: { type: "hangup" }, skip_dids: [], since: "hier" },
  users: [{ id: "201", name: "Julie", dids: ["0412345679"], status: "dnd" }],
});

test("historique : la photo ignore dates, statuts et ouvert/fermé", () => {
  const a = buildSnapshot(base());
  const b0 = base(); b0.objects[0].updated_at = "autre"; b0.standard.state = "open"; b0.users[0].status = "available"; b0.objects.reverse();
  assert.equal(hashOf(a), hashOf(buildSnapshot(b0)));
  assert.equal(a.settings.receptionist, undefined);
});

test("historique : changements décrits en français", () => {
  const before = buildSnapshot(base());
  const x = base();
  x.objects[0].data.members.push("203");
  x.objects.push({ kind: "ivr", id: "i1", number: "800", name: "Menu", data: {} });
  x.objects = x.objects.filter((o) => o.kind !== "rule");
  x.settings.outbound_rules = [{ id: "o1" }];
  x.users[0].dids = [];
  x.standard.closed_dest = { type: "user_vm", target: "201" };
  const ch = describeChanges(before, buildSnapshot(x));
  assert.deepEqual(ch, ["Groupe « Accueil » modifié", "SVI « Menu » ajouté", "Règle entrante « SDA principale » supprimée",
    "Règles sortantes modifiées", "Standard (destination quand c'est fermé) modifié", "SDA de Julie (201) modifiées"]);
  assert.deepEqual(describeChanges(null, before), ["Première version gardée"]);
  const h = base(); h.objects.push({ kind: "schedule", id: "s1", name: "Bureau", data: {} });
  assert.deepEqual(describeChanges(before, buildSnapshot(h)), ["Horaires « Bureau » ajoutés"]);
});
