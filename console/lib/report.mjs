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

/** Décalage du fuseau (ms) à un instant donné */
const tzOffset = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};
/** Minuit (heure locale du PBX) d'un jour donné, en heure UTC ; gère le passage heure d'été / heure d'hiver */
const localMidnight = (y, m, d, tz) => { const g = Date.UTC(y, m, d); let t = g - tzOffset(g, tz); t = g - tzOffset(t, tz); return new Date(t); };

/** Bornes d'une période : semaine (lundi → lundi) ou mois civil, la dernière terminée ou en cours, en heure locale du PBX */
export function periodOf(kind, now = Date.now(), { previous = false, tz = "Europe/Paris" } = {}) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const y = +p.year, mo = +p.month - 1, day = +p.day, wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  if (kind === "month") {
    const m = mo - (previous ? 1 : 0);
    return { from: localMidnight(y, m, 1, tz).toISOString(), to: localMidnight(y, m + 1, 1, tz).toISOString(),
      label: new Date(Date.UTC(y, m, 1)).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }) };
  }
  const d0 = day - wd - (previous ? 7 : 0);
  const f = (dd) => { const x = new Date(Date.UTC(y, mo, dd)); const n = x.getUTCDate(); return `${n === 1 ? "1er" : n} ${x.toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" })}`; };
  return { from: localMidnight(y, mo, d0, tz).toISOString(), to: localMidnight(y, mo, d0 + 7, tz).toISOString(), label: `semaine du ${f(d0)} au ${f(d0 + 6)}` };
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

const escH = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dur = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`);
/**
 * E-mail du rapport mensuel envoyé au client, aux couleurs du partenaire (thème du serveur, ou Callikoe sans Marque blanche).
 * brand : { color, logoCid?, signature } ; synthesis : texte de l'IA (facultatif).
 */
export function monthlyReportMail({ label, stats: s, prev: p0, synthesis = "", pbxName = "", brand = {} }) {
  const p = p0 && p0.inbound ? p0 : null;   // pas de comparaison avec un mois sans appels
  const color = /^#[0-9a-f]{6}$/i.test(brand.color || "") ? brand.color : "#d8141c";
  const sign = brand.signature || "Votre installateur téléphonique";
  const ev = (cur, old, opts) => { const t = delta(cur, old, opts); return t && t !== "=" ? ` (${t} par rapport au mois précédent)` : ""; };
  const kpi = (v, l, sub = "") => `<td style="padding:14px 10px;background:#f6f7f9;border-radius:10px;text-align:center;width:25%"><div style="font-size:24px;font-weight:700;color:#1b1d24">${escH(v)}</div>
    <div style="font-size:13px;color:#626977">${escH(l)}</div>${sub ? `<div style="font-size:12px;color:#8a90a0;margin-top:2px">${escH(sub)}</div>` : ""}</td>`;
  const maxD = Math.max(1, ...s.days.map((d) => d.calls));
  const bars = s.days.map((d) => `<tr><td style="padding:3px 10px 3px 0;font-size:13px;color:#626977;width:90px">${escH(d.name)}</td>
    <td style="padding:3px 0"><div style="height:14px;border-radius:7px;background:${color};opacity:.85;width:${Math.max(2, Math.round((d.calls / maxD) * 100))}%"></div></td>
    <td style="padding:3px 0 3px 10px;font-size:13px;color:#1b1d24;width:110px;white-space:nowrap">${d.calls} appel${d.calls > 1 ? "s" : ""}${d.missed ? ` · ${d.missed} manqué${d.missed > 1 ? "s" : ""}` : ""}</td></tr>`).join("");
  const syn = synthesis ? synthesis.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const title = `Votre standard téléphonique en ${label}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#eef0f4;padding:24px 12px"><div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">
  <div style="background:${color};padding:22px 24px;color:#fff">${brand.logoCid ? `<img src="cid:${brand.logoCid}" alt="" style="height:40px;background:#fff;border-radius:8px;padding:4px;margin-bottom:10px;display:block">` : ""}
    <div style="font-size:20px;font-weight:700">${escH(title)}</div><div style="font-size:14px;opacity:.9;margin-top:4px">${escH(pbxName)}</div></div>
  <div style="padding:22px 24px">
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px"><tr>
      ${kpi(s.inbound, "appels reçus", delta(s.inbound, p?.inbound))}${kpi(`${s.answer_rate} %`, "appels pris", delta(s.answer_rate, p?.answer_rate, { points: true }))}
      ${kpi(s.missed, "appels manqués", s.voicemail ? `dont ${s.voicemail} message${s.voicemail > 1 ? "s" : ""}` : "")}${kpi(dur(s.avg_wait), "d'attente en moyenne", "")}</tr></table>
    <h3 style="font-size:15px;margin:20px 0 8px;color:#1b1d24">Appels reçus par jour</h3><table role="presentation" style="width:100%;border-collapse:collapse">${bars}</table>
    ${s.busiest_hour !== null ? `<p style="font-size:14px;color:#1b1d24;margin:14px 0 0">Heure la plus chargée : <b>${s.busiest_hour} h – ${s.busiest_hour + 1} h</b>.${s.worst_hour ? ` C'est vers <b>${s.worst_hour.hour} h</b> que l'on perd le plus d'appels (${s.worst_hour.rate} %).` : ""}</p>` : ""}
    ${s.agents.length ? `<h3 style="font-size:15px;margin:20px 0 8px;color:#1b1d24">Appels pris par personne</h3><p style="font-size:14px;color:#1b1d24;margin:0;line-height:1.7">${s.agents.slice(0, 12).map((a) => `${escH(a.name || a.ext)} : <b>${a.answered}</b>`).join(" · ")}</p>` : ""}
    ${s.outbound ? `<p style="font-size:14px;color:#1b1d24;margin:14px 0 0">${s.outbound} appel${s.outbound > 1 ? "s" : ""} passé${s.outbound > 1 ? "s" : ""} vers l'extérieur.</p>` : ""}
    ${syn.length ? `<div style="margin:22px 0 0;padding:14px 16px;border-radius:10px;background:#f6f7f9;border-left:4px solid ${color}"><div style="font-size:15px;font-weight:700;margin-bottom:6px;color:#1b1d24">Notre analyse</div>
      ${syn.map((l) => `<p style="margin:4px 0;font-size:14px;color:#1b1d24;line-height:1.5">${escH(l)}</p>`).join("")}</div>` : ""}
  </div>
  <div style="padding:16px 24px;border-top:1px solid #e6e8ee;font-size:12px;color:#8a90a0">Rapport préparé par ${escH(sign)} · chiffres du standard ${escH(pbxName)}, du 1er au dernier jour du mois.</div></div></div>`;
  const text = [title, pbxName, "", `Appels reçus : ${s.inbound}${ev(s.inbound, p?.inbound)}`, `Appels pris : ${s.answer_rate} %${ev(s.answer_rate, p?.answer_rate, { points: true })}`,
    `Appels manqués : ${s.missed}${s.voicemail ? ` (dont ${s.voicemail} message${s.voicemail > 1 ? "s" : ""})` : ""}`, `Attente moyenne avant réponse : ${dur(s.avg_wait)}`, "",
    ...s.days.map((d) => `${d.name} : ${d.calls} appel${d.calls > 1 ? "s" : ""}, ${d.missed} manqué${d.missed > 1 ? "s" : ""}`), ...(syn.length ? ["", "Notre analyse :", ...syn] : []), "", `Rapport préparé par ${sign}.`].join("\n");
  return { subject: title + (pbxName ? ` — ${pbxName}` : ""), html, text };
}
