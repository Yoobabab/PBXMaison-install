import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeOf, simulateCalls } from "../lib/simulate.mjs";

const n = (type, title, children = [], extra = {}) => ({ type, title, children, status: "ok", detail: [], ...extra });
const c = (label, node, current) => ({ label, node, ...(current === undefined ? {} : { current }) });

test("simulateur : chemin suivi résumé", () => {
  const tree = n("did", "SDA 04", [c("Règle", n("rule", "Règle « Standard »", [
    c("Ouvert", n("group", "Groupe 600 · Accueil", [c("Membre", n("member", "201 · Julie", [], { ext: "201" })), c("Sans réponse", n("voicemail", "Messagerie de 201 · Julie"))]), false),
    c("Fermé", n("prompt", "Annonce « Fermé »", [c("Puis", n("hangup", "Raccroche"))]), true),
  ]))]);
  assert.equal(outcomeOf(tree), "Annonce « Fermé » → Raccroche");
  tree.children[0].node.children[0].current = true; tree.children[0].node.children[1].current = false;
  assert.equal(outcomeOf(tree), "Groupe 600 · Accueil → Messagerie de 201 · Julie");
  assert.equal(outcomeOf(n("did", "SDA", [c("x", n("ivr", "SVI 800", [c("1", n("group", "G"))]))])), "SVI 800");
  assert.equal(outcomeOf(n("did", "SDA")), "Aucune destination");
});

test("simulateur : appels rejoués et regroupés", () => {
  // Faux traceur : avant 9 h (heure UTC du test) fermé, sinon groupe ; le modèle « after » ouvre à 8 h
  const trace = (did, m) => ({ root: n("did", did, [c("r", new Date(m.now).getUTCHours() >= m.open ? n("group", "Groupe Accueil") : n("voicemail", "Messagerie"))]) });
  const calls = [8, 8, 10, 7, 8].map((hh, i) => ({ start: `2026-10-2${i}T0${hh}:30:00Z`.replace("T010", "T10"), did: "0412345678", from: `C${i}` }));
  calls.push({ start: "2026-10-20T08:00:00Z", did: "", from: "interne" });
  const r = simulateCalls(calls, { open: 9 }, { open: 8 }, trace);
  assert.equal(r.total, 5); assert.equal(r.changed, 3);
  assert.deepEqual(r.groups.map((g) => [g.from, g.to, g.count, g.examples.length]), [["Messagerie", "Groupe Accueil", 3, 3]]);
});
