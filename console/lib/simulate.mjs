/**
 * Simulateur de standard : avant d'appliquer un changement de routage, les appels entrants des 4 dernières semaines
 * sont rejoués (traceur à l'heure de chaque appel) sur la configuration actuelle et sur la nouvelle, et on compte
 * ceux qui auraient pris un autre chemin. Fonctions pures testées dans console/test/simulate.test.mjs.
 */
import { pathNow } from "./diagnose.mjs";

const STOP = new Set(["ivr", "voicemail", "groupvm", "external", "hangup", "conf", "receptionist", "ai", "none", "queue", "loop", "deep", "legacy"]);
const KEEP = new Set(["user", "group", "queue", "ivr", "voicemail", "groupvm", "external", "hangup", "conf", "receptionist", "ai", "none", "prompt", "mobile", "loop", "deep", "legacy", "info"]);

/** Chemin réellement suivi, résumé en quelques étapes : « Groupe 600 · Accueil → Messagerie de 201 · Sophie Durand » */
export function outcomeOf(root) {
  const steps = [];
  const walk = (n, depth) => {
    if (!n || depth > 12 || steps.length >= 4) return;
    if (KEEP.has(n.type) && n.title) steps.push(n.title);
    if (STOP.has(n.type)) return;   // SVI : le choix dépend de l'appelant ; messagerie, raccrocher… : fin du chemin
    // Un groupe sonne ses membres puis passe à « Sans réponse » : on ne suit que la suite
    const next = (n.children || []).filter((c) => c.node?.type !== "member");
    if (next.length) walk(next[0].node, depth + 1);
  };
  walk(pathNow(root), 0);
  return steps.join(" → ") || "Aucune destination";
}

/**
 * calls : [{ start, did, from }] ; before / after : modèles du traceur ; trace : (numéro, modèle) → { root }
 * → { total, changed, groups: [{ from, to, count, examples }] } (groupes les plus nombreux d'abord)
 */
export function simulateCalls(calls, before, after, trace, { maxExamples = 3 } = {}) {
  const groups = new Map();
  let total = 0, changed = 0, errors = 0;
  for (const c of calls) {
    if (!c.did) continue;
    const at = new Date(c.start);
    let a, b;
    try {
      a = outcomeOf(trace(c.did, { ...before, now: at }).root);
      b = outcomeOf(trace(c.did, { ...after, now: at }).root);
    } catch { errors++; continue; }
    total++;
    if (a === b) continue;
    changed++;
    const k = `${a}\u0000${b}`;
    const g = groups.get(k) || { from: a, to: b, count: 0, examples: [] };
    g.count++;
    if (g.examples.length < maxExamples) g.examples.push({ start: c.start, did: c.did, from: c.from || "" });
    groups.set(k, g);
  }
  return { total, changed, errors, groups: [...groups.values()].sort((x, y) => y.count - x.count).slice(0, 20) };
}
