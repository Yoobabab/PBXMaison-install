/**
 * Gestion d'appels : groupes d'appel, files d'attente, SVI, messageries de groupe, horaires,
 * règles entrantes (par SDA) et annonces. Fonctions pures (sans base ni AMI), testées dans
 * console/test/callflow.test.mjs :
 *   - validation des objets et des destinations ;
 *   - génération d'extensions_callflow.conf et de queues_callikoe.conf ;
 *   - traceur de routage (arbre de configuration d'un numéro) et liste des renvois actifs.
 */
import { UserError, STATUSES, displayName, nationalNumber, ringsForGroups } from "./users.mjs";
import { PLAN_DAYS, PLAN_DAY_LONG, PLAN_MAX_SCENARIOS, planMin, ymdOf, isWeekB, planHolidays, resolvePlan, localNow, mondayOf, describeSlots } from "../public/planning-core.js";

export const KINDS = {
  group: "Groupe d'appel", queue: "File d'attente", ivr: "SVI (standard automatique)", groupvm: "Messagerie de groupe",
  schedule: "Horaires", rule: "Règle entrante", prompt: "Annonce", flow: "Routage", conf: "Salle de réunion", planning: "Planning",
};
/** Objets qui reçoivent des SDA comme une règle entrante (une seule « par défaut » parmi eux). */
const ENTRY_KINDS = ["rule", "flow", "planning"];
/** Étapes d'un routage (éditeur visuel / description en texte), enchaînées de gauche à droite. */
export const STEP_TYPES = {
  ring: "Faire sonner des utilisateurs", group: "Groupe d'appel", queue: "File d'attente", prompt: "Lire une annonce",
  ivr: "Répondeur numérique (SVI)", user: "Utilisateur (avec ses renvois)", user_vm: "Boîte vocale d'un utilisateur",
  groupvm: "Boîte vocale de groupe", conf: "Salle de réunion", external: "Numéro externe", hangup: "Terminer l'appel",
  ai: "Standardiste IA (répond, renseigne, transfère)", ai_msg: "Standardiste IA (prend un message)",
};
/** Étapes après lesquelles rien ne peut suivre (l'appel ne revient pas). */
export const TERMINAL_STEPS = ["ivr", "user", "user_vm", "groupvm", "conf", "external", "hangup", "ai", "ai_msg"];
export const BRANCHES = { open: "Heures d'ouverture", closed: "Bureau fermé", break: "Pause", holiday: "Jour férié / congés" };
/** Objets qui ont un numéro interne (composable depuis un poste). */
export const NUMBERED = ["group", "queue", "ivr", "groupvm", "conf"];
export const DEST_TYPES = {
  hangup: "Terminer l'appel", user: "Utilisateur", user_vm: "Boîte vocale d'un utilisateur", group: "Groupe d'appel",
  ivr: "Répondeur numérique (SVI)", queue: "File d'attente", groupvm: "Boîte vocale de groupe",
  external: "Transférer vers un numéro externe", prompt: "Lire une annonce puis raccrocher",
  ai: "Standardiste IA (répond, renseigne, transfère)", ai_msg: "Standardiste IA (prend un message)",
};
export const GROUP_STRATEGIES = {
  hunt: "1 à 1 dans l'ordre", all: "Sonne tous", rotate: "1 à 1 en tournant (on commence par le suivant à chaque appel)",
  page: "Annonce sans décrocher (interphone : les postes décrochent tout seuls en haut-parleur)",
};
export const QUEUE_STRATEGIES = {
  ringall: "Tous en même temps", rrmemory: "Chacun son tour (tourniquet)", leastrecent: "Celui qui a raccroché depuis le plus longtemps",
  fewestcalls: "Celui qui a pris le moins d'appels", linear: "Dans l'ordre de la liste", random: "Au hasard",
};
export const DAYS = [["mon", "Lundi"], ["tue", "Mardi"], ["wed", "Mercredi"], ["thu", "Jeudi"], ["fri", "Vendredi"], ["sat", "Samedi"], ["sun", "Dimanche"]];
const EMERGENCY = ["15", "17", "18", "112", "114", "115", "116000", "119", "191", "196", "197"];
const IVR_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "*", "#"];

const clean = (s, max = 50) => String(s ?? "").replace(/[\r\n"<>,;|\\()[\]{}$]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const fmt = (n) => /^0\d{9}$/.test(n) ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : n;
const int = (v, min, max, def, label, field) => {
  if (v === undefined || v === "" || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} : entre ${min} et ${max}.`, field);
  return n;
};

// ------------------------------------------------------------------ Valeurs par défaut
/** Heures de bureau propres à un groupe, une file ou un SVI : null = « accepter quand même ». */
const OFFICE = { dids: [], schedule: "", closed: null, break: null, holiday: null };
export const OFFICE_KINDS = ["group", "queue", "ivr"];
export function defaultObject(kind) {
  const hang = { type: "hangup", target: "" };
  switch (kind) {
    case "group": return { name: "", number: "", strategy: "all", members: [], ring_time: 20, cid_prefix: "", greeting: "", no_answer: hang, ...OFFICE };
    case "queue": return { name: "", number: "", strategy: "ringall", members: [], member_timeout: 15, max_wait: 300, wrapup: 5,
      announce_position: true, announce_holdtime: false, greeting: "", moh: "", periodic: [], periodic_freq: 30, no_answer: hang, ...OFFICE };
    case "ivr": return { name: "", number: "", prompt: "", timeout: 5, retries: 2, direct_dial: true, options: {}, invalid: hang, speech: false, keywords: {}, ...OFFICE };
    case "groupvm": return { name: "", number: "", pin: "", members: [] };
    case "conf": return { name: "", number: "", pin: "", max_members: 20, video: true };
    case "schedule": return { name: "", week: Object.fromEntries(DAYS.map(([d]) => [d, ["mon", "tue", "wed", "thu", "fri"].includes(d) ? [["09:00", "12:00"], ["14:00", "18:00"]] : []])),
      holidays_fr: true, holidays: [], override: "auto", general: false };
    case "rule": return { name: "", dids: [], is_default: false, schedule: "", open: hang, closed: hang, break: null, holiday: null };
    case "prompt": return { name: "", file: "", duration: 0 };
    case "flow": return { name: "", dids: [], is_default: false, schedule: "", branches: { open: [], closed: null, break: null, holiday: null } };
    case "planning": return { name: "", dids: [], is_default: false, managers: true, scenarios: [{ id: "s1", name: "En dehors des plages", color: "#94a3b8" }],
      branches: { s1: [{ type: "hangup", target: "" }] }, outside: "s1", week: Object.fromEntries(PLAN_DAYS.map((x) => [x, []])), alternate: false,
      week_b: Object.fromEntries(PLAN_DAYS.map((x) => [x, []])), ref_monday: mondayOf(ymdOf(Date.now())), holidays_fr: true, holiday_scenario: "s1", days: {}, override: "" };
    default: throw new UserError("Type d'objet inconnu.");
  }
}

// ------------------------------------------------------------------ Validation
/**
 * ctx : { users: Map(id → fiche), objects: [{kind,id,number,name,data}], cc, selfId, usedNumbers: Map(numéro → libellé),
 *         userDids: Map(sda → poste), trunkDids: Set }
 */
export function validateDest(d, ctx, field, { allowNull = false } = {}) {
  if (d === null || d === undefined || d === "") {
    if (allowNull) return null;
    throw new UserError("Choisis une destination.", field);
  }
  const type = String(d.type || "");
  if (!DEST_TYPES[type]) throw new UserError("Destination inconnue.", field);
  const target = String(d.target ?? "").trim();
  // « Lire l'annonce » avant d'envoyer l'appel vers la destination
  if (d.prompt) {
    if (!ctx.objects.some((o) => o.kind === "prompt" && o.id === d.prompt)) throw new UserError("Annonce introuvable.", field);
    const { prompt, ...rest } = d;
    return { ...validateDest(rest, ctx, field), prompt };
  }
  if (type === "hangup" || type === "ai" || type === "ai_msg") return { type, target: "" };
  if (type === "user" || type === "user_vm") {
    if (!ctx.users.has(target)) throw new UserError("Choisis l'utilisateur.", field);
    if (type === "user_vm" && !ctx.users.get(target).voicemail.enabled) throw new UserError(`La messagerie de ${target} est désactivée.`, field);
    return { type, target };
  }
  if (type === "external") {
    const n = nationalNumber(target, ctx.cc || "33");
    if (!n) throw new UserError("Numéro externe : numéro national (ex. 06 12 34 56 78).", field);
    if (/^08[9]/.test(n) || EMERGENCY.includes(n)) throw new UserError("Numéro non autorisé.", field);
    return { type, target: n };
  }
  const o = ctx.objects.find((x) => x.kind === type && x.id === target);
  if (!o) throw new UserError(`Choisis : ${DEST_TYPES[type].toLowerCase()}.`, field);
  if (o.id === ctx.selfId && type !== "prompt") throw new UserError("Un objet ne peut pas renvoyer vers lui-même.", field);
  return { type, target };
}

function validMembers(list, ctx, field) {
  const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,;]+/);
  const out = [];
  for (const m of arr.map((x) => String(x).trim()).filter(Boolean)) {
    if (!ctx.users.has(m)) throw new UserError(`Membre inconnu : ${m}.`, field);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** SDA attribuées à une règle ou à un groupe / file / SVI : uniques sur tout le PBX. */
function validDids(input, ctx, field) {
  const arr = Array.isArray(input) ? input : String(input || "").split(/[\n,;]+/);
  const out = [];
  for (const raw of arr.map((x) => String(x).trim()).filter(Boolean)) {
    const n = nationalNumber(raw, ctx.cc || "33");
    if (!n) throw new UserError(`SDA invalide : ${raw}.`, field);
    const owner = ctx.userDids?.get(n);
    if (owner) throw new UserError(`La SDA ${fmt(n)} est attribuée directement à l'utilisateur ${owner} : retire-la de sa fiche d'abord.`, field);
    const other = ctx.objects.find((o) => o.id !== ctx.selfId && (o.data.dids || []).includes(n));
    if (other) throw new UserError(`La SDA ${fmt(n)} est déjà ${other.kind === "rule" ? `dans la règle « ${other.data.name} »` : `attribuée à : ${KINDS[other.kind].toLowerCase()} « ${other.data.name} »`}.`, field);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}
const promptId = (v, ctx, field) => v ? validateDest({ type: "prompt", target: v }, ctx, field).target : "";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function validNumber(num, ctx) {
  const n = String(num ?? "").trim();
  if (!/^[1-9]\d{2}$/.test(n)) throw new UserError("Numéro interne : 3 chiffres, de 100 à 999.", "number");
  if (EMERGENCY.includes(n)) throw new UserError(`${n} est un numéro d'urgence : choisis-en un autre.`, "number");
  const used = ctx.usedNumbers?.get(n);
  if (used) throw new UserError(`Le numéro ${n} est déjà utilisé (${used}).`, "number");
  return n;
}

/** Valide un objet complet (data) ; renvoie { number, name, data }. */
export function validateObject(kind, input, current, ctx) {
  const d = { ...defaultObject(kind), ...(current || {}) };
  const name = input.name !== undefined ? clean(input.name) : d.name;
  if (!name) throw new UserError("Donne un nom.", "name");
  d.name = name;
  if (NUMBERED.includes(kind)) d.number = validNumber(input.number ?? d.number, ctx);
  else delete d.number;
  if (OFFICE_KINDS.includes(kind)) {
    if (input.dids !== undefined) d.dids = validDids(input.dids, ctx, "dids");
    if (input.schedule !== undefined) {
      if (input.schedule && !ctx.objects.some((o) => o.kind === "schedule" && o.id === input.schedule)) throw new UserError("Horaires introuvables.", "schedule");
      d.schedule = input.schedule || "";
    }
    for (const f of ["closed", "break", "holiday"]) if (input[f] !== undefined) d[f] = validateDest(input[f], ctx, f, { allowNull: true });
  }

  if (kind === "group") {
    if (input.strategy !== undefined) { if (!GROUP_STRATEGIES[input.strategy]) throw new UserError("Stratégie inconnue.", "strategy"); d.strategy = input.strategy; }
    if (input.members !== undefined) d.members = validMembers(input.members, ctx, "members");
    d.ring_time = int(input.ring_time, 5, 300, d.ring_time, "Durée de sonnerie (secondes)", "ring_time");
    if (input.greeting !== undefined) d.greeting = promptId(input.greeting, ctx, "greeting");
    if (input.cid_prefix !== undefined) d.cid_prefix = String(input.cid_prefix).replace(/[\r\n"<>,;|\\(){}$]/g, " ").replace(/\s+/g, " ").trim().slice(0, 20);
    if (input.no_answer !== undefined) d.no_answer = validateDest(input.no_answer, ctx, "no_answer");
  } else if (kind === "queue") {
    if (input.strategy !== undefined) { if (!QUEUE_STRATEGIES[input.strategy]) throw new UserError("Stratégie inconnue.", "strategy"); d.strategy = input.strategy; }
    if (input.members !== undefined) d.members = validMembers(input.members, ctx, "members");
    d.member_timeout = int(input.member_timeout, 5, 120, d.member_timeout, "Sonnerie par agent (secondes)", "member_timeout");
    d.max_wait = int(input.max_wait, 10, 3600, d.max_wait, "Attente maximum (secondes)", "max_wait");
    d.wrapup = int(input.wrapup, 0, 300, d.wrapup, "Pause entre deux appels (secondes)", "wrapup");
    if (input.announce_position !== undefined) d.announce_position = !!input.announce_position;
    if (input.announce_holdtime !== undefined) d.announce_holdtime = !!input.announce_holdtime;
    if (input.greeting !== undefined) d.greeting = promptId(input.greeting, ctx, "greeting");
    if (input.moh !== undefined) d.moh = promptId(input.moh, ctx, "moh");
    if (input.periodic !== undefined) d.periodic = (Array.isArray(input.periodic) ? input.periodic : String(input.periodic || "").split(",")).filter(Boolean).slice(0, 10).map((x) => promptId(x, ctx, "periodic"));
    d.periodic_freq = int(input.periodic_freq, 10, 600, d.periodic_freq ?? 30, "Délai entre les annonces (secondes)", "periodic_freq");
    if (input.no_answer !== undefined) d.no_answer = validateDest(input.no_answer, ctx, "no_answer");
  } else if (kind === "ivr") {
    if (input.prompt !== undefined) d.prompt = promptId(input.prompt, ctx, "prompt");
    d.timeout = int(input.timeout, 1, 30, d.timeout, "Délai de choix (secondes)", "timeout");
    d.retries = int(input.retries, 0, 5, d.retries, "Nombre de répétitions", "retries");
    if (input.direct_dial !== undefined) d.direct_dial = !!input.direct_dial;
    if (input.options !== undefined) {
      const opts = {};
      for (const [k, v] of Object.entries(input.options || {})) {
        if (!IVR_KEYS.includes(k)) throw new UserError(`Touche invalide : ${k}.`, "options");
        if (!v || !v.type || v.type === "none") continue;
        opts[k] = validateDest(v, ctx, `options.${k}`);
      }
      d.options = opts;
    }
    if (input.invalid !== undefined) d.invalid = validateDest(input.invalid, ctx, "invalid");
    // SVI qui comprend la parole (IA) : mots-clés facultatifs par touche (« compta, factures »)
    if (input.speech !== undefined) d.speech = !!input.speech;
    if (input.keywords !== undefined) {
      const kw = {};
      for (const [k, v] of Object.entries(input.keywords || {})) { const t = clean(v, 120); if (IVR_KEYS.includes(k) && t) kw[k] = t; }
      d.keywords = kw;
    }
  } else if (kind === "conf") {
    if (input.pin !== undefined) {
      const pin = String(input.pin).trim();
      if (pin && !/^\d{4,8}$/.test(pin)) throw new UserError("Code PIN : 4 à 8 chiffres (ou vide).", "pin");
      d.pin = pin;
    }
    d.max_members = int(input.max_members, 2, 100, d.max_members, "Participants maximum", "max_members");
    if (input.video !== undefined) d.video = !!input.video;
  } else if (kind === "groupvm") {
    if (input.pin !== undefined) {
      const pin = String(input.pin).trim();
      if (!/^\d{4,8}$/.test(pin)) throw new UserError("Code PIN : 4 à 8 chiffres.", "pin");
      d.pin = pin;
    }
    if (!d.pin) d.pin = String(Math.floor(100000 + Math.random() * 900000));
    if (input.members !== undefined) d.members = validMembers(input.members, ctx, "members");
  } else if (kind === "schedule") {
    if (input.week !== undefined) {
      const week = {};
      for (const [day, label] of DAYS) {
        const ranges = [];
        for (const r of input.week?.[day] || []) {
          let [a, b] = [String(r?.[0] || "").trim(), String(r?.[1] || "").trim()];
          if (!a && !b) continue;
          if (b === "23:59") b = "24:00";   // « jusqu'à 23:59 » = jusqu'à minuit (sinon fermé la dernière minute)
          if (!HHMM.test(a) || !(HHMM.test(b) || b === "24:00")) throw new UserError(`${label} : heures au format HH:MM (fin possible à 24:00). Pour une plage de nuit, coupe-la à minuit sur deux jours.`, `week.${day}`);
          if (toMin(b) <= toMin(a)) throw new UserError(`${label} : l'heure de fin doit être après l'heure de début.`, `week.${day}`);
          ranges.push([a, b]);
        }
        ranges.sort((x, y) => toMin(x[0]) - toMin(y[0]));
        for (let i = 1; i < ranges.length; i++) if (toMin(ranges[i][0]) < toMin(ranges[i - 1][1])) throw new UserError(`${label} : plages qui se chevauchent.`, `week.${day}`);
        week[day] = ranges;
      }
      d.week = week;
    }
    if (input.holidays_fr !== undefined) d.holidays_fr = !!input.holidays_fr;
    if (input.general !== undefined) d.general = !!input.general;
    if (input.holidays !== undefined) {
      const list = [];
      for (const h of Array.isArray(input.holidays) ? input.holidays : []) {
        const from = String(h?.from || "").trim(), to = String(h?.to || h?.from || "").trim();
        if (!from) continue;
        if (!validYmd(from) || !validYmd(to)) throw new UserError(`Date invalide : ${[from, to].find((x) => !validYmd(x)).split("-").reverse().join("/")}.`, "holidays");
        if (to < from) throw new UserError("Congés : la date de fin est avant la date de début.", "holidays");
        if (Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw new UserError("Congés : une période ne peut pas dépasser un an.", "holidays");
        list.push({ from, to, label: clean(h.label, 40) });
      }
      d.holidays = list.slice(0, 100);
    }
    if (input.override !== undefined) {
      if (!["auto", "open", "closed"].includes(input.override)) throw new UserError("Mode inconnu.", "override");
      d.override = input.override;
    }
  } else if (kind === "rule") {
    if (input.is_default !== undefined) d.is_default = !!input.is_default;
    if (input.dids !== undefined) d.dids = validDids(input.dids, ctx, "dids");
    if (!d.is_default && !d.dids.length) throw new UserError("Indique au moins une SDA, ou coche « règle par défaut ».", "dids");
    if (d.is_default) {
      const other = ctx.objects.find((o) => ENTRY_KINDS.includes(o.kind) && o.id !== ctx.selfId && o.data.is_default);
      if (other) throw new UserError(`« ${other.data.name} » est déjà la règle par défaut.`, "is_default");
    }
    if (input.schedule !== undefined) d.schedule = input.schedule ? (ctx.objects.some((o) => o.kind === "schedule" && o.id === input.schedule) ? input.schedule : (() => { throw new UserError("Horaires introuvables.", "schedule"); })()) : "";
    if (input.open !== undefined) d.open = validateDest(input.open, ctx, "open");
    if (input.closed !== undefined) d.closed = validateDest(input.closed, ctx, "closed");
    if (input.holiday !== undefined) d.holiday = validateDest(input.holiday, ctx, "holiday", { allowNull: true });
    if (input.break !== undefined) d.break = validateDest(input.break, ctx, "break", { allowNull: true });
  } else if (kind === "flow") {
    if (input.dids !== undefined) d.dids = validDids(input.dids, ctx, "dids");
    if (input.is_default !== undefined) d.is_default = !!input.is_default;
    if (d.is_default) {
      const other = ctx.objects.find((o) => ENTRY_KINDS.includes(o.kind) && o.id !== ctx.selfId && o.data.is_default);
      if (other) throw new UserError(`« ${other.data.name} » est déjà le routage par défaut.`, "is_default");
    }
    if (!d.is_default && !d.dids.length) throw new UserError("Glisse au moins une SDA, ou coche « routage par défaut ».", "dids");
    if (input.schedule !== undefined) {
      if (input.schedule && !ctx.objects.some((o) => o.kind === "schedule" && o.id === input.schedule)) throw new UserError("Horaires introuvables.", "schedule");
      d.schedule = input.schedule || "";
    }
    if (input.branches !== undefined) {
      const b = { open: validateSteps(input.branches?.open || [], ctx, "branches.open"), closed: null, break: null, holiday: null };
      for (const k of ["closed", "break", "holiday"]) {
        const v = input.branches?.[k];
        b[k] = Array.isArray(v) && d.schedule ? validateSteps(v, ctx, `branches.${k}`) : null;
      }
      d.branches = b;
    }
    if (!d.branches.open.length) throw new UserError("Ajoute au moins une étape au routage.", "branches.open");
  } else if (kind === "planning") {
    validatePlanning(d, input, ctx);
  } else if (kind === "prompt") {
    // fichier et durée posés par le serveur après conversion
  }
  return { number: d.number || null, name: d.name, data: d };
}

// ------------------------------------------------------------------ Planning de la semaine
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_T = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const validYmd = (v) => YMD.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`)) && ymdOf(Date.parse(`${v}T00:00:00Z`)) === v;
function validSlots(list, ids, label, field) {
  if (!Array.isArray(list)) throw new UserError(`${label} : plages invalides.`, field);
  if (list.length > 96) throw new UserError(`${label} : trop de plages.`, field);
  const out = [];
  for (const r of list) {
    const from = String(r?.from || "").trim(), to = String(r?.to || "").trim(), s = String(r?.s || "");
    if (!SLOT_T.test(from) || from === "24:00" || !SLOT_T.test(to)) throw new UserError(`${label} : heures au format HH:MM.`, field);
    if (planMin(to) <= planMin(from)) throw new UserError(`${label} : l'heure de fin doit être après l'heure de début.`, field);
    if (!ids.has(s)) throw new UserError(`${label} : scénario inconnu.`, field);
    out.push({ from, to, s });
  }
  out.sort((x, y) => planMin(x.from) - planMin(y.from));
  for (let i = 1; i < out.length; i++) if (planMin(out[i].from) < planMin(out[i - 1].to)) throw new UserError(`${label} : plages qui se chevauchent (${out[i - 1].from}-${out[i - 1].to} et ${out[i].from}-${out[i].to}).`, field);
  return out;
}
function validatePlanning(d, input, ctx) {
  if (input.dids !== undefined) d.dids = validDids(input.dids, ctx, "dids");
  if (input.is_default !== undefined) d.is_default = !!input.is_default;
  if (d.is_default) {
    const other = ctx.objects.find((o) => ENTRY_KINDS.includes(o.kind) && o.id !== ctx.selfId && o.data.is_default);
    if (other) throw new UserError(`« ${other.data.name} » est déjà le routage par défaut.`, "is_default");
  }
  if (!d.is_default && !d.dids.length) throw new UserError("Ajoute au moins une SDA, ou coche « routage par défaut ».", "dids");
  if (input.managers !== undefined) d.managers = !!input.managers;
  if (input.scenarios !== undefined) {
    const arr = Array.isArray(input.scenarios) ? input.scenarios : [];
    if (!arr.length) throw new UserError("Crée au moins un scénario.", "scenarios");
    if (arr.length > PLAN_MAX_SCENARIOS) throw new UserError(`${PLAN_MAX_SCENARIOS} scénarios maximum.`, "scenarios");
    const seen = new Set();
    d.scenarios = arr.map((x, i) => {
      const id = String(x?.id || "");
      if (!/^[a-z0-9]{1,8}$/.test(id) || seen.has(id)) throw new UserError(`Scénario ${i + 1} : identifiant invalide.`, "scenarios");
      seen.add(id);
      const name = clean(x?.name, 30);
      if (!name) throw new UserError(`Scénario ${i + 1} : donne-lui un nom.`, `scenario.${id}`);
      const color = /^#[0-9a-f]{6}$/i.test(String(x?.color || "")) ? String(x.color).toLowerCase() : "#94a3b8";
      return { id, name, color };
    });
  }
  const ids = new Set(d.scenarios.map((x) => x.id));
  if (input.branches !== undefined) {
    const b = {};
    for (const sc of d.scenarios) {
      const steps = validateSteps(input.branches?.[sc.id] || [], ctx, `branches.${sc.id}`);
      if (!steps.length) throw new UserError(`Scénario « ${sc.name} » : ajoute au moins une étape.`, `branches.${sc.id}`);
      b[sc.id] = steps;
    }
    d.branches = b;
  }
  for (const sc of d.scenarios) if (!d.branches[sc.id]) throw new UserError(`Scénario « ${sc.name} » : ajoute au moins une étape.`, `branches.${sc.id}`);
  for (const k of Object.keys(d.branches)) if (!ids.has(k)) delete d.branches[k];
  if (input.outside !== undefined) d.outside = String(input.outside || "");
  if (!ids.has(d.outside)) throw new UserError("Choisis le scénario utilisé en dehors des plages.", "outside");
  for (const [key, label] of [["week", "Semaine A"], ["week_b", "Semaine B"]]) {
    if (input[key] === undefined) continue;
    const w = {};
    for (const day of PLAN_DAYS) w[day] = validSlots(input[key]?.[day] || [], ids, `${label} · ${PLAN_DAY_LONG[day]}`, `${key}.${day}`);
    d[key] = w;
  }
  if (input.alternate !== undefined) d.alternate = !!input.alternate;
  if (input.ref_monday !== undefined) {
    const r = String(input.ref_monday || "");
    if (!validYmd(r)) throw new UserError("Date de début de la semaine A invalide.", "ref_monday");
    d.ref_monday = mondayOf(r);
  }
  if (input.holidays_fr !== undefined) d.holidays_fr = !!input.holidays_fr;
  if (input.holiday_scenario !== undefined) d.holiday_scenario = String(input.holiday_scenario || "");
  if (d.holiday_scenario && !ids.has(d.holiday_scenario)) d.holiday_scenario = "";
  if (input.days !== undefined) {
    const out = {};
    const entries = Object.entries(input.days && typeof input.days === "object" ? input.days : {});
    if (entries.length > 400) throw new UserError("400 journées particulières maximum.", "days");
    for (const [ymd, v] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      if (!validYmd(ymd)) throw new UserError(`Date invalide : ${ymd}.`, "days");
      out[ymd] = { slots: validSlots(v?.slots || [], ids, `Journée du ${ymd.split("-").reverse().join("/")}`, `days.${ymd}`), label: clean(v?.label, 40) };
    }
    d.days = out;
  }
  for (const [ymd, v] of Object.entries(d.days || {})) v.slots = v.slots.filter((x) => ids.has(x.s));
  for (const k of ["week", "week_b"]) for (const day of PLAN_DAYS) d[k][day] = (d[k][day] || []).filter((x) => ids.has(x.s));
  if (input.override !== undefined) d.override = String(input.override || "");
  if (d.override && !ids.has(d.override)) d.override = "";
}

/** Valide une suite d'étapes ; une étape « terminale » doit être la dernière. */
export function validateSteps(list, ctx, field) {
  if (!Array.isArray(list)) throw new UserError("Étapes invalides.", field);
  if (list.length > 12) throw new UserError("12 étapes maximum.", field);
  const out = [];
  list.forEach((st, i) => {
    const f = `${field}.${i}`;
    const type = String(st?.type || "");
    if (!STEP_TYPES[type]) throw new UserError(`Étape ${i + 1} : type inconnu.`, f);
    if (i > 0 && TERMINAL_STEPS.includes(out[i - 1].type)) throw new UserError(`Étape ${i + 1} : rien ne peut suivre « ${STEP_TYPES[out[i - 1].type]} » (l'appel ne revient pas).`, f);
    if (type === "ring") {
      const users = validMembers(st.users, ctx, f);
      if (!users.length) throw new UserError(`Étape ${i + 1} : choisis qui doit sonner.`, f);
      if (!["all", "hunt"].includes(st.strategy || "all")) throw new UserError("Stratégie inconnue.", f);
      out.push({ type, users, strategy: st.strategy || "all", time: int(st.time, 5, 300, 20, `Étape ${i + 1} : durée de sonnerie`, f) });
    } else if (type === "group") {
      const t = validateDest({ type: "group", target: st.target }, ctx, f).target;
      out.push({ type, target: t, time: st.time === undefined || st.time === "" || st.time === null ? null : int(st.time, 5, 300, null, `Étape ${i + 1} : durée de sonnerie`, f) });
    } else {
      const v = validateDest({ type, target: st.target }, ctx, f);
      out.push({ type, target: v.target });
    }
  });
  return out;
}
const branchLabel = (d, b) => BRANCHES[b] || `scénario « ${d.scenarios?.find((x) => x.id === b)?.name || b} »`;
const flowSteps = (d) => Object.entries(d.branches || {}).flatMap(([b, list]) => (list || []).map((st, i) => ({ b, i, st, label: branchLabel(d, b) })));

/** Références vers un objet (avant suppression) : [{ kind, id, name, where }] */
export function referencesTo(kind, id, objects, users) {
  const refs = [];
  const hit = (dest) => dest && dest.type === kind && dest.target === id;
  for (const o of objects) {
    const d = o.data;
    const where = [];
    if (hit(d.no_answer)) where.push("sans réponse");
    if (hit(d.invalid)) where.push("choix invalide");
    if (hit(d.open)) where.push("ouvert");
    if (hit(d.closed)) where.push("fermé");
    if (hit(d.holiday)) where.push("jour férié");
    if (hit(d.break)) where.push("pause");
    if (kind === "prompt") for (const f of ["no_answer", "invalid", "open", "closed", "holiday", "break"]) if (d[f]?.prompt === id) where.push(`annonce avant « ${f} »`);
    if (kind === "prompt" && d.moh === id) where.push("musique d'attente");
    if (kind === "prompt" && (d.periodic || []).includes(id)) where.push("annonce d'attente");
    for (const [k, v] of Object.entries(d.options || {})) if (hit(v)) where.push(`touche ${k}`);
    if (kind === "prompt" && (d.greeting === id || d.prompt === id)) where.push(o.kind === "ivr" ? "annonce du SVI" : "annonce d'accueil");
    if (kind === "schedule" && d.schedule === id) where.push("horaires");
    for (const { i, st, label } of flowSteps(d)) {
      if (st.type === kind && st.target === id) where.push(`étape ${i + 1} (${label.toLowerCase()})`);
      if (kind === "user" && (st.type === "user" || st.type === "user_vm") && st.target === id) where.push(`étape ${i + 1} (${label.toLowerCase()})`);
    }
    if (where.length) refs.push({ kind: o.kind, id: o.id, name: d.name, where: where.join(", ") });
  }
  if (kind === "user") {
    // membres de groupes, files, messageries de groupe
    for (const o of objects) if ((o.data.members || []).includes(id)) refs.push({ kind: o.kind, id: o.id, name: o.data.name, where: "membre" });
    for (const o of objects) if (flowSteps(o.data).some(({ st }) => st.type === "ring" && st.users.includes(id))) refs.push({ kind: o.kind, id: o.id, name: o.data.name, where: "sonne dans une étape" });
  }
  void users;
  return refs;
}

// ------------------------------------------------------------------ Jours fériés (France métropolitaine)
export function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
const ymd = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400_000);
export function frenchHolidays(year) {
  const e = easter(year);
  return [
    [`${year}-01-01`, "Jour de l'an"], [ymd(addDays(e, 1)), "Lundi de Pâques"], [`${year}-05-01`, "Fête du Travail"], [`${year}-05-08`, "Victoire 1945"],
    [ymd(addDays(e, 39)), "Ascension"], [ymd(addDays(e, 50)), "Lundi de Pentecôte"], [`${year}-07-14`, "Fête nationale"], [`${year}-08-15`, "Assomption"],
    [`${year}-11-01`, "Toussaint"], [`${year}-11-11`, "Armistice"], [`${year}-12-25`, "Noël"],
  ];
}
/** Jours fermés (fériés + congés) entre deux années incluses : Map("AAAA-MM-JJ" → libellé). */
export function closedDays(schedule, fromYear, toYear) {
  const out = new Map();
  if (schedule.holidays_fr) for (let y = fromYear; y <= toYear; y++) for (const [d, l] of frenchHolidays(y)) out.set(d, l);
  for (const h of schedule.holidays || []) {
    for (let dt = new Date(`${h.from}T00:00:00Z`); ymd(dt) <= h.to; dt = addDays(dt, 1)) {
      const y = dt.getUTCFullYear();
      if (y >= fromYear && y <= toYear) out.set(ymd(dt), h.label || "Fermeture");
    }
  }
  return out;
}

/** État des horaires à un instant donné, dans le fuseau du PBX : open | closed | holiday. */
export function scheduleState(schedule, date = new Date(), tz = "Europe/Paris") {
  if (schedule.override === "open") return "open";
  if (schedule.override === "closed") return "closed";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(date).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (closedDays(schedule, Number(parts.year), Number(parts.year)).has(day)) return "holiday";
  const wd = parts.weekday.toLowerCase().slice(0, 3);
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const ranges = schedule.week[wd] || [];
  if (ranges.some(([a, b]) => now >= toMin(a) && now < toMin(b))) return "open";
  // Entre deux plages du même jour : pause (déjeuner…)
  if (ranges.length > 1 && now >= toMin(ranges[0][0]) && now < toMin(ranges.at(-1)[1])) return "break";
  return "closed";
}

export function describeWeek(week) {
  const parts = [];
  let i = 0;
  while (i < DAYS.length) {
    const key = JSON.stringify(week[DAYS[i][0]] || []);
    let j = i;
    while (j + 1 < DAYS.length && JSON.stringify(week[DAYS[j + 1][0]] || []) === key) j++;
    const ranges = week[DAYS[i][0]] || [];
    if (ranges.length) {
      const days = i === j ? DAYS[i][1].slice(0, 3).toLowerCase() : `${DAYS[i][1].slice(0, 3).toLowerCase()}-${DAYS[j][1].slice(0, 3).toLowerCase()}`;
      parts.push(`${days} ${ranges.map(([a, b]) => `${a}-${b}`).join(", ")}`);
    }
    i = j + 1;
  }
  return parts.join(" ; ") || "jamais ouvert";
}

// ------------------------------------------------------------------ Génération Asterisk
const nameOf = (o) => clean(o.data.name, 40);
const byKind = (objects, kind) => objects.filter((o) => o.kind === kind);
const find = (objects, kind, id) => objects.find((o) => o.kind === kind && o.id === id);
const promptPath = (dir, o) => `${dir}/${o.data.file.replace(/\.wav$/, "")}`;
const devices = (ext) => `PJSIP/${ext}&PJSIP/${ext}-web&Local/${ext}@cx-app/n`;   // poste, softphone web, appli mobile

/** Applications Asterisk qui envoient l'appel vers une destination. */
export function destApps(d, m) {
  if (!d) return ["Hangup()"];
  if (d.prompt) {
    const p = find(m.objects, "prompt", d.prompt);
    const { prompt, ...rest } = d;
    void prompt;
    return [...(p?.data?.file ? ["Answer()", `Playback(${promptPath(m.soundsDir, p)})`] : []), ...destApps(rest, m)];
  }
  switch (d.type) {
    case "user": return m.users.has(d.target) ? [`Goto(users,${d.target},1)`] : ["Hangup()"];
    case "user_vm": return m.users.get(d.target)?.voicemail.enabled ? [`VoiceMail(${d.target}@default,u)`, "Hangup()"] : ["Hangup()"];
    case "external": return [`Goto(user-external,${d.target},1)`];
    case "prompt": {
      const p = find(m.objects, "prompt", d.target);
      return p?.data?.file ? ["Answer()", `Playback(${promptPath(m.soundsDir, p)})`, "Hangup()"] : ["Hangup()"];
    }
    case "hangup": return ["Hangup()"];
    case "ai": return ["Goto(cx-ai,s,1)"];
    case "ai_msg": return ["Goto(cx-ai,msg,1)"];
    default: {
      const o = find(m.objects, d.type, d.target);
      return o ? [`Goto(callflow,${o.number},1)`] : ["Hangup()"];
    }
  }
}

const hopGuard = (L, what) => {
  L.push(" same => n,Set(__PBX_HOPS=$[0${PBX_HOPS} + 1])");
  L.push(` same => n,GotoIf($[\${PBX_HOPS} > 8]?loop)`);
  void what;
};
const pushApps = (L, apps, label = "") => apps.forEach((a, i) => L.push(` same => n${i === 0 && label ? `(${label})` : ""},${a}`));
const minusOne = (t) => { const m = (toMin(t) + 1439) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const ringers = (members, users) => members.filter((x) => users.has(x) && ringsForGroups(users.get(x)));

/** Heures de bureau d'un groupe / file / SVI : renvoie les lignes de fin (branches fermé / pause / férié). */
function officeGate(L, o, m) {
  const d = o.data;
  const sched = d.schedule && find(m.objects, "schedule", d.schedule);
  const tails = [];
  if (!sched) return tails;
  const branches = [["closed", d.closed], ["break", d.break], ["holiday", d.holiday]].filter(([, x]) => x);
  if (!branches.length) return tails;
  L.push(` same => n,Gosub(sched-${sched.id},s,1)`);
  for (const [st, dest] of branches) {
    L.push(` same => n,GotoIf($["\${GOSUB_RETVAL}" = "${st}"]?of-${st})`);
    destApps(dest, m).forEach((a, i) => tails.push(` same => n${i === 0 ? `(of-${st})` : ""},${a}`));
  }
  return tails;
}

/**
 * Contenu de extensions_callflow.conf.
 * m : { users: Map, objects: [...], soundsDir, tz, year }
 */
export function buildCallflowDialplan(m) {
  const tz = m.tz || "Europe/Paris";
  const year = m.year || new Date().getFullYear();
  const L = [`; Gestion d'appels — écrit par la console web (${new Date().toISOString()}). Ne pas modifier à la main.`, "", "[callflow]"];
  for (const o of byKind(m.objects, "group")) {
    const d = o.data;
    L.push(`; ---- Groupe ${o.number} ${nameOf(o)}`, `exten => ${o.number},1,NoOp(Groupe ${o.number} ${nameOf(o)})`);
    hopGuard(L);
    L.push(" same => n,Set(CDR(dest_kind)=group)", " same => n,Set(__RINGTYPE=groupe)");
    const tails = officeGate(L, o, m);
    // Préfixe : toujours devant le nom d'origine (pas « [B] [A] Jean » quand l'appel passe par deux groupes)
    if (d.cid_prefix) L.push(" same => n,GotoIf($[${LEN(${CID_ORIG})} > 0]?cidok)", " same => n,Set(__CID_ORIG=${CALLERID(name)})",
      ` same => n(cidok),Set(CALLERID(name)=${d.cid_prefix} \${CID_ORIG})`);
    const gp = d.greeting && find(m.objects, "prompt", d.greeting);
    if (gp?.data?.file) L.push(" same => n,Answer()", ` same => n,Playback(${promptPath(m.soundsDir, gp)})`);
    const ring = ringers(d.members, m.users);
    if (ring.length && d.strategy === "page") {
      // Interphone : décroché automatique (Call-Info answer-after=0), le groupe parle à tous les membres
      L.push(` same => n,Page(${ring.map(devices).join("&")},db(page-headers^s^1)i,${d.ring_time})`, " same => n,Goto(end)");
    } else if (ring.length) {
      if (d.strategy === "hunt" || d.strategy === "rotate") {
        // Un membre après l'autre ; en cyclique, on démarre au suivant du dernier appel (variable globale)
        L.push(` same => n,Set(MEMBERS=${ring.join("&")})`);
        if (d.strategy === "rotate") L.push(` same => n,Set(I=$[0\${RR_${o.number}} % ${ring.length}])`, ` same => n,Set(GLOBAL(RR_${o.number})=$[\${I} + 1])`);
        else L.push(" same => n,Set(I=0)");
        L.push(" same => n,Set(K=0)",
          ` same => n(next),GotoIf($[\${K} >= ${ring.length}]?done)`,
          ` same => n,Set(M=\${CUT(MEMBERS,&,$[(\${I} + \${K}) % ${ring.length} + 1])})`,
          ` same => n,Dial(PJSIP/\${M}&PJSIP/\${M}-web&Local/\${M}@cx-app/n,${d.ring_time},tb(pickup-mark^s^1))`,
          ' same => n,GotoIf($["${DIALSTATUS}" = "ANSWER" | "${DIALSTATUS}" = "CANCEL"]?end)',
          " same => n,Set(K=$[${K} + 1])", " same => n,Goto(next)", " same => n(done),NoOp(Personne n'a répondu)");
      } else {
        L.push(` same => n,Dial(${ring.map(devices).join("&")},${d.ring_time},tb(pickup-mark^s^1))`, ' same => n,GotoIf($["${DIALSTATUS}" = "ANSWER" | "${DIALSTATUS}" = "CANCEL"]?end)');
      }
    } else L.push(` same => n,NoOp(Aucun membre disponible dans le groupe ${o.number})`);
    pushApps(L, destApps(d.no_answer, m));
    L.push(` same => n(loop),Log(WARNING,Boucle de renvois détectée : groupe ${o.number})`, " same => n(end),Hangup()", ...tails);
  }
  for (const o of byKind(m.objects, "queue")) {
    const d = o.data;
    L.push(`; ---- File d'attente ${o.number} ${nameOf(o)}`, `exten => ${o.number},1,NoOp(File ${o.number} ${nameOf(o)})`);
    hopGuard(L);
    L.push(" same => n,Set(CDR(dest_kind)=queue)", " same => n,Set(__RINGTYPE=file)");
    const tails = officeGate(L, o, m);
    L.push(" same => n,Answer()");
    const g = d.greeting && find(m.objects, "prompt", d.greeting);
    if (g?.data?.file) L.push(` same => n,Playback(${promptPath(m.soundsDir, g)})`);
    L.push(` same => n,Queue(q${o.number},t,,,${d.max_wait})`);
    pushApps(L, destApps(d.no_answer, m));
    L.push(` same => n(loop),Log(WARNING,Boucle de renvois détectée : file ${o.number})`, " same => n(end),Hangup()", ...tails);
  }
  for (const o of byKind(m.objects, "ivr")) {
    L.push(`; ---- SVI ${o.number} ${nameOf(o)}`, `exten => ${o.number},1,NoOp(SVI ${o.number} ${nameOf(o)})`);
    hopGuard(L);
    const tails = officeGate(L, o, m);
    L.push(` same => n,Goto(ivr-${o.number},s,1)`, ` same => n(loop),Log(WARNING,Boucle de renvois détectée : SVI ${o.number})`, " same => n,Hangup()", ...tails);
  }
  for (const o of byKind(m.objects, "conf")) {
    // Salle de réunion : audio pour les téléphones, vidéo (SFU) pour les softphones web
    L.push(`; ---- Réunion ${o.number} ${nameOf(o)}`, `exten => ${o.number},1,NoOp(Réunion ${o.number} ${nameOf(o)})`, " same => n,Set(CDR(dest_kind)=conf)", " same => n,Answer()");
    if (o.data.pin) L.push(` same => n,Authenticate(${o.data.pin})`);
    L.push(` same => n,Set(CONFBRIDGE(bridge,max_members)=${o.data.max_members})`, ` same => n,Set(CONFBRIDGE(bridge,video_mode)=${o.data.video ? "sfu" : "none"})`,
      ` same => n,ConfBridge(conf-${o.number},callikoe_bridge,callikoe_user,callikoe_menu)`, " same => n,Hangup()");
  }
  for (const o of byKind(m.objects, "groupvm")) {
    L.push(`; ---- Messagerie de groupe ${o.number} ${nameOf(o)}`, `exten => ${o.number},1,NoOp(Messagerie de groupe ${o.number})`,
      " same => n,Set(CDR(dest_kind)=groupvm)", ` same => n,VoiceMail(${o.number}@default,u)`, " same => n,Hangup()");
  }
  L.push("", "; Supervision (BLF) des groupes et files : occupé si un membre est en ligne", "[callflow-hints]");
  for (const o of [...byKind(m.objects, "group"), ...byKind(m.objects, "queue")]) {
    const mem = o.data.members.filter((x) => m.users.has(x));
    if (mem.length) L.push(`exten => ${o.number},hint,${mem.map((x) => `PJSIP/${x}&PJSIP/${x}-web`).join("&")}`);   // voyant : postes et softphone (pas l'appli)
  }

  // SVI : un contexte par menu (WaitExten attend les touches dans le contexte courant)
  for (const o of byKind(m.objects, "ivr")) {
    const d = o.data;
    const p = d.prompt && find(m.objects, "prompt", d.prompt);
    L.push("", `[ivr-${o.number}]`, "exten => s,1,Answer()", " same => n,Set(CDR(dest_kind)=ivr)", " same => n,Set(__RINGTYPE=svi)", " same => n,Set(TRIES=0)", " same => n,Set(TIMEOUT(digit)=2)");
    if (d.speech && m.speech) {
      // L'appelant peut taper une touche pendant l'annonce, ou parler : sa phrase est enregistrée (fin après 2 s de silence, 7 s au plus)
      // puis la console (IA) choisit la touche correspondante ; sinon, retour au fonctionnement normal
      L.push(` same => n(menu),${p?.data?.file ? `Background(${promptPath(m.soundsDir, p)})` : "Wait(1)"}`, " same => n,WaitExten(1)",
        ` same => n,Record(${m.speech.dir}/svi-\${UNIQUEID}-\${TRIES}.wav,2,7,q)`,
        " same => n,Set(CURLOPT(httptimeout)=15)",
        ` same => n,Set(SVI_CHOICE=\${CURL(${m.speech.url}&ivr=${o.id}&u=\${UNIQUEID}-\${TRIES})})`,
        " same => n,GotoIf($[\"${SVI_CHOICE}\" != \"\"]?${SVI_CHOICE},1)", ` same => n,WaitExten(${Math.max(1, d.timeout - 1)})`);
    } else L.push(` same => n(menu),${p?.data?.file ? `Background(${promptPath(m.soundsDir, p)})` : "Wait(1)"}`, ` same => n,WaitExten(${d.timeout})`);
    for (const [k, dest] of Object.entries(d.options)) {
      L.push(`exten => ${k},1,NoOp(SVI ${o.number} : touche ${k})`);
      pushApps(L, destApps(dest, m));
    }
    if (d.direct_dial) {
      L.push("exten => _XXX,1,GotoIf(${DIALPLAN_EXISTS(users,${EXTEN},1)}?users,${EXTEN},1)",
        " same => n,GotoIf(${DIALPLAN_EXISTS(callflow,${EXTEN},1)}?callflow,${EXTEN},1)", " same => n,Goto(i,1)");
    }
    for (const x of ["t", "i"]) {
      L.push(`exten => ${x},1,Set(TRIES=$[\${TRIES} + 1])`);
      if (x === "i") L.push(" same => n,Playback(option-is-invalid)");
      L.push(` same => n,GotoIf($[\${TRIES} <= ${d.retries}]?s,menu)`);
      pushApps(L, destApps(d.invalid, m));
    }
  }

  // Standardiste IA : la console (IA) répond en direct par AudioSocket ; transferts vers les destinations réglées (cx-ai-out)
  if (m.speech) {
    const r = m.receptionist || {};
    const reg = (mode) => `Set(CXAI=\${CURL(${m.speech.aiUrl}&mode=${mode}&from=\${URIENCODE(\${CALLERID(num)})}&name=\${URIENCODE(\${CALLERID(name)})}&chan=\${URIENCODE(\${CHANNEL})}&did=\${URIENCODE(\${CDR(did)})})})`;
    L.push("", "[cx-ai]");
    for (const [ex, mode] of [["s", "full"], ["msg", "msg"]]) {
      L.push(`exten => ${ex},1,Answer()`, " same => n,Set(CDR(dest_kind)=ai)", " same => n,Set(CURLOPT(httptimeout)=8)", ` same => n,${reg(mode)}`,
        ` same => n,GotoIf($["\${CXAI}" = ""]?off)`, ` same => n,AudioSocket(\${CXAI},${m.speech.audiosocket})`, " same => n,Hangup()");
      pushApps(L, destApps(r.fallback || { type: "hangup", target: "" }, m), "off");
    }
    L.push("", "[cx-ai-out]");
    (r.transfers || []).forEach((t, i) => { L.push(`exten => ${i + 1},1,NoOp(Standardiste IA : ${clean(t.label, 40)})`); pushApps(L, destApps(t.dest, m)); });
  }

  // Interphone : demande aux postes (et au softphone web) de décrocher tout seuls
  L.push("", "[page-headers]", "exten => s,1,Set(PJSIP_HEADER(add,Call-Info)=<sip:pbx>\\;answer-after=0)", " same => n,Set(PJSIP_HEADER(add,Alert-Info)=<http://127.0.0.1>\\;info=alert-autoanswer)", " same => n,Return()");

  // Membres des files : Local/<poste>@queue-ring (sonne poste + softphone web)
  L.push("", "[queue-ring]", "exten => _XXX,1,Dial(PJSIP/${EXTEN}&PJSIP/${EXTEN}-web&Local/${EXTEN}@cx-app/n,,tb(pickup-mark^s^1))", " same => n,Hangup()");
  // Appli mobile : la sonne tout de suite si elle est ouverte, sinon réveille le téléphone (notification) et attend qu'elle soit prête
  if (m.speech?.appUrl) {
    const u = m.speech.appUrl;
    L.push("", "[cx-app]", "exten => _X.,1,Set(CDR_PROP(disable)=1)",
      ' same => n,GotoIf($["${DB_EXISTS(cxapp/${EXTEN})}" != "1"]?none)',
      " same => n,Set(CURLOPT(httptimeout)=10)",
      ` same => n,Set(CXAPP=\${CURL(${u}&ext=\${EXTEN}&call=\${UNIQUEID}&num=\${URIENCODE(\${CALLERID(num)})}&name=\${URIENCODE(\${CALLERID(name)})})})`,
      ' same => n,GotoIf($["${CXAPP}" = "dial"]?dial)', ' same => n,GotoIf($["${CXAPP}" != "wait"]?none)', " same => n,Set(I=0)",
      " same => n(wait),Wait(0.5)",
      ` same => n,GotoIf($["\${CURL(${u}&call=\${UNIQUEID}&poll=1)}" = "ready"]?dial)`,
      " same => n,Set(I=$[${I} + 1])", ` same => n,GotoIf($[\${I} < ${2 * 20}]?wait)`, " same => n,Goto(none)",
      " same => n(dial),Set(C=${PJSIP_DIAL_CONTACTS(${EXTEN}-app)})", ' same => n,GotoIf($["${C}" = ""]?none)',
      " same => n,Dial(${C},,b(cx-app-hdr^s^1(${UNIQUEID})))",
      " same => n(none),Hangup()",
      `exten => h,1,Set(R=\${CURL(${u}&call=\${UNIQUEID}&end=1)})`,
      "", "[cx-app-hdr]", "exten => s,1,Set(PJSIP_HEADER(add,X-Callikoe-Call)=${ARG1})", " same => n,Return()");
  }

  // Horaires : Gosub qui renvoie open, closed ou holiday
  for (const o of byKind(m.objects, "schedule")) {
    const d = o.data;
    L.push("", `[sched-${o.id}]`, `exten => s,1,NoOp(Horaires ${nameOf(o)})`);
    if (d.override !== "auto") { L.push(` same => n,Return(${d.override === "open" ? "open" : "closed"})`); continue; }
    L.push(` same => n,Set(LOCAL(D)=\${STRFTIME(\${EPOCH},${tz},%Y%m%d)})`, ` same => n,GotoIf(\${DIALPLAN_EXISTS(sched-${o.id}-closed,\${D},1)}?holiday)`);
    for (const [day] of DAYS) for (const [a, b] of d.week[day] || []) L.push(` same => n,GotoIfTime(${a}-${minusOne(b)},${day},*,*,${tz}?open)`);
    for (const [day] of DAYS) { const r = d.week[day] || []; if (r.length > 1) L.push(` same => n,GotoIfTime(${r[0][0]}-${minusOne(r.at(-1)[1])},${day},*,*,${tz}?break)`); }
    L.push(" same => n,Return(closed)", " same => n(open),Return(open)", " same => n(break),Return(break)", " same => n(holiday),Return(holiday)");
    L.push(`[sched-${o.id}-closed]`);
    for (const [day, label] of closedDays(d, year, year + 2)) L.push(`exten => ${day.replace(/-/g, "")},1,NoOp(${clean(label, 40)})`);
  }

  // Règles entrantes
  L.push("", "; SDA → règle entrante", "[did-rules]");
  for (const o of byKind(m.objects, "rule")) {
    for (const did of o.data.dids) L.push(`exten => ${did},1,Goto(rule-${o.id},s,1)`);
    if (o.data.is_default) L.push(`exten => default,1,Goto(rule-${o.id},s,1)`);
  }
  for (const o of m.objects.filter((x) => OFFICE_KINDS.includes(x.kind))) for (const did of o.data.dids || []) L.push(`exten => ${did},1,Goto(callflow,${o.number},1)`);
  for (const o of byKind(m.objects, "rule")) {
    const d = o.data;
    const sched = d.schedule && find(m.objects, "schedule", d.schedule);
    L.push("", `[rule-${o.id}]`, `exten => s,1,NoOp(Règle entrante ${nameOf(o)})`, " same => n,Set(CDR(rule)=" + nameOf(o) + ")");
    if (sched) {
      L.push(` same => n,Gosub(sched-${sched.id},s,1)`, ' same => n,GotoIf($["${GOSUB_RETVAL}" = "holiday"]?holiday)', ' same => n,GotoIf($["${GOSUB_RETVAL}" = "closed"]?closed)',
        ' same => n,GotoIf($["${GOSUB_RETVAL}" = "break"]?break)');
      pushApps(L, destApps(d.open, m), "open");
      pushApps(L, destApps(d.closed, m), "closed");
      pushApps(L, destApps(d.break || d.closed, m), "break");
      pushApps(L, destApps(d.holiday || d.closed, m), "holiday");
    } else {
      pushApps(L, destApps(d.open, m), "open");
    }
  }

  // Routages (éditeur visuel / description en texte)
  for (const o of byKind(m.objects, "flow")) {
    for (const did of o.data.dids) L.splice(L.indexOf("[did-rules]") + 1, 0, `exten => ${did},1,Goto(flow-${o.id},s,1)`);
    if (o.data.is_default) L.splice(L.indexOf("[did-rules]") + 1, 0, `exten => default,1,Goto(flow-${o.id},s,1)`);
  }
  for (const o of byKind(m.objects, "flow")) L.push("", ...buildFlow(o, m));

  // Plannings de la semaine
  for (const o of byKind(m.objects, "planning")) {
    for (const did of o.data.dids) L.splice(L.indexOf("[did-rules]") + 1, 0, `exten => ${did},1,Goto(plan-${o.id},s,1)`);
    if (o.data.is_default) L.splice(L.indexOf("[did-rules]") + 1, 0, `exten => default,1,Goto(plan-${o.id},s,1)`);
  }
  for (const o of byKind(m.objects, "planning")) L.push("", ...buildPlanning(o, m, tz, year));

  // Dépannage : test de sonnerie (console › Gestion d'appels › Dépannage), sans journal d'appel
  L.push("", "[cx-ringtest]", "exten => _XXX,1,Set(CDR_PROP(disable)=1)", ' same => n,Set(CALLERID(all)="TEST Callikoe" <0>)', " same => n,Dial(PJSIP/${EXTEN}&PJSIP/${EXTEN}-web,12)", " same => n,Hangup()");

  // Messagerie d'un utilisateur en destination directe
  L.push("", "[vm-direct]", "exten => _XXX,1,VoiceMail(${EXTEN}@default,u)", " same => n,Hangup()", "");
  return L.join("\n");
}

/** Lignes d'une étape de routage : [[label, application], …] */
function stepLines(st, m, tag) {
  const out = [];
  const add = (app, label = "") => out.push([label, app]);
  let cidN = 0;
  const ringUsers = (users, strategy, time) => {
    const ring = ringers(users, m.users);
    if (!ring.length) { add(`NoOp(Personne ne peut sonner : ${users.join(" ")})`); return; }
    const targets = strategy === "hunt" ? ring.map(devices) : [ring.map(devices).join("&")];
    for (const t of targets) { add(`Dial(${t},${time},tb(pickup-mark^s^1))`); add('GotoIf($["${DIALSTATUS}" = "ANSWER" | "${DIALSTATUS}" = "CANCEL"]?end)'); }
  };
  switch (st.type) {
    case "ring": ringUsers(st.users, st.strategy, st.time); break;
    case "group": {
      const g = find(m.objects, "group", st.target);
      if (!g) { add("NoOp(Groupe supprimé)"); break; }
      const d = g.data, time = st.time || d.ring_time;
      add("Set(__RINGTYPE=groupe)");
      { const gp = d.greeting && find(m.objects, "prompt", d.greeting); if (gp?.data?.file) { add("Answer()"); add(`Playback(${promptPath(m.soundsDir, gp)})`); } }
      if (d.cid_prefix) { const lb = `cid${++cidN}`; add(`GotoIf($[\${LEN(\${CID_ORIG})} > 0]?${lb})`); add("Set(__CID_ORIG=${CALLERID(name)})"); add(`Set(CALLERID(name)=${d.cid_prefix} \${CID_ORIG})`, lb); }
      if (d.strategy === "page") { const r = ringers(d.members, m.users); if (r.length) { add(`Page(${r.map(devices).join("&")},db(page-headers^s^1)i,${time})`); add("Goto(end)"); } break; }
      if (d.strategy === "rotate") {
        const ring = ringers(d.members, m.users);
        if (!ring.length) { add("NoOp(Aucun membre disponible)"); break; }
        add(`Set(MEMBERS=${ring.join("&")})`); add(`Set(I=$[0\${RR_${g.number}} % ${ring.length}])`); add(`Set(GLOBAL(RR_${g.number})=$[\${I} + 1])`); add("Set(K=0)");
        add(`GotoIf($[\${K} >= ${ring.length}]?done-${tag})`, `next-${tag}`);
        add(`Set(M=\${CUT(MEMBERS,&,$[(\${I} + \${K}) % ${ring.length} + 1])})`);
        add(`Dial(PJSIP/\${M}&PJSIP/\${M}-web&Local/\${M}@cx-app/n,${time},tb(pickup-mark^s^1))`);
        add('GotoIf($["${DIALSTATUS}" = "ANSWER" | "${DIALSTATUS}" = "CANCEL"]?end)');
        add("Set(K=$[${K} + 1])"); add(`Goto(next-${tag})`); add("NoOp()", `done-${tag}`);
        break;
      }
      ringUsers(d.members, d.strategy === "hunt" ? "hunt" : "all", time);
      break;
    }
    case "queue": {
      const q = find(m.objects, "queue", st.target);
      if (!q) { add("NoOp(File supprimée)"); break; }
      add("Answer()");
      const gr = q.data.greeting && find(m.objects, "prompt", q.data.greeting);
      if (gr?.data?.file) add(`Playback(${promptPath(m.soundsDir, gr)})`);
      add(`Queue(q${q.number},t,,,${q.data.max_wait})`);
      break;
    }
    case "prompt": {
      const p = find(m.objects, "prompt", st.target);
      if (p?.data?.file) { add("Answer()"); add(`Playback(${promptPath(m.soundsDir, p)})`); }
      break;
    }
    default: for (const a of destApps({ type: st.type, target: st.target }, m)) add(a);
  }
  return out;
}
function buildFlow(o, m) {
  const d = o.data;
  const L = [`[flow-${o.id}]`, `exten => s,1,NoOp(${nameOf(o)})`, ` same => n,Set(CDR(rule)=${nameOf(o)})`];
  const sched = d.schedule && find(m.objects, "schedule", d.schedule);
  const branches = ["open", ...(sched ? ["closed", "break", "holiday"].filter((b) => d.branches[b]) : [])];
  if (sched && branches.length > 1) {
    L.push(` same => n,Gosub(sched-${sched.id},s,1)`);
    for (const b of branches.slice(1)) L.push(` same => n,GotoIf($["\${GOSUB_RETVAL}" = "${b}"]?b-${b})`);
  }
  for (const b of branches) {
    L.push(` same => n(b-${b}),NoOp(${BRANCHES[b]})`);
    d.branches[b].forEach((st, i) => { for (const [label, app] of stepLines(st, m, `${b}-${i}`)) L.push(` same => n${label ? `(${label})` : ""},${app}`); });
    L.push(" same => n,Hangup()");
  }
  L.push(" same => n(end),Hangup()");
  return L;
}

/**
 * Planning : le scénario dépend du jour et de l'heure, calculés à chaque appel (fuseau du PBX).
 * Ordre : forcé → journée particulière → jour férié → semaine B (si alternance) → semaine A → « en dehors ».
 */
function buildPlanning(o, m, tz, year) {
  const d = o.data, P = `plan-${o.id}`;
  const sc = (id) => `${P}-sc,sc${id},1`;
  const L = [`[${P}]`, `exten => s,1,NoOp(Planning ${nameOf(o)})`, ` same => n,Set(CDR(rule)=${nameOf(o)})`];
  if (d.override) { L.push(` same => n,Goto(${sc(d.override)})`); }
  else {
    L.push(` same => n,Set(PLAN_D=\${STRFTIME(\${EPOCH},${tz},%Y%m%d)})`);
    if (Object.keys(d.days || {}).length) L.push(` same => n,GotoIf(\${DIALPLAN_EXISTS(${P}-day,\${PLAN_D},1)}?${P}-day,\${PLAN_D},1)`);
    if (d.holidays_fr && d.holiday_scenario) L.push(` same => n,GotoIf(\${DIALPLAN_EXISTS(${P}-hol,\${PLAN_D},1)}?${sc(d.holiday_scenario)})`);
    if (d.alternate) L.push(` same => n,GotoIf(\${DIALPLAN_EXISTS(${P}-wb,\${PLAN_D},1)}?${P}-b,s,1)`);
    L.push(` same => n,Goto(${P}-a,s,1)`);
  }
  const slotLines = (slots, day) => slots.map((x) => ` same => n,GotoIfTime(${x.from}-${minusOne(x.to === "24:00" ? "00:00" : x.to)},${day},*,*,${tz}?${sc(x.s)})`);
  for (const [ctx, week] of [["a", d.week], ...(d.alternate ? [["b", d.week_b]] : [])]) {
    L.push(`[${P}-${ctx}]`, `exten => s,1,NoOp(${ctx === "a" ? (d.alternate ? "Semaine A" : "Semaine type") : "Semaine B"})`);
    for (const day of PLAN_DAYS) L.push(...slotLines(week[day] || [], day));
    L.push(` same => n,Goto(${sc(d.outside)})`);
  }
  if (Object.keys(d.days || {}).length) {
    L.push(`[${P}-day]`);
    for (const [ymd, v] of Object.entries(d.days)) {
      L.push(`exten => ${ymd.replace(/-/g, "")},1,NoOp(${clean(v.label || "Journée particulière", 40)})`, ...slotLines(v.slots, "*"), ` same => n,Goto(${sc(d.outside)})`);
    }
  }
  if (d.holidays_fr && d.holiday_scenario) {
    L.push(`[${P}-hol]`);
    for (let y = year; y <= year + 2; y++) for (const [ymd, label] of planHolidays(y)) L.push(`exten => ${ymd.replace(/-/g, "")},1,NoOp(${clean(label, 40)})`);
  }
  if (d.alternate) {
    // Jours des semaines B sur 3 ans (listés de l'année en cours à dans 2 ans, comme les jours fériés)
    L.push(`[${P}-wb]`);
    for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 3, 0, 1); t += 86400_000) { const ymd = ymdOf(t); if (isWeekB(d, ymd)) L.push(`exten => ${ymd.replace(/-/g, "")},1,NoOp(B)`); }
  }
  L.push(`[${P}-sc]`);
  for (const s of d.scenarios) {
    L.push(`exten => sc${s.id},1,NoOp(Scénario ${clean(s.name, 30)})`, ` same => n,Set(CDR(rule)=${nameOf(o)} · ${clean(s.name, 30)})`);
    (d.branches[s.id] || []).forEach((st, i) => { for (const [label, app] of stepLines(st, m, `${s.id}-${i}`)) L.push(` same => n${label ? `(${label})` : ""},${app}`); });
    L.push(" same => n,Hangup()", " same => n(end),Hangup()");
  }
  return L;
}

/** Contenu de queues_callikoe.conf (inclus dans queues.conf). */
export function buildQueues(m) {
  const L = [`; Files d'attente — écrit par la console web (${new Date().toISOString()}).`];
  for (const o of byKind(m.objects, "queue")) {
    const d = o.data;
    L.push("", `[q${o.number}]`, `strategy = ${d.strategy}`, `timeout = ${d.member_timeout}`, "retry = 2", `wrapuptime = ${d.wrapup}`,
      `musicclass = ${d.moh && find(m.objects, "prompt", d.moh)?.data?.file ? `q${o.number}` : "default"}`, "ringinuse = no", "joinempty = paused,invalid,unavailable", "leavewhenempty = paused,invalid,unavailable",
      `announce-position = ${d.announce_position ? "yes" : "no"}`, `announce-frequency = ${d.announce_position || d.announce_holdtime ? 45 : 0}`,
      `announce-holdtime = ${d.announce_holdtime ? "yes" : "no"}`, "setinterfacevar = yes");
    const per = (d.periodic || []).map((id) => find(m.objects, "prompt", id)).filter((p) => p?.data?.file).map((p) => promptPath(m.soundsDir, p));
    if (per.length) L.push(`periodic-announce = ${per.join(",")}`, `periodic-announce-frequency = ${d.periodic_freq || 30}`);
    for (const x of ringers(d.members, m.users)) {
      L.push(`member => Local/${x}@queue-ring/n,0,${clean(displayName(m.users.get(x)), 40)},hint:${x}@users-hints`);
    }
  }
  L.push("");
  return L.join("\n");
}

/** Musiques d'attente personnalisées : une classe par file (dossier contenant le fichier). */
export function mohClasses(m) {
  return byKind(m.objects, "queue").map((o) => ({ o, p: o.data.moh && find(m.objects, "prompt", o.data.moh) })).filter(({ p }) => p?.data?.file)
    .map(({ o, p }) => ({ cls: `q${o.number}`, dir: `${m.soundsDir}/moh-q${o.number}`, file: p.data.file }));
}
export function buildMoh(m) {
  return [`; Musiques d'attente — écrit par la console web.`, ...mohClasses(m).map((c) => `\n[${c.cls}]\nmode = files\ndirectory = ${c.dir}\nsort = alpha`), ""].join("\n");
}

/** Boîtes vocales de groupe (ajoutées à voicemail_users.conf). */
export function buildGroupVoicemail(m) {
  return byKind(m.objects, "groupvm").map((o) => `${o.number} => ${o.data.pin},${clean(o.data.name, 40)},,,tz=paris`).join("\n");
}

/** Boîtes surveillées par chaque utilisateur (voyant messagerie) : Map(poste → "201@default,800@default"). */
export function mailboxesByUser(m) {
  const out = new Map();
  for (const [id, u] of m.users) {
    const boxes = u.voicemail.enabled ? [`${id}@default`] : [];
    for (const o of byKind(m.objects, "groupvm")) if (o.data.members.includes(id)) boxes.push(`${o.number}@default`);
    out.set(id, boxes.join(",") || null);
  }
  return out;
}

// ------------------------------------------------------------------ Traceur de routage
const USTATUS = STATUSES;
const node = (type, title, extra = {}) => ({ type, title, detail: [], status: "ok", children: [], ...extra });
const MAX_DEPTH = 14;

/**
 * Arbre de la configuration d'un numéro.
 * m : { users: Map, objects, registered: Map(poste → [appareils]), outboundTrunk, trunkDids: Set, legacyInbound: [postes], cc, tz, now }
 */
export function traceNumber(input, m) {
  const raw = String(input || "").trim();
  const digits = raw.replace(/[\s.\-()]/g, "");
  if (!digits) throw new UserError("Tape un numéro : SDA, poste, groupe ou numéro externe.", "number");
  const internal = /^\d{3}$/.test(digits) ? digits : null;
  if (internal) {
    if (m.users.has(internal)) return { query: internal, kind: "internal", root: expand({ type: "user", target: internal }, m, [], 0) };
    const o = m.objects.find((x) => x.number === internal);
    if (o) return { query: internal, kind: "internal", root: expand({ type: o.kind, target: o.id }, m, [], 0) };
    return { query: internal, kind: "internal", root: node("none", `Le numéro ${internal} n'existe pas`, { status: "bad", detail: ["Aucun utilisateur, groupe, file, SVI ou messagerie n'a ce numéro."] }) };
  }
  const n = nationalNumber(digits, m.cc || "33");
  if (!n) throw new UserError("Numéro non reconnu : tape une SDA ou un numéro national (ex. 04 12 34 56 78) ou un numéro interne à 3 chiffres.", "number");

  const roots = [];
  // 1. SDA du PBX ?
  const userDid = [...m.users.values()].find((u) => u.dids.includes(n));
  const rule = m.objects.find((o) => o.kind === "rule" && o.data.dids.includes(n));
  const objDid = m.objects.find((o) => OFFICE_KINDS.includes(o.kind) && (o.data.dids || []).includes(n));
  const flow = m.objects.find((o) => (o.kind === "flow" || o.kind === "planning") && o.data.dids.includes(n));
  const isOurs = m.trunkDids.has(n) || userDid || rule || objDid || flow;
  if (isOurs) {
    const head = node("did", `SDA ${fmt(n)}`, { detail: [] });
    if (!m.trunkDids.has(n)) { head.status = "warn"; head.detail.push("Ce numéro n'est déclaré dans aucun trunk (Trunks › SDA) : vérifie que l'opérateur l'envoie bien sur ce PBX."); }
    if (userDid) {
      head.detail.push(`Attribuée directement à l'utilisateur ${userDid.id} (fiche utilisateur › Général).`);
      head.children.push({ label: "SDA directe", node: expand({ type: "user", target: userDid.id }, m, [], 0) });
    } else if (objDid) {
      head.detail.push(`Attribuée directement à : ${KINDS[objDid.kind].toLowerCase()} ${objDid.number}.`);
      head.children.push({ label: "SDA directe", node: expand({ type: objDid.kind, target: objDid.id }, m, [], 0) });
    } else if (rule) {
      head.children.push({ label: "Règle entrante", node: expandRule(rule, m, [], 0) });
    } else if (flow) {
      head.children.push({ label: flow.kind === "planning" ? "Planning" : "Routage", node: flow.kind === "planning" ? expandPlanning(flow, m) : expandFlow(flow, m) });
    } else {
      const def = m.objects.find((o) => ENTRY_KINDS.includes(o.kind) && o.data.is_default);
      if (def) head.children.push({ label: "Aucune règle pour cette SDA → routage par défaut", node: def.kind === "flow" ? expandFlow(def, m) : def.kind === "planning" ? expandPlanning(def, m) : expandRule(def, m, [], 0) });
      else head.children.push({ label: "Aucune règle pour cette SDA", node: legacyInbound(m) });
    }
    roots.push(head);
  }
  // 2. Qui renvoie vers ce numéro (numéro externe) ?
  const refs = externalRefs(n, m);
  if (refs.length || !isOurs) {
    const head = node("external-refs", refs.length ? `Ce qui renvoie vers ${fmt(n)}` : `${fmt(n)} n'est ni une SDA du PBX, ni la cible d'un renvoi`, {
      status: refs.length ? "info" : "warn",
      detail: refs.length ? [`${refs.length} renvoi${refs.length > 1 ? "s" : ""} trouvé${refs.length > 1 ? "s" : ""}.`] : ["Vérifie le numéro, ou ajoute la SDA dans le trunk (Trunks › SDA)."],
    });
    for (const r of refs) head.children.push({ label: r.when, node: node(r.type, r.who, { status: r.active ? "warn" : "info", detail: [r.active ? "Actif en ce moment" : "Inactif en ce moment (dépend du statut ou de l'horaire)"] }) });
    roots.push(head);
  }
  return { query: n, kind: "number", root: roots.length === 1 ? roots[0] : { type: "multi", title: fmt(n), detail: [], status: "info", children: roots.map((r) => ({ label: "", node: r })) } };
}

function legacyInbound(m) {
  const list = m.legacyInbound || [];
  if (!list.length) return node("none", "Aucune destination", { status: "bad", detail: ["L'appelant entend « service indisponible ». Crée une règle entrante (ou une règle par défaut)."] });
  const nd = node("legacy", "Sonnerie générale (Routes › Appels entrants)", { detail: ["Les postes cochés sonnent ensemble 45 s, puis l'appel est raccroché."] });
  for (const id of list) nd.children.push({ label: "", node: memberNode(id, m) });
  if (!list.some((id) => m.users.has(id) && ringsForGroups(m.users.get(id)))) { nd.status = "bad"; nd.detail.push("Aucun de ces postes ne peut sonner en ce moment."); }
  return nd;
}

function memberNode(id, m) {
  const u = m.users.get(id);
  if (!u) return node("user", `${id} (supprimé)`, { status: "bad" });
  const devs = m.registered.get(id) || [];
  const nd = node("member", `${id} · ${displayName(u)}`, { detail: [], ext: id });
  if (u.options.disabled) { nd.status = "bad"; nd.detail.push("Désactivé : ne sonne pas"); }
  else if (u.status !== "available") { nd.status = "warn"; nd.detail.push(`${USTATUS[u.status]} : ne sonne pas`); }
  else if (!u.options.accept_group_calls) { nd.status = "warn"; nd.detail.push("Refuse les appels de groupe : ne sonne pas"); }
  else if (!devs.length) { nd.status = "warn"; nd.detail.push("Sonne, mais aucun appareil connecté"); }
  else nd.detail.push(`Sonne : ${devs.join(", ")}`);
  return nd;
}

function expandFlow(o, m) {
  const d = o.data;
  const nd = node("rule", `Routage « ${d.name} »`, { detail: [] });
  const sched = d.schedule && find(m.objects, "schedule", d.schedule);
  const now = sched ? scheduleState(sched.data, m.now || new Date(), m.tz) : "open";
  if (sched) nd.detail.push(`Horaires « ${sched.data.name} » : ${describeWeek(sched.data.week)}`);
  else nd.detail.push("Toujours ouvert (pas d'horaires)");
  const branches = ["open", ...(sched ? ["closed", "break", "holiday"] : [])];
  for (const b of branches) {
    const list = d.branches[b];
    const effective = list || d.branches.open;
    const label = `${sched ? BRANCHES[b] : "Tous les appels"}${!list && b !== "open" ? " (même routage qu'ouvert)" : ""}${sched && b === now ? " ← maintenant" : ""}`;
    if (!list && b !== "open") { nd.children.push({ label, node: node("info", "Accepté comme aux heures d'ouverture", { status: "info" }), current: b === now }); continue; }
    nd.children.push({ label, node: chainNode(effective, 0, m, []), current: sched && b === now });
  }
  return nd;
}
function expandPlanning(o, m) {
  const d = o.data;
  const nd = node("rule", `Planning « ${d.name} »`, { detail: [] });
  const { ymd, minute } = localNow(m.now || new Date(), m.tz);
  const now = resolvePlan(d, ymd, minute);
  const name = (id) => d.scenarios.find((x) => x.id === id)?.name || "?";
  if (now.forced) { nd.status = "warn"; nd.detail.push(`Forcé sur le scénario « ${name(d.override)} » (Planning › Forcer)`); }
  else nd.detail.push(`Maintenant : ${now.label.toLowerCase()} → « ${name(now.scenario)} »`);
  const wd = PLAN_DAYS[(new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7];
  const today = d.days?.[ymd]?.slots || (isWeekB(d, ymd) ? d.week_b : d.week)[wd] || [];
  nd.detail.push(`Aujourd'hui : ${describeSlots(today, name) || "aucune plage"} ; sinon « ${name(d.outside)} »`);
  for (const s of d.scenarios) nd.children.push({ label: `${s.name}${s.id === now.scenario ? " ← maintenant" : ""}`, node: chainNode(d.branches[s.id] || [], 0, m, []), current: s.id === now.scenario });
  return nd;
}
/** Suite d'étapes en arbre : chaque étape a pour enfant la suivante (« sans réponse »). */
function chainNode(steps, i, m, path) {
  if (i >= steps.length) return node("hangup", "Fin du routage : raccroche", { status: "warn" });
  const st = steps[i];
  let nd;
  if (st.type === "ring") {
    nd = node("group", `Étape ${i + 1} · Sonne ${st.time} s${st.strategy === "hunt" ? " (l'un après l'autre)" : ""}`, { detail: [] });
    for (const x of st.users) nd.children.push({ label: "Sonne", node: memberNode(x, m) });
    if (!ringers(st.users, m.users).length) { nd.status = "bad"; nd.detail.push("Personne ne peut décrocher en ce moment."); }
  } else if (st.type === "group") {
    const g = find(m.objects, "group", st.target);
    nd = g ? node("group", `Étape ${i + 1} · Groupe ${g.number} · ${g.data.name}`, { detail: [`${GROUP_STRATEGIES[g.data.strategy]}, ${st.time || g.data.ring_time} s`] }) : node("none", "Groupe supprimé", { status: "bad" });
    if (g) { for (const x of g.data.members) nd.children.push({ label: "Membre", node: memberNode(x, m) }); if (!ringers(g.data.members, m.users).length) { nd.status = "bad"; nd.detail.push("Personne ne peut décrocher en ce moment."); } }
  } else if (st.type === "queue") {
    const q = find(m.objects, "queue", st.target);
    nd = q ? node("queue", `Étape ${i + 1} · File ${q.number} · ${q.data.name}`, { detail: [`Attente max ${q.data.max_wait} s`] }) : node("none", "File supprimée", { status: "bad" });
    if (q) for (const x of q.data.members) nd.children.push({ label: "Agent", node: memberNode(x, m) });
  } else if (st.type === "prompt") {
    const p = find(m.objects, "prompt", st.target);
    nd = node("prompt", `Étape ${i + 1} · Annonce « ${p?.data.name || "?"} »`, { status: p ? "ok" : "bad" });
  } else {
    const t = expand({ type: st.type, target: st.target }, m, path, 1);
    t.title = `Étape ${i + 1} · ${t.title}`;
    return t;
  }
  nd.children.push({ label: st.type === "prompt" ? "Puis" : st.type === "queue" ? "Attente dépassée / aucun agent" : "Sans réponse", node: chainNode(steps, i + 1, m, path) });
  return nd;
}

function expandRule(o, m, path, depth) {
  const d = o.data;
  const nd = node("rule", `Règle « ${d.name} »`, { detail: [] });
  const sched = d.schedule && find(m.objects, "schedule", d.schedule);
  if (!sched) {
    nd.detail.push("Toujours ouvert (pas d'horaires)");
    nd.children.push({ label: "Tous les appels", node: expand(d.open, m, path, depth + 1) });
    return nd;
  }
  const now = scheduleState(sched.data, m.now || new Date(), m.tz);
  nd.detail.push(`Horaires « ${sched.data.name} » : ${describeWeek(sched.data.week)}${sched.data.holidays_fr ? " · jours fériés fermés" : ""}`);
  if (sched.data.override !== "auto") { nd.status = "warn"; nd.detail.push(`Forcé en mode ${sched.data.override === "open" ? "« ouvert »" : "« fermé »"} (Horaires)`); }
  const tag = (s) => (s === now ? " ← maintenant" : "");
  nd.children.push({ label: `Ouvert${tag("open")}`, node: expand(d.open, m, path, depth + 1), current: now === "open" });
  nd.children.push({ label: `Fermé${tag("closed")}`, node: expand(d.closed, m, path, depth + 1), current: now === "closed" });
  if (Object.values(sched.data.week).some((r) => r.length > 1)) nd.children.push({ label: `Pause${tag("break")}`, node: expand(d.break || d.closed, m, path, depth + 1), current: now === "break" });
  nd.children.push({ label: `Jour férié / congés${tag("holiday")}`, node: expand(d.holiday || d.closed, m, path, depth + 1), current: now === "holiday" });
  return nd;
}

function expand(dest, m, path, depth) {
  if (!dest) return node("hangup", "Raccroche", { status: "warn" });
  const key = `${dest.type}:${dest.target}`;
  if (path.includes(key)) return node("loop", "Boucle !", { status: "bad", detail: ["Cette destination renvoie vers une étape déjà traversée : l'appel tournerait en rond (coupé par le PBX après 8 sauts)."] });
  if (depth > MAX_DEPTH) return node("deep", "…", { status: "warn", detail: ["Chaîne de renvois trop longue."] });
  const p = [...path, key];
  switch (dest.type) {
    case "hangup": return node("hangup", "Raccroche", { status: "warn" });
    case "ai": case "ai_msg": return node("prompt", dest.type === "ai" ? "Standardiste IA (répond, renseigne, transfère)" : "Standardiste IA (prend un message)", { status: "ok", detail: ["Réglages : Administration › IA. Si l'IA est indisponible : destination de secours."] });
    case "external": {
      const nd = node("external", `Numéro externe ${fmt(dest.target)}`, { detail: [] });
      if (!m.outboundTrunk) { nd.status = "bad"; nd.detail.push("Aucun trunk sortant (Routes) : le renvoi échoue."); }
      else nd.detail.push(`Sort par le trunk ${m.outboundTrunk}`);
      return nd;
    }
    case "user_vm": {
      const u = m.users.get(dest.target);
      return node("voicemail", `Messagerie de ${dest.target}${u ? ` · ${displayName(u)}` : ""}`, { status: u?.voicemail.enabled ? "ok" : "bad", detail: u?.voicemail.enabled ? [] : ["Messagerie désactivée : raccroche."] });
    }
    case "prompt": {
      const o = find(m.objects, "prompt", dest.target);
      return node("prompt", `Annonce « ${o?.data.name || "?"} » puis raccroche`, { status: o?.data?.file ? "ok" : "bad", detail: o ? [] : ["Annonce supprimée."] });
    }
    case "user": return expandUser(dest.target, m, p, depth);
    default: {
      const o = find(m.objects, dest.type, dest.target);
      if (!o) return node("none", "Destination supprimée", { status: "bad", detail: ["Choisis une nouvelle destination."] });
      return expandObject(o, m, p, depth);
    }
  }
}

function expandUser(id, m, path, depth) {
  const u = m.users.get(id);
  if (!u) return node("user", `Utilisateur ${id} (supprimé)`, { status: "bad" });
  const devs = m.registered.get(id) || [];
  const nd = node("user", `${id} · ${displayName(u)}`, { detail: [`Statut : ${USTATUS[u.status]}`], ext: id });
  if (u.options.disabled) { nd.status = "bad"; nd.detail.push("Utilisateur désactivé : l'appelant entend « service indisponible »."); return nd; }
  const vmDest = (d) => d.type === "voicemail" ? { type: "user_vm", target: id } : d.type === "extension" ? { type: "user", target: d.target } : d;
  if (u.status === "away" || u.status === "dnd") {
    nd.status = "warn";
    nd.detail.push("Ne sonne pas : renvoi de statut");
    nd.children.push({ label: `${USTATUS[u.status]} : tous les appels`, node: expand(vmDest(u.forwarding[u.status]), m, path, depth + 1) });
    return nd;
  }
  const ring = [devs.length ? devs.join(", ") : "aucun appareil connecté"];
  if (u.options.ring_mobile && u.mobile) ring.push(`mobile ${fmt(u.mobile)}`);
  nd.detail.push(`Sonne ${u.forwarding.timeout} s : ${ring.join(" + ")}`);
  if (!devs.length && !(u.options.ring_mobile && u.mobile)) { nd.status = "warn"; nd.detail.push("Aucun appareil connecté : passe directement à « occupé / non connecté »."); }
  nd.children.push({ label: `Sans réponse (${u.forwarding.timeout} s)`, node: expand(vmDest(u.forwarding.no_answer), m, path, depth + 1) });
  nd.children.push({ label: "Occupé / non connecté", node: expand(vmDest(u.forwarding.busy), m, path, depth + 1) });
  return nd;
}

function expandObject(o, m, path, depth) {
  const nd = expandObjectBody(o, m, path, depth);
  const d = o.data;
  const sched = OFFICE_KINDS.includes(o.kind) && d.schedule && find(m.objects, "schedule", d.schedule);
  if (sched) {
    const now = scheduleState(sched.data, m.now || new Date(), m.tz);
    nd.detail.push(`Heures de bureau « ${sched.data.name} » : ${describeWeek(sched.data.week)}`);
    const extra = [];
    for (const [st, label] of [["closed", "Bureau fermé"], ["break", "Pause"], ["holiday", "Jour férié / congés"]]) {
      if (d[st]) extra.push({ label: `${label}${st === now ? " ← maintenant" : ""}`, node: expand(d[st], m, path, depth + 1), current: st === now });
    }
    if (extra.length) nd.children.unshift(...extra);
    if (now !== "open" && !d[now]) nd.detail.push(`En ce moment : ${now === "closed" ? "fermé" : now === "break" ? "pause" : "férié"}, mais l'appel est accepté quand même.`);
  }
  if (d.dids?.length) nd.detail.push(`SDA : ${d.dids.map(fmt).join(", ")}`);
  return nd;
}

function expandObjectBody(o, m, path, depth) {
  const d = o.data;
  switch (o.kind) {
    case "group": {
      const nd = node("group", `Groupe ${o.number} · ${d.name}`, { detail: [`${GROUP_STRATEGIES[d.strategy]}, ${d.ring_time} s${d.strategy === "hunt" ? " par membre" : ""}`] });
      for (const x of d.members) nd.children.push({ label: "Membre", node: memberNode(x, m) });
      if (!ringers(d.members, m.users).length) { nd.status = "bad"; nd.detail.push("Personne ne peut décrocher en ce moment : l'appel part directement en « sans réponse »."); }
      nd.children.push({ label: "Sans réponse", node: expand(d.no_answer, m, path, depth + 1) });
      return nd;
    }
    case "queue": {
      const nd = node("queue", `File ${o.number} · ${d.name}`, { detail: [`${QUEUE_STRATEGIES[d.strategy]} · ${d.member_timeout} s par agent · attente max ${d.max_wait} s${d.announce_position ? " · annonce de la position" : ""}`] });
      for (const x of d.members) nd.children.push({ label: "Agent", node: memberNode(x, m) });
      if (!ringers(d.members, m.users).length) { nd.status = "bad"; nd.detail.push("Aucun agent disponible : l'appelant ressort tout de suite de la file."); }
      nd.children.push({ label: "Attente dépassée / aucun agent", node: expand(d.no_answer, m, path, depth + 1) });
      return nd;
    }
    case "ivr": {
      const nd = node("ivr", `SVI ${o.number} · ${d.name}`, { detail: [] });
      const p = d.prompt && find(m.objects, "prompt", d.prompt);
      if (!p) { nd.status = "warn"; nd.detail.push("Pas d'annonce : l'appelant n'entend rien."); } else nd.detail.push(`Annonce « ${p.data.name} »`);
      if (d.direct_dial) nd.detail.push("Composition directe d'un poste autorisée");
      const keys = Object.keys(d.options);
      if (!keys.length) { nd.status = "warn"; nd.detail.push("Aucune touche configurée."); }
      for (const k of keys) nd.children.push({ label: `Touche ${k}`, node: expand(d.options[k], m, path, depth + 1) });
      nd.children.push({ label: `Aucun choix (${d.timeout} s) ou erreur, après ${d.retries} répétition${d.retries > 1 ? "s" : ""}`, node: expand(d.invalid, m, path, depth + 1) });
      return nd;
    }
    case "conf": return node("conf", `Salle de réunion ${o.number} · ${d.name}`, { detail: [`${d.max_members} participants max${d.pin ? " · code PIN" : ""}${d.video ? " · vidéo depuis le softphone web" : ""}`] });
    case "groupvm": return node("voicemail", `Messagerie de groupe ${o.number} · ${d.name}`, { detail: [`Voyant chez : ${d.members.join(", ") || "personne"}`] });
    default: return node("none", d.name);
  }
}

/** Tout ce qui envoie des appels vers un numéro externe donné. */
function externalRefs(n, m) {
  const out = [];
  for (const u of m.users.values()) {
    const who = `${u.id} · ${displayName(u)}`;
    if (u.options.ring_mobile && u.mobile === n) out.push({ type: "user", who, when: "Sonne aussi sur ce mobile (sonnerie simultanée)", active: u.status === "available" && !u.options.disabled });
    for (const [rule, label, active] of [["no_answer", "Renvoi sans réponse", u.status === "available"], ["busy", "Renvoi occupé / non connecté", u.status === "available"], ["away", "Renvoi en Absent", u.status === "away"], ["dnd", "Renvoi en Ne pas déranger", u.status === "dnd"]]) {
      if (u.forwarding[rule]?.type === "external" && u.forwarding[rule].target === n) out.push({ type: "user", who, when: label, active: active && !u.options.disabled });
    }
  }
  for (const o of m.objects) {
    const d = o.data;
    const label = `${KINDS[o.kind]} « ${d.name} »${o.number ? ` (${o.number})` : ""}`;
    const hit = (x) => x?.type === "external" && x.target === n;
    if (hit(d.no_answer)) out.push({ type: o.kind, who: label, when: "Sans réponse", active: true });
    if (hit(d.invalid)) out.push({ type: o.kind, who: label, when: "Choix invalide", active: true });
    for (const [k, v] of Object.entries(d.options || {})) if (hit(v)) out.push({ type: o.kind, who: label, when: `Touche ${k}`, active: true });
    for (const [f, l] of [["open", "Heures d'ouverture"], ["closed", "Fermé"], ["holiday", "Jour férié"]]) if (hit(d[f])) out.push({ type: o.kind, who: label, when: l, active: true });
  }
  return out;
}

/** « Où sont les renvois ? » : tous les renvois et sonneries hors standard, du plus visible au plus discret. */
export function listForwards(m) {
  const rows = [];
  const dl = (d, u) => {
    switch (d.type) {
      case "voicemail": return u.voicemail.enabled ? "sa messagerie" : "raccroche (messagerie désactivée)";
      case "extension": { const t = m.users.get(d.target); return `poste ${d.target}${t ? ` · ${displayName(t)}` : ""}`; }
      case "external": return fmt(d.target);
      default: return "raccroche";
    }
  };
  for (const u of m.users.values()) {
    const who = { id: u.id, name: displayName(u) };
    if (u.options.disabled) { rows.push({ ...who, level: "bad", when: "Utilisateur désactivé", to: "service indisponible", active: true, kind: "disabled" }); continue; }
    if (u.status !== "available") rows.push({ ...who, level: "warn", when: `Statut ${USTATUS[u.status]} : tous les appels`, to: dl(u.forwarding[u.status], u), active: true, kind: "status", external: u.forwarding[u.status].type === "external" });
    for (const [rule, label] of [["no_answer", `Sans réponse (${u.forwarding.timeout} s)`], ["busy", "Occupé / non connecté"]]) {
      const d = u.forwarding[rule];
      if (d.type === "extension" || d.type === "external") rows.push({ ...who, level: "info", when: label, to: dl(d, u), active: u.status === "available", kind: "rule", external: d.type === "external" });
    }
    for (const st of ["away", "dnd"]) {
      const d = u.forwarding[st];
      if (u.status !== st && (d.type === "extension" || d.type === "external")) rows.push({ ...who, level: "info", when: `Si ${USTATUS[st]}`, to: dl(d, u), active: false, kind: "rule", external: d.type === "external" });
    }
    if (u.options.ring_mobile && u.mobile) rows.push({ ...who, level: "info", when: "Sonnerie simultanée", to: `mobile ${fmt(u.mobile)}`, active: u.status === "available", kind: "mobile", external: true });
  }
  for (const o of byKind(m.objects, "planning")) {
    if (o.data.override) rows.push({ id: "", name: `Planning « ${o.data.name} »`, level: "warn", when: "Scénario forcé", to: o.data.scenarios.find((x) => x.id === o.data.override)?.name || "?", active: true, kind: "schedule" });
  }
  for (const o of byKind(m.objects, "schedule")) {
    if (o.data.override !== "auto") rows.push({ id: "", name: `Horaires « ${o.data.name} »`, level: "warn", when: "Mode forcé", to: o.data.override === "open" ? "toujours ouvert" : "toujours fermé", active: true, kind: "schedule" });
  }
  const order = { bad: 0, warn: 1, info: 2 };
  return rows.sort((a, b) => (b.active - a.active) || order[a.level] - order[b.level] || String(a.id).localeCompare(String(b.id)));
}
