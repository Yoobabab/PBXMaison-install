/**
 * Bouclier anti-arnaque collectif, côté PBX :
 *   - liste des numéros d'arnaque partagée par le portail (signalée par au moins 2 PBX Callikoe, ou bloquée par IRT),
 *     récupérée chaque heure ; les contacts de l'annuaire ne sont jamais filtrés ;
 *   - sur un appel entrant d'un de ces numéros : nom affiché « ARNAQUE? … » (par défaut) ou appel refusé ;
 *   - alerte « numéro usurpé » : pic d'appels de numéros inconnus sur une SDA (les gens rappellent un numéro qu'on a usurpé).
 * Fonctions pures testées dans console/test/shield.test.mjs.
 */
import { UserError } from "./users.mjs";
import { sameNumberKey } from "./callback.mjs";

export const DEFAULT_SHIELD = { enabled: true, mode: "mark", spoof_alert: true };
export const SHIELD_MODES = { mark: "Afficher « ARNAQUE? » devant le nom", block: "Refuser l'appel" };
export const SHIELD_REASONS = { scam: "Arnaque", spam: "Démarchage abusif", spoof: "Faux conseiller (banque, impôts…)", other: "Autre" };

export function validateShield(input, cur = DEFAULT_SHIELD) {
  const s = { ...DEFAULT_SHIELD, ...cur };
  if (input.enabled !== undefined) s.enabled = !!input.enabled;
  if (input.spoof_alert !== undefined) s.spoof_alert = !!input.spoof_alert;
  if (input.mode !== undefined) {
    if (!SHIELD_MODES[input.mode]) throw new UserError("Choix inconnu.", "mode");
    s.mode = input.mode;
  }
  return s;
}

export const shieldGlobals = (s) => [`SHIELD_MODE = ${s.enabled ? s.mode : "off"}`];

/**
 * Contexte [shield] : un numéro par ligne, sous les formes reçues de l'opérateur (0612345678, 33612345678, +33…).
 * numbers : liste du portail ; contacts : clés (9 derniers chiffres) des numéros de l'annuaire, jamais filtrés.
 */
export function buildShieldDialplan(numbers = [], contacts = new Set()) {
  const L = ["", "; Bouclier anti-arnaque collectif (liste du portail Callikoe) — écrit par la console", "[shield]"];
  const seen = new Set();
  for (const n of numbers) {
    if (!/^\d{8,15}$/.test(n) || contacts.has(sameNumberKey(n))) continue;
    const forms = /^0[1-9]\d{8}$/.test(n) ? [n, `33${n.slice(1)}`] : [n];
    for (const f of forms) if (!seen.has(f)) { seen.add(f); L.push(`exten => ${f},1,Return()`); }
  }
  L.push("");
  return L.join("\n");
}

/**
 * Numéro usurpé : sur chaque SDA, appelants inconnus (ni annuaire, ni appelés ou eus au téléphone avant) de la dernière heure,
 * comparés à la moyenne des 4 semaines d'avant à la même heure. Alerte si ≥ minCallers et ≥ factor × la normale.
 * calls : journal (summarize) des 29 derniers jours.
 */
export function spoofSignals(calls, { now = Date.now(), contacts = new Set(), minCallers = 10, factor = 4, tz = "Europe/Paris" } = {}) {
  const hour = 3600_000, start = now - hour;
  const keyOf = (c) => sameNumberKey(c.direction === "in" ? c.from.number : c.direction === "out" ? c.to.number : "");
  const firstSeen = new Map();
  for (const c of [...calls].sort((a, b) => a.start.localeCompare(b.start))) { const k = keyOf(c); if (k.length >= 9 && !firstSeen.has(k)) firstSeen.set(k, c.start); }
  const localHour = (ms) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms)));
  const h0 = localHour(now - hour / 2);
  const recent = new Map(), base = new Map();
  for (const c of calls) {
    if (c.direction !== "in" || !c.did) continue;
    const k = keyOf(c), t = Date.parse(c.start);
    if (k.length < 9 || contacts.has(k) || firstSeen.get(k) !== c.start) continue;   // seulement la toute première fois qu'on entend ce numéro
    if (t >= start && t <= now) { if (!recent.has(c.did)) recent.set(c.did, new Set()); recent.get(c.did).add(k); }
    else if (t < start && t >= now - 29 * 24 * hour && localHour(t) === h0) base.set(c.did, (base.get(c.did) || 0) + 1);
  }
  const out = [];
  for (const [did, set] of recent) {
    const usual = (base.get(did) || 0) / 28;
    if (set.size >= minCallers && set.size >= factor * Math.max(1, usual)) out.push({ did, callers: set.size, usual: Math.round(usual * 10) / 10 });
  }
  return out;
}
