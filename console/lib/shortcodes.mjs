/**
 * Codes raccourcis composés depuis un poste (parcage, interception, statut, files, messagerie, interphone…).
 * Les codes sont modifiables dans la console ; le contexte [shortcodes] est inclus dans [from-internal].
 * Fonctions pures, testées dans console/test/shortcodes.test.mjs.
 */
import { UserError } from "./users.mjs";

/** id → [libellé, groupe, code par défaut, suffixe composé après le code (aide)] */
export const SHORTCODES = {
  park: ["Parquer l'appel en cours (transfert vers ce code)", "Appels", "*0", ""],
  unpark: ["Reprendre un appel parqué (place 1 à 9)", "Appels", "*1", "place"],
  pickup: ["Intercepter un appel qui sonne sur un poste", "Appels", "**", "poste"],
  pickup_any: ["Intercepter n'importe quel appel qui sonne", "Appels", "*8", ""],
  hide_cid: ["Masquer son numéro pour un appel", "Appels", "*5", "numéro"],
  intercom: ["Interphone (le poste décroche tout seul)", "Appels", "*9", "poste"],
  echo: ["Test d'écho (micro et haut-parleur)", "Appels", "*43", ""],
  vm_own: ["Écouter sa messagerie vocale", "Messagerie", "*97", ""],
  vm_any: ["Écouter une autre boîte (numéro + code)", "Messagerie", "*98", ""],
  vm_direct: ["Laisser un message directement dans une boîte", "Messagerie", "*99", "poste"],
  st_available: ["Statut : disponible", "Statut", "*30", ""],
  st_away: ["Statut : absent", "Statut", "*31", ""],
  st_dnd: ["Statut : ne pas déranger", "Statut", "*32", ""],
  fwd_number: ["Renvoyer tous ses appels vers un numéro", "Renvois", "*21", "numéro"],
  fwd_vm: ["Renvoyer tous ses appels vers sa messagerie", "Renvois", "*22", ""],
  fwd_off: ["Annuler son renvoi", "Renvois", "#21", ""],
  std_close: ["Fermer le standard (rôle Standardiste)", "Standard", "*80", ""],
  std_open: ["Rouvrir le standard (rôle Standardiste)", "Standard", "*81", ""],
  std_forward: ["Renvoyer le standard vers un numéro (rôle Standardiste)", "Standard", "*82", "numéro"],
  q_login: ["Se connecter à toutes ses files d'attente", "Files d'attente", "*62", ""],
  q_logout: ["Se déconnecter de toutes ses files d'attente", "Files d'attente", "*63", ""],
};

export function defaultShortcodes() {
  return Object.fromEntries(Object.entries(SHORTCODES).map(([k, v]) => [k, v[2]]));
}

/** Valide les codes : *, # et chiffres, pas de doublon, pas de préfixe d'un autre code à suffixe, pas de numéro d'urgence. */
export function validateShortcodes(input, current = defaultShortcodes()) {
  const out = { ...defaultShortcodes(), ...current };
  for (const k of Object.keys(SHORTCODES)) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).replace(/\s/g, "");
    if (!/^[*#][0-9*#]{0,4}$/.test(v)) throw new UserError(`${SHORTCODES[k][0]} : le code commence par * ou # (5 caractères au plus).`, k);
    out[k] = v;
  }
  const seen = new Map();
  for (const [k, v] of Object.entries(out)) {
    if (seen.has(v)) throw new UserError(`Le code ${v} est utilisé deux fois (${SHORTCODES[seen.get(v)][0]} et ${SHORTCODES[k][0]}).`, k);
    seen.set(v, k);
  }
  // Un code avec suffixe ne doit pas être le début d'un autre code (ambiguïté à la numérotation)
  for (const [k, v] of Object.entries(out)) {
    if (!SHORTCODES[k][3]) continue;
    const len = { place: 1, poste: 3 }[SHORTCODES[k][3]];
    for (const [k2, v2] of Object.entries(out)) {
      const rest = v2.slice(v.length);
      const clash = v2.startsWith(v) && (rest === "" || (/^\d+$/.test(rest) && (!len || rest.length === len)));
      if (k2 !== k && clash) throw new UserError(`Le code ${v2} (${SHORTCODES[k2][0]}) commence comme ${v} (${SHORTCODES[k][0]}).`, k2);
    }
  }
  return out;
}

/** Échappe un code pour un motif Asterisk (* et # sont littéraux, il suffit d'éviter les lettres de motif). */
const lit = (c) => c;

/** Contexte [shortcodes], inclus dans [from-internal]. */
export function buildShortcodesDialplan(c) {
  const SRC = "${CUT(CUT(CHANNEL(name),/,2),-,1)}";
  const L = ["", "; Codes raccourcis — écrit par la console web", "[shortcodes]"];
  L.push(`exten => ${lit(c.park)},1,NoOp(Parcage)`, " same => n,Park(default)", " same => n,Hangup()");
  L.push(`exten => _${lit(c.unpark)}[1-9],1,ParkedCall(default,70\${EXTEN:${c.unpark.length}})`, " same => n,Hangup()");
  L.push(`exten => _${lit(c.pickup)}XXX,1,Pickup(\${EXTEN:${c.pickup.length}}@PICKUPMARK)`, " same => n,Hangup()");
  L.push(`exten => ${lit(c.pickup_any)},1,Pickup()`, " same => n,Hangup()");
  L.push(`exten => _${lit(c.hide_cid)}X.,1,Set(CALLERID(pres)=prohib)`, ` same => n,Goto(from-internal,\${EXTEN:${c.hide_cid.length}},1)`);
  L.push(`exten => _${lit(c.intercom)}XXX,1,Set(T=\${EXTEN:${c.intercom.length}})`,
    " same => n,GotoIf($[${DIALPLAN_EXISTS(users,${T},1)} = 0]?bad)",
    " same => n,Dial(PJSIP/${T}&PJSIP/${T}-web,30,b(page-headers^s^1))", " same => n,Hangup()",
    " same => n(bad),Playback(pbx-invalid)", " same => n,Hangup()");
  L.push(`exten => ${lit(c.echo)},1,Answer()`, " same => n,Playback(demo-echotest)", " same => n,Echo()", " same => n,Hangup()");
  L.push(`exten => ${lit(c.vm_own)},1,Answer()`, " same => n,GotoIf(${DIALPLAN_EXISTS(vm-access,${CHANNEL(endpoint)},1)}?vm-access,${CHANNEL(endpoint)},1)",
    " same => n,Playback(ss-noservice)", " same => n,Hangup()");
  L.push(`exten => ${lit(c.vm_any)},1,Answer()`, " same => n,VoiceMailMain(@default)", " same => n,Hangup()");
  L.push(`exten => _${lit(c.vm_direct)}XXX,1,Answer()`, ` same => n,VoiceMail(\${EXTEN:${c.vm_direct.length}}@default,u)`, " same => n,Hangup()");
  // Statut : noté dans la base Asterisk, la console l'applique (renvois, groupes) dans les secondes qui suivent
  for (const [k, st] of [["st_available", "available"], ["st_away", "away"], ["st_dnd", "dnd"]]) {
    L.push(`exten => ${lit(c[k])},1,Answer()`, ` same => n,Set(DB(callikoe_status/${SRC})=${st})`, ` same => n,Set(DEVICE_STATE(Custom:dnd${SRC})=${st === "available" ? "NOT_INUSE" : "INUSE"})`, " same => n,Wait(0.5)", " same => n,Playback(beep)", " same => n,Hangup()");
  }
  // Touche « Statut » du téléphone (BLF sur status<poste> ; pas de x, z ou n dans le préfixe : Asterisk les lit comme des jokers) : voyant allumé si l'utilisateur n'est pas disponible, appui = bascule
  L.push("exten => _statusXXX,1,Answer()", // le voyant (hint) est déclaré par poste dans [users-hints]
    ` same => n,GotoIf($["${SRC}" != "\${EXTEN:6}"]?deny)`,
    " same => n,Set(NEW=${IF($[\"${DEVICE_STATE(Custom:dnd${EXTEN:6})}\" = \"NOT_INUSE\"]?dnd:available)})",
    " same => n,Set(DB(callikoe_status/${EXTEN:6})=${NEW})",
    " same => n,Set(DEVICE_STATE(Custom:dnd${EXTEN:6})=${IF($[\"${NEW}\" = \"available\"]?NOT_INUSE:INUSE)})",
    " same => n,Wait(0.5)", " same => n,Playback(beep)", " same => n,Hangup()",
    " same => n(deny),Playback(pbx-invalid)", " same => n,Hangup()");
  // Renvoi immédiat : noté dans la base Asterisk, la console l'applique (renvois, voyant de la touche « Renvoi ») dans les secondes qui suivent
  const fwd = (v) => [` same => n,Set(DB(callikoe_fwd/${SRC})=${v})`, " same => n,Wait(0.5)", " same => n,Playback(beep)", " same => n,Hangup()"];
  L.push(`exten => _${lit(c.fwd_number)}0[1-79]XXXXXXXX,1,Answer()`, ...fwd(`num:\${EXTEN:${c.fwd_number.length}}`));
  L.push(`exten => ${lit(c.fwd_vm)},1,Answer()`, ...fwd("vm"));
  L.push(`exten => ${lit(c.fwd_off)},1,Answer()`, ...fwd("off"));
  // Touche « Renvoi » (BLF sur fwd<poste>) : appui = active le dernier renvoi utilisé, ou l'annule
  L.push("exten => _fwdX.,1,Answer()", ` same => n,GotoIf($["${SRC}" != "\${EXTEN:3}"]?deny)`,
    " same => n,Set(DB(callikoe_fwd/${EXTEN:3})=toggle)",
    " same => n,Set(DEVICE_STATE(Custom:fwd${EXTEN:3})=${IF($[\"${DEVICE_STATE(Custom:fwd${EXTEN:3})}\" = \"NOT_INUSE\"]?INUSE:NOT_INUSE)})",
    " same => n,Wait(0.5)", " same => n,Playback(beep)", " same => n,Hangup()", " same => n(deny),Playback(pbx-invalid)", " same => n,Hangup()");
  // Standard (tout le PBX) : réservé aux postes du contexte [std-allow] (rôle Standardiste, Responsable, Accès console)
  L.push(`exten => ${lit(c.std_close)},1,Answer()`, " same => n,Gosub(std-set,s,1(closed))");
  L.push(`exten => ${lit(c.std_open)},1,Answer()`, " same => n,Gosub(std-set,s,1(open))");
  L.push(`exten => _${lit(c.std_forward)}0[1-79]XXXXXXXX,1,Answer()`, ` same => n,Gosub(std-set,s,1(fwd:\${EXTEN:${c.std_forward.length}}))`);
  // Touche « Standard » (BLF sur « standard ») : voyant allumé si fermé ou renvoyé ; appui = ferme, ou rouvre
  L.push("exten => standard,hint,Custom:cxstd",
    'exten => standard,1,Answer()', ' same => n,Set(CUR=${DB(callikoe/standard)})',
    ' same => n,Gosub(std-set,s,1(${IF($["${CUR}" = "" | "${CUR}" = "open"]?closed:open)}))');
  L.push(`exten => ${lit(c.q_login)},1,Answer()`, ` same => n,UnpauseQueueMember(,Local/${SRC}@queue-ring/n)`, " same => n,Playback(agent-loginok)", " same => n,Hangup()");
  L.push(`exten => ${lit(c.q_logout)},1,Answer()`, ` same => n,PauseQueueMember(,Local/${SRC}@queue-ring/n)`, " same => n,Playback(agent-loggedoff)", " same => n,Hangup()");
  L.push("", "; Change l'état du standard (ARG1 = open | closed | fwd:<numéro>) si le poste y est autorisé", "[std-set]",
    `exten => s,1,Set(LOCAL(ME)=${SRC})`,
    " same => n,GotoIf(${DIALPLAN_EXISTS(std-allow,${ME},1)}?ok)",
    " same => n,Playback(pbx-invalid)", " same => n,Hangup()",
    " same => n(ok),Set(DB(callikoe/standard)=${ARG1})", " same => n,Set(DB(callikoe/standard_by)=${ME})",
    ' same => n,Set(DEVICE_STATE(Custom:cxstd)=${IF($["${ARG1}" = "open"]?NOT_INUSE:INUSE)})',
    " same => n,Wait(0.5)", " same => n,Playback(beep)", " same => n,Hangup()");
  L.push("");
  return L.join("\n");
}

/** Liste lisible (page Codes raccourcis, aide du softphone). */
export function shortcodesList(c) {
  return Object.entries(SHORTCODES).map(([id, [label, group, def, suffix]]) => ({ id, label, group, code: c[id] || def, default: def, suffix }));
}
