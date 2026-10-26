/**
 * Import / export en CSV : utilisateurs, annuaire, trunks, règles entrantes, règles sortantes.
 * Deux formats : « Callikoe » (CSV au point-virgule, s'ouvre directement dans Excel) et « 3CX »
 * (fichiers des écrans d'import / export de 3CX : utilisateurs et annuaire ; règles entrantes en import seulement).
 * Tout est en fonctions pures (lecture, écriture, conversion) testées dans console/test/transfer.test.mjs ;
 * createTransfer() les branche sur la base (aperçu puis import réel).
 */
import { UserError, nationalNumber, defaultUser, validateUser } from "./users.mjs";
import { validateContact } from "./contacts.mjs";
import { validateRule, rangesText } from "./outbound.mjs";
import { validateObject } from "./callflow.mjs";
import { MODELS, normalizeMac } from "./phones.mjs";
import { convert3cx } from "./import3cx.mjs";

export const KINDS = {
  users: { label: "Utilisateurs", formats: ["callikoe", "3cx"] },
  contacts: { label: "Annuaire", formats: ["callikoe", "3cx"] },
  trunks: { label: "Trunks", formats: ["callikoe"] },
  inbound: { label: "Règles entrantes", formats: ["callikoe"], import3cx: true },
  outbound: { label: "Règles sortantes", formats: ["callikoe"] },
};
/** Parties réservées à l'installateur (comme dans la console : pas pour le rôle « accès restreint ») */
export const INSTALLER_KINDS = ["trunks", "outbound"];

// ------------------------------------------------------------------ CSV
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** Lit un tableau CSV (séparateur ; , ou tabulation deviné sur la 1re ligne). */
export function readTable(text) {
  const t = String(text || "").replace(/^﻿/, "");
  const first = t.split(/\r?\n/)[0] || "";
  const count = (c) => first.split(c).length - 1;
  const sep = [";", ",", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"' && cell === "") q = true;   // guillemet au milieu d'une cellule (Écran 27") : gardé tel quel, comme Excel
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const data = rows.filter((r) => r.some((x) => x.trim())).map((r) => r.map((x) => x.replace(/^'(?=[=+\-@])/, "")));   // apostrophe anti-formule de l'export
  if (!data.length) throw new UserError("Fichier vide.", "file");
  return { headers: data[0].map((h) => h.trim()), rows: data.slice(1).map((r) => r.map((x) => x.trim())), sep };
}

/** Écrit un CSV. Callikoe : « ; » + BOM (Excel en français) ; 3CX : « , » sans BOM. */
export function writeCsv(headers, rows, format = "callikoe") {
  const sep = format === "3cx" ? "," : ";";
  // Texte qui commence par = + - @ : apostrophe devant, sinon Excel le prend pour une formule
  const q = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s) && !/^\+\d[\d ]*$/.test(s)) s = `'${s}`; return /[",;\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s; };
  const nl = format === "3cx" ? "\n" : "\r\n";   // 3CX : fins de ligne Unix, comme ses propres exports
  const body = [headers, ...rows].map((r) => r.map(q).join(sep)).join(nl) + nl;
  return format === "3cx" ? body : "﻿" + body;
}

/** Associe les colonnes du fichier aux champs connus (en-têtes en français, en anglais ou de 3CX). */
function mapColumns(headers, aliases) {
  const idx = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(aliases)) if (idx[field] === undefined && names.includes(n)) { idx[field] = i; break; }
  });
  return idx;
}
const cellOf = (row, idx) => (f) => (idx[f] === undefined ? undefined : row[idx[f]] ?? "");
const yes = (v) => /^(1|oui|o|yes|y|true|vrai|x|on)$/i.test(String(v).trim());
const boolOf = (v) => (v === undefined || String(v).trim() === "" ? undefined : yes(v));
const yn = (b) => (b ? "Oui" : "Non");
/** Numéro relu d'un fichier : sans espaces ni points ; 9 chiffres = le 0 du début enlevé par Excel, on le remet */
const frNumber = (n) => { const x = String(n).replace(/[\s.]/g, ""); return /^[1-9]\d{8}$/.test(x) ? `0${x}` : x; };
const fmtNum = (n) => (/^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : n || "");
const splitList = (v) => String(v || "").split(/\s*[,;:|\n/]\s*|\s+-\s+|\s{2,}/).map((x) => x.trim()).filter(Boolean);

// ------------------------------------------------------------------ Utilisateurs
const ROLE_NAMES = { user: "Utilisateur", standard: "Pilote", manager: "Superviseur", console: "Gestionnaire", admin: "Administrateur" };
const ROLE_3CX = { user: "users", standard: "receptionists", manager: "managers", console: "managers", admin: "managers" };
const ROLE_IN = {
  utilisateur: "user", user: "user", users: "user", pilote: "standard", standard: "standard", receptionist: "standard", receptionists: "standard",
  superviseur: "manager", manager: "manager", managers: "manager", gestionnaire: "console", console: "console", administrateur: "admin", admin: "admin",
};
const ROLE_3CX_ADMIN = ["groupadmins", "groupowners", "systemadmins", "systemowners"];
const VM_MAIL = ["Non", "Avis seul", "Avec le message", "Avec le message, effacé du répondeur"];

const USER_COLS = [
  ["number", "Poste"], ["first_name", "Prénom"], ["last_name", "Nom"], ["email", "E-mail"], ["mobile", "Mobile"], ["outbound_cid", "Numéro présenté"],
  ["dids", "SDA"], ["role", "Rôle"], ["vm", "Messagerie"], ["vm_pin", "Code messagerie"], ["vm_email", "Messages par e-mail"],
  ["disabled", "Désactivé"], ["hidden", "Masqué de l'annuaire"], ["block_external", "Appels externes bloqués"], ["model", "Modèle de téléphone"], ["mac", "Adresse MAC"],
];
// Colonnes exactes de l'écran Utilisateurs › Importer de 3CX (v20), dans le même ordre ; 3CX refuse le fichier s'il en manque une (ex. « Department »)
const USER_3CX = ["Number", "FirstName", "LastName", "EmailAddress", "MobileNumber", "OutboundCallerID", "DID", "Role", "Department", "ClickToCallAuth", "WMApprove",
  "WebMeetingFriendlyName", "MAC", "Template", "Model", "Router", "Language", "Ringtone", "QRingtone", "PhoneSettings", "VMEnable", "VMLanguage", "VMPlayMsgDateTime",
  "VMPIN", "VMEmailOptions", "VMNoPin", "VMPlayCallerID", "RecordCalls", "RecordExternal", "ForbidRecording", "RecordCanSee", "RecordCanDelete", "RecordStartStop",
  "RecordNotify", "Disabled", "HideFWrules", "DisableExternalCalls", "HideInPhonebook", "CallScreening", "PinProtected", "PinTimeout", "Transcription", "AllowLanOnly",
  "SIPID", "DeliverAudio", "HotDesk", "SRTPMode", "EmailMissedCalls", "MS365SignInDisabled", "MS365CalendarDisabled", "MS365ContactsDisabled", "MS365TeamsDisabled",
  "GoogleSignInDisabled", "GoogleContactsDisabled", "GoogleCalendarDisabled", "BLF", "AiAgent", "AiAgentSettings"];
// Valeurs par défaut d'une extension exportée par 3CX (réglages que Callikoe n'a pas)
const USER_3CX_DEFAULTS = { Department: "DEFAULT", ClickToCallAuth: 0, WMApprove: 0, VMPlayMsgDateTime: 0, VMNoPin: 1, VMPlayCallerID: 0, RecordCalls: 0,
  RecordExternal: 0, ForbidRecording: 0, RecordCanSee: 0, RecordCanDelete: 0, RecordStartStop: 1, RecordNotify: 0, HideFWrules: 0, CallScreening: 0, PinProtected: 0,
  PinTimeout: 60, AllowLanOnly: 0, DeliverAudio: 1, HotDesk: 0, SRTPMode: 0, EmailMissedCalls: 0, BLF: "<PhoneDevice><BLFS /></PhoneDevice>" };
// Nom de réunion web 3CX : lettres et chiffres, unique sur le PBX
const meetingName = (u, used) => {
  let n = `${u.first_name || ""}${u.last_name || ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "") || `poste${u.id}`;
  if (used.has(n)) n += u.id;
  used.add(n);
  return n;
};
const USER_ALIASES = {
  number: ["poste", "number", "numero", "extension", "ext", "extensionnumber"], first_name: ["prenom", "firstname"], last_name: ["nom", "lastname"],
  email: ["email", "emailaddress", "mail", "courriel"], mobile: ["mobile", "mobilenumber", "portable"], outbound_cid: ["numeropresente", "outboundcallerid", "callerid"],
  dids: ["sda", "did", "dids"], role: ["role"], vm: ["messagerie", "vmenable", "voicemail"], vm_pin: ["codemessagerie", "vmpin", "pin"],
  vm_email: ["messagesparemail", "vmemailoptions"], disabled: ["desactive", "disabled"], hidden: ["masquedelannuaire", "hideinphonebook", "masque"],
  block_external: ["appelsexternesbloques", "disableexternalcalls"], model: ["modeledetelephone", "model", "modele"], mac: ["adressemac", "mac"],
};
const modelLabel3cx = (m) => m.label.split(" / ")[0].replace(/\s*\(.*\)$/, "");
function modelOf(v) {
  const n = norm(v);
  if (!n) return "";
  const m = MODELS.find((x) => x.id === String(v).trim().toLowerCase() || norm(x.id) === n || x.label.split(" / ").some((p, i) => norm(i ? `${x.brand} ${p}` : p.replace(/\s*\(.*\)$/, "")) === n) || norm(x.label) === n);
  return m ? m.id : null;
}
const vmMailIndex = (vm) => (!vm.email ? 0 : !vm.email_attach ? 1 : vm.email_delete ? 3 : 2);
function vmMailOf(v) {
  const s = String(v).trim();
  if (/^[0-3]$/.test(s)) return Number(s);
  const n = norm(s);
  if (!n || ["non", "no", "aucun"].includes(n)) return 0;
  if (/eff|delete/.test(n)) return 3;
  if (/avis|notif|sans/.test(n)) return 1;
  return 2;
}

/** Utilisateurs → lignes du fichier */
export function usersRows(users, format = "callikoe") {
  const model = (u) => MODELS.find((m) => m.id === u.phone?.model);
  if (format === "3cx") {
    const used = new Set();
    return { headers: USER_3CX, rows: users.map((u) => {
      const v = { ...USER_3CX_DEFAULTS, Number: u.id, FirstName: u.first_name, LastName: u.last_name, EmailAddress: u.email, MobileNumber: u.mobile,
        OutboundCallerID: u.outbound_cid, DID: (u.dids || []).join(":"), Role: `<role name="${ROLE_3CX[u.options?.role || "user"]}" />`, WebMeetingFriendlyName: meetingName(u, used),
        MAC: (u.phone?.mac || "").toUpperCase(), Model: model(u) ? modelLabel3cx(model(u)) : "", VMEnable: u.voicemail.enabled ? 1 : 0, VMPIN: u.voicemail.pin || "",
        VMEmailOptions: vmMailIndex(u.voicemail), Disabled: u.options.disabled ? 1 : 0, HideInPhonebook: u.options.hidden ? 1 : 0, DisableExternalCalls: u.options.block_external ? 1 : 0 };
      return USER_3CX.map((h) => v[h] ?? "");
    }) };
  }
  return { headers: USER_COLS.map(([, l]) => l), rows: users.map((u) => [u.id, u.first_name, u.last_name, u.email, fmtNum(u.mobile), fmtNum(u.outbound_cid),
    (u.dids || []).map(fmtNum).join(", "), ROLE_NAMES[u.options?.role || "user"], yn(u.voicemail.enabled), u.voicemail.pin || "", VM_MAIL[vmMailIndex(u.voicemail)],
    yn(u.options.disabled), yn(u.options.hidden), yn(u.options.block_external), model(u)?.label || "", (u.phone?.mac || "").toUpperCase().replace(/(..)(?=.)/g, "$1:")]) };
}

/** Fichier → fiches à créer / mettre à jour (champs absents du fichier = inchangés) */
export function parseUsers(table, cc = "33") {
  const idx = mapColumns(table.headers, USER_ALIASES);
  if (idx.number === undefined) throw new UserError("Colonne « Poste » (ou « Number » pour 3CX) introuvable.", "file");
  const is3cx = table.headers.includes("FirstName") || table.headers.includes("EmailAddress");
  return table.rows.map((row, i) => {
    const c = cellOf(row, idx);
    const warnings = [];
    const num = String(c("number") || "").trim();
    const input = { number: num };
    for (const f of ["first_name", "last_name", "email", "mobile", "outbound_cid"]) if (c(f) !== undefined) input[f] = c(f);
    if (c("dids") !== undefined) {
      const dids = [];
      for (const raw of splitList(c("dids"))) {
        const n = nationalNumber(raw.replace(/^\*+/, ""), cc);
        if (n) dids.push(n); else warnings.push(`SDA ignorée : ${raw}`);
      }
      input.dids = dids;
    }
    const options = {};
    for (const f of ["disabled", "hidden", "block_external"]) if (boolOf(c(f)) !== undefined) options[f] = boolOf(c(f));
    if (c("role") !== undefined && c("role").trim()) {
      const raw = c("role").replace(/^.*name\s*=\s*"([^"]*)".*$/s, "$1");
      if (ROLE_3CX_ADMIN.includes(norm(raw))) { options.role = "manager"; warnings.push(`Rôle 3CX « ${raw} » : mis en Superviseur (l'accès à la console se donne à part)`); }
      else if (ROLE_IN[norm(raw)]) options.role = ROLE_IN[norm(raw)];
      else warnings.push(`Rôle inconnu ignoré : ${raw}`);
    }
    if (Object.keys(options).length) input.options = options;
    const vm = {};
    if (boolOf(c("vm")) !== undefined) vm.enabled = boolOf(c("vm"));
    if (c("vm_pin") !== undefined && c("vm_pin").trim()) vm.pin = c("vm_pin").trim();
    if (c("vm_email") !== undefined && c("vm_email").trim()) {
      const k = vmMailOf(c("vm_email"));
      Object.assign(vm, { email: k > 0, email_attach: k >= 2, email_delete: k === 3 });
    }
    if (Object.keys(vm).length) input.voicemail = vm;
    const mac = c("mac") !== undefined ? normalizeMac(c("mac")) : undefined;
    const model = c("model") !== undefined ? modelOf(c("model")) : undefined;
    if (mac === null) warnings.push(`Adresse MAC invalide ignorée : ${c("mac")}`);
    if (model === null) warnings.push(`Modèle de téléphone non géré, téléphone ignoré : ${c("model")}`);
    if (mac && model) input.phone = { model, mac };
    else if (mac && model === "") warnings.push("Adresse MAC sans modèle de téléphone : téléphone ignoré");
    const name = `${input.first_name || ""} ${input.last_name || ""}`.trim();
    return { line: i + 2, key: num, label: name ? `${num} · ${name}` : num, input, warnings, is3cx };
  });
}

// ------------------------------------------------------------------ Annuaire
const CONTACT_COLS = ["Prénom", "Nom", "Société", "Téléphone", "Mobile", "Domicile", "Autre", "E-mail", "Notes"];
const CONTACT_3CX = ["FirstName", "LastName", "Company", "Mobile", "Mobile2", "Home", "Home2", "Business", "Business2", "Email", "Other", "BusinessFax", "HomeFax", "Pager"];
const CONTACT_FIELDS = {
  prenom: "first_name", firstname: "first_name", nom: "last_name", lastname: "last_name", name: "last_name", societe: "company", entreprise: "company", company: "company", organisation: "company",
  telephone: "work", tel: "work", bureau: "work", business: "work", business2: "work", work: "work", phone: "work", fixe: "work", telephonebureau: "work",
  mobile: "mobile", mobile2: "mobile", portable: "mobile", gsm: "mobile", cell: "mobile", domicile: "home", home: "home", home2: "home",
  autre: "other", other: "other", fax: "other", businessfax: "other", homefax: "other", pager: "other",
  email: "email", emailaddress: "email", mail: "email", courriel: "email", notes: "notes", commentaire: "notes",
};
export function contactsRows(contacts, format = "callikoe") {
  const nums = (c, t) => c.phones.filter((p) => p.type === t).map((p) => p.number);
  if (format === "3cx") {
    return { headers: CONTACT_3CX, rows: contacts.map((c) => {
      const [m1 = "", m2 = ""] = nums(c, "mobile"), [h1 = "", h2 = ""] = nums(c, "home"), [w1 = "", w2 = ""] = nums(c, "work");
      return [c.first_name, c.last_name, c.company, ...[m1, m2, h1, h2, w1, w2].map(fmtNum), c.email, fmtNum(nums(c, "other")[0] || ""), "", "", ""];
    }) };
  }
  return { headers: CONTACT_COLS, rows: contacts.map((c) => [c.first_name, c.last_name, c.company, ...["work", "mobile", "home", "other"].map((t) => nums(c, t).map(fmtNum).join(" / ")), c.email, c.notes]) };
}
export function parseContacts(table) {
  const head = table.headers.map((h) => CONTACT_FIELDS[norm(h)] || "");
  if (!head.some(Boolean)) throw new UserError("En-têtes non reconnus : Prénom ; Nom ; Société ; Téléphone ; Mobile ; E-mail (ou fichier d'annuaire 3CX).", "file");
  return table.rows.map((r, i) => {
    const o = { phones: [] };
    head.forEach((k, j) => {
      const v = (r[j] || "").trim();
      if (!k || !v) return;
      if (["work", "mobile", "home", "other"].includes(k)) for (const n of v.split(/\s*[/|]\s*/).filter(Boolean)) o.phones.push({ type: k, number: frNumber(n) });
      else o[k] = o[k] ? `${o[k]} ${v}` : v;
    });
    const label = `${o.first_name || ""} ${o.last_name || ""}`.trim() || o.company || `Ligne ${i + 2}`;
    return { line: i + 2, key: o.phones[0]?.number || "", label, input: o, warnings: [] };
  });
}

// ------------------------------------------------------------------ Trunks
const TRUNK_COLS = ["Nom", "Opérateur", "Numéro principal", "Serveur", "Port", "Proxy", "Identifiant SIP", "Mot de passe", "SDA supplémentaires", "Codecs"];
const TRUNK_ALIASES = {
  name: ["nom", "name", "id"], template: ["operateur", "operator", "template", "modele"], number: ["numeroprincipal", "numero", "number"], host: ["serveur", "host", "registrar"],
  port: ["port"], proxy: ["proxy", "outboundproxy"], username: ["identifiantsip", "identifiant", "username", "authid", "login"], password: ["motdepasse", "password", "mdp"],
  dids: ["sdasupplementaires", "sda", "dids"], codecs: ["codecs"],
};
export function trunksRows(trunks) {
  return { headers: TRUNK_COLS, rows: trunks.map((t) => [t.id, t.operator, t.number, t.host, t.port || "", t.proxy || "", t.username, "", (t.extra_dids || []).join(", "), (t.codecs || []).filter(Boolean).join(",")]) };
}
export function parseTrunks(table, templates) {
  const idx = mapColumns(table.headers, TRUNK_ALIASES);
  if (idx.name === undefined || idx.template === undefined) throw new UserError("Colonnes « Nom » et « Opérateur » introuvables.", "file");
  return table.rows.map((row, i) => {
    const c = cellOf(row, idx);
    const name = String(c("name") || "").trim().toLowerCase();
    const op = c("template") || "";
    const t = templates.find((x) => x.id === op.trim() || norm(x.label) === norm(op));
    const input = { name, template: t?.id || "" };
    for (const f of ["number", "host", "port", "username", "password", "codecs"]) if (c(f)) input[f] = c(f);
    if (c("proxy")) input.proxy = c("proxy");
    if (c("dids") !== undefined) input.dids = splitList(c("dids")).join(",");
    return { line: i + 2, key: name, label: `${name}${t ? ` · ${t.label}` : ""}`, input, warnings: [], error: t ? "" : `Opérateur inconnu : ${op || "(vide)"}` };
  });
}

// ------------------------------------------------------------------ Règles sortantes
const CID_TEXT = { user: "Utilisateur", trunk: "Trunk", hidden: "Masqué" };
export function outboundRows(rules) {
  const n = Math.max(1, ...rules.map((r) => r.routes.length));
  const headers = ["Nom", "Préfixes", "Postes", "Longueurs"];
  for (let i = 1; i <= n; i++) headers.push(`Route ${i} : trunk`, `Route ${i} : chiffres retirés`, `Route ${i} : chiffres ajoutés`, `Route ${i} : numéro présenté`);
  return { headers, rows: rules.map((r) => {
    const out = [r.name, r.prefixes.join(","), rangesText(r.extensions), rangesText(r.lengths)];
    for (let i = 0; i < n; i++) {
      const x = r.routes[i];
      out.push(...(x ? [x.trunk, x.strip || 0, x.prepend || "", x.cid_mode === "custom" ? fmtNum(x.cid) : CID_TEXT[x.cid_mode] || "Utilisateur"] : ["", "", "", ""]));
    }
    return out;
  }) };
}
export function parseOutbound(table) {
  const h = table.headers.map(norm);
  const col = (...names) => h.findIndex((x) => names.includes(x));
  const ci = { name: col("nom", "name"), prefixes: col("prefixes", "prefixe", "prefix"), extensions: col("postes", "extensions", "poste"), lengths: col("longueurs", "longueur", "lengths", "length") };
  if (ci.name < 0) throw new UserError("Colonne « Nom » introuvable.", "file");
  const routeCols = [];
  h.forEach((x, j) => {
    const m = /^route(\d)(trunk|chiffresretires|retirer|strip|chiffresajoutes|ajouter|prepend|numeropresente|cid)$/.exec(x);
    if (!m) return;
    const k = { trunk: "trunk", chiffresretires: "strip", retirer: "strip", strip: "strip", chiffresajoutes: "prepend", ajouter: "prepend", prepend: "prepend", numeropresente: "cid", cid: "cid" }[m[2]];
    (routeCols[Number(m[1]) - 1] ||= {})[k] = j;
  });
  return table.rows.map((row, i) => {
    const v = (j) => (j >= 0 ? row[j] || "" : "");
    const routes = routeCols.filter(Boolean).map((rc) => {
      const cid = v(rc.cid).trim(), nc = norm(cid);
      const mode = !nc || nc === "utilisateur" || nc === "user" ? "user" : nc === "trunk" ? "trunk" : ["masque", "hidden", "anonyme"].includes(nc) ? "hidden" : "custom";
      return { trunk: v(rc.trunk).trim(), strip: Number(v(rc.strip) || 0), prepend: v(rc.prepend).trim(), cid_mode: mode, cid: mode === "custom" ? cid : "" };
    }).filter((x) => x.trunk);
    const name = v(ci.name).trim();
    return { line: i + 2, key: norm(name), label: name || `Ligne ${i + 2}`, input: { name, prefixes: v(ci.prefixes), extensions: v(ci.extensions), lengths: v(ci.lengths), routes }, warnings: [] };
  });
}

// ------------------------------------------------------------------ Règles entrantes
const DEST_WORDS = { user: "Utilisateur", user_vm: "Messagerie", group: "Groupe", queue: "File", ivr: "SVI", groupvm: "Messagerie de groupe", external: "Numéro", prompt: "Annonce", hangup: "Raccrocher" };
/** Destination → texte lisible : « Groupe 600 », « Messagerie 201 », « Numéro 06 12 34 56 78 », « Annonce Fermé, puis Raccrocher » */
export function destText(d, objects) {
  if (!d) return "";
  const obj = (kind, id) => objects.find((o) => o.kind === kind && o.id === id);
  const pre = d.prompt ? `Annonce ${obj("prompt", d.prompt)?.name || "?"}, puis ` : "";
  if (d.type === "hangup") return `${pre}Raccrocher`;
  if (d.type === "user" || d.type === "user_vm") return `${pre}${DEST_WORDS[d.type]} ${d.target}`;
  if (d.type === "external") return `${pre}Numéro ${fmtNum(d.target)}`;
  const o = obj(d.type, d.target);
  return `${pre}${DEST_WORDS[d.type]} ${o ? o.number || o.name : "?"}`;
}
const DEST_IN = [
  [/^(messagerie de groupe|boite vocale de groupe|group voicemail)\s+(.+)$/i, "groupvm"],
  [/^(messagerie|boite vocale|voicemail|vm)\s+(.+)$/i, "user_vm"],
  [/^(utilisateur|poste|extension|ext\.?|user)\s+(.+)$/i, "user"],
  [/^(groupe d'appel|groupe|ring ?group|hunt ?group)\s+(.+)$/i, "group"],
  [/^(file d'attente|file|queue|call queue)\s+(.+)$/i, "queue"],
  [/^(svi|repondeur numerique|ivr|digital receptionist)\s+(.+)$/i, "ivr"],
  [/^(numero externe|numero|external number|external|transfer to external number|number)\s+(.+)$/i, "external"],
  [/^(annonce|prompt|play prompt)\s+(.+)$/i, "prompt"],
];
/** Texte → destination (mots français, ou ceux de 3CX) ; null si vide ; lève une erreur si inconnu. */
export function parseDest(text, { users, objects }) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s*,?\s+puis\s+|\s*,?\s+then\s+/i);
  if (parts.length > 1) {
    const p = parseDest(parts[0], { users, objects });
    if (p?.type !== "prompt") throw new UserError(`Destination incomprise : ${raw}`);
    return { ...parseDest(parts.slice(1).join(" puis "), { users, objects }), prompt: p.target };
  }
  const s = raw.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/^(raccrocher|terminer l'appel|end call|hang ?up|disconnect|fin)$/i.test(s)) return { type: "hangup", target: "" };
  const find = (kind, v) => {
    const n = norm(v);
    const o = objects.find((x) => x.kind === kind && (String(x.number || "") === v.trim() || norm(x.name) === n));
    if (!o) throw new UserError(`${DEST_WORDS[kind]} introuvable : ${v}`);
    return { type: kind, target: o.id };
  };
  for (const [re, type] of DEST_IN) {
    const m = re.exec(s);
    if (!m) continue;
    const v = raw.slice(raw.length - m[2].length).trim();
    if (type === "user" || type === "user_vm") {
      const id = v.match(/^\d{3}/)?.[0];
      if (id && users.has(id)) return { type, target: id };
      if (type === "user_vm") { try { return find("groupvm", v); } catch { /* pas une boîte de groupe */ } }
      throw new UserError(`Utilisateur introuvable : ${v}`);
    }
    if (type === "external") return { type, target: v.replace(/[^\d+]/g, "") };
    return find(type, v);
  }
  // Juste un numéro : poste, groupe / file / SVI, ou numéro externe
  const digits = raw.replace(/[\s.]/g, "");
  if (/^\d{3}$/.test(digits)) {
    if (users.has(digits)) return { type: "user", target: digits };
    const o = objects.find((x) => ["group", "queue", "ivr", "groupvm"].includes(x.kind) && x.number === digits);
    if (o) return { type: o.kind, target: o.id };
  }
  if (/^\+?\d{9,15}$/.test(digits)) return { type: "external", target: digits };
  throw new UserError(`Destination incomprise : ${raw}`);
}
const INBOUND_COLS = ["Nom", "SDA", "Par défaut", "Horaires", "Ouvert", "Fermé", "Pause", "Jours fériés"];
export function inboundRows(rules, objects) {
  const sched = (id) => objects.find((o) => o.kind === "schedule" && o.id === id)?.name || "";
  return { headers: INBOUND_COLS, rows: rules.map((r) => [r.name, (r.data.dids || []).map(fmtNum).join(", "), yn(r.data.is_default), sched(r.data.schedule),
    destText(r.data.open, objects), destText(r.data.closed, objects), destText(r.data.break, objects), destText(r.data.holiday, objects)]) };
}
const INBOUND_ALIASES = {
  name: ["nom", "name", "rulename", "rule", "regle", "description"],
  dids: ["sda", "did", "dids", "didnumber", "didnumbers", "mask", "didmask", "numbers", "numeros"],
  is_default: ["pardefaut", "default", "isdefault"],
  schedule: ["horaires", "schedule", "hours", "officehourstype"],
  open: ["ouvert", "open", "duringofficehours", "officehoursdestination", "routeduringofficehours", "officehours", "destination", "routeto", "route"],
  closed: ["ferme", "closed", "outofofficehours", "outsideofficehours", "afterhours", "outofofficehoursdestination", "routeoutsideofficehours", "outofoffice"],
  break: ["pause", "break", "breaktime", "duringbreak"],
  holiday: ["joursferies", "jourferie", "holidays", "holiday", "duringholidays"],
};
export function parseInbound(table, ctx) {
  const idx = mapColumns(table.headers, INBOUND_ALIASES);
  if (idx.name === undefined && idx.dids === undefined) throw new UserError("Colonnes « Nom » ou « SDA » introuvables.", "file");
  const is3cx = !table.headers.some((h) => ["ouvert", "ferme", "sda"].includes(norm(h)));
  return table.rows.map((row, i) => {
    const c = cellOf(row, idx);
    const warnings = [];
    let error = "";
    const dids = [];
    for (const raw of splitList(c("dids"))) {
      const n = nationalNumber(raw.replace(/^\*+/, ""), ctx.cc || "33");
      if (n) dids.push(n); else warnings.push(`SDA ignorée : ${raw}`);
    }
    const name = String(c("name") || "").trim() || (dids[0] ? `SDA ${fmtNum(dids[0])}` : `Règle ${i + 2}`);
    const input = { name, dids };
    if (boolOf(c("is_default")) !== undefined) input.is_default = boolOf(c("is_default"));
    if (c("schedule") !== undefined && c("schedule").trim()) {
      const s = ctx.objects.find((o) => o.kind === "schedule" && norm(o.name) === norm(c("schedule")));
      if (s) input.schedule = s.id; else warnings.push(`Horaires introuvables : ${c("schedule")} (règle sans horaires)`);
    }
    for (const f of ["open", "closed", "break", "holiday"]) {
      if (c(f) === undefined) continue;
      try {
        const d = parseDest(c(f), ctx);
        if (d) input[f] = d; else if (f === "break" || f === "holiday") input[f] = null;
      } catch (e) { error = error || e.message; }
    }
    if (!input.open && !error) error = "Destination « Ouvert » manquante.";
    if (input.open && !input.closed) input.closed = input.open;
    return { line: i + 2, key: norm(name), label: name, input, warnings, error, is3cx };
  });
}

// ------------------------------------------------------------------ Branchement sur le PBX
/**
 * Aperçu : chaque ligne → « créer », « mettre à jour » ou « erreur » (rien n'est enregistré).
 * Import : même chose, enregistré ligne par ligne ; une ligne en erreur n'empêche pas les autres.
 */
export function createTransfer({ pbx, admin }) {
  const check = (kind) => { if (!KINDS[kind]) throw Object.assign(new UserError("Type inconnu."), { status: 404 }); };
  const pickIds = (list, ids, key = "id") => (ids?.length ? list.filter((x) => ids.includes(String(x[key]))) : list);

  /** Liste pour choisir quoi exporter */
  async function items(kind) {
    check(kind);
    if (kind === "users") return (await pbx.listExtensions()).map((u) => ({ id: u.id, label: `${u.id} · ${u.name}`, sub: u.email || "" }));
    if (kind === "contacts") return (await pbx.listContacts()).map((c) => ({ id: c.id, label: c.name, sub: c.company && c.company !== c.name ? c.company : c.phones[0]?.number || "" }));
    if (kind === "trunks") return (await pbx.listTrunks()).map((t) => ({ id: t.id, label: t.id, sub: `${t.operator} · ${t.number}` }));
    if (kind === "inbound") return (await pbx.listObjects("rule")).map((o) => ({ id: o.id, label: o.name, sub: (o.data.dids || []).map(fmtNum).join(", ") || (o.data.is_default ? "Par défaut" : "") }));
    return (await admin.listOutbound()).rules.map((r) => ({ id: r.id, label: r.name, sub: r.summary || "" }));
  }

  async function exportKind(kind, { format = "callikoe", ids = [] } = {}) {
    check(kind);
    if (!KINDS[kind].formats.includes(format)) throw new UserError("Format non disponible pour cette partie : 3CX ne sait pas exporter ni importer ces réglages.");
    let t;
    if (kind === "users") t = usersRows(pickIds(await pbx.loadUsers(), ids), format);
    else if (kind === "contacts") t = contactsRows(pickIds(await pbx.listContacts(), ids), format);
    else if (kind === "trunks") t = trunksRows(pickIds(await pbx.listTrunks(), ids));
    else if (kind === "inbound") { const objects = await pbx.loadObjects(); t = inboundRows(pickIds(objects.filter((o) => o.kind === "rule"), ids), objects); }
    else t = outboundRows(pickIds((await admin.listOutbound()).rules, ids));
    const day = new Date().toISOString().slice(0, 10);
    const file = { users: "utilisateurs", contacts: "annuaire", trunks: "trunks", inbound: "regles-entrantes", outbound: "regles-sortantes" }[kind];
    return { filename: `${file}${format === "3cx" ? "-3cx" : ""}-${day}.csv`, text: writeCsv(t.headers, t.rows, format), count: t.rows.length };
  }

  /** opts : { apply, consoleRoles (installateur : peut donner Gestionnaire / Administrateur), by } */
  // pending (aperçu d'une sauvegarde 3CX) : postes, horaires et trunks qui seront créés avant cette partie
  async function importKind(kind, text, { apply = false, consoleRoles = false, by = "", pending = null } = {}) {
    check(kind);
    const table = readTable(text);
    if (table.rows.length > 5000) throw new UserError("5 000 lignes au maximum par import.", "file");
    const cc = pbx.countryCode();
    let lines = [];
    let format = "callikoe";

    if (kind === "users") {
      const users = await pbx.loadUsers();
      const byId = new Map(users.map((u) => [u.id, u]));
      lines = parseUsers(table, cc);
      if (lines.some((l) => l.is3cx)) format = "3cx";
      const didOwners = new Map();
      for (const u of users) for (const d of u.dids) didOwners.set(d, u.id);
      for (const o of await pbx.loadObjects()) if (o.kind === "rule") for (const d of o.data.dids) didOwners.set(d, `la règle entrante « ${o.name} »`);
      const extensions = new Set([...byId.keys(), ...lines.map((l) => l.key)]);
      const seen = new Set();
      for (const l of lines) {
        const cur = byId.get(l.key);
        l.action = cur ? "update" : "create";
        try {
          if (!/^[1-9]\d{2}$/.test(l.key)) throw new UserError("Numéro de poste : 3 chiffres, de 100 à 999.");
          if (seen.has(l.key)) throw new UserError("Poste en double dans le fichier.");
          seen.add(l.key);
          const role = l.input.options?.role;
          const curRole = cur?.options.role || "user";
          if (!consoleRoles && (["console", "admin"].includes(role) || (role && ["console", "admin"].includes(curRole)))) {
            delete l.input.options.role;
            l.warnings.push("Rôle non modifié : seul l'installateur donne ou retire Gestionnaire et Administrateur");
          }
          const base = cur ? structuredClone(cur) : defaultUser(l.key);
          if (!cur && l.input.first_name === undefined && l.input.last_name === undefined) l.input.first_name = `Poste ${l.key}`;
          const { phone, number, ...rest } = l.input; void phone; void number;
          validateUser(rest, base, { cc, extensions, didOwners });
          if (l.input.phone) for (const u of users) if (u.id !== l.key && u.phone?.mac === l.input.phone.mac) throw new UserError(`Adresse MAC déjà attribuée au poste ${u.id}.`);
        } catch (e) { l.error = e.message; }
      }
      if (apply) for (const l of lines.filter((x) => !x.error)) {
        try {
          const { phone, number, ...rest } = l.input;
          if (l.action === "create") await pbx.createExtension({ ...rest, number }, by);
          else await pbx.updateUser(number, rest, by);
          if (phone) await pbx.updateUser(number, { phone }, by);
          l.done = true;
        } catch (e) { l.error = e.message; }
      }
    } else if (kind === "contacts") {
      lines = parseContacts(table);
      if (table.headers.includes("Business") || table.headers.includes("Mobile2")) format = "3cx";
      const existing = new Set((await pbx.listContacts()).flatMap((c) => c.phones.map((p) => p.number)));
      for (const l of lines) {
        try {
          const c = validateContact(l.input, cc);
          l.action = c.phones.some((p) => existing.has(p.number)) ? "update" : "create";
          for (const p of c.phones) existing.add(p.number);
        } catch (e) { l.error = e.message; l.action = "create"; }
      }
      if (apply) {
        const ok = lines.filter((x) => !x.error);
        if (ok.length) await pbx.importContacts(ok.map((l) => l.input), false, by);
        for (const l of ok) l.done = true;
      }
    } else if (kind === "trunks") {
      const templates = pbx.templates();
      const current = new Set((await pbx.listTrunks()).map((t) => t.id));
      lines = parseTrunks(table, templates);
      for (const l of lines) {
        l.action = current.has(l.key) ? "update" : "create";
        if (l.error) continue;
        if (!/^[a-z][a-z0-9_-]{1,30}$/.test(l.key)) l.error = "Nom : lettres minuscules, chiffres, - ou _ (ex. dstny, unyc-siege).";
        else if (l.action === "create" && !l.input.password) l.error = "Mot de passe SIP manquant (les mots de passe ne sont jamais exportés : complète la colonne).";
        else if (l.action === "update" && !l.input.password) l.warnings.push("Mot de passe vide : celui déjà enregistré est gardé");
      }
      if (apply) for (const l of lines.filter((x) => !x.error)) {
        try { await pbx.createTrunk({ ...l.input, replace: l.action === "update" }); l.done = true; } catch (e) { l.error = e.message; }
      }
    } else if (kind === "inbound") {
      const [objects0, users] = await Promise.all([pbx.loadObjects(), pbx.loadUsers()]);
      const objects = [...objects0, ...(pending?.objects || []).filter((p) => !objects0.some((o) => o.kind === p.kind && norm(o.name) === norm(p.name)))];
      const ctx = { users: new Map(users.map((u) => [u.id, u])), objects, cc };
      for (const id of pending?.users || []) if (!ctx.users.has(id)) ctx.users.set(id, defaultUser(id));
      lines = parseInbound(table, ctx);
      if (lines.some((l) => l.is3cx)) format = "3cx";
      const byName = new Map(objects.filter((o) => o.kind === "rule").map((o) => [norm(o.name), o]));
      const userDids = new Map();
      for (const u of users) for (const d of u.dids) userDids.set(d, u.id);
      for (const l of lines) {
        const cur = byName.get(l.key);
        l.action = cur ? "update" : "create";
        if (l.error) continue;
        try { validateObject("rule", l.input, cur?.data, { ...ctx, selfId: cur?.id, userDids }); }
        catch (e) { l.error = e.message; }
      }
      if (apply) for (const l of lines.filter((x) => !x.error)) {
        try {
          const cur = (await pbx.listObjects("rule")).find((o) => norm(o.name) === l.key);
          await pbx.saveObject("rule", cur?.id || null, l.input, by); l.done = true;
        } catch (e) { l.error = e.message; }
      }
    } else {
      const list = await admin.listOutbound();
      const trunks = new Set([...list.trunks.map((t) => t.id), ...(pending?.trunks || [])]);
      const byName = new Map(list.rules.map((r) => [norm(r.name), r]));
      lines = parseOutbound(table);
      for (const l of lines) {
        l.action = byName.has(l.key) ? "update" : "create";
        try {
          validateRule(l.input, { trunks, cc });
        } catch (e) { l.error = e.message; }
      }
      if (apply) for (const l of lines.filter((x) => !x.error)) {
        try { await admin.saveOutbound(byName.get(l.key)?.id || null, l.input); l.done = true; } catch (e) { l.error = e.message; }
      }
    }

    const out = lines.map(({ line, label, action, warnings, error, done }) => ({ line, label, action: error ? "error" : action, warnings, error: error || "", done: !!done }));
    return {
      kind, format, applied: apply, lines: out,
      counts: { create: out.filter((l) => l.action === "create").length, update: out.filter((l) => l.action === "update").length, error: out.filter((l) => l.action === "error").length },
    };
  }

  /**
   * Sauvegarde 3CX complète (texte du fichier …Db.xml) : aperçu ou import de chaque partie, dans l'ordre
   * trunks → utilisateurs (et leurs renvois) → horaires → règles entrantes → règles sortantes → annuaire.
   */
  async function import3cx(xml, { apply = false, consoleRoles = false, by = "" } = {}) {
    let conv;
    try { conv = convert3cx(String(xml || ""), { cc: pbx.countryCode(), templates: pbx.templates() }); }
    catch (e) { throw new UserError(e.message, "file"); }
    const T = conv.tables;
    const csv = (k) => writeCsv(T[k].headers, T[k].rows);
    const sections = [];
    const run = async (kind, label, opts = {}) => {
      if (!T[kind].rows.length) return null;
      const r = await importKind(kind, csv(kind), { apply, consoleRoles, by, ...opts });
      sections.push({ ...r, label });
      return r;
    };
    const existingSched = (await pbx.loadObjects()).filter((o) => o.kind === "schedule");
    const pending = {
      users: T.users.rows.map((r) => r[0]),
      trunks: T.trunks.rows.map((r) => r[0]),
      objects: conv.schedules.map((x, i) => ({ kind: "schedule", id: `__3cx${i}`, name: x.name, data: x.data })),
    };
    if (consoleRoles) await run("trunks", "Trunks (avec leurs mots de passe)");
    const users = await run("users", "Utilisateurs");
    // Renvois des fiches (sans réponse, occupé, absent) : après la création des postes
    if (conv.forwards.length) {
      const ok = new Set((users?.lines || []).filter((l) => l.action !== "error").map((l) => l.label.split(" ")[0]));
      const lines = [];
      for (const f of conv.forwards) {
        const l = { line: 0, label: `${f.ext} : ${Object.entries(f.forwarding).map(([k, v]) => k === "timeout" ? `${v} s` : `${{ no_answer: "sans réponse", busy: "occupé", away: "absent" }[k]} → ${v.type === "external" ? v.target : v.type === "extension" ? `poste ${v.target}` : v.type === "voicemail" ? "messagerie" : "raccrocher"}`).join(", ")}`,
          action: "update", warnings: [], error: ok.has(f.ext) ? "" : "Poste non importé", done: false };
        if (apply && !l.error) { try { await pbx.updateUser(f.ext, { forwarding: f.forwarding }, by); l.done = true; } catch (e) { l.error = e.message; } }
        if (l.error) l.action = "error";
        lines.push(l);
      }
      sections.push({ kind: "forwards", label: "Renvois des utilisateurs", applied: apply, lines, counts: { create: 0, update: lines.filter((l) => l.action === "update").length, error: lines.filter((l) => l.action === "error").length } });
    }
    // Horaires du bureau
    if (conv.schedules.length) {
      const hasGeneral = existingSched.some((o) => o.data.general);
      const lines = [];
      for (const x of conv.schedules) {
        const cur = existingSched.find((o) => norm(o.name) === norm(x.name));
        const l = { line: 0, label: x.name, action: cur ? "update" : "create", warnings: hasGeneral && x.data.general ? ["Les horaires généraux du PBX restent ceux déjà choisis"] : [], error: "", done: false };
        if (apply) { try { await pbx.saveObject("schedule", cur?.id || null, { ...x.data, general: x.data.general && !hasGeneral }, by); l.done = true; } catch (e) { l.error = e.message; l.action = "error"; } }
        lines.push(l);
      }
      sections.push({ kind: "schedules", label: "Horaires", applied: apply, lines, counts: { create: lines.filter((l) => l.action === "create").length, update: lines.filter((l) => l.action === "update").length, error: lines.filter((l) => l.action === "error").length } });
    }
    await run("inbound", "Règles entrantes (SDA)", { pending });
    if (consoleRoles) await run("outbound", "Règles sortantes", { pending });
    await run("contacts", "Annuaire");
    return { version: conv.version, applied: apply, sections, notes: [...conv.notes, ...(consoleRoles ? [] : ["Trunks et règles sortantes : réservés à l'installateur, non importés."])] };
  }

  return { items, exportKind, importKind, import3cx };
}
