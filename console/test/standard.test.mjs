import { test } from "node:test";
import assert from "node:assert/strict";
import { parseState, stateValue, validateState, validateConfig, buildStandardDialplan, describeState, defaultStandard } from "../lib/standard.mjs";
import { defaultUser, validateUser, buildUsersDialplan, isStandardist, forwardSummary } from "../lib/users.mjs";
import { buildShortcodesDialplan, defaultShortcodes, normalizeShortcodes, validateShortcodes } from "../lib/shortcodes.mjs";

test("standard : état lu et écrit dans la base d'Asterisk", () => {
  assert.deepEqual(parseState(""), { state: "open", target: "" });
  assert.deepEqual(parseState("closed"), { state: "closed", target: "" });
  assert.deepEqual(parseState("fwd:0612345678"), { state: "forward", target: "0612345678" });
  assert.deepEqual(parseState("fwd:089"), { state: "open", target: "" });
  assert.equal(stateValue({ state: "forward", target: "0612345678" }), "fwd:0612345678");
  assert.equal(stateValue({ state: "closed" }), "closed");
  assert.equal(describeState({ state: "forward", target: "0612345678" }), "Fermé · renvoyé vers 06 12 34 56 78");
});

test("standard : renvoi vers un numéro français, jamais surtaxé", () => {
  assert.deepEqual(validateState({ state: "forward", target: "+33 6 12 34 56 78" }), { state: "forward", target: "0612345678" });
  assert.throws(() => validateState({ state: "forward", target: "0899123456" }), /surtaxé/);
  assert.throws(() => validateState({ state: "forward", target: "112" }), /10 chiffres/);
  assert.throws(() => validateState({ state: "bidon" }), /inconnu/);
  assert.deepEqual(validateState({ state: "closed", target: "0612345678" }), { state: "closed", target: "" });
});

test("standard : plan de numérotation fermé / renvoyé / numéros exclus", () => {
  const cfg = validateConfig({ skip_dids: ["+33 1 23 45 67 89", "0123456789"] }, defaultStandard(), { cc: "33", extensions: new Set(), objects: [] });
  assert.deepEqual(cfg.skip_dids, ["0123456789"]);
  const d = buildStandardDialplan(cfg, { objects: [], users: [] });
  assert.match(d, /\[standard-closed\]/);
  assert.match(d, /Goto\(user-external,\$\{STD:4\},1\)/);
  assert.match(d, /\[standard-skip\]\nexten => 0123456789,1,Return\(\)/);
});

test("rôle Standardiste et renvoi immédiat d'un utilisateur", () => {
  const ctx = { cc: "33", extensions: new Set(["201", "202"]), didOwners: new Map() };
  const u = validateUser({ first_name: "Léa", options: { role: "standard" }, forwarding: { always: { type: "external", target: "06 12 34 56 78" } } }, defaultUser("201"), ctx);
  assert.ok(isStandardist(u));
  assert.ok(!isStandardist(validateUser({ first_name: "Paul" }, defaultUser("202"), ctx)));
  assert.equal(u.forwarding.always.target, "0612345678");
  assert.deepEqual(u.forwarding.always_last, { type: "external", target: "0612345678" });
  assert.ok(forwardSummary(u).some((l) => /Renvoi immédiat/.test(l.text)));
  const plan = buildUsersDialplan([u]);
  assert.match(plan, /exten => fwd201,hint,Custom:fwd201/);
  assert.match(plan, /\[std-allow\]\nexten => 201,1,Return\(\)/);
  const off = validateUser({ forwarding: { always: { type: "none" } } }, u, ctx);
  assert.equal(off.forwarding.always.type, "none");
  assert.equal(off.forwarding.always_last.target, "0612345678");   // retenu pour la touche Renvoi
});

test("codes *21 #21 *22 *80 *81 *82 et touches Renvoi / Standard", () => {
  const d = buildShortcodesDialplan(defaultShortcodes());
  for (const re of [/exten => \*21,1,/, /\}\)=on\)/, /_\*220\[1-79\]X{8}/, /#21,1/, /\*80,1/, /\*81,1/, /_\*820\[1-79\]X{8}/, /exten => standard,hint,Custom:cxstd/, /\[std-set\]/, /DIALPLAN_EXISTS\(std-allow/])
    assert.match(d, re);
});

test("codes : anciens réglages repris sans casser le plan de numérotation", () => {
  const old = { park: "*0", fwd_number: "*21", fwd_vm: "*22", fwd_off: "#21" };   // version précédente, sans les codes du standard
  const n = normalizeShortcodes(old);
  assert.equal(n.fwd_on, "*21"); assert.equal(n.fwd_number, "*22"); assert.equal(n.std_close, "*80");
  assert.equal(n.fwd_vm, undefined);
  assert.doesNotMatch(buildShortcodesDialplan(old), /undefined/);
  assert.throws(() => validateShortcodes({ fwd_on: "*80" }, old), /deux fois/);
});

test("renvoi immédiat : destination gardée quand il est désactivé", () => {
  const ctx = { cc: "33", extensions: new Set(["201"]), didOwners: new Map() };
  const u = validateUser({ first_name: "A", forwarding: { always: { type: "none" }, always_last: { type: "external", target: "0611223344" } } }, defaultUser("201"), ctx);
  assert.equal(u.forwarding.always.type, "none");
  assert.deepEqual(u.forwarding.always_last, { type: "external", target: "0611223344" });
  assert.throws(() => validateUser({ forwarding: { always_last: { type: "none" } } }, u, ctx), /Destination/);
});

test("touche à bascule ajoutée sur la première touche libre", async () => {
  const { addToggleKey } = await import("../lib/phones.mjs");
  assert.equal(addToggleKey({ model: "", keys: [] }, "fwd"), null);
  assert.equal(addToggleKey({ model: "fanvil-x4u", keys: [] }, "fwd"), null);
  const p = { model: "yealink-t57w", keys: [{ type: "line" }, { type: "blf", value: "202", label: "Paul" }, { type: "none" }], modules: [] };
  const r = addToggleKey(p, "standard");
  assert.equal(r.position, 3); assert.equal(r.keys[2].type, "standard"); assert.equal(r.keys[2].label, "Ouvert/Fermé");
  assert.equal(addToggleKey({ ...p, keys: r.keys }, "standard").position, 0);
  const full = { model: "yealink-t31w", keys: [{ type: "line" }, { type: "blf", value: "202" }] };
  assert.equal(addToggleKey(full, "fwd").position, -1);
  assert.equal(addToggleKey({ model: "yealink-t31w", keys: [] }, "fwd").position, 2);
});
