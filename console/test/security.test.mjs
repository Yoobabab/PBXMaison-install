import test from "node:test";
import assert from "node:assert/strict";
import { validateSecurity, buildSecurityDialplan, checkIp, ipAllowed, securityGlobals } from "../lib/security.mjs";

test("validation et contextes", () => {
  const s = validateSecurity({ intl: ["32", "+41", "0044", "33"], in_block: [{ number: "06 12 34 56 78", label: "Démarcheur" }, { number: "0899*" }, ""], out_block: ["+33 8 99 00 00 00"],
    max_user_calls: 3, max_duration: 60, console_allow: "192.168.1.0/24, 203.0.113.5", f2b: { maxretry: 4, findtime: 5, bantime: 1440 } });
  assert.deepEqual(s.intl, ["32", "41", "44"]);
  assert.deepEqual(s.in_block[1], { number: "0899", prefix: true, label: "" });
  assert.equal(s.out_block[0].number, "0899000000");
  const d = buildSecurityDialplan(s);
  assert.match(d, /\[blocked-in\]\nexten => 0612345678,1,Return\(\)\nexten => _0899\.,1,Return\(\)/);
  assert.match(d, /exten => _0041\.,1,Return\(\)/);
  assert.deepEqual(securityGlobals(s), ["SEC_BLOCK_PREMIUM = 1", "SEC_BLOCK_ANON = 0", "SEC_MAX_USER_CALLS = 3", "SEC_MAX_DURATION = 60"]);
  assert.throws(() => validateSecurity({ console_allow: "300.1.1.1" }), /IP invalide/);
  assert.throws(() => validateSecurity({ in_block: ["abc"] }), /invalide/);
  assert.throws(() => validateSecurity({ max_user_calls: 99 }), /entre 0 et 50/);
});

test("adresses IP et accès console", () => {
  assert.equal(checkIp("10.0.0.0/8"), "10.0.0.0/8");
  assert.equal(checkIp("2001:db8::1"), "2001:db8::1");
  assert.equal(checkIp("1.2.3"), null);
  assert.equal(ipAllowed("8.8.8.8", []), true);
  assert.equal(ipAllowed("192.168.1.42", ["192.168.1.0/24"]), true);
  assert.equal(ipAllowed("192.168.2.42", ["192.168.1.0/24"]), false);
  assert.equal(ipAllowed("::ffff:203.0.113.5", ["203.0.113.5"]), true);
  assert.equal(ipAllowed("127.0.0.1", ["203.0.113.5"]), true);
});
