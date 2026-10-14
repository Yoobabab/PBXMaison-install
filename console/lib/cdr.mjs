/**
 * Journal des appels : regroupe les lignes CDR d'Asterisk (une par couple appelant/appelé) en appels lisibles.
 * Fonctions pures, testées dans console/test/cdr.test.mjs.
 */
const endpointOf = (ch) => /^PJSIP\/(.+)-[0-9a-f]+$/.exec(ch || "")?.[1] || "";
const extOf = (ch) => { const e = endpointOf(ch); return /^\d{3}(-web)?$/.test(e) ? e.slice(0, 3) : ""; };
const parseClid = (clid) => {
  const m = String(clid || "").match(/^"?([^"<]*)"?\s*<([^>]*)>$/);
  return m ? { name: m[1].trim(), number: m[2].trim() } : { name: "", number: String(clid || "") };
};

/** rows : lignes CDR d'un même linkedid (ou mélangées) → appels [{ id, start, direction, from, to, … }] */
export function summarize(rows, trunkIds = new Set()) {
  const by = new Map();
  for (const r of rows) {
    const k = r.linkedid || r.uniqueid;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const calls = [];
  for (const [id, list] of by) {
    list.sort((a, b) => new Date(a.calldate) - new Date(b.calldate) || (a.sequence || 0) - (b.sequence || 0));
    const first = list[0];
    const caller = parseClid(first.clid);
    const aEp = endpointOf(first.channel);
    const direction = first.direction || list.find((r) => r.direction)?.direction || (trunkIds.has(aEp) ? "in" : list.some((r) => trunkIds.has(endpointOf(r.dstchannel))) ? "out" : "internal");
    const answered = list.filter((r) => r.disposition === "ANSWERED" && r.dstchannel && r.billsec > 0);
    const answeredBy = answered.map((r) => extOf(r.dstchannel)).find(Boolean) || "";
    const rang = [...new Set(list.map((r) => extOf(r.dstchannel)).filter(Boolean))];
    const vm = list.some((r) => /^VoiceMail/i.test(r.lastapp || ""));
    const vmBox = list.map((r) => /^VoiceMail$/i.test(r.lastapp || "") ? String(r.lastdata || "").split("@")[0] : "").find(Boolean) || "";
    const extCall = answered.find((r) => trunkIds.has(endpointOf(r.dstchannel)));
    const talk = Math.max(0, ...answered.map((r) => Number(r.billsec) || 0));
    let status = answered.length ? "answered" : vm ? "voicemail" : list.some((r) => r.disposition === "BUSY") ? "busy" : "missed";
    if (direction === "out" && !answered.length) status = list.some((r) => r.disposition === "BUSY") ? "busy" : "failed";
    const end = list.reduce((m, r) => Math.max(m, new Date(r.enddate || r.calldate).getTime()), 0);
    calls.push({
      id, start: new Date(first.calldate).toISOString(), end: end ? new Date(end).toISOString() : null,
      direction, status,
      from: { number: direction === "in" ? caller.number : extOf(first.channel) || caller.number, name: caller.name, ext: extOf(first.channel) },
      to: { number: direction === "in" ? (first.did || first.dst) : first.dst, ext: answeredBy || (direction === "internal" ? first.dst : "") },
      did: first.did || "", rule: list.find((r) => r.rule)?.rule || "", answered_by: answeredBy, rang,
      external: extCall ? endpointOf(extCall.dstchannel) : "", voicemail: vmBox,
      recording: list.map((r) => r.userfield || "").find((f) => /\.wav$/.test(f)) || "",
      duration: Math.round((end - new Date(first.calldate).getTime()) / 1000) || Number(first.duration) || 0, talk,
    });
  }
  return calls.sort((a, b) => b.start.localeCompare(a.start));
}

/** Vue d'un utilisateur : ses appels passés et reçus, « manqué » seulement si personne n'a répondu. */
export function forUser(calls, ext) {
  const out = [];
  for (const c of calls) {
    const mine = c.from.ext === ext;
    const rangMe = c.rang.includes(ext) || c.to.ext === ext || c.voicemail === ext;
    if (!mine && !rangMe) continue;
    let status;
    if (mine) status = c.status === "answered" ? "answered" : "failed";
    else if (c.answered_by === ext) status = "answered";
    else if (c.answered_by) status = "answered_elsewhere";
    else status = c.voicemail === ext ? "voicemail" : "missed";
    out.push({
      id: c.id, at: c.start, direction: mine ? "out" : "in", status,
      number: mine ? c.to.number : (c.from.ext && c.direction === "internal" ? c.from.ext : c.from.number),
      name: mine ? "" : c.from.name, answered_by: c.answered_by, duration: status === "answered" ? c.talk : 0, did: c.did,
    });
  }
  return out;
}
