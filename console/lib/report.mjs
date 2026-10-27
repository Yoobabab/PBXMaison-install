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
  if (kind === "day") {
    const d = day - (previous ? 1 : 0);
    const x = new Date(Date.UTC(y, mo, d));
    return { from: localMidnight(y, mo, d, tz).toISOString(), to: localMidnight(y, mo, d + 1, tz).toISOString(),
      label: x.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) };
  }
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

// ------------------------------------------------------------------ Rapports détaillés planifiés (jour, semaine, mois)
export const REPORT_SECTIONS = { summary: "Chiffres clés", users: "Par utilisateur", dids: "Par numéro appelé (SDA)", missed: "Liste des appels manqués", hours: "Appels par heure" };
export const REPORT_FREQ = { day: "Chaque jour (la veille)", week: "Chaque semaine (le lundi, semaine écoulée)", month: "Chaque mois (le 1er, mois écoulé)" };
const fmtNum = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");

/** Planification validée : { id, name, frequency, hour, recipients[], sections{}, csv } */
export function validateSchedule(input, id) {
  const freq = REPORT_FREQ[input?.frequency] ? input.frequency : "week";
  const hour = Math.min(23, Math.max(0, Math.round(Number(input?.hour ?? 8)) || 0));
  const recipients = [...new Set((Array.isArray(input?.recipients) ? input.recipients : String(input?.recipients || "").split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
  for (const r of recipients) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r)) throw Object.assign(new Error(`Adresse invalide : ${r}`), { field: "recipients", user: true });
  if (!recipients.length) throw Object.assign(new Error("Indique au moins un destinataire."), { field: "recipients", user: true });
  const sections = Object.fromEntries(Object.keys(REPORT_SECTIONS).map((k) => [k, input?.sections?.[k] !== undefined ? !!input.sections[k] : true]));
  if (!Object.values(sections).some(Boolean) && !input?.csv) throw Object.assign(new Error("Choisis au moins une partie du rapport."), { field: "sections", user: true });
  return { id, name: String(input?.name || "").replace(/[<>\r\n]/g, " ").trim().slice(0, 60) || `Rapport ${REPORT_FREQ[freq].split(" (")[0].toLowerCase()}`,
    frequency: freq, hour, recipients, sections, csv: input?.csv !== undefined ? !!input.csv : true, enabled: input?.enabled !== undefined ? !!input.enabled : true };
}
/** Le rapport est-il à envoyer maintenant ? (heure locale du PBX) → clé de la période, sinon null */
export function scheduleDue(sch, now = Date.now(), tz = "Europe/Paris") {
  if (!sch.enabled) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  if (Number(p.hour) < sch.hour) return null;
  if (sch.frequency === "week" && p.weekday !== "Mon") return null;
  if (sch.frequency === "month" && Number(p.day) !== 1) return null;
  const per = periodOf(sch.frequency, now, { previous: true, tz });
  return per.from;
}

/** Chiffres par utilisateur et par SDA, appels manqués d'une période (calls : journal summarize) */
export function detailedStats(calls, { from, to, names = new Map() }) {
  const inP = calls.filter((c) => c.start >= from && c.start < to);
  const users = new Map();
  const U = (ext) => { if (!users.has(ext)) users.set(ext, { ext, name: names.get(ext) || "", answered: 0, talk: 0, outbound: 0, out_talk: 0, internal: 0 }); return users.get(ext); };
  const dids = new Map();
  for (const c of inP) {
    if (c.direction === "in") {
      if (c.answered_by) { const u = U(c.answered_by); u.answered++; u.talk += c.talk || 0; }
      const k = c.did || c.to.number || "?";
      const d = dids.get(k) || { did: k, calls: 0, answered: 0, missed: 0 };
      d.calls++; c.status === "answered" ? d.answered++ : d.missed++; dids.set(k, d);
    } else if (c.direction === "out" && c.from.ext) { const u = U(c.from.ext); u.outbound++; u.out_talk += c.talk || 0; }
    else if (c.direction === "internal" && c.from.ext) U(c.from.ext).internal++;
  }
  const missed = inP.filter((c) => c.direction === "in" && c.status !== "answered").sort((a, b) => a.start.localeCompare(b.start))
    .map((c) => ({ at: c.start, from: c.from.number, name: c.from.name || "", did: c.did, status: c.status }));
  return { users: [...users.values()].sort((a, b) => (b.answered + b.outbound) - (a.answered + a.outbound) || a.ext.localeCompare(b.ext)),
    dids: [...dids.values()].sort((a, b) => b.calls - a.calls), missed };
}
const STATUS_FR = { answered: "Répondu", missed: "Manqué", voicemail: "Messagerie", busy: "Occupé", failed: "Sans réponse" };
const DIR_FR = { in: "Entrant", out: "Sortant", internal: "Interne" };
/** CSV (Excel, « ; ») de tous les appels de la période */
export function callsCsv(calls, { from, to, tz = "Europe/Paris", names = new Map() }) {
  const q = (v) => { const x = String(v ?? ""); return /[";\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const dt = (iso) => new Date(iso).toLocaleString("fr-FR", { timeZone: tz });
  const rows = calls.filter((c) => c.start >= from && c.start < to).sort((a, b) => a.start.localeCompare(b.start)).map((c) => [dt(c.start), DIR_FR[c.direction] || c.direction,
    c.direction === "out" ? `${c.from.ext} ${names.get(c.from.ext) || ""}`.trim() : fmtNum(c.from.number), c.from.name || "", c.direction === "in" ? fmtNum(c.did || c.to.number) : fmtNum(c.to.number),
    STATUS_FR[c.status] || c.status, c.answered_by ? `${c.answered_by} ${names.get(c.answered_by) || ""}`.trim() : "", c.talk || 0]);
  return "\uFEFF" + [["Date", "Sens", "De", "Nom de l'appelant", "Vers", "Résultat", "Répondu par", "Durée de conversation (s)"], ...rows].map((r) => r.map(q).join(";")).join("\r\n") + "\r\n";
}
/** E-mail du rapport détaillé */
export function detailedReportMail({ name, label, stats: s, detail: d, sections, pbxName = "", brand = {}, tz = "Europe/Paris" }) {
  const color = /^#[0-9a-f]{6}$/i.test(brand.color || "") ? brand.color : "#d8141c";
  const th = (t) => `<th style="text-align:left;padding:6px 8px;font-size:12px;color:#626977;border-bottom:1px solid #e6e8ee">${escH(t)}</th>`;
  const td = (t, b) => `<td style="padding:6px 8px;font-size:13px;color:#1b1d24;border-bottom:1px solid #f0f1f4${b ? ";font-weight:700" : ""}">${escH(t)}</td>`;
  const table = (heads, rows) => `<table role="presentation" style="width:100%;border-collapse:collapse"><tr>${heads.map(th).join("")}</tr>${rows.join("")}</table>`;
  const h3 = (t) => `<h3 style="font-size:15px;margin:22px 0 8px;color:#1b1d24">${escH(t)}</h3>`;
  const kpi = (v, l) => `<td style="padding:12px 8px;background:#f6f7f9;border-radius:10px;text-align:center;width:25%"><div style="font-size:22px;font-weight:700;color:#1b1d24">${escH(v)}</div><div style="font-size:12px;color:#626977">${escH(l)}</div></td>`;
  const hm = (iso) => new Date(iso).toLocaleString("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = [];
  if (sections.summary) parts.push(`<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px"><tr>${kpi(s.inbound, "appels reçus")}${kpi(`${s.answer_rate} %`, "appels pris")}${kpi(s.missed, "manqués")}${kpi(s.outbound, "appels passés")}</tr></table>
    <p style="font-size:13px;color:#626977;margin:6px 0 0">Attente moyenne ${dur(s.avg_wait)} · durée moyenne ${dur(s.avg_talk)} · ${s.callers} appelant${s.callers > 1 ? "s" : ""} différent${s.callers > 1 ? "s" : ""}${s.not_called_back ? ` · <b>${s.not_called_back} pas encore rappelé${s.not_called_back > 1 ? "s" : ""}</b>` : ""}</p>`);
  if (sections.users && d.users.length) parts.push(h3("Par utilisateur") + table(["Poste", "Appels pris", "Temps au téléphone", "Appels passés"], d.users.map((u) => `<tr>${td(`${u.ext} ${u.name}`.trim(), true)}${td(u.answered)}${td(dur(u.talk + u.out_talk))}${td(u.outbound)}</tr>`)));
  if (sections.dids && d.dids.length) parts.push(h3("Par numéro appelé") + table(["Numéro", "Appels", "Pris", "Manqués"], d.dids.map((x) => `<tr>${td(fmtNum(x.did), true)}${td(x.calls)}${td(x.answered)}${td(x.missed)}</tr>`)));
  if (sections.hours && s.inbound) parts.push(h3("Appels reçus par heure") + table(["Heure", "Appels", "Manqués"], s.hours.map((x, i) => [x, i]).filter(([x]) => x.calls).map(([x, i]) => `<tr>${td(`${i} h – ${i + 1} h`)}${td(x.calls)}${td(x.missed)}</tr>`)));
  if (sections.missed) parts.push(h3(`Appels manqués (${d.missed.length})`) + (d.missed.length ? table(["Quand", "Appelant", "Numéro appelé", ""], d.missed.slice(0, 150).map((m) => `<tr>${td(hm(m.at))}${td(`${fmtNum(m.from) || "Masqué"}${m.name ? ` · ${m.name}` : ""}`)}${td(fmtNum(m.did))}${td(m.status === "voicemail" ? "message laissé" : "")}</tr>`))
    + (d.missed.length > 150 ? `<p style="font-size:12px;color:#8a90a0">… et ${d.missed.length - 150} autres (voir le fichier joint).</p>` : "") : '<p style="font-size:13px;color:#626977;margin:0">Aucun appel manqué.</p>'));
  const title = `${name} — ${label}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#eef0f4;padding:24px 12px"><div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">
  <div style="background:${color};padding:20px 24px;color:#fff">${brand.logoCid ? `<img src="cid:${brand.logoCid}" alt="" style="height:36px;background:#fff;border-radius:8px;padding:4px;margin-bottom:8px;display:block">` : ""}
    <div style="font-size:19px;font-weight:700">${escH(name)}</div><div style="font-size:14px;opacity:.9;margin-top:4px">${escH(label)} · ${escH(pbxName)}</div></div>
  <div style="padding:20px 24px">${parts.join("")}</div>
  <div style="padding:14px 24px;border-top:1px solid #e6e8ee;font-size:12px;color:#8a90a0">${brand.signature ? `Rapport préparé par ${escH(brand.signature)}` : "Rapport automatique du standard"}${sections.csv ? " · tous les appels dans le fichier joint (Excel)" : ""}.</div></div></div>`;
  const text = [title, pbxName, "", `Appels reçus : ${s.inbound} · pris : ${s.answer_rate} % · manqués : ${s.missed} · passés : ${s.outbound}`,
    ...(sections.users ? ["", "Par utilisateur :", ...d.users.map((u) => `${u.ext} ${u.name} : ${u.answered} pris, ${u.outbound} passés`)] : []),
    ...(sections.missed ? ["", `Appels manqués : ${d.missed.length}`, ...d.missed.slice(0, 150).map((m) => `${hm(m.at)} ${fmtNum(m.from) || "Masqué"} → ${fmtNum(m.did)}`)] : [])].join("\n");
  return { subject: title + (pbxName ? ` · ${pbxName}` : ""), html, text };
}
