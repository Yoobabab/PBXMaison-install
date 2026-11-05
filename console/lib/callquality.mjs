// Qualité des appels : mesurée pendant l'appel sur chaque côté (poste, softphone, appli, opérateur) toutes les 5 secondes.
// Pertes de paquets, gigue, délai, note MOS (modèle E simplifié, UIT-T G.107) et coupures de son (plus rien reçu ≥ 3 s).
// Fonctions pures testées ; le service interroge Asterisk (CHANNEL(rtcp,all)) et garde le résultat avec l'appel.

/** « ssrc=…;themssrc=…;lp=3;rxjitter=0.002;rxcount=500;txjitter=…;txcount=…;rlp=…;rtt=…;rxmes=…;txmes=… » → nombres */
export function parseQos(s) {
  const o = {};
  for (const part of String(s || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = Number(part.slice(i + 1));
    if (k && Number.isFinite(v)) o[k] = v;
  }
  return o.rxcount === undefined && o.txcount === undefined ? null : {
    rxcount: o.rxcount || 0, lp: Math.max(0, o.lp || 0), txcount: o.txcount || 0, rlp: Math.max(0, o.rlp || 0),
    // Asterisk donne la gigue et le délai aller-retour en secondes
    jitter_ms: Math.round(Math.max(o.rxjitter || 0, o.txjitter || 0) * 1000), rtt_ms: Math.round((o.rtt || 0) * 1000),
    mes: Math.max(o.rxmes || 0, 0) && Math.max(o.txmes || 0, 0) ? Math.min(o.rxmes, o.txmes) : Math.max(o.rxmes || 0, o.txmes || 0),
  };
}

const pct = (lost, got) => (got + lost > 0 ? (100 * lost) / (got + lost) : 0);

/** Note MOS de 1 à 4,5 (modèle E simplifié) : pertes, gigue, délai ; codec G.711 / G.722 avec masquage des pertes */
export function mosOf({ loss = 0, jitter_ms = 0, rtt_ms = 0 }) {
  const d = rtt_ms / 2 + jitter_ms * 2 + 10;
  const id = 0.024 * d + (d > 177.3 ? 0.11 * (d - 177.3) : 0);
  const ie = (95 * loss) / (loss + 25.1);   // Ie = 0 et Bpl = 25,1 (G.711 avec masquage des pertes)
  const r = Math.max(0, Math.min(93.2, 93.2 - id - ie));
  return Math.round((1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r)) * 100) / 100;
}

export const GRADES = { good: "Bonne", fair: "Correcte", poor: "Moyenne", bad: "Mauvaise" };
/** Note d'un côté de l'appel : MOS, puis coupures (une coupure de son d'au moins 3 s rend l'appel « Mauvais ») */
export function gradeOf(q) {
  if (q.max_gap_s >= 3) return "bad";
  return q.mos >= 4 ? "good" : q.mos >= 3.6 ? "fair" : q.mos >= 3.1 ? "poor" : "bad";
}

/**
 * Nouvelle mesure d'un côté : cumule les coupures (aucun paquet reçu entre deux mesures alors que l'appel est en cours).
 * prev : état précédent ou null ; cur : parseQos ; dt : secondes depuis la mesure précédente ; up : appel décroché (pas en sonnerie)
 */
export function stepQuality(prev, cur, { dt = 5, up = true, held = false } = {}) {
  const p = prev || { rxcount: 0, gaps: 0, max_gap_s: 0, gap_now: 0, rx_loss: 0, tx_loss: 0 };
  const silent = up && !held && p.rxcount > 0 && cur.rxcount <= p.rxcount;
  const gapNow = silent ? (p.gap_now || 0) + dt : 0;
  const newGap = silent && !(p.gap_now > 0);
  const q = {
    rxcount: cur.rxcount, lp: cur.lp, txcount: cur.txcount, rlp: cur.rlp,
    rx_loss: Math.round(pct(cur.lp, cur.rxcount) * 10) / 10, tx_loss: Math.round(pct(cur.rlp, cur.txcount) * 10) / 10,
    jitter_ms: Math.max(cur.jitter_ms, p.jitter_ms || 0), rtt_ms: Math.max(cur.rtt_ms, p.rtt_ms || 0), mes: cur.mes || 0,
    gap_now: gapNow, gaps: (p.gaps || 0) + (newGap && gapNow >= 3 ? 1 : 0), max_gap_s: Math.max(p.max_gap_s || 0, gapNow),
  };
  // une coupure qui dure : comptée une fois, dès qu'elle atteint 3 s
  if (silent && p.gap_now > 0 && p.gap_now < 3 && gapNow >= 3) q.gaps = (p.gaps || 0) + 1;
  q.mos = mosOf({ loss: Math.max(q.rx_loss, q.tx_loss), jitter_ms: q.jitter_ms, rtt_ms: q.rtt_ms });
  q.grade = gradeOf(q);
  return q;
}

/** Côté de l'appel d'après l'endpoint : opérateur (trunk), poste, softphone web, appli */
export function sideOf(endpoint, trunkIds) {
  if (trunkIds.has(endpoint)) return { kind: "trunk", label: `côté opérateur (${endpoint})` };
  const m = /^(.+?)-(web|app)$/.exec(endpoint);
  if (m) return { kind: m[2], label: m[2] === "web" ? `softphone du ${m[1]}` : `appli du ${m[1]}` };
  return { kind: "phone", label: `poste ${endpoint}` };
}

/** Bilan d'un appel à partir de ses côtés : la note du plus mauvais côté, et une phrase claire */
export function callQuality(legs) {
  if (!legs.length) return null;
  const order = ["good", "fair", "poor", "bad"];
  const worst = legs.reduce((w, l) => (order.indexOf(l.grade) > order.indexOf(w.grade) ? l : w), legs[0]);
  const bits = [];
  if (worst.max_gap_s >= 3) bits.push(`coupure de son de ${Math.round(worst.max_gap_s)} s`);
  const loss = Math.max(worst.rx_loss, worst.tx_loss);
  if (loss >= 1) bits.push(`${String(loss).replace(".", ",")} % de paquets perdus`);
  if (worst.jitter_ms >= 30) bits.push(`gigue ${worst.jitter_ms} ms`);
  if (worst.rtt_ms >= 300) bits.push(`délai ${worst.rtt_ms} ms`);
  return { grade: worst.grade, label: GRADES[worst.grade], mos: worst.mos,
    detail: worst.grade === "good" ? "" : `${bits.join(", ") || `note ${String(worst.mos).replace(".", ",")} / 4,5`} — ${worst.side_label}`,
    legs: legs.map((l) => ({ side: l.side_label, kind: l.side_kind, codec: l.codec, grade: l.grade, mos: l.mos, rx_loss: l.rx_loss, tx_loss: l.tx_loss, jitter_ms: l.jitter_ms, rtt_ms: l.rtt_ms, gaps: l.gaps, max_gap_s: l.max_gap_s })) };
}

// ------------------------------------------------------------------ Service
export function createCallQuality({ db, ami, trunkIds, log = () => {} }) {
  const live = new Map();   // uniqueid → { linkedid, endpoint, codec, q, at }
  async function migrate() {
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_call_quality (
      uniqueid text PRIMARY KEY, linkedid text NOT NULL, endpoint text NOT NULL, side_kind text NOT NULL, side_label text NOT NULL, codec text NOT NULL DEFAULT '',
      first_at timestamptz NOT NULL DEFAULT now(), last_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL DEFAULT '{}')`);
    await db.query("CREATE INDEX IF NOT EXISTS pbxmaison_call_quality_linked ON pbxmaison_call_quality (linkedid)");
  }
  const getvar = async (channel, v) => { try { return (await ami.action({ Action: "Getvar", Channel: channel, Variable: v })).Value || ""; } catch { return ""; } };
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      let lines;
      try { lines = await ami.command("core show channels concise"); } catch { return; }
      const chans = lines.map((l) => l.split("!")).filter((f) => f.length > 12 && f[0].startsWith("PJSIP/"))
        .map((f) => ({ name: f[0], state: f[4], app: f[5], uniqueid: f[13] || f[f.length - 1] }));
      const trunks = await trunkIds();
      const now = Date.now(), seen = new Set();
      for (const c of chans) {
        if (!c.uniqueid) continue;
        seen.add(c.uniqueid);
        const qos = parseQos(await getvar(c.name, "CHANNEL(rtcp,all)"));
        if (!qos) continue;
        let e = live.get(c.uniqueid);
        if (!e) {
          const endpoint = /^PJSIP\/(.+)-[0-9a-f]+$/.exec(c.name)?.[1] || "";
          e = { linkedid: (await getvar(c.name, "CHANNEL(linkedid)")) || c.uniqueid, endpoint, side: sideOf(endpoint, trunks),
            codec: await getvar(c.name, "CHANNEL(audioreadformat)"), q: null, at: now };
          live.set(c.uniqueid, e);
        }
        const up = c.state === "Up", held = /MusicOnHold|Hold/i.test(c.app);
        e.q = stepQuality(e.q, qos, { dt: Math.max(1, (now - e.at) / 1000), up, held });
        e.at = now;
        await db.query(`INSERT INTO pbxmaison_call_quality (uniqueid, linkedid, endpoint, side_kind, side_label, codec, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (uniqueid) DO UPDATE SET last_at = now(), data = $7, codec = $6`,
        [c.uniqueid, e.linkedid, e.endpoint, e.side.kind, e.side.label, e.codec, JSON.stringify(e.q)]);
      }
      for (const [id, e] of live) if (!seen.has(id)) { live.delete(id); if (e.q?.grade === "bad") log(`Appel de mauvaise qualité (${e.side.label}) : ${JSON.stringify(e.q)}`); }
    } finally { busy = false; }
  }
  /** Qualité des appels du journal : linkedid → bilan */
  async function forCalls(ids) {
    if (!ids.length) return new Map();
    const r = await db.query("SELECT linkedid, side_kind, side_label, codec, data FROM pbxmaison_call_quality WHERE linkedid = ANY($1)", [ids]);
    const by = new Map();
    for (const x of r.rows) { if (!by.has(x.linkedid)) by.set(x.linkedid, []); by.get(x.linkedid).push({ ...x.data, side_kind: x.side_kind, side_label: x.side_label, codec: x.codec }); }
    return new Map([...by].map(([k, legs]) => [k, callQuality(legs)]));
  }
  const purge = () => db.query("DELETE FROM pbxmaison_call_quality WHERE last_at < now() - interval '120 days'");
  return { migrate, tick, forCalls, purge };
}
