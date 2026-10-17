import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueueShow, queueStats } from "../lib/supervision.mjs";

const OUT = `q600 has 2 calls (max unlimited) in 'ringall' strategy (12s holdtime, 45s talktime), W:0, C:10, A:2, SL:0.0%, SL2:0.0% within 0s
   Members:
      Marie Durand (Local/201@queue-ring/n) (ringinuse disabled) (dynamic) (Not in use) has taken 3 calls (last was 120 secs ago)
      Paul Martin (Local/202@queue-ring/n) (ringinuse disabled) (paused) (In use) has taken 0 calls
   Callers:
      1. PJSIP/trunk-00000001 (wait: 0:12, prio: 0)
      2. PJSIP/trunk-00000002 (wait: 1:05, prio: 0)

q601 has 0 calls (max unlimited) in 'rrmemory' strategy (0s holdtime, 0s talktime), W:0, C:0, A:0, SL:0.0%, SL2:0.0% within 0s
   No Members
   No Callers

default has 0 calls (max unlimited) in 'ringall' strategy (0s holdtime, 0s talktime), W:0, C:0, A:0, SL:0.0%, SL2:0.0% within 0s
   No Members
   No Callers`;

test("files d'attente : lecture de queue show", () => {
  const p = parseQueueShow(OUT);
  assert.equal(p.length, 3);
  assert.equal(p[0].waiting, 2); assert.equal(p[0].completed, 10); assert.equal(p[0].abandoned, 2);
  assert.deepEqual(p[0].members.map((m) => [m.ext, m.state, m.taken]), [["201", "free", 3], ["202", "paused", 0]]);
  assert.deepEqual(p[0].callers.map((c) => c.wait), [12, 65]);
  const s = queueStats(p, [{ kind: "queue", number: "600", name: "Accueil" }]);
  assert.equal(s.length, 2);   // « default » ignorée
  assert.equal(s[0].name, "Accueil"); assert.equal(s[0].longest, 65); assert.equal(s[0].lost_pct, 17);
  assert.equal(s[1].lost_pct, 0); assert.equal(s[1].longest, 0);
});
