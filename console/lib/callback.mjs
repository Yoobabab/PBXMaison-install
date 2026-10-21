/**
 * Appels perdus classés par priorité : qui rappeler d'abord.
 * Part du journal des appels (summarize) : appels entrants sans réponse, regroupés par numéro, retirés dès que
 * quelqu'un a rappelé (ou que l'appelant a été pris plus tard), ou qu'un Pilote l'a marqué « traité ».
 * Priorité : nombre d'essais, message laissé (et jugé urgent par l'IA), ancienneté, contact connu.
 * Fonctions pures, testées dans console/test/callback.test.mjs.
 */
const digits = (n) => String(n || "").replace(/[^\d+]/g, "");
/** Numéro comparable : 0612… / +33612… / 0033612… → 612… (9 derniers chiffres) */
export const sameNumberKey = (n) => digits(n).replace(/^\+/, "").slice(-9);

export function missedCallers(calls, { now = Date.now(), done = new Map(), voicemails = [], contacts = new Map(), tz = "Europe/Paris" } = {}) {
  const byNum = new Map();
  for (const c of calls) {
    const external = c.direction === "in" ? c.from.number : c.direction === "out" ? c.to.number : "";
    const key = sameNumberKey(external);
    if (key.length < 9) continue;   // numéro masqué ou interne
    if (!byNum.has(key)) byNum.set(key, []);
    byNum.get(key).push(c);
  }
  const hm = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).replace(":", " h ");
  const out = [];
  for (const [key, list] of byNum) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    // Dernier contact réussi : entrant répondu, ou rappel sortant qui a abouti
    const lastOk = list.filter((c) => c.status === "answered").at(-1);
    const doneAt = done.get(key) || "";
    const since = [lastOk?.start || "", doneAt].sort().at(-1);
    const missed = list.filter((c) => c.direction === "in" && c.status !== "answered" && c.start > since);
    if (!missed.length) continue;
    const triedBack = list.filter((c) => c.direction === "out" && c.start > missed[0].start);   // rappel tenté, sans réponse
    const first = missed[0], last = missed.at(-1);
    const vms = voicemails.filter((v) => sameNumberKey(v.caller_number) === key && v.at >= first.start.slice(0, 16));
    const vm = vms.at(-1) || (missed.some((c) => c.status === "voicemail") ? { summary: "", urgent: false, box: missed.find((c) => c.status === "voicemail").voicemail || "" } : null);
    const urgent = vms.some((v) => v.urgent);
    const hours = (now - Date.parse(first.start)) / 3600_000;
    const contact = contacts.get(key) || "";
    const score = Math.round(Math.min(missed.length, 5) * 25 + (urgent ? 45 : 0) + (vm ? 15 : 0) + Math.min(hours, 24) * 1.5 + (contact ? 10 : 0) - (triedBack.length ? 15 : 0));
    const why = [
      missed.length > 1 ? `a appelé ${missed.length} fois depuis ${hm(first.start)}` : `appel manqué à ${hm(first.start)}`,
      urgent ? "message urgent" : vm ? "a laissé un message" : "",
      triedBack.length ? `rappel tenté ${triedBack.length > 1 ? `${triedBack.length} fois` : "1 fois"}, sans réponse` : "",
    ].filter(Boolean);
    out.push({
      key, number: last.from.number, name: last.from.name || contact || "", contact,
      attempts: missed.length, first_at: first.start, last_at: last.start, did: last.did || "", rule: last.rule || "",
      voicemail: vm ? { summary: vm.summary || "", urgent: !!vm.urgent, box: vm.box || "" } : null,
      tried_back: triedBack.length, score, level: score >= 75 ? "high" : score >= 40 ? "mid" : "low", why: why.join(" · "),
    });
  }
  return out.sort((a, b) => b.score - a.score || b.last_at.localeCompare(a.last_at));
}
export const LEVELS = { high: "À rappeler vite", mid: "À rappeler", low: "Peut attendre" };
