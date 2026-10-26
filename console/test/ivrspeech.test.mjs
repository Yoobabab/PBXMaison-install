import { test } from "node:test";
import assert from "node:assert/strict";
import { ivrOptions, localMatch } from "../lib/ivrspeech.mjs";

test("SVI parlé : libellés des touches et correspondances simples", () => {
  const ivr = { options: { 1: { type: "group", target: "g1" }, 2: { type: "queue", target: "q1" }, 3: { type: "user", target: "201" } }, keywords: { 2: "factures, paiement, compta" } };
  const opts = ivrOptions(ivr, { objects: [{ kind: "group", id: "g1", name: "Commercial" }, { kind: "queue", id: "q1", name: "Comptabilité" }], users: new Map([["201", { first_name: "Sophie", last_name: "Durand" }]]) });
  assert.deepEqual(opts.map((o) => o.label), ["Commercial", "Comptabilité", "Sophie Durand"]);
  assert.equal(localMatch("je voudrais la compta s'il vous plaît", opts), "2");
  assert.equal(localMatch("c'est pour une facture", opts), "");          // « facture » ≠ « factures » : l'IA tranchera
  assert.equal(localMatch("c'est pour mes factures", opts), "2");
  assert.equal(localMatch("le deux", opts), "2");
  assert.equal(localMatch("Sophie Durand svp", opts), "3");
  assert.equal(localMatch("le commercial ou la comptabilité", opts), "");  // ambigu : l'IA tranchera
  assert.equal(localMatch("neuf", opts), "");                              // pas une touche du menu
});

test("SVI parlé : les mots-clés passent avant les chiffres ; « une » n'est pas la touche 1", () => {
  const opts = [{ key: "1", label: "Commercial", keywords: "" }, { key: "2", label: "Support", keywords: "panne, depannage" }];
  assert.equal(localMatch("j'ai une panne", opts), "2");
  assert.equal(localMatch("une question", opts), "");
  assert.equal(localMatch("le un", opts), "1");
  assert.equal(localMatch("le deux", opts), "2");
});
