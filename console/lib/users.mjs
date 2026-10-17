/**
 * Utilisateurs (postes) : validation des fiches et génération des fichiers lus par Asterisk.
 * Fonctions pures, sans base ni AMI, testées dans console/test/users.test.mjs.
 *
 *  - extensions_users.conf : un bloc par utilisateur dans [users] (sonnerie, renvois, messagerie),
 *    [did-map] (SDA attribuées à un utilisateur) et [vm-access] (*97 depuis son poste).
 *  - voicemail_users.conf  : boîtes vocales.
 */

export const STATUSES = { available: "Disponible", away: "Absent", dnd: "Ne pas déranger" };
export const DEST_TYPES = { voicemail: "Messagerie vocale", extension: "Autre utilisateur", external: "Numéro externe", hangup: "Raccrocher" };
const EMERGENCY = ["15", "17", "18", "112", "114", "115", "116000", "119", "191", "196", "197"];

export class UserError extends Error {
  constructor(message, field) { super(message); this.field = field; this.status = 400; }
}

/** Rôle d'un utilisateur du PBX : un responsable gère les plannings depuis son softphone et l'appli. */
export const USER_ROLES = { user: "Utilisateur", standard: "Pilote (ouvre et ferme tout le PBX)", manager: "Responsable (Pilote + plannings)", console: "Accès console (restreint)" };
/** Responsable : modifie les plannings depuis son softphone ; « accès console » : en plus, se connecte à la console du PBX (accès restreint). */
export const isManager = (u) => ["manager", "console"].includes(u?.options?.role) && !u.options.disabled;
/** Pilote : ouvre, ferme ou renvoie tout le PBX (tout le PBX) depuis son téléphone, le softphone ou l'appli */
export const isStandardist = (u) => ["standard", "manager", "console"].includes(u?.options?.role) && !u.options.disabled;
/** Renvoi immédiat (tous les appels) : réglable par code, touche, softphone, appli ou console */
export const ALWAYS_TYPES = { none: "Aucun", voicemail: "Messagerie vocale", extension: "Autre utilisateur", external: "Numéro externe" };

export function defaultUser(id) {
  return {
    id, first_name: "", last_name: "", email: "", mobile: "", outbound_cid: "", dids: [],
    status: "available",
    forwarding: {
      timeout: 20,
      always: { type: "none", target: "" },
      always_last: { type: "voicemail", target: "" },
      no_answer: { type: "voicemail", target: "" },
      busy: { type: "voicemail", target: "" },
      away: { type: "voicemail", target: "" },
      dnd: { type: "voicemail", target: "" },
    },
    options: { ring_mobile: false, accept_group_calls: true, disabled: false, block_external: false, hidden: false, role: "user" },
    voicemail: { enabled: true, pin: "", skip_pin: true },
  };
}

/** Fusionne une ligne de base (colonnes jsonb éventuellement vides) avec les valeurs par défaut. */
export function fromRow(row) {
  const d = defaultUser(row.id);
  const fw = row.forwarding || {};
  return {
    ...d,
    first_name: row.first_name || "", last_name: row.last_name || "",
    email: row.email || "", mobile: row.mobile || "", outbound_cid: row.outbound_cid || "",
    dids: row.dids || [], status: STATUSES[row.status] ? row.status : "available",
    forwarding: {
      timeout: Number(fw.timeout) || d.forwarding.timeout,
      always: { ...d.forwarding.always, ...fw.always },
      always_last: { ...d.forwarding.always_last, ...fw.always_last },
      no_answer: { ...d.forwarding.no_answer, ...fw.no_answer },
      busy: { ...d.forwarding.busy, ...fw.busy },
      away: { ...d.forwarding.away, ...fw.away },
      dnd: { ...d.forwarding.dnd, ...fw.dnd },
    },
    options: { ...d.options, ...row.options },
    voicemail: { ...d.voicemail, ...row.voicemail },
    // Ancien poste créé avant les fiches : le nom complet est dans « name »
    ...(!row.first_name && !row.last_name && row.name ? { first_name: row.name } : {}),
  };
}

export const displayName = (u) => `${u.first_name} ${u.last_name}`.trim() || `Poste ${u.id}`;

/** Numéro national (0 + chiffres) ; accepte espaces, points, +33, 0033. Renvoie "" si vide, null si invalide. */
export function nationalNumber(input, cc = "33") {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  if (!/^[+\d][\d .\-()]*$/.test(raw)) return null;
  let n = raw.replace(/[^\d+]/g, "");
  if (n.startsWith("+")) n = n.slice(1);
  else if (n.startsWith("00")) n = n.slice(2);
  else if (n.startsWith("0")) return checkNational(n, cc);
  if (n.startsWith(cc)) return checkNational(`0${n.slice(cc.length)}`, cc);
  return null; // international : pas pris en charge pour les renvois
}
function checkNational(n, cc) {
  if (cc === "33") return /^0[1-9]\d{8}$/.test(n) ? n : null;
  return /^0[1-9]\d{5,13}$/.test(n) ? n : null;
}
const isPremium = (n, cc) => cc === "33" && /^08[9]/.test(n);

const clean = (s, max = 60) => String(s ?? "").replace(/[\r\n"<>,;|\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Valide et normalise une fiche envoyée par la console.
 * @param input   données du formulaire (partielles : les champs absents gardent la valeur actuelle)
 * @param current fiche actuelle (fromRow) ou defaultUser
 * @param ctx     { extensions: Set des numéros de poste existants, didOwners: Map sda → poste, cc }
 */
export function validateUser(input, current, ctx) {
  const cc = ctx.cc || "33";
  const u = structuredClone(current);
  const set = (k, v) => { if (v !== undefined) u[k] = v; };
  set("first_name", input.first_name !== undefined ? clean(input.first_name, 40) : undefined);
  set("last_name", input.last_name !== undefined ? clean(input.last_name, 40) : undefined);
  if (!u.first_name && !u.last_name) throw new UserError("Indique au moins un prénom ou un nom.", "first_name");

  if (input.email !== undefined) {
    const e = String(input.email).trim().toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new UserError("Adresse e-mail invalide.", "email");
    u.email = e;
  }
  for (const [field, label] of [["mobile", "Mobile"], ["outbound_cid", "Numéro présenté"]]) {
    if (input[field] === undefined) continue;
    const n = nationalNumber(input[field], cc);
    if (n === null) throw new UserError(`${label} : numéro national invalide (ex. 06 12 34 56 78).`, field);
    u[field] = n;
  }
  if (input.dids !== undefined) {
    const list = Array.isArray(input.dids) ? input.dids : String(input.dids).split(/[\n,;]+/);
    const out = [];
    for (const raw of list) {
      if (!String(raw).trim()) continue;
      const n = nationalNumber(raw, cc);
      if (!n) throw new UserError(`SDA invalide : ${String(raw).trim()}`, "dids");
      const owner = ctx.didOwners?.get(n);
      if (owner && owner !== u.id) throw new UserError(/^\d+$/.test(owner) ? `La SDA ${n} est déjà attribuée au poste ${owner}.` : `La SDA ${n} est déjà utilisée par ${owner} (Gestion d'appels).`, "dids");
      if (!out.includes(n)) out.push(n);
    }
    u.dids = out;
  }
  if (input.status !== undefined) {
    if (!STATUSES[input.status]) throw new UserError("Statut inconnu.", "status");
    u.status = input.status;
  }

  if (input.options) {
    for (const k of Object.keys(u.options)) if (k !== "role" && input.options[k] !== undefined) u.options[k] = !!input.options[k];
    if (input.options.role !== undefined) {
      if (!USER_ROLES[input.options.role]) throw new UserError("Rôle inconnu.", "options.role");
      u.options.role = input.options.role;
    }
  }
  if (input.voicemail) {
    const vm = input.voicemail;
    if (vm.enabled !== undefined) u.voicemail.enabled = !!vm.enabled;
    if (vm.skip_pin !== undefined) u.voicemail.skip_pin = !!vm.skip_pin;
    if (vm.pin !== undefined) {
      const pin = String(vm.pin).trim();
      if (pin && !/^\d{4,8}$/.test(pin)) throw new UserError("Code PIN : 4 à 8 chiffres.", "voicemail.pin");
      u.voicemail.pin = pin;
    }
  }
  if (u.voicemail.enabled && !u.voicemail.pin) u.voicemail.pin = String(Math.floor(100000 + Math.random() * 900000));

  if (input.forwarding) {
    const fw = input.forwarding;
    if (fw.timeout !== undefined) {
      const t = Number(fw.timeout);
      if (!Number.isInteger(t) || t < 5 || t > 120) throw new UserError("Délai de non-réponse : 5 à 120 secondes.", "forwarding.timeout");
      u.forwarding.timeout = t;
    }
    for (const rule of ["always", "always_last", "no_answer", "busy", "away", "dnd"]) {
      if (!fw[rule]) continue;
      const type = fw[rule].type;
      // always_last : où va le renvoi immédiat quand on l'active (code, touche « Renvoi », softphone)
      if (rule === "always_last" ? (!ALWAYS_TYPES[type] || type === "none") : rule === "always" ? !ALWAYS_TYPES[type] : !DEST_TYPES[type]) throw new UserError("Destination inconnue.", `forwarding.${rule}`);
      let target = "";
      if (type === "extension") {
        target = String(fw[rule].target || "").trim();
        if (!ctx.extensions?.has(target)) throw new UserError("Choisis l'utilisateur vers qui renvoyer.", `forwarding.${rule}`);
        if (target === u.id) throw new UserError("Un utilisateur ne peut pas se renvoyer vers lui-même.", `forwarding.${rule}`);
      } else if (type === "external") {
        const n = nationalNumber(fw[rule].target, cc);
        if (!n) throw new UserError("Numéro externe : numéro national (ex. 06 12 34 56 78). L'international n'est pas autorisé.", `forwarding.${rule}`);
        if (isPremium(n, cc)) throw new UserError("Les numéros surtaxés ne sont pas autorisés.", `forwarding.${rule}`);
        if (EMERGENCY.includes(n)) throw new UserError("Numéro non autorisé.", `forwarding.${rule}`);
        target = n;
      }
      u.forwarding[rule] = { type, target };
      // Dernier renvoi immédiat utilisé : la touche « Renvoi » le réactive d'un appui
      if (rule === "always" && type !== "none") u.forwarding.always_last = { type, target };
    }
  }
  if (u.options.ring_mobile && !u.mobile) throw new UserError("Renseigne le mobile pour le faire sonner en même temps.", "mobile");
  return u;
}

// ------------------------------------------------------------------ Lecture humaine (liste, traceur)
const fmt = (n) => /^0\d{9}$/.test(n) ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : n;
export function describeDest(d, u) {
  switch (d.type) {
    case "voicemail": return u.voicemail.enabled ? "messagerie vocale" : "messagerie (désactivée → raccroche)";
    case "extension": return `poste ${d.target}`;
    case "external": return fmt(d.target);
    default: return "raccroche";
  }
}

/** Renvois « remarquables » d'un utilisateur, pour la liste et la recherche des renvois. */
export function forwardSummary(u) {
  const out = [];
  if (u.options.disabled) out.push({ level: "bad", text: "Utilisateur désactivé" });
  if (u.forwarding.always?.type && u.forwarding.always.type !== "none") out.push({ level: "warn", text: `Renvoi immédiat : tout vers ${describeDest(u.forwarding.always, u)}` });
  if (u.status === "away") out.push({ level: "warn", text: `Absent : tout vers ${describeDest(u.forwarding.away, u)}` });
  if (u.status === "dnd") out.push({ level: "warn", text: `Ne pas déranger : tout vers ${describeDest(u.forwarding.dnd, u)}` });
  if (u.status === "available") {
    for (const [rule, label] of [["no_answer", `Sans réponse (${u.forwarding.timeout} s)`], ["busy", "Occupé / non connecté"]]) {
      const d = u.forwarding[rule];
      if (d.type === "extension" || d.type === "external") out.push({ level: "info", text: `${label} → ${describeDest(d, u)}` });
    }
  }
  if (u.options.ring_mobile) out.push({ level: "info", text: `Sonne aussi sur le mobile ${fmt(u.mobile)}` });
  return out;
}

// ------------------------------------------------------------------ Génération Asterisk
function destLines(d, u, rule) {
  switch (d.type) {
    case "voicemail":
      return u.voicemail.enabled
        ? [`VoiceMail(${u.id}@default,${rule === "busy" ? "b" : "u"})`, "Hangup()"]
        : ["Hangup()"];
    case "extension": return [`Goto(users,${d.target},1)`];
    case "external": return [`Goto(user-external,${d.target},1)`];
    default: return ["Hangup()"];
  }
}

/** Contenu de extensions_users.conf. */
export function buildUsersDialplan(users) {
  const L = [`; Utilisateurs — écrit par la console web (${new Date().toISOString()}). Ne pas modifier à la main.`, "", "[users]"];
  for (const u of users) {
    const name = displayName(u).replace(/[(),]/g, " ");
    L.push(`; ---- ${u.id} ${name}`);
    L.push(`exten => ${u.id},1,NoOp(Utilisateur ${u.id} ${name} — statut ${u.status})`);
    L.push(" same => n,Set(__PBX_HOPS=$[0${PBX_HOPS} + 1])");
    L.push(" same => n,GotoIf($[${PBX_HOPS} > 6]?loop)");
    const body = []; // [libellé, application]
    const add = (lines, label = "") => lines.forEach((l, i) => body.push([i === 0 ? label : "", l]));
    if (u.options.disabled) {
      add(["Playback(ss-noservice)", "Hangup()"]);
    } else if (u.forwarding.always?.type && u.forwarding.always.type !== "none") {
      add(destLines(u.forwarding.always, u, "busy"));
    } else if (u.status === "away" || u.status === "dnd") {
      add(destLines(u.forwarding[u.status], u, "busy"));
    } else {
      const target = `PJSIP/${u.id}&PJSIP/${u.id}-web` + (u.options.ring_mobile && u.mobile ? `&Local/${u.mobile}@user-external/n` : "");
      add([`Dial(${target},${u.forwarding.timeout},tTb(pickup-mark^s^1))`, 'GotoIf($["${DIALSTATUS}" = "ANSWER" | "${DIALSTATUS}" = "CANCEL"]?end)',
        'GotoIf($["${DIALSTATUS}" = "NOANSWER"]?noanswer)']);
      add(destLines(u.forwarding.busy, u, "busy"));
      add(destLines(u.forwarding.no_answer, u, "unavail"), "noanswer");
    }
    for (const [label, app] of body) L.push(` same => n${label ? `(${label})` : ""},${app}`);
    L.push(` same => n(loop),Log(WARNING,Boucle de renvois détectée sur le poste ${u.id})`);
    L.push(" same => n(end),Hangup()");
  }
  L.push("", "; Supervision (BLF) : état des postes", "[users-hints]");
  for (const u of users) L.push(`exten => ${u.id},hint,PJSIP/${u.id}&PJSIP/${u.id}-web`);
  // Touche « Statut » du téléphone : voyant allumé si l'utilisateur est Absent ou en Ne pas déranger
  for (const u of users) L.push(`exten => status${u.id},hint,Custom:dnd${u.id}`);
  // Touche « Renvoi » : voyant allumé si un renvoi immédiat est actif
  for (const u of users) L.push(`exten => fwd${u.id},hint,Custom:fwd${u.id}`);
  L.push("", "; Postes autorisés à ouvrir / fermer le standard (rôle Pilote, Responsable ou Accès console)", "[std-allow]");
  for (const u of users) if (isStandardist(u)) L.push(`exten => ${u.id},1,Return()`);
  L.push("", "; SDA attribuées directement à un utilisateur", "[did-map]");
  for (const u of users) for (const d of u.dids) L.push(`exten => ${d},1,Goto(users,${u.id},1)`);
  L.push("", "; *97 : messagerie de son propre poste", "[vm-access]");
  for (const u of users) {
    if (!u.voicemail.enabled) continue;
    for (const ep of [u.id, `${u.id}-web`]) L.push(`exten => ${ep},1,VoiceMailMain(${u.id}@default${u.voicemail.skip_pin ? ",s" : ""})`, " same => n,Hangup()");
  }
  L.push("");
  return L.join("\n");
}

/** Contenu de voicemail_users.conf (inclus dans la section [default] de voicemail.conf). */
export function buildVoicemail(users) {
  const L = [`; Boîtes vocales — écrit par la console web (${new Date().toISOString()}).`];
  for (const u of users) {
    if (!u.voicemail.enabled) continue;
    L.push(`${u.id} => ${u.voicemail.pin},${displayName(u).replace(/[,|]/g, " ")},,,tz=paris`);
  }
  L.push("");
  return L.join("\n");
}

/** Valeur set_var de l'endpoint : USER_OPTS=<numéro présenté>,<appels externes bloqués 0|1> */
export const userOpts = (u) => `USER_OPTS=${u.outbound_cid || ""},${u.options.disabled || u.options.block_external ? 1 : 0}`;

/** Membres réellement sonnés par la route entrante « tous les postes ». */
export const ringsForGroups = (u) => !u.options.disabled && u.status === "available" && u.options.accept_group_calls;

/** Visibilité entre utilisateurs : un utilisateur masqué n'est vu par aucun autre (la console d'administration voit tout). */
export const sees = (viewer, other) => !!other && !other.options?.hidden && !other.options?.disabled;
