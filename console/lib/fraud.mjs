/**
 * Anti-fraude intelligent : compare les appels sortants récents aux habitudes du PBX (30 derniers jours)
 * et signale ce qui sort de l'ordinaire, avant que la facture n'explose. Complète les plafonds fixes (Sécurité).
 *
 *   - rafale : beaucoup plus d'appels sortants dans la dernière heure que d'habitude à cette heure-là ;
 *   - heure inhabituelle : appels externes la nuit / le week-end alors que le PBX n'appelle jamais à ces heures ;
 *   - nouveau pays : premier appel vers un pays jamais appelé en 30 jours ;
 *   - balayage : un poste appelle beaucoup de numéros différents en quelques minutes (robot) ;
 *   - appel long coûteux : appel vers l'étranger ou un numéro surtaxé de plus de 20 minutes.
 * Fonction pure, testée dans console/test/fraud.test.mjs.
 */
import { numberRisk } from "./watch.mjs";

const COUNTRIES = {
  1: "États-Unis / Canada", 7: "Russie", 20: "Égypte", 27: "Afrique du Sud", 30: "Grèce", 31: "Pays-Bas", 32: "Belgique", 33: "France", 34: "Espagne", 36: "Hongrie",
  39: "Italie", 40: "Roumanie", 41: "Suisse", 43: "Autriche", 44: "Royaume-Uni", 45: "Danemark", 46: "Suède", 47: "Norvège", 48: "Pologne", 49: "Allemagne",
  51: "Pérou", 52: "Mexique", 53: "Cuba", 54: "Argentine", 55: "Brésil", 60: "Malaisie", 61: "Australie", 62: "Indonésie", 63: "Philippines", 64: "Nouvelle-Zélande",
  65: "Singapour", 66: "Thaïlande", 81: "Japon", 82: "Corée du Sud", 84: "Vietnam", 86: "Chine", 90: "Turquie", 91: "Inde", 92: "Pakistan", 212: "Maroc", 213: "Algérie",
  216: "Tunisie", 221: "Sénégal", 225: "Côte d'Ivoire", 230: "Maurice", 234: "Nigeria", 237: "Cameroun", 242: "Congo", 243: "RD Congo", 262: "La Réunion", 351: "Portugal",
  352: "Luxembourg", 353: "Irlande", 355: "Albanie", 370: "Lituanie", 371: "Lettonie", 372: "Estonie", 373: "Moldavie", 375: "Biélorussie", 377: "Monaco", 380: "Ukraine",
  381: "Serbie", 385: "Croatie", 420: "Tchéquie", 421: "Slovaquie", 590: "Guadeloupe", 594: "Guyane", 596: "Martinique", 675: "Papouasie-Nouvelle-Guinée",
  682: "Îles Cook", 870: "Satellite Inmarsat", 881: "Satellite", 882: "Réseaux internationaux", 960: "Maldives", 961: "Liban", 962: "Jordanie", 966: "Arabie saoudite",
  971: "Émirats arabes unis", 972: "Israël", 974: "Qatar",
};
/** Pays d'un numéro international (00… ou +…) : { code, name } */
export function countryOf(raw) {
  let n = String(raw || "").replace(/[\s.()-]/g, "");
  if (n.startsWith("+")) n = `00${n.slice(1)}`;
  if (!n.startsWith("00")) return null;
  const d = n.slice(2);
  for (const len of [3, 2, 1]) if (COUNTRIES[d.slice(0, len)]) return { code: d.slice(0, len), name: COUNTRIES[d.slice(0, len)] };
  return { code: d.slice(0, 3), name: `indicatif +${d.slice(0, 3)}` };
}

const hourKey = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: p.weekday, hour: Number(p.hour), weekend: /sam|dim/i.test(p.weekday) };
};

/**
 * calls : journal (summarize) des 30 derniers jours ; renvoie les signaux de la dernière heure
 * [{ key, kind, severity, text, extension, detail }] — key stable pour ne signaler qu'une fois.
 */
export function fraudSignals(calls, { now = Date.now(), cc = "33", tz = "Europe/Paris" } = {}) {
  const out = calls.filter((c) => c.direction === "out" && c.to?.number);
  const HOUR = 3600_000, recentFrom = now - HOUR;
  const recent = out.filter((c) => Date.parse(c.start) >= recentFrom);
  const history = out.filter((c) => Date.parse(c.start) < recentFrom && Date.parse(c.start) >= now - 30 * 24 * HOUR);
  const signals = [];
  const slot = new Date(Math.floor(now / HOUR) * HOUR).toISOString().slice(0, 13);
  const days = Math.max(1, Math.min(30, history.length ? (recentFrom - Math.min(...history.map((c) => Date.parse(c.start)))) / (24 * HOUR) : 1));

  // 1. Rafale : comparé à la moyenne de cette heure de la journée
  const h = hourKey(new Date(now).toISOString(), tz);
  const sameHour = history.filter((c) => hourKey(c.start, tz).hour === h.hour).length / days;
  const limit = Math.max(15, Math.ceil(sameHour * 5));
  if (recent.length >= limit) signals.push({ key: `burst:${slot}`, kind: "burst", severity: "critical",
    text: `${recent.length} appels sortants dans la dernière heure, au lieu de ${Math.round(sameHour * 10) / 10} en moyenne à cette heure-ci.`, extension: "", detail: { count: recent.length, usual: sameHour } });

  // 2. Heure inhabituelle : nuit (22 h – 6 h) ou week-end, alors que le PBX n'appelle presque jamais à ces moments-là
  for (const [name, test, label] of [["night", (k) => k.hour >= 22 || k.hour < 6, "en pleine nuit"], ["weekend", (k) => k.weekend, "le week-end"]]) {
    const odd = (c) => test(hourKey(c.start, tz));
    const oddRecent = recent.filter(odd);
    const share = history.length ? history.filter(odd).length / history.length : 0;
    if (oddRecent.length < 3 || share >= 0.03) continue;
    signals.push({ key: `odd:${name}:${slot}`, kind: "odd_hours", severity: "critical",
      text: `${oddRecent.length} appels sortants ${label} (${[...new Set(oddRecent.map((c) => c.from.ext).filter(Boolean))].map((e) => `poste ${e}`).join(", ") || "postes inconnus"}), alors que ce PBX n'appelle presque jamais à ce moment-là.`,
      extension: oddRecent[0].from.ext || "", detail: { numbers: [...new Set(oddRecent.map((c) => c.to.number))].slice(0, 10) } });
  }

  // 3. Nouveau pays
  const known = new Set(history.map((c) => countryOf(c.to.number)?.code).filter(Boolean));
  const seenNow = new Map();
  for (const c of recent) { const k = countryOf(c.to.number); if (k && k.code !== cc && !known.has(k.code) && !seenNow.has(k.code)) seenNow.set(k.code, { k, c }); }
  for (const [code, { k, c }] of seenNow) signals.push({ key: `country:${code}:${slot.slice(0, 10)}`, kind: "new_country", severity: "warning",
    text: `Premier appel vers ${k.name} (+${code}) depuis 30 jours : ${c.to.number}, poste ${c.from.ext || "?"}.`, extension: c.from.ext || "", detail: { number: c.to.number } });

  // 4. Balayage : ≥ 8 numéros différents en 10 minutes depuis un même poste
  const byExt = new Map();
  for (const c of recent) { if (!c.from.ext) continue; if (!byExt.has(c.from.ext)) byExt.set(c.from.ext, []); byExt.get(c.from.ext).push(c); }
  for (const [ext, list] of byExt) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < list.length; i++) {
      const win = list.filter((c) => Date.parse(c.start) >= Date.parse(list[i].start) && Date.parse(c.start) < Date.parse(list[i].start) + 10 * 60_000);
      const distinct = new Set(win.map((c) => c.to.number)).size;
      if (distinct >= 8) { signals.push({ key: `scan:${ext}:${slot}`, kind: "scan", severity: "critical",
        text: `Le poste ${ext} a appelé ${distinct} numéros différents en 10 minutes : comportement de robot (compte du poste piraté ?).`, extension: ext, detail: { distinct } }); break; }
    }
  }

  // 5. Appel long vers l'étranger ou un numéro surtaxé
  // (le journal n'a l'appel qu'une fois fini : on regarde les appels terminés dans la dernière heure, même commencés bien avant)
  for (const c of out.filter((x) => Date.parse(x.start) + (x.duration || x.talk || 0) * 1000 >= recentFrom)) {
    const risk = numberRisk(c.to.number, cc);
    if ((risk === "intl" || risk === "premium") && (c.talk || 0) >= 20 * 60) signals.push({ key: `long:${c.id}`, kind: "long_costly", severity: "warning",
      text: `Appel de ${Math.round(c.talk / 60)} min vers ${risk === "intl" ? countryOf(c.to.number)?.name || "l'étranger" : "un numéro surtaxé"} (${c.to.number}) depuis le poste ${c.from.ext || "?"}.`, extension: c.from.ext || "", detail: { number: c.to.number, talk: c.talk } });
  }
  return signals;
}
export const FRAUD_KINDS = { burst: "Rafale d'appels", odd_hours: "Heure inhabituelle", new_country: "Nouveau pays", scan: "Balayage de numéros", long_costly: "Appel long coûteux" };
