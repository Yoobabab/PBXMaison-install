/**
 * Sauvegarde 3CX (v18 / v20, fichier « …Db.xml » du .zip) → données d'import Callikoe.
 * Fonction pure, testée dans console/test/import3cx.test.mjs. Le navigateur extrait le XML (et les annonces .wav)
 * du .zip ; la console réutilise ensuite l'import habituel (aperçu, puis import) partie par partie.
 *
 * Résultat : tables (CSV Callikoe : trunks, utilisateurs, règles entrantes, sortantes, annuaire), schedules (horaires
 * par service 3CX), prompts (annonces à reprendre), objects (groupes, files, SVI, messageries de groupe, avec leurs
 * destinations à résoudre après création), forwards (renvois des fiches), notes (ce qui reste à faire à la main).
 */
import { parseXml, kid, kids, txt } from "./xmlmini.mjs";
import { nationalNumber } from "./users.mjs";

const DAYS = { Monday: "mon", Tuesday: "tue", Wednesday: "wed", Thursday: "thu", Friday: "fri", Saturday: "sat", Sunday: "sun" };
const DAY_FR = { mon: "lundi", tue: "mardi", wed: "mercredi", thu: "jeudi", fri: "vendredi", sat: "samedi", sun: "dimanche" };
const ROLE_FR = { users: "Utilisateur", receptionists: "Pilote", managers: "Superviseur", group_owners: "Superviseur", group_admins: "Superviseur",
  system_admins: "Superviseur", system_owners: "Superviseur" };
const CODECS = { pcma: "alaw", g711a: "alaw", pcmu: "ulaw", g711u: "ulaw", g722: "g722", gsm: "gsm" };
const VM_MAIL = { None: "Non", Notification: "Avis seul", Attachment: "Avec le message", AttachmentAndDelete: "Avec le message, effacé du répondeur" };
const GROUP_STRAT = { RingAll: "all", Hunt: "hunt", Prioritized: "hunt", Paging: "page", RoundRobin: "rotate" };
const QUEUE_STRAT = { RingAll: "ringall", Hunt: "linear", Prioritized: "linear", RoundRobin: "rrmemory", LongestWaiting: "leastrecent", LeastTalkTime: "fewestcalls",
  FewestAnswered: "fewestcalls", HuntRandomStart: "random", Random: "random", RingAllHuntRandomStart: "random" };
const prop = (el, name) => { for (const p of kids(el, "Properties/DNProperty")) if (txt(p, "Name") === name) return txt(p, "Value"); return ""; };
const yes = (v) => /^(true|1)$/i.test(String(v || "").trim());
const clamp = (v, a, b, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(b, Math.max(a, n)) : def; };
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Nom de trunk Callikoe : « NETW Siège » → « netw-siege » */
export const trunkSlug = (name) => {
  const s = String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return /^[a-z]/.test(s) && s.length >= 2 ? s : `trunk-${s || "1"}`.slice(0, 30);
};
/** Nom d'annonce à partir du fichier 3CX : « 001 PREDEC CONCEPT.wav » → « 001 PREDEC CONCEPT » */
export const promptName = (file) => String(file || "").replace(/\.wav$/i, "").replace(/[\r\n"<>,;|\\()[\]{}$_]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);

/** Plages horaires 3CX → semaine Callikoe */
function weekOf(hours) {
  const week = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  for (const pd of kids(hours, "PeriodsOfDay")) {
    const d = DAYS[pd.attrs.DayOfWeek]; if (!d) continue;
    for (const p of kids(pd, "PeriodOfDay")) {
      const a = (p.attrs.begin || "").slice(0, 5), b = (p.attrs.end || "").slice(0, 5);
      if (/^\d\d:\d\d$/.test(a) && /^\d\d:\d\d$/.test(b) && week[d].length < 4) week[d].push([a, b === "00:00" ? "24:00" : b]);
    }
    week[d].sort((x, y) => toMin(x[0]) - toMin(y[0]));
  }
  return week;
}

export function convert3cx(xml, { cc = "33", templates = [] } = {}) {
  const root = typeof xml === "string" ? parseXml(xml) : xml;
  if (root.tag !== "PhoneSystem") throw new Error("Ce fichier n'est pas une sauvegarde 3CX (…Db.xml introuvable ou illisible).");
  const version = txt(root, "header/version");
  const t = kid(root, "Tenants/Tenant") || root;
  const dns = kid(t, "DN") || { children: [] };
  const notes = [];
  const nat = (n) => nationalNumber(String(n || "").replace(/^\*+/, "").replace(/[^\d+]/g, ""), cc) || "";
  const users = new Set(dns.children.filter((e) => e.tag === "Extension").map((e) => txt(e, "Number")));
  const kindOfDn = new Map();
  for (const el of dns.children) {
    const n = txt(el, "Number");
    if (el.tag === "Extension") kindOfDn.set(n, "user");
    else if (el.tag === "RingGroup") kindOfDn.set(n, "group");
    else if (el.tag === "Queue") kindOfDn.set(n, "queue");
    else if (el.tag === "IVR") kindOfDn.set(n, "ivr");
  }
  // Messageries de groupe (3CX : « messagerie » d'un groupe ou d'une file) : créées à part, numéros 9xx libres
  const taken = new Set(kindOfDn.keys());
  const groupVm = new Map();
  const vmFor = (dn) => {
    if (!groupVm.has(dn)) { let n = 900; while (taken.has(String(n)) && n < 999) n++; taken.add(String(n)); groupVm.set(dn, String(n)); }
    return groupVm.get(dn);
  };

  /** Destination 3CX → { type, ref } (ref : numéro de poste, de groupe… ou numéro externe) ; null si aucune */
  const specOf = (to, dn, num) => {
    switch (to) {
      case "VoiceMail": return !dn ? null : users.has(dn) ? { type: "user_vm", ref: dn } : kindOfDn.has(dn) ? { type: "groupvm", ref: vmFor(dn), of: dn } : null;
      case "Extension": return dn ? { type: "user", ref: dn } : null;
      case "RingGroup": return dn ? { type: "group", ref: dn } : null;
      case "Queue": return dn ? { type: "queue", ref: dn } : null;
      case "IVR": case "DigitalReceptionist": return dn ? { type: "ivr", ref: dn } : null;
      case "External": case "ExternalNumber": case "Mobile": case "MyMobile": { const n = nat(num) || String(num || "").replace(/[^\d+]/g, ""); return n ? { type: "external", ref: n } : null; }
      case "EndCall": case "None": return { type: "hangup", ref: "" };
      default: return dn && kindOfDn.has(dn) ? { type: kindOfDn.get(dn), ref: dn } : null;
    }
  };
  const specOfEl = (el) => {
    if (!el) return null;
    const ext = kid(el, "External") || kid(el, "Mobile");
    return specOf(txt(el, "To"), kid(el, "Internal")?.attrs.DN || txt(el, "Internal"), (ext && (ext.attrs.Number || ext.attrs.ExternalNumber || ext.text.trim())) || txt(el, "Number") || txt(el, "ExternalNumber"));
  };
  /** Route d'un numéro selon l'heure (« IVR.803. », « Extension.101. », « ProceedWithNoExceptions.. ») */
  const specOfRoute = (s) => {
    const m = /^([A-Za-z]+)\.([^.]*)\.(.*)$/.exec(String(s || "").trim());
    if (!m || m[1] === "ProceedWithNoExceptions" || m[1] === "None") return null;
    return specOf(m[1], m[2], m[3] || m[2]);
  };
  const destText = (s) => {
    if (!s) return "";
    return { user: `Utilisateur ${s.ref}`, user_vm: `Messagerie ${s.ref}`, group: `Groupe ${s.ref}`, queue: `File ${s.ref}`, ivr: `SVI ${s.ref}`,
      groupvm: `Messagerie de groupe ${s.ref}`, external: `Numéro ${s.ref}`, hangup: "Raccrocher" }[s.type] || "";
  };

  // ---- Services 3CX (départements) : horaires, pauses, membres
  const OFFICE = "Horaires du bureau (3CX)";
  const schedules = [], deptOf = new Map(), roleOf = new Map();
  for (const g of kids(t, "Groups/Group")) {
    const gname = txt(g, "Name");
    const name = gname === "__DEFAULT__" || !schedules.length ? OFFICE : `Horaires ${gname}`.slice(0, 50);
    for (const m of kids(g, "Members/Member")) {
      if (!deptOf.has(m.attrs.DN)) deptOf.set(m.attrs.DN, name);
      const r = kid(m, "role")?.attrs.name;
      if (r && (!roleOf.has(m.attrs.DN) || m.attrs.IsPrimary === "true")) roleOf.set(m.attrs.DN, r);
    }
    const hours = kid(g, "Hours");
    if (!hours || !kids(hours, "PeriodsOfDay").length) continue;
    const week = weekOf(hours);
    // Pauses 3CX : Callikoe ne connaît que la pause entre deux plages d'une même journée
    const brk = weekOf(kid(g, "BreakTime") || { children: [] });
    const pauses = {};
    for (const [d, list] of Object.entries(brk)) {
      const w = week[d];
      for (const [a, b] of list) {
        const inside = w.length && toMin(a) >= toMin(w[0][0]) && toMin(b) <= toMin(w.at(-1)[1]);
        if (inside) {   // pause au milieu de la journée : on coupe la plage
          const cut = [];
          for (const [x, y] of w) {
            if (toMin(b) <= toMin(x) || toMin(a) >= toMin(y)) cut.push([x, y]);
            else { if (toMin(a) > toMin(x)) cut.push([x, a]); if (toMin(b) < toMin(y)) cut.push([b, y]); }
          }
          week[d] = cut;
        } else (pauses[d] ||= []).push([a, b]);   // avant l'ouverture ou après la fermeture : pause à part
      }
    }
    const holidays = kids(g, "OfficeHolidays/Holiday").concat(kids(t, "OfficeHolidays/Holiday")).map((h) => {
      const from = (txt(h, "DateTimeRangeBegin") || h.attrs.Begin || "").slice(0, 10), to = (txt(h, "DateTimeRangeEnd") || h.attrs.End || "").slice(0, 10) || from;
      return /^\d{4}-\d\d-\d\d$/.test(from) ? { from, to: /^\d{4}-\d\d-\d\d$/.test(to) ? to : from, label: (txt(h, "Name") || "").slice(0, 60) } : null;
    }).filter(Boolean);
    schedules.push({ name, data: { name, week, pauses, holidays_fr: true, holidays, override: "auto", general: name === OFFICE } });
  }
  const schedFor = (dn) => (schedules.some((s) => s.name === deptOf.get(dn)) ? deptOf.get(dn) : schedules[0]?.name || "");

  // ---- Annonces (fichiers .wav de la sauvegarde) utilisées par les SVI, groupes et files
  const prompts = new Map();
  const promptRef = (file) => { const f = String(file || "").trim(); if (!f || /^Empty\.wav$/i.test(f)) return ""; if (!prompts.has(f)) prompts.set(f, promptName(f)); return f; };

  // ---- Trunks : fournisseurs SIP (VoipProvider) et leurs lignes (ExternalLine)
  const providers = kids(root, "Gateways/VoipProvider");
  const lines = dns.children.filter((e) => e.tag === "ExternalLine");
  const trunkRows = [], trunkOfLine = new Map(), trunkOfGw = new Map();
  const used = new Set();
  for (const p of providers) {
    const name = txt(p, "Name");
    const pl = lines.filter((l) => txt(l, "Gateway") === name);
    if (!pl.length) { notes.push(`Opérateur « ${name} » sans ligne : non importé.`); continue; }
    const host = txt(p, "Host"), port = txt(p, "Port") || txt(p, "ProxyPort") || "5060";
    const proxy = txt(p, "ProxyHost") || txt(p, "OutboundProxy");
    const low = name.toLowerCase();
    const tpl = templates.find((x) => x.id !== "generique" && (low.includes(x.id) || (x.registrar?.host && x.registrar.host === host)))
      || templates.find((x) => x.id === "generique") || { id: "generique", label: "Opérateur générique" };
    const codecs = [...new Set(kids(p, "Codecs/codec").concat(kids(p, "Codecs/Codec")).map((c) => CODECS[(c.attrs.RFCName || c.attrs.Name || c.text || "").trim().toLowerCase()]).filter(Boolean))];
    pl.forEach((l, i) => {
      let slug = trunkSlug(pl.length > 1 ? `${name}-${i + 1}` : name);
      while (used.has(slug)) slug = `${slug.slice(0, 27)}-${used.size}`;
      used.add(slug);
      trunkOfLine.set(l, slug); if (!trunkOfGw.has(name)) trunkOfGw.set(name, slug);
      const dids = txt(l, "DIDNumbers").split(/[:;,\s]+/).map(nat).filter(Boolean);
      const main = nat(txt(l, "ExternalNumber")) || dids[0] || "";
      trunkRows.push([slug, tpl.label, main, host, port, proxy && proxy !== host ? `${proxy}:${port}` : "", txt(l, "AuthID"), txt(l, "AuthPassword"),
        [...new Set(dids.filter((x) => x !== main))].join(", "), codecs.join(",")]);
    });
  }

  // ---- Utilisateurs (Extension), leurs téléphones et leurs renvois
  const userRows = [], forwards = [];
  for (const e of dns.children.filter((x) => x.tag === "Extension")) {
    const n = txt(e, "Number");
    const role = ROLE_FR[roleOf.get(n)] || "Utilisateur";
    const dev = kids(e, "PhoneDevices/PhoneDevice").find((d) => txt(d, "MAC") || d.attrs.MAC || d.attrs.MacAddress);
    const mac = (dev ? txt(dev, "MAC") || dev.attrs.MAC || dev.attrs.MacAddress : "").replace(/[^0-9a-f]/gi, "");
    const model = dev ? txt(dev, "ProvisioningFilename2") || txt(dev, "Model") || dev.attrs.Model || "" : "";
    if (kids(e, "PhoneDevices/PhoneDevice").length > 1) notes.push(`Poste ${n} : ${kids(e, "PhoneDevices/PhoneDevice").length} téléphones dans 3CX, seul le premier est repris.`);
    userRows.push([n, txt(e, "FirstName"), txt(e, "LastName"), txt(e, "EmailAddress"), nat(prop(e, "MOBILENUMBER") || txt(e, "MobileNumber")), nat(txt(e, "OutboundCallerID")), "",
      role, yes(txt(e, "VMEnabled")) ? "Oui" : "Non", txt(e, "VMPIN"), txt(e, "EmailAddress") ? VM_MAIL[txt(e, "VMEmailOptions")] || "Non" : "Non",
      yes(txt(e, "Enabled")) || !txt(e, "Enabled") ? "Non" : "Oui", prop(e, "DONT_SHOW_EXT_IN_PHBK") === "1" ? "Oui" : "Non", "Non", mac.length === 12 ? model : "", mac.length === 12 ? mac : ""]);
    const prof = (nm) => kids(e, "FwdProfiles/FwdProfile").find((p) => txt(p, "Name") === nm);
    const av = prof("Available"), aw = prof("Away");
    const fw = {};
    const timeout = Number(txt(av, "NoAnswerTimeout")) || 0;
    if (timeout >= 5 && timeout <= 120) fw.timeout = timeout;
    const toFw = (s) => !s ? null : s.type === "user_vm" ? { type: "voicemail", target: "" } : s.type === "user" ? { type: "extension", target: s.ref }
      : s.type === "external" ? { type: "external", target: s.ref } : s.type === "hangup" ? { type: "hangup", target: "" } : null;
    const na = toFw(specOfEl(kid(av, "AvailableRoute/NoAnswer/AllCalls"))), bz = toFw(specOfEl(kid(av, "AvailableRoute/Busy/AllCalls")));
    const away = toFw(specOfEl(kid(aw, "AwayRoute/External/AllHours")));
    if (na) fw.no_answer = na; if (bz) fw.busy = bz; if (away) fw.away = away;
    if (Object.keys(fw).some((k) => k !== "timeout" && fw[k].type !== "voicemail") || (fw.timeout && fw.timeout !== 20)) forwards.push({ ext: n, forwarding: fw });
  }

  // ---- Groupes d'appel, files d'attente, SVI (+ leurs horaires 3CX « selon l'heure »)
  const objects = [];
  const office = (el, n) => {
    const closed = specOfRoute(txt(el, "OutOfOfficeHoursRoute")), brk = specOfRoute(txt(el, "BreakTimeRoute")), hol = specOfRoute(txt(el, "HolidaysRoute"));
    if (!closed && !brk && !hol) return {};
    return { schedule: schedFor(n), dests: { closed, break: brk || closed, holiday: hol } };
  };
  for (const el of dns.children) {
    const n = txt(el, "Number"), name = txt(el, "Name") || n;
    if (el.tag === "RingGroup") {
      const o = office(el, n);
      objects.push({ kind: "group", number: n, name, schedule: o.schedule || "",
        input: { strategy: GROUP_STRAT[txt(el, "RingStrategy")] || "all", ring_time: clamp(txt(el, "RingTime"), 5, 300, 20), members: kids(el, "Members/Member").map((m) => m.attrs.DN).filter((d) => users.has(d)),
          greeting: promptRef(prop(el, "GREETING_DEFAULT")) },
        dests: { no_answer: specOfEl(kid(el, "Destination")) || { type: "hangup", ref: "" }, ...(o.dests || {}) } });
      if (/^(Hunt|Prioritized|RingAll|Paging|RoundRobin)$/.test(txt(el, "RingStrategy")) === false && txt(el, "RingStrategy")) notes.push(`Groupe ${n} : stratégie 3CX « ${txt(el, "RingStrategy")} » remplacée par « sonne tous ».`);
    } else if (el.tag === "Queue") {
      const o = office(el, n);
      objects.push({ kind: "queue", number: n, name, schedule: o.schedule || "",
        input: { strategy: QUEUE_STRAT[txt(el, "PollingStrategy")] || "ringall", members: kids(el, "Members/Member").map((m) => m.attrs.DN).filter((d) => users.has(d)),
          member_timeout: clamp(txt(el, "RingTimeout"), 5, 120, 20), max_wait: clamp(txt(el, "MasterTimeout"), 10, 3600, 300), wrapup: Math.min(300, Math.max(0, Number(prop(el, "WRAPUP_TIME")) || 5)),
          announce_position: yes(txt(el, "AnnounceQueuePosition")), announce_holdtime: prop(el, "ANNOUNCE_ESTIMATED_WAITTIME") === "1",
          moh: promptRef(txt(el, "OnHoldFile")), greeting: yes(txt(el, "EnableIntro")) ? promptRef(txt(el, "IntroFile") || prop(el, "GREETING_DEFAULT")) : "" },
        dests: { no_answer: specOfEl(kid(el, "Destination")) || { type: "hangup", ref: "" }, ...(o.dests || {}) } });
    } else if (el.tag === "IVR") {
      if (!/^\d+$/.test(n) || prop(el, "PINPROTECTIONIVR") === "1") continue;   // SVI internes de 3CX
      const o = office(el, n);
      const tt = txt(el, "TimeoutForwardType"), tdn = txt(el, "TimeoutForwardDN");
      const options = {};
      for (const f of kids(el, "Forwards/IVRForward").concat(kids(el, "IVRForwards/IVRForward"))) {
        const key = f.attrs.Number ?? f.attrs.Key ?? txt(f, "Number");
        const s = specOf(txt(f, "ForwardType") || f.attrs.ForwardType, txt(f, "ForwardDN") || f.attrs.ForwardDN, txt(f, "ExternalNumber") || f.attrs.ExternalNumber);
        if (/^[0-9*#]$/.test(key || "") && s) options[key] = s;
      }
      objects.push({ kind: "ivr", number: n, name, schedule: o.schedule || "",
        input: { prompt: promptRef(txt(el, "PromptFilename")), timeout: clamp(txt(el, "Timeout"), 1, 30, 5), retries: Object.keys(options).length ? 1 : 0, direct_dial: prop(el, "DIRECT_FROM_IVR") !== "0" },
        dests: { invalid: specOf(tt, tdn, tdn) || { type: "hangup", ref: "" }, ...Object.fromEntries(Object.entries(options).map(([k, s]) => [`option:${k}`, s])), ...(o.dests || {}) } });
    }
  }
  for (const [of, num] of groupVm) {
    const o = objects.find((x) => x.number === of);
    objects.push({ kind: "groupvm", number: num, name: `Messagerie ${o?.name || of}`.slice(0, 50), schedule: "", input: { members: o?.input.members || [] }, dests: {} });
    notes.push(`La messagerie du ${o?.kind === "queue" ? "la file" : "groupe"} ${of} devient la messagerie de groupe ${num} (code à choisir dans Gestion d'appels › Messageries).`);
  }

  // ---- Règles entrantes : une par SDA (règle « BasedOnDID ») + une pour les autres SDA de la ligne (« ForwardAll »)
  const inboundRows = [], seenDid = new Set();
  for (const l of lines) {
    const slug = trunkOfLine.get(l);
    if (!slug) continue;
    const lineDids = [nat(txt(l, "ExternalNumber")), ...txt(l, "DIDNumbers").split(/[:;,\s]+/).map(nat)].filter(Boolean);
    const rules = kids(l, "RoutingRules/ExternalLineRule");
    const explicit = new Set(rules.filter((r) => kid(r, "Conditions/Condition")?.attrs.Type !== "ForwardAll").flatMap((r) => (txt(r, "Data") || "").split(/[:;,\s]+/).map((x) => nat(x.replace(/\*/g, ""))).filter(Boolean)));
    rules.forEach((r, i) => {
      const all = kid(r, "Conditions/Condition")?.attrs.Type === "ForwardAll";
      let dids = all ? lineDids.filter((d) => !explicit.has(d)) : (txt(r, "Data") || "").split(/[:;,\s]+/).map((x) => nat(x.replace(/\*/g, ""))).filter(Boolean);
      const dup = dids.filter((d) => seenDid.has(d));
      if (dup.length) notes.push(`SDA ${dup.join(", ")} : aussi reçue par le trunk ${slug} dans 3CX, gardée sur la première règle.`);
      dids = [...new Set(dids.filter((d) => !seenDid.has(d)))];
      if (!dids.length) return;
      dids.forEach((d) => seenDid.add(d));
      const fd = kid(r, "ForwardDestinations");
      const hours = kid(r, "Hours")?.attrs.HoursType || kid(r, "Conditions/Hours")?.attrs.Type || "AllHours";
      const openS = specOfEl(kid(fd, "OfficeHoursDestination"));
      const altOut = yes(txt(fd, "AlterDestinationDuringOutOfOfficeHours")), altHol = yes(txt(fd, "AlterDestinationDuringHolidays"));
      const closedS = altOut ? specOfEl(kid(fd, "OutOfOfficeHoursDestination")) : openS;
      const holS = altHol ? specOfEl(kid(fd, "HolidaysDestination")) : null;
      const sched = schedules.length && hours !== "AllHours" && (altOut || altHol) ? schedFor(openS?.ref) : "";
      const same = !sched || (destText(openS) === destText(closedS) && !holS);
      inboundRows.push([dids.length === 1 ? `SDA ${dids[0].replace(/(\d{2})(?=\d)/g, "$1 ")}` : `Ligne ${slug}${rules.length > 1 ? ` ${i + 1}` : ""}`, dids.join(", "), "Non",
        same ? "" : sched, destText(openS) || "Raccrocher", same ? "" : destText(closedS) || "Raccrocher", "", same ? "" : destText(holS)]);
    });
  }

  // ---- Règles sortantes (ordre de priorité 3CX)
  const deptMembers = (g) => [...deptOf.entries()].filter(([dn, s]) => users.has(dn) && /^[1-9]\d{2}$/.test(dn) && s === (g === "__DEFAULT__" ? OFFICE : `Horaires ${g}`.slice(0, 50))).map(([dn]) => dn);
  const outRows = [];
  let maxRoutes = 1;
  for (const r of kids(t, "OutboundRules/OutboundRule").sort((a, b) => Number(txt(a, "Priority")) - Number(txt(b, "Priority")))) {
    const routes = kids(r, "OutboundRoutes/OutboundRoute").map((x) => {
      const gw = txt(x, "Gateway"); if (!gw) return null;
      const cid = txt(x, "OutCID") || txt(x, "CallerID");
      return [trunkOfGw.get(gw) || trunkSlug(gw), txt(x, "StripDigits") || "0", txt(x, "Prepend"), cid ? (nat(cid) || cid) : "Utilisateur"];
    }).filter(Boolean);
    if (!routes.length) continue;
    maxRoutes = Math.max(maxRoutes, routes.length);
    const groups = kids(r, "DNGroups/Group").map((g) => g.text.trim());
    const exts = [...kids(r, "DNRanges/DNRange").map((x) => `${x.attrs.From || txt(x, "From")}-${x.attrs.To || txt(x, "To")}`).filter((x) => x !== "-"),
      ...(groups.length && !(groups.length === 1 && groups[0] === "__DEFAULT__" && kids(t, "Groups/Group").length === 1) ? groups.flatMap(deptMembers) : [])];
    const prefixes = txt(r, "Prefix").split(/[,;\s]+/).filter(Boolean);
    outRows.push({ base: [txt(r, "Name") || "Règle 3CX", prefixes.length >= 10 && ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].every((p) => prefixes.includes(p)) ? "" : prefixes.join(","), [...new Set(exts)].join(","), txt(r, "NumberLengthRanges") || txt(r, "NumberLength")], routes });
  }
  const outHeaders = ["Nom", "Préfixes", "Postes", "Longueurs"];
  for (let i = 1; i <= maxRoutes; i++) outHeaders.push(`Route ${i} : trunk`, `Route ${i} : chiffres retirés`, `Route ${i} : chiffres ajoutés`, `Route ${i} : numéro présenté`);

  // ---- Annuaire de l'entreprise
  const contactRows = kids(t, "PhoneBookEntries/PhoneBookEntry").map((p) => {
    const g = (k) => txt(p, k) || p.attrs[k] || "";
    return [g("FirstName"), g("LastName"), g("CompanyName"), g("PhoneNumber") || g("Business"), g("Mobile") || g("Mobile1"), g("Home"), g("Other") || g("Business2"), g("Email"), ""];
  }).filter((r) => r.slice(3, 7).some(Boolean));

  return {
    version,
    tables: {
      trunks: { headers: ["Nom", "Opérateur", "Numéro principal", "Serveur", "Port", "Proxy", "Identifiant SIP", "Mot de passe", "SDA supplémentaires", "Codecs"], rows: trunkRows },
      users: { headers: ["Poste", "Prénom", "Nom", "E-mail", "Mobile", "Numéro présenté", "SDA", "Rôle", "Messagerie", "Code messagerie", "Messages par e-mail", "Désactivé", "Masqué de l'annuaire", "Appels externes bloqués", "Modèle de téléphone", "Adresse MAC"], rows: userRows },
      inbound: { headers: ["Nom", "SDA", "Par défaut", "Horaires", "Ouvert", "Fermé", "Pause", "Jours fériés"], rows: inboundRows },
      outbound: { headers: outHeaders, rows: outRows.map((r) => [...r.base, ...Array.from({ length: maxRoutes }, (_, i) => r.routes[i] || ["", "", "", ""]).flat()]) },
      contacts: { headers: ["Prénom", "Nom", "Société", "Téléphone", "Mobile", "Domicile", "Autre", "E-mail", "Notes"], rows: contactRows },
    },
    schedules, forwards, notes, objects,
    prompts: [...prompts].map(([file, name]) => ({ file, name })),
  };
}
