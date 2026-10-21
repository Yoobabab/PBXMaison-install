/**
 * Chiffres d'une période (bilan de la semaine du Superviseur, rapport mensuel au client) à partir du journal des appels.
 * Fonctions pures, testées dans console/test/report.test.mjs ; la synthèse en français est demandée à l'IA à part.
 */
import { missedCallers } from "./callback.mjs";

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const local = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) };
};

/** Bornes d'une période : semaine (lundi → lundi) ou mois civil, la dernière terminée ou en cours */
export function periodOf(kind, now = Date.now(), { previous = false } = {}) {
  const d = new Date(now);
  if (kind === "month") {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() - (previous ? 1 : 0);
    return { from: new Date(Date.UTC(y, m, 1)).toISOString(), to: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
      label: new Date(Date.UTC(y, m, 1)).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }) };
  }
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - (previous ? 7 : 0)));
  const end = new Date(monday.getTime() + 7 * 86400_000);
  const f = (x) => x.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
  return { from: monday.toISOString(), to: end.toISOString(), label: `semaine du ${f(monday)} au ${f(new Date(end.getTime() - 86400_000))}` };
}

/** Chiffres d'une période. calls : journal (summarize) qui couvre au moins la période ; names : poste → nom */
export function periodStats(calls, { from, to, tz = "Europe/Paris", names = new Map(), now = Date.now() } = {}) {
  const inP = calls.filter((c) => c.start >= from && c.start < to);
  const inbound = inP.filter((c) => c.direction === "in");
  const answered = inbound.filter((c) => c.status === "answered");
  const missed = inbound.filter((c) => c.status !== "answered");
  const outbound = inP.filter((c) => c.direction === "out");
  const wait = answered.map((c) => Math.max(0, (c.duration || 0) - (c.talk || 0)));
  const hours = Array.from({ length: 24 }, () => ({ calls: 0, missed: 0 }));
  const days = DAYS.map((name) => ({ name, calls: 0, missed: 0 }));
  for (const c of inbound) {
    const k = local(c.start, tz);
    hours[k.hour].calls++; days[k.day].calls++;
    if (c.status !== "answered") { hours[k.hour].missed++; days[k.day].missed++; }
  }
  const agents = new Map();
  for (const c of answered) {
    if (!c.answered_by) continue;
    const a = agents.get(c.answered_by) || { ext: c.answered_by, name: names.get(c.answered_by) || "", answered: 0, talk: 0 };
    a.answered++; a.talk += c.talk || 0; agents.set(c.answered_by, a);
  }
  const busiest = hours.map((h, i) => ({ ...h, hour: i })).filter((h) => h.calls).sort((a, b) => b.calls - a.calls)[0] || null;
  const worst = hours.map((h, i) => ({ ...h, hour: i, rate: pct(h.missed, h.calls) })).filter((h) => h.calls >= 3).sort((a, b) => b.rate - a.rate || b.missed - a.missed)[0] || null;
  // Appelants de la période restés sans réponse, et toujours pas rappelés aujourd'hui
  const stillToCall = missedCallers(calls.filter((c) => c.start >= from), { now, tz }).filter((x) => x.first_at >= from && x.first_at < to).length;
  return {
    from, to,
    inbound: inbound.length, answered: answered.length, missed: missed.length, voicemail: missed.filter((c) => c.status === "voicemail").length,
    answer_rate: pct(answered.length, inbound.length),
    avg_wait: wait.length ? Math.round(wait.reduce((a, b) => a + b, 0) / wait.length) : 0, max_wait: wait.length ? Math.max(...wait) : 0,
    avg_talk: answered.length ? Math.round(answered.reduce((a, c) => a + (c.talk || 0), 0) / answered.length) : 0,
    outbound: outbound.length, outbound_answered: outbound.filter((c) => c.status === "answered").length,
    callers: new Set(inbound.map((c) => c.from.number).filter(Boolean)).size,
    hours, days, busiest_hour: busiest?.hour ?? null, worst_hour: worst && worst.rate > 0 ? { hour: worst.hour, rate: worst.rate, missed: worst.missed } : null,
    agents: [...agents.values()].sort((a, b) => b.answered - a.answered), not_called_back: stillToCall,
  };
}

/** Évolution d'un chiffre par rapport à la période d'avant : « +12 % », « −3 points » */
export function delta(cur, prev, { points = false } = {}) {
  if (prev === undefined || prev === null) return "";
  if (points) { const d = cur - prev; return d ? `${d > 0 ? "+" : "−"}${Math.abs(d)} pt${Math.abs(d) > 1 ? "s" : ""}` : "="; }
  if (!prev) return cur ? "nouveau" : "";
  const d = Math.round(((cur - prev) / prev) * 100);
  return d ? `${d > 0 ? "+" : "−"}${Math.abs(d)} %` : "=";
}

/** Données envoyées à l'IA pour la synthèse (chiffres seulement, aucun numéro de téléphone) */
export function reportInput(kind, label, cur, prev, voicemailSummaries = []) {
  const brief = (s) => s && { appels_recus: s.inbound, repondus: s.answered, taux_reponse: `${s.answer_rate} %`, manques: s.missed, messages: s.voicemail,
    attente_moyenne_s: s.avg_wait, attente_max_s: s.max_wait, duree_moyenne_s: s.avg_talk, appels_emis: s.outbound, appelants_differents: s.callers,
    heure_la_plus_chargee: s.busiest_hour !== null ? `${s.busiest_hour} h` : null, heure_ou_on_perd_le_plus: s.worst_hour ? `${s.worst_hour.hour} h (${s.worst_hour.rate} % perdus)` : null,
    jours: s.days.map((d) => `${d.name} ${d.calls} appels / ${d.missed} manqués`), personnes: s.agents.map((a) => `${a.name || a.ext} : ${a.answered} appels pris`),
    appelants_toujours_pas_rappeles: s.not_called_back };
  return JSON.stringify({ type: kind === "month" ? "rapport mensuel" : "bilan de la semaine", periode: label, chiffres: brief(cur), periode_precedente: brief(prev),
    sujets_des_messages_vocaux: voicemailSummaries.slice(0, 40) });
}
