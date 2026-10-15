import test from "node:test";
import assert from "node:assert/strict";
import { parsePrefixes, parseRanges, validateRule, buildOutboundDialplan, describeRule } from "../lib/outbound.mjs";

test("préfixes et plages", () => {
  assert.deepEqual(parsePrefixes("06, 07,1-3"), ["06", "07", "1", "2", "3"]);
  assert.throws(() => parsePrefixes("6-07"), /Plage/);
  assert.deepEqual(parseRanges("100,103-105", "x"), [[100, 100], [103, 105]]);
  assert.throws(() => parseRanges("105-103", "x"), /invalide/);
});

test("validation d'une règle", () => {
  const ctx = { trunks: new Set(["dstny", "netw"]), cc: "33" };
  const r = validateRule({ name: "Mobiles", prefixes: "06,07", lengths: "10", extensions: "200-299",
    routes: [{ trunk: "dstny", strip: 0, prepend: "", cid_mode: "user" }, { trunk: "netw", strip: 1, prepend: "0033", cid_mode: "custom", cid: "04 12 34 56 78" }, { trunk: "" }] }, ctx);
  assert.equal(r.routes.length, 2);
  assert.equal(r.routes[1].cid, "0412345678");
  assert.match(describeRule(r), /commençant par 06, 07, de 10 chiffres, appelés par 200-299/);
  assert.throws(() => validateRule({ name: "X", routes: [] }, ctx), /au moins une route/);
  assert.throws(() => validateRule({ name: "X", routes: [{ trunk: "inconnu" }] }, ctx), /trunk inconnu/);
  assert.throws(() => validateRule({ name: "X", routes: [{ trunk: "dstny", cid_mode: "custom", cid: "abc" }] }, ctx), /présenté/);
});

test("plan de numérotation des règles sortantes (ordre, secours)", () => {
  const ctx = { trunks: new Set(["dstny", "netw"]), cc: "33" };
  const rules = [
    validateRule({ name: "Mobiles", prefixes: "06,07", lengths: "10", routes: [{ trunk: "dstny" }, { trunk: "netw", cid_mode: "hidden" }] }, ctx),
    validateRule({ name: "Tout", routes: [{ trunk: "netw", strip: 1, prepend: "33" }] }, ctx),
  ];
  const t = buildOutboundDialplan(rules, new Map([["dstny", { dial_format: "national", cid_format: "e164", outbound_cid: "0465001530" }], ["netw", { dial_format: "e164", cid_format: "national", outbound_cid: "0412345678" }]]));
  assert.match(t, /GotoIf\(\$\[\$\{REGEX\("\^\(06\|07\)" \$\{N\}\)\} & \(\$\{LEN\(\$\{N\}\)\} = 10\)\]\?r1-1\)/);
  assert.match(t, /GotoIf\(1\?r2-1\)/);
  assert.match(t, /n\(r1-1\),NoOp[\s\S]*Gosub\(out-cid,s,1\(user,,0465001530,e164\)\)\n same => n,Dial\(PJSIP\/\$\{D\}@dstny,120,T\)\n same => n,GotoIf\([^)]*CHANUNAVAIL[^)]*\?r1-2\)/);
  assert.match(t, /n\(r2-1\)[\s\S]*Set\(D=33\$\{N:1\}\)/);
  assert.equal(buildOutboundDialplan([], new Map()).includes("exten"), false);
});
