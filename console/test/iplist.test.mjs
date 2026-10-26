import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIpList, validIp } from "../lib/iplist.mjs";

test("liste d'IP : JSON, CSV, texte", () => {
  assert.deepEqual(parseIpList('["203.0.113.7", "198.51.100.2", "203.0.113.7"]').ips, ["203.0.113.7", "198.51.100.2"]);
  assert.deepEqual(parseIpList('{"blocked":[{"ip":"203.0.113.7","reason":"scan"},{"address":"2001:db8::1"}]}').ips, ["203.0.113.7", "2001:db8::1"]);
  assert.deepEqual(parseIpList("ip;motif\n203.0.113.7;sipvicious\n198.51.100.2/32;scan\n").ips, ["203.0.113.7", "198.51.100.2"]);
  const r = parseIpList("2026-10-26 10:12:01 Ban 203.0.113.9\n999.1.1.1\nexemple.fr\n");
  assert.deepEqual(r.ips, ["203.0.113.9"]); assert.deepEqual(r.invalid, ["999.1.1.1"]);
  assert.equal(validIp("::1"), true); assert.equal(validIp("1.2.3"), false); assert.equal(validIp("2001:db8:::1"), false);
});
