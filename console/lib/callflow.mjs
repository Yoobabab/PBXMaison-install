/**
 * Gestion d'appels : groupes d'appel, files d'attente, SVI, messageries de groupe, horaires,
 * règles entrantes (par SDA) et annonces. Fonctions pures (sans base ni AMI), testées dans
 * console/test/callflow.test.mjs :
 *   - validation des objets et des destinations ;
 *   - génération d'extensions_callflow.conf et de queues_callikoe.conf ;
 *   - traceur de routage (arbre de configuration d'un numéro) et liste des renvois actifs.
 */
import { UserError, STATUSES, displayName, nationalNumber, ringsForGroups } from "./users.mjs";

export const KINDS = {
  group: "Groupe d'appel", queue: "File d'attente", ivr: "SVI (standard automatique)", groupvm: "Messagerie de groupe",
  schedule: "Horaires", rule: "Règle entrante", prompt: "Annonce",
};
/** Objets qui ont un numéro interne (composable depuis un poste). */
export const NUMBERED = ["group", "queue", "ivr", "groupvm"];
export const DEST_TYPES = {
  hangup: "Terminer l'appel", user: "Utilisateur", user_vm: "Boîte vocale d'un utilisateur", group: "Groupe d'appel",
  ivr: "Répondeur numérique (SVI)", queue: "File d'attente", groupvm: "Boîte vocale de groupe",
  external: "Transférer vers un numéro externe", prompt: "Lire une annonce puis raccrocher",
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
    case "group": return { name: "", number: "", strategy: "all", members: [], ring_time: 20, cid_prefix: "", no_answer: hang, ...OFFICE };
    case "queue": return { name: "", number: "", strategy: "ringall", members: [], member_timeout: 15, max_wait: 300, wrapup: 5,
      announce_position: true, announce_holdtime: false, greeting: "", moh: "", periodic: [], periodic_freq: 30, no_answer: hang, ...OFFICE };
    case "ivr": return { name: "", number: "", prompt: "", timeout: 5, retries: 2, direct_dial: true, options: {}, invalid: hang, ...OFFICE };
    case "groupvm": return { name: "", number: "", pin: "", members: [] };
    case "schedule": return { name: "", week: Object.fromEntries(DAYS.map(([d]) => [d, ["mon", "tue", "wed", "thu", "fri"].includes(d) ? [["09:00", "12:00"], ["14:00", "18:00"]] : []])),
      holidays_fr: true, holidays: [], override: "auto" };
    case "rule": return { name: "", dids: [], is_default: false, schedule: "", open: hang, closed: hang, break: null, holiday: null };
    case "prompt": return { name: "", file: "", duration: 0 };
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
  if (type === "hangup") return { type, target: "" };
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
    if (input.cid_prefix !== undefined) d.cid_prefix = clean(input.cid_prefix, 20);
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
          const [a, b] = [String(r?.[0] || "").trim(), String(r?.[1] || "").trim()];
          if (!a && !b) continue;
          if (!HHMM.test(a) || !HHMM.test(b)) throw new UserError(`${label} : heures au format HH:MM.`, `week.${day}`);
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
    if (input.holidays !== undefined) {
      const list = [];
      for (const h of Array.isArray(input.holidays) ? input.holidays : []) {
        const from = String(h?.from || "").trim(), to = String(h?.to || h?.from || "").trim();
        if (!from) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) throw new UserError("Date invalide (AAAA-MM-JJ).", "holidays");
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
      const other = ctx.objects.find((o) => o.kind === "rule" && o.id !== ctx.selfId && o.data.is_default);
      if (other) throw new UserError(`La règle « ${other.data.name} » est déjà la règle par défaut.`, "is_default");
    }
    if (input.schedule !== undefined) d.schedule = input.schedule ? (ctx.objects.some((o) => o.kind === "schedule" && o.id === input.schedule) ? input.schedule : (() => { throw new UserError("Horaires introuvables.", "schedule"); })()) : "";
    if (input.open !== undefined) d.open = validateDest(input.open, ctx, "open");
    if (input.closed !== undefined) d.closed = validateDest(input.closed, ctx, "closed");
    if (input.holiday !== undefined) d.holiday = validateDest(input.holiday, ctx, "holiday", { allowNull: true });
    if (input.break !== undefined) d.break = validateDest(input.break, ctx, "break", { allowNull: true });
  } else if (kind === "prompt") {
    // fichier et durée posés par le serveur après conversion
  }
  return { number: d.number || null, name: d.name, data: d };
}

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
    if (kind === "prompt" && (d.greeting === id || d.prompt === id)) where.push("annonce d'accueil");
    if (kind === "schedule" && d.schedule === id) where.push("horaires");
    if (where.length) refs.push({ kind: o.kind, id: o.id, name: d.name, where: where.join(", ") });
  }
  if (kind === "user") {
    // membres de groupes, files, messageries de groupe
    for (const o of objects) if ((o.data.members || []).includes(id)) refs.push({ kind: o.kind, id: o.id, name: o.data.name, where: "membre" });
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
const devices = (ext) => `PJSIP/${ext}&PJSIP/${ext}-web`;

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
    L.push(" same => n,Set(CDR(dest_kind)=group)");
    const tails = officeGate(L, o, m);
    if (d.cid_prefix) L.push(` same => n,Set(CALLERID(name)=${d.cid_prefix} \${CALLERID(name)})`);
    const ring = ringers(d.members, m.users);
    if (ring.length && d.strategy === "page") {
      // Interphone : décroché automatique (Call-Info answer-after=0), le groupe parle à tous les membres
      L.push(` same => n,Page(${ring.map(devices).join("&")},db(page-headers^s^1)i,${d.ring_time})`, " same => n,Goto(end)");
    } else if (ring.length) {
      if (d.strategy === "hunt" || d.strategy === "rotate") {
        // Un membre après l'autre ; en cyclique, on démarre au suivant du dernier appel (variable globale)
        L.push(` same => n,Set(LOCAL(MEMBERS)=${ring.join("&")})`);
        if (d.strategy === "rotate") L.push(` same => n,Set(LOCAL(I)=$[0\${RR_${o.number}} % ${ring.length}])`, ` same => n,Set(GLOBAL(RR_${o.number})=$[\${I} + 1])`);
        else L.push(" same => n,Set(LOCAL(I)=0)");
        L.push(" same => n,Set(LOCAL(K)=0)",
          ` same => n(next),GotoIf($[\${K} >= ${ring.length}]?done)`,
          ` same => n,Set(LOCAL(M)=\${CUT(MEMBERS,&,$[(\${I} + \${K}) % ${ring.length} + 1])})`,
          ` same => n,Dial(PJSIP/\${M}&PJSIP/\${M}-web,${d.ring_time},tb(pickup-mark^s^1))`,
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
    L.push(" same => n,Set(CDR(dest_kind)=queue)");
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
  for (const o of byKind(m.objects, "groupvm")) {
    L.push(`; ---- Messagerie de groupe ${o.number} ${nameOf(o)}`, `exten => ${o.number},1,NoOp(Messagerie de groupe ${o.number})`,
      " same => n,Set(CDR(dest_kind)=groupvm)", ` same => n,VoiceMail(${o.number}@default,u)`, " same => n,Hangup()");
  }
  L.push("", "; Supervision (BLF) des groupes et files : occupé si un membre est en ligne", "[callflow-hints]");
  for (const o of [...byKind(m.objects, "group"), ...byKind(m.objects, "queue")]) {
    const mem = o.data.members.filter((x) => m.users.has(x));
    if (mem.length) L.push(`exten => ${o.number},hint,${mem.map(devices).join("&")}`);
  }

  // SVI : un contexte par menu (WaitExten attend les touches dans le contexte courant)
  for (const o of byKind(m.objects, "ivr")) {
    const d = o.data;
    const p = d.prompt && find(m.objects, "prompt", d.prompt);
    L.push("", `[ivr-${o.number}]`, "exten => s,1,Answer()", " same => n,Set(CDR(dest_kind)=ivr)", " same => n,Set(TRIES=0)", " same => n,Set(TIMEOUT(digit)=2)");
    L.push(` same => n(menu),${p?.data?.file ? `Background(${promptPath(m.soundsDir, p)})` : "Wait(1)"}`, ` same => n,WaitExten(${d.timeout})`);
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

  // Interphone : demande aux postes (et au softphone web) de décrocher tout seuls
  L.push("", "[page-headers]", "exten => s,1,Set(PJSIP_HEADER(add,Call-Info)=<sip:pbx>\\;answer-after=0)", " same => n,Set(PJSIP_HEADER(add,Alert-Info)=<http://127.0.0.1>\\;info=alert-autoanswer)", " same => n,Return()");

  // Membres des files : Local/<poste>@queue-ring (sonne poste + softphone web)
  L.push("", "[queue-ring]", "exten => _XXX,1,Dial(PJSIP/${EXTEN}&PJSIP/${EXTEN}-web,,tb(pickup-mark^s^1))", " same => n,Hangup()");

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

  // Messagerie d'un utilisateur en destination directe
  L.push("", "[vm-direct]", "exten => _XXX,1,VoiceMail(${EXTEN}@default,u)", " same => n,Hangup()", "");
  return L.join("\n");
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
  const isOurs = m.trunkDids.has(n) || userDid || rule || objDid;
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
    } else {
      const def = m.objects.find((o) => o.kind === "rule" && o.data.is_default);
      if (def) head.children.push({ label: "Aucune règle pour cette SDA → règle par défaut", node: expandRule(def, m, [], 0) });
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
  const nd = node("member", `${id} · ${displayName(u)}`, { detail: [] });
  if (u.options.disabled) { nd.status = "bad"; nd.detail.push("Désactivé : ne sonne pas"); }
  else if (u.status !== "available") { nd.status = "warn"; nd.detail.push(`${USTATUS[u.status]} : ne sonne pas`); }
  else if (!u.options.accept_group_calls) { nd.status = "warn"; nd.detail.push("Refuse les appels de groupe : ne sonne pas"); }
  else if (!devs.length) { nd.status = "warn"; nd.detail.push("Sonne, mais aucun appareil connecté"); }
  else nd.detail.push(`Sonne : ${devs.join(", ")}`);
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
  const nd = node("user", `${id} · ${displayName(u)}`, { detail: [`Statut : ${USTATUS[u.status]}`] });
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
  for (const o of byKind(m.objects, "schedule")) {
    if (o.data.override !== "auto") rows.push({ id: "", name: `Horaires « ${o.data.name} »`, level: "warn", when: "Mode forcé", to: o.data.override === "open" ? "toujours ouvert" : "toujours fermé", active: true, kind: "schedule" });
  }
  const order = { bad: 0, warn: 1, info: 2 };
  return rows.sort((a, b) => (b.active - a.active) || order[a.level] - order[b.level] || String(a.id).localeCompare(String(b.id)));
}
