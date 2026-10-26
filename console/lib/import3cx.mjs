/**
 * Sauvegarde 3CX (v18 / v20, fichier « …Db.xml » du .zip) → tableaux d'import Callikoe.
 * Fonction pure, testée dans console/test/import3cx.test.mjs. Le navigateur extrait le XML du .zip ; la console
 * réutilise ensuite l'import habituel (aperçu, puis import) partie par partie : trunks, utilisateurs, horaires,
 * règles entrantes, règles sortantes, annuaire. Groupes d'appel, files d'attente et SVI sont listés (à recréer).
 */
import { parseXml, kid, kids, txt, find } from "./xmlmini.mjs";
import { nationalNumber } from "./users.mjs";

const DAYS = { Monday: "mon", Tuesday: "tue", Wednesday: "wed", Thursday: "thu", Friday: "fri", Saturday: "sat", Sunday: "sun" };
const ROLE_FR = { users: "Utilisateur", receptionists: "Pilote", managers: "Superviseur", group_owners: "Superviseur", group_admins: "Superviseur",
  system_admins: "Superviseur", system_owners: "Superviseur" };
const CODECS = { pcma: "alaw", g711a: "alaw", pcmu: "ulaw", g711u: "ulaw", g722: "g722", gsm: "gsm" };
const VM_MAIL = { None: "Non", Notification: "Avis seul", Attachment: "Avec le message", AttachmentAndDelete: "Avec le message, effacé du répondeur" };
const prop = (el, name) => { for (const p of kids(el, "Properties/DNProperty")) if (txt(p, "Name") === name) return txt(p, "Value"); return ""; };
const yes = (v) => /^(true|1)$/i.test(String(v || "").trim());
/** Nom de trunk Callikoe : « NETW Siège » → « netw-siege » */
export const trunkSlug = (name) => {
  const s = String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return /^[a-z]/.test(s) && s.length >= 2 ? s : `trunk-${s || "1"}`.slice(0, 30);
};

/** Destination 3CX ({ To, Internal DN / External … }) → texte de destination Callikoe (« Utilisateur 101 », « Numéro 06… ») */
function destOf(el, cc, types) {
  if (!el) return "";
  const to = txt(el, "To");
  const dn = kid(el, "Internal")?.attrs.DN || txt(el, "Internal");
  const ext = kid(el, "External") || kid(el, "Mobile");
  const num = (ext && (ext.attrs.Number || ext.attrs.ExternalNumber || ext.text.trim())) || txt(el, "Number") || txt(el, "ExternalNumber");
  switch (to) {
    case "VoiceMail": return dn ? `Messagerie ${dn}` : "";
    case "Extension": return dn ? `Utilisateur ${dn}` : "";
    case "RingGroup": return dn ? `Groupe ${dn}` : "";
    case "Queue": return dn ? `File ${dn}` : "";
    case "IVR": case "DigitalReceptionist": return dn ? `SVI ${dn}` : "";
    case "External": case "ExternalNumber": case "Mobile": case "MyMobile": {
      const n = nationalNumber(String(num || "").replace(/[^\d+]/g, ""), cc) || String(num || "").replace(/[^\d+]/g, "");
      return n ? `Numéro ${n}` : "";
    }
    case "EndCall": case "None": case "": return to === "" ? "" : "Raccrocher";
    default: {
      if (dn && types.has(dn)) return `${types.get(dn)} ${dn}`;
      return "";
    }
  }
}
/** Destination 3CX → { type, target } d'un renvoi de fiche utilisateur */
function fwOf(el, cc) {
  const t = destOf(el, cc, new Map());
  if (!t) return null;
  if (t.startsWith("Messagerie")) return { type: "voicemail", target: "" };
  if (t.startsWith("Utilisateur ")) return { type: "extension", target: t.split(" ")[1] };
  if (t.startsWith("Numéro ")) return { type: "external", target: t.slice(7) };
  if (t === "Raccrocher") return { type: "hangup", target: "" };
  return null;
}
/** Plages horaires 3CX (<Hours><PeriodsOfDay DayOfWeek><PeriodOfDay begin end/>) → semaine Callikoe */
function weekOf(hours) {
  const week = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  for (const pd of kids(hours, "PeriodsOfDay")) {
    const d = DAYS[pd.attrs.DayOfWeek]; if (!d) continue;
    for (const p of kids(pd, "PeriodOfDay")) {
      const a = (p.attrs.begin || "").slice(0, 5), b = (p.attrs.end || "").slice(0, 5);
      if (/^\d\d:\d\d$/.test(a) && /^\d\d:\d\d$/.test(b) && week[d].length < 4) week[d].push([a, b === "00:00" ? "24:00" : b]);
    }
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
  // Numéros des autres types (groupes, files, SVI) pour les destinations
  const types = new Map();
  for (const el of dns.children) {
    const n = txt(el, "Number");
    if (el.tag === "RingGroup") types.set(n, "Groupe"); else if (el.tag === "Queue") types.set(n, "File"); else if (el.tag === "IVR") types.set(n, "SVI");
  }

  // ---- Horaires du bureau (groupe par défaut) et jours fériés
  const group = kids(t, "Groups/Group")[0];
  const schedules = [];
  const officeHours = group && kid(group, "Hours");
  const holidays = kids(t, "OfficeHolidays/Holiday").concat(group ? kids(group, "OfficeHolidays/Holiday") : []).map((h) => {
    const from = (h.attrs.Day ? `${h.attrs.Year || new Date().getFullYear()}-${String(h.attrs.Month).padStart(2, "0")}-${String(h.attrs.Day).padStart(2, "0")}` : (txt(h, "DateTimeRangeBegin") || h.attrs.Begin || "").slice(0, 10));
    const to = (txt(h, "DateTimeRangeEnd") || h.attrs.End || "").slice(0, 10) || from;
    return /^\d{4}-\d\d-\d\d$/.test(from) ? { from, to: /^\d{4}-\d\d-\d\d$/.test(to) ? to : from, label: (txt(h, "Name") || h.attrs.Name || "").slice(0, 60) } : null;
  }).filter(Boolean);
  const OFFICE = "Horaires du bureau (3CX)";
  if (officeHours && kids(officeHours, "PeriodsOfDay").length) {
    schedules.push({ name: OFFICE, data: { name: OFFICE, week: weekOf(officeHours), holidays_fr: true, holidays, override: "auto", general: true } });
  }
  const roleOf = new Map((group ? kids(group, "Members/Member") : []).map((m) => [m.attrs.DN, kid(m, "role")?.attrs.name || ""]));

  // ---- Trunks : fournisseurs SIP (VoipProvider) et leurs lignes (ExternalLine)
  const providers = kids(root, "Gateways/VoipProvider").concat(kids(root, "Gateways/Gateway").filter((g) => txt(g, "Type") === "Provider" || txt(g, "Type") === "Gateway" && txt(g, "Host")));
  const lines = dns.children.filter((e) => e.tag === "ExternalLine");
  const trunkRows = [], trunkOfLine = new Map();
  const used = new Set();
  for (const p of providers) {
    const name = txt(p, "Name");
    const pl = lines.filter((l) => txt(l, "Gateway") === name);
    if (!pl.length) { notes.push(`Opérateur « ${name} » sans ligne : non importé.`); continue; }
    const host = txt(p, "Host"), port = txt(p, "Port") || txt(p, "ProxyPort") || "5060";
    const tpl = templates.find((x) => [x.id, x.label].some((v) => String(v || "").toLowerCase().includes(name.toLowerCase())) || (x.registrar?.host && x.registrar.host === host))
      || templates.find((x) => x.id === "generique") || { id: "generique", label: "Opérateur générique" };
    const codecs = [...new Set(kids(p, "Codecs/codec").concat(kids(p, "Codecs/Codec")).map((c) => CODECS[(c.text || c.attrs.Name || "").trim().toLowerCase()]).filter(Boolean))];
    pl.forEach((l, i) => {
      let slug = trunkSlug(pl.length > 1 ? `${name}-${i + 1}` : name);
      while (used.has(slug)) slug = `${slug.slice(0, 27)}-${used.size}`;
      used.add(slug);
      trunkOfLine.set(l, slug);
      const main = nationalNumber(txt(l, "ExternalNumber"), cc) || txt(l, "ExternalNumber");
      const dids = txt(l, "DIDNumbers").split(/[:;,\s]+/).map((x) => nationalNumber(x.replace(/^\*+/, ""), cc)).filter((x) => x && x !== main);
      trunkRows.push([slug, tpl.label, main, host, port, "", txt(l, "AuthID"), txt(l, "AuthPassword"), [...new Set(dids)].join(", "), codecs.join(",")]);
    });
  }

  // ---- Utilisateurs (Extension)
  const userRows = [], forwards = [];
  for (const e of dns.children.filter((x) => x.tag === "Extension")) {
    const n = txt(e, "Number");
    const role = ROLE_FR[roleOf.get(n)] || "Utilisateur";
    const dev = find(kid(e, "PhoneDevices"), (c) => c.attrs.MacAddress || c.attrs.MAC || c.tag === "MacAddress");
    const mac = (dev?.attrs.MacAddress || dev?.attrs.MAC || dev?.text || "").replace(/[^0-9a-f]/gi, "");
    const model = dev?.attrs.Model || dev?.attrs.ModelName || "";
    userRows.push([n, txt(e, "FirstName"), txt(e, "LastName"), txt(e, "EmailAddress"), prop(e, "MOBILENUMBER") || txt(e, "MobileNumber"), txt(e, "OutboundCallerID"), "",
      role, yes(txt(e, "VMEnabled")) ? "Oui" : "Non", txt(e, "VMPIN"), VM_MAIL[txt(e, "VMEmailOptions")] || "Non",
      yes(txt(e, "Enabled")) || !txt(e, "Enabled") ? "Non" : "Oui", prop(e, "DONT_SHOW_EXT_IN_PHBK") === "1" ? "Oui" : "Non", "Non", model, mac.length === 12 ? mac : ""]);
    // Renvois : profil « Available » (sans réponse, occupé) et « Away » (absent)
    const prof = (nm) => kids(e, "FwdProfiles/FwdProfile").find((p) => txt(p, "Name") === nm);
    const av = prof("Available"), aw = prof("Away");
    const fw = {};
    const timeout = Number(txt(av, "NoAnswerTimeout")) || 0;
    if (timeout >= 5 && timeout <= 120) fw.timeout = timeout;
    const na = fwOf(kid(av, "AvailableRoute/NoAnswer/AllCalls"), cc), bz = fwOf(kid(av, "AvailableRoute/Busy/AllCalls"), cc);
    const away = fwOf(kid(aw, "AwayRoute/External/AllHours"), cc);
    if (na) fw.no_answer = na; if (bz) fw.busy = bz; if (away) fw.away = away;
    if (Object.keys(fw).some((k) => k !== "timeout" && fw[k].type !== "voicemail") || fw.timeout && fw.timeout !== 20) forwards.push({ ext: n, forwarding: fw });
  }

  // ---- Règles entrantes : une par ligne (SDA de la ligne → destination aux heures d'ouverture, en dehors, fériés)
  const inboundRows = [];
  for (const l of lines) {
    const slug = trunkOfLine.get(l);
    if (!slug) continue;
    const main = nationalNumber(txt(l, "ExternalNumber"), cc) || "";
    const allDids = [main, ...txt(l, "DIDNumbers").split(/[:;,\s]+/).map((x) => nationalNumber(x.replace(/^\*+/, ""), cc))].filter(Boolean);
    const rules = kids(l, "RoutingRules/ExternalLineRule");
    rules.forEach((r, i) => {
      const cond = kid(r, "Conditions/Condition");
      const mask = cond?.attrs.Type === "BasedOnDID" || cond?.attrs.Type === "DID" ? (txt(r, "Conditions/Condition") || cond.attrs.Value || cond.attrs.Mask || "") : "";
      const dids = mask ? mask.split(/[:;,\s]+/).map((x) => nationalNumber(x.replace(/\*/g, ""), cc)).filter(Boolean) : allDids;
      const fd = kid(r, "ForwardDestinations");
      const hours = kid(r, "Hours")?.attrs.HoursType || kid(r, "Conditions/Hours")?.attrs.Type || "AllHours";
      const open = destOf(kid(fd, "OfficeHoursDestination"), cc, types);
      const altOut = yes(txt(fd, "AlterDestinationDuringOutOfOfficeHours")), altHol = yes(txt(fd, "AlterDestinationDuringHolidays"));
      const closed = altOut ? destOf(kid(fd, "OutOfOfficeHoursDestination"), cc, types) : open;
      const hol = altHol ? destOf(kid(fd, "HolidaysDestination"), cc, types) : "";
      const withSchedule = schedules.length && (altOut || hours !== "AllHours");
      inboundRows.push([`Ligne ${slug}${rules.length > 1 ? ` ${i + 1}` : ""}`, [...new Set(dids)].join(", "), "Non", withSchedule ? OFFICE : "", open || "Raccrocher", withSchedule ? closed || "Raccrocher" : "", "", hol]);
    });
  }

  // ---- Règles sortantes
  const outRows = [];
  let maxRoutes = 1;
  for (const r of kids(t, "OutboundRules/OutboundRule")) {
    const routes = kids(r, "OutboundRoutes/OutboundRoute").map((x) => {
      const gw = txt(x, "Gateway"); if (!gw) return null;
      const line = lines.find((l) => txt(l, "Gateway") === gw);
      const slug = (line && trunkOfLine.get(line)) || trunkSlug(gw);
      const cid = txt(x, "OutCID") || txt(x, "CallerID");
      return [slug, txt(x, "StripDigits") || "0", txt(x, "Prepend"), cid ? (nationalNumber(cid, cc) || cid) : "Utilisateur"];
    }).filter(Boolean);
    if (!routes.length) continue;
    maxRoutes = Math.max(maxRoutes, routes.length);
    const ranges = kids(r, "DNRanges/DNRange").map((x) => `${x.attrs.From || txt(x, "From")}-${x.attrs.To || txt(x, "To")}`).filter((x) => x !== "-");
    const prefix = txt(r, "Prefix");
    const len = txt(r, "NumberLengthRanges") || txt(r, "NumberLength");
    outRows.push({ base: [txt(r, "Name") || "Règle 3CX", prefix, ranges.join(","), len], routes });
  }
  const outHeaders = ["Nom", "Préfixes", "Postes", "Longueurs"];
  for (let i = 1; i <= maxRoutes; i++) outHeaders.push(`Route ${i} : trunk`, `Route ${i} : chiffres retirés`, `Route ${i} : chiffres ajoutés`, `Route ${i} : numéro présenté`);

  // ---- Annuaire de l'entreprise
  const contactRows = kids(t, "PhoneBookEntries/PhoneBookEntry").map((p) => {
    const g = (k) => txt(p, k) || p.attrs[k] || "";
    return [g("FirstName"), g("LastName"), g("CompanyName"), g("PhoneNumber") || g("Business"), g("Mobile") || g("Mobile1"), g("Home"), g("Other") || g("Business2"), g("Email"), ""];
  }).filter((r) => r.slice(3, 7).some(Boolean));

  // ---- Ce qui n'est pas importé (à recréer)
  const label = { RingGroup: "Groupe d'appel", Queue: "File d'attente", IVR: "SVI" };
  for (const el of dns.children) {
    if (!label[el.tag]) continue;
    const n = txt(el, "Number"), nm = txt(el, "Name");
    if (el.tag === "IVR" && (!/^\d+$/.test(n) || prop(el, "PINPROTECTIONIVR") === "1")) continue;   // SVI internes de 3CX
    notes.push(`${label[el.tag]} ${n} « ${nm} » : à recréer dans Gestion d'appels.`);
  }
  if (contactRows.length === 0 && kids(t, "PhoneBookEntries/PhoneBookEntry").length) notes.push("Annuaire : entrées sans numéro ignorées.");

  return {
    version,
    tables: {
      trunks: { headers: ["Nom", "Opérateur", "Numéro principal", "Serveur", "Port", "Proxy", "Identifiant SIP", "Mot de passe", "SDA supplémentaires", "Codecs"], rows: trunkRows },
      users: { headers: ["Poste", "Prénom", "Nom", "E-mail", "Mobile", "Numéro présenté", "SDA", "Rôle", "Messagerie", "Code messagerie", "Messages par e-mail", "Désactivé", "Masqué de l'annuaire", "Appels externes bloqués", "Modèle de téléphone", "Adresse MAC"], rows: userRows },
      inbound: { headers: ["Nom", "SDA", "Par défaut", "Horaires", "Ouvert", "Fermé", "Pause", "Jours fériés"], rows: inboundRows },
      outbound: { headers: outHeaders, rows: outRows.map((r) => [...r.base, ...Array.from({ length: maxRoutes }, (_, i) => r.routes[i] || ["", "", "", ""]).flat()]) },
      contacts: { headers: ["Prénom", "Nom", "Société", "Téléphone", "Mobile", "Domicile", "Autre", "E-mail", "Notes"], rows: contactRows },
    },
    schedules, forwards, notes,
  };
}
