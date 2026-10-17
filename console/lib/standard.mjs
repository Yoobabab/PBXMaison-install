/**
 * Standard du PBX : ouvert, fermé ou renvoyé vers un numéro, pour tous les numéros (sauf les SDA directes des utilisateurs
 * et les numéros exclus). Basculé depuis un poste (touche « Standard », *80 / *81 / *82), le softphone, l'appli ou la console.
 *
 * L'état vit dans la base d'Asterisk (callikoe/standard = open | closed | fwd:<numéro>) : il s'applique tout de suite, sans
 * recharger le plan de numérotation. La console le recopie dans ses réglages (qui, depuis quand) et règle la destination « fermé ».
 * Fonctions pures, testées dans console/test/standard.test.mjs.
 */
import { validateDest, destApps } from "./callflow.mjs";
import { UserError, nationalNumber } from "./users.mjs";

export function defaultStandard() {
  return { closed_dest: { type: "hangup", target: "" }, skip_dids: [], state: "open", target: "", since: null, by: "" };
}
/** Valeur de la base Asterisk → { state, target } */
export function parseState(v) {
  const s = String(v || "").trim();
  if (s === "closed") return { state: "closed", target: "" };
  const m = /^fwd:(0\d{9})$/.exec(s);
  if (m) return { state: "forward", target: m[1] };
  return { state: "open", target: "" };
}
export const stateValue = (st) => st.state === "closed" ? "closed" : st.state === "forward" ? `fwd:${st.target}` : "open";

/** Numéro de renvoi du standard : national, pas surtaxé, pas d'urgence */
export function forwardNumber(input) {
  const n = nationalNumber(input, "33");
  if (!n || !/^0[1-79]\d{8}$/.test(n)) throw new UserError("Numéro de renvoi : numéro français à 10 chiffres (ex. 06 12 34 56 78), pas de numéro surtaxé.", "target");
  return n;
}
/** Changement d'état demandé (console, softphone, appli) */
export function validateState(input) {
  const state = String(input?.state || "");
  if (state === "open" || state === "closed") return { state, target: "" };
  if (state === "forward") return { state, target: forwardNumber(input.target) };
  throw new UserError("État du standard inconnu.", "state");
}
/** Réglages (console › Gestion d'appels › Standard) : destination quand le standard est fermé, numéros non concernés */
export function validateConfig(input, current, ctx) {
  const out = { ...defaultStandard(), ...current };
  if (input.closed_dest !== undefined) out.closed_dest = validateDest(input.closed_dest, ctx, "closed_dest");
  if (input.skip_dids !== undefined) {
    if (!Array.isArray(input.skip_dids) || input.skip_dids.length > 200) throw new UserError("Liste de numéros invalide.", "skip_dids");
    out.skip_dids = [...new Set(input.skip_dids.map((d) => nationalNumber(d, ctx.cc || "33")).filter(Boolean))];
  }
  return out;
}

/** Plan de numérotation : destination « fermé », numéros non concernés, voyant de la touche « Standard » */
export function buildStandardDialplan(std, m) {
  const s = { ...defaultStandard(), ...std };
  const L = ["", "; Standard fermé ou renvoyé — écrit par la console web", "[standard-closed]",
    'exten => s,1,NoOp(Standard ${STD})',
    ' same => n,Set(CDR(rule)=${IF($["${STD:0:4}" = "fwd:"]?Fermé, renvoyé vers ${STD:4}:Fermé (bouton Ouvert/Fermé))})',
    ' same => n,GotoIf($["${STD:0:4}" = "fwd:"]?fwd)'];
  destApps(s.closed_dest, m).forEach((a) => L.push(` same => n,${a}`));
  L.push(" same => n,Hangup()", ' same => n(fwd),Goto(user-external,${STD:4},1)');
  L.push("", "; Numéros jamais concernés par la fermeture du standard", "[standard-skip]");
  for (const d of s.skip_dids) L.push(`exten => ${d},1,Return()`);
  L.push("");
  return L.join("\n");
}

/** Texte lisible de l'état (console, softphone, journal) */
export function describeState(st) {
  if (st.state === "closed") return "Fermé";
  if (st.state === "forward") return `Fermé · renvoyé vers ${st.target.replace(/(\d{2})(?=\d)/g, "$1 ")}`;
  return "Ouvert";
}
