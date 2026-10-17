/**
 * Supervision (rôle Superviseur) : lecture de « queue show » d'Asterisk → état des files d'attente.
 * Fonctions pures, testées dans console/test/supervision.test.mjs.
 *
 * Exemple de sortie :
 *   q600 has 1 calls (max unlimited) in 'ringall' strategy (12s holdtime, 45s talktime), W:0, C:10, A:2, SL:0.0%, SL2:0.0% within 0s
 *      Members:
 *         Marie (Local/201@queue-ring/n) (ringinuse disabled) (dynamic) (Not in use) has taken 3 calls (last was 120 secs ago)
 *      Callers:
 *         1. PJSIP/trunk-00000001 (wait: 0:12, prio: 0)
 */
const MEMBER_STATE = { "not in use": "free", "in use": "busy", busy: "busy", ringing: "ringing", "on hold": "busy", unavailable: "off", invalid: "off", paused: "paused" };

export function parseQueueShow(lines) {
  const out = [];
  let q = null, part = "";
  for (const raw of Array.isArray(lines) ? lines : String(lines || "").split("\n")) {
    const l = raw.replace(/\r$/, "");
    const head = /^(\S+) has (\d+) calls? \(max [^)]*\) in '([^']+)' strategy \((\d+)s holdtime, (\d+)s talktime\), W:\d+, C:(\d+), A:(\d+)/.exec(l);
    if (head) {
      q = { name: head[1], waiting: Number(head[2]), strategy: head[3], holdtime: Number(head[4]), talktime: Number(head[5]),
        completed: Number(head[6]), abandoned: Number(head[7]), members: [], callers: [] };
      out.push(q); part = ""; continue;
    }
    if (!q) continue;
    const t = l.trim();
    if (/^Members:/.test(t)) { part = "m"; continue; }
    if (/^Callers:/.test(t)) { part = "c"; continue; }
    if (/^No (Members|Callers)/.test(t)) { part = ""; continue; }
    if (part === "m" && t) {
      const ext = /Local\/(\d+)@/.exec(t)?.[1] || "";
      const flags = [...t.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].toLowerCase());
      const paused = flags.some((f) => f.startsWith("paused"));
      const st = flags.map((f) => MEMBER_STATE[f]).find(Boolean) || "free";
      out.at(-1).members.push({ ext, name: t.split(" (")[0], state: paused ? "paused" : st, taken: Number(/has taken (\d+) calls?/.exec(t)?.[1] || 0) });
    } else if (part === "c" && t) {
      const w = /wait: (\d+):(\d+)/.exec(t);
      out.at(-1).callers.push({ wait: w ? Number(w[1]) * 60 + Number(w[2]) : 0 });
    }
  }
  return out;
}

/** Résumé par file : nom lisible (objet « queue » q<numéro>), en attente, plus longue attente, répondus, perdus, % perdus */
export function queueStats(parsed, objects = []) {
  return parsed.filter((q) => /^q\d+$/.test(q.name)).map((q) => {
    const o = objects.find((x) => x.kind === "queue" && `q${x.number}` === q.name);
    const total = q.completed + q.abandoned;
    return {
      number: q.name.slice(1), name: o?.name || q.name, waiting: q.waiting, longest: Math.max(0, ...q.callers.map((c) => c.wait)),
      holdtime: q.holdtime, talktime: q.talktime, answered: q.completed, lost: q.abandoned, lost_pct: total ? Math.round((q.abandoned / total) * 100) : 0,
      agents: q.members.map((m) => ({ ext: m.ext, name: m.name, state: m.state, taken: m.taken })),
    };
  });
}
