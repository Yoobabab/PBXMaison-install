// Planning de la semaine (Gestion d'appels › Routages) : logique pure, sans DOM ni base.
// Utilisée par la console (écran), le softphone (responsables) et le serveur (validation, traceur, tests).
//
// Données d'un planning :
//   scenarios : [{ id, name, color }]          branches : { <id scénario> : [étapes] }
//   outside   : id du scénario hors des plages peintes
//   week      : { mon: [{ from, to, s }], … }  (semaine A ; « to » peut valoir 24:00)
//   alternate : semaines A / B en alternance   week_b : idem week   ref_monday : lundi d'une semaine A (AAAA-MM-JJ)
//   holidays_fr + holiday_scenario : jours fériés (scénario toute la journée ; vide = jour normal)
//   days      : { "AAAA-MM-JJ": { slots: [...], label } }  journées particulières (planning du mois)
//   override  : id d'un scénario forcé maintenant (vide = automatique)

export const PLAN_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const PLAN_DAY_LONG = { mon: "Lundi", tue: "Mardi", wed: "Mercredi", thu: "Jeudi", fri: "Vendredi", sat: "Samedi", sun: "Dimanche" };
export const PLAN_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#db2777", "#0891b2", "#ca8a04", "#dc2626", "#4f46e5", "#0d9488", "#65a30d", "#94a3b8"];
export const PLAN_MAX_SCENARIOS = 12;

export const planMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
export const planTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const DAY_MS = 86400_000;
const utc = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
export const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Jour de la semaine (mon…sun) d'une date AAAA-MM-JJ. */
export const weekdayOf = (ymd) => PLAN_DAYS[(new Date(utc(ymd)).getUTCDay() + 6) % 7];
/** Lundi de la semaine d'une date. */
export const mondayOf = (ymd) => ymdOf(utc(ymd) - PLAN_DAYS.indexOf(weekdayOf(ymd)) * DAY_MS);

/** Semaine B ? (alternance depuis le lundi de référence, qui est une semaine A) */
export function isWeekB(d, ymd) {
  if (!d.alternate || !d.ref_monday) return false;
  const n = Math.floor((utc(mondayOf(ymd)) - utc(d.ref_monday)) / (7 * DAY_MS));
  return ((n % 2) + 2) % 2 === 1;
}

/** Jours fériés de France métropolitaine : Map("AAAA-MM-JJ" → libellé) */
export function planHolidays(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7, mm = Math.floor((a + 11 * hh + 22 * l) / 451);
  const E = Date.UTC(year, Math.floor((hh + l - 7 * mm + 114) / 31) - 1, ((hh + l - 7 * mm + 114) % 31) + 1);
  const dd = (n) => ymdOf(E + n * DAY_MS);
  return new Map([[`${year}-01-01`, "Jour de l'an"], [dd(1), "Lundi de Pâques"], [`${year}-05-01`, "Fête du Travail"], [`${year}-05-08`, "Victoire 1945"],
    [dd(39), "Ascension"], [dd(50), "Lundi de Pentecôte"], [`${year}-07-14`, "Fête nationale"], [`${year}-08-15`, "Assomption"],
    [`${year}-11-01`, "Toussaint"], [`${year}-11-11`, "Armistice"], [`${year}-12-25`, "Noël"]]);
}

/**
 * Plages qui s'appliquent un jour donné.
 * → { slots, source: "day" | "holiday" | "a" | "b", label, whole: id de scénario toute la journée ou null }
 */
export function dayPlan(d, ymd) {
  const special = d.days?.[ymd];
  if (special) return { slots: special.slots || [], source: "day", label: special.label || "Journée particulière", whole: null };
  if (d.holidays_fr && d.holiday_scenario) {
    const hol = planHolidays(Number(ymd.slice(0, 4))).get(ymd);
    if (hol) return { slots: [], source: "holiday", label: hol, whole: d.holiday_scenario };
  }
  const b = isWeekB(d, ymd);
  const wd = weekdayOf(ymd);
  return { slots: ((b ? d.week_b : d.week) || {})[wd] || [], source: b ? "b" : "a", label: b ? "Semaine B" : d.alternate ? "Semaine A" : "Semaine type", whole: null };
}

/** Scénario appliqué à une date et une minute (0-1439). → { scenario, source, label, forced } */
export function resolvePlan(d, ymd, minute) {
  if (d.override) return { scenario: d.override, source: "override", label: "Forcé", forced: true };
  const p = dayPlan(d, ymd);
  if (p.whole) return { scenario: p.whole, source: p.source, label: p.label, forced: false };
  const hit = p.slots.find((s) => minute >= planMin(s.from) && minute < planMin(s.to));
  return { scenario: hit ? hit.s : d.outside, source: p.source, label: p.label, forced: false, slot: hit || null };
}

/** Date et minute locales d'un instant dans un fuseau. */
export function localNow(date = new Date(), tz = "Europe/Paris") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/** Peint [from, to[ avec le scénario s (null = effacer) dans une liste de plages ; renvoie une nouvelle liste triée et fusionnée. */
export function paintSlots(slots, from, to, s) {
  const cells = new Array(1440).fill(null);
  for (const x of slots || []) for (let m = planMin(x.from); m < planMin(x.to); m++) cells[m] = x.s;
  for (let m = Math.max(0, from); m < Math.min(1440, to); m++) cells[m] = s;
  return cellsToSlots(cells);
}
export function cellsToSlots(cells) {
  const out = [];
  let i = 0;
  while (i < 1440) {
    if (!cells[i]) { i++; continue; }
    let j = i;
    while (j < 1440 && cells[j] === cells[i]) j++;
    out.push({ from: planTime(i), to: j === 1440 ? "24:00" : planTime(j), s: cells[i] });
    i = j;
  }
  return out;
}

/** Résumé en texte d'une liste de plages : « 09:00-12:00 Matin Paul, 14:00-18:00 Julie » */
export function describeSlots(slots, names) {
  return (slots || []).map((x) => `${x.from}-${x.to} ${names(x.s)}`).join(", ");
}
