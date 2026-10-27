/**
 * Annuaire de l'entreprise : contacts partagés (clients, fournisseurs…). Fonctions pures, testées dans
 * console/test/contacts.test.mjs : validation, import CSV, annuaire Yealink (XML), nom de l'appelant (dialplan).
 */
import { UserError, nationalNumber, USER_ROLES } from "./users.mjs";

/** Qui voit le contact : { scope: "all" } | { scope: "users", users: ["201", …] } | { scope: "roles", roles: ["manager", …] } */
export function validateVisibility(v) {
  const scope = ["users", "roles"].includes(v?.scope) ? v.scope : "all";
  if (scope === "users") {
    const users = [...new Set((Array.isArray(v.users) ? v.users : []).map(String).filter((x) => /^\d{2,6}$/.test(x)))].slice(0, 100);
    if (!users.length) throw new UserError("Choisis au moins une personne qui verra ce contact.", "visibility");
    return { scope, users };
  }
  if (scope === "roles") {
    const roles = [...new Set((Array.isArray(v.roles) ? v.roles : []).filter((r) => USER_ROLES[r]))];
    if (!roles.length) throw new UserError("Choisis au moins un rôle qui verra ce contact.", "visibility");
    return { scope, roles };
  }
  return { scope: "all" };
}
/** Le contact est-il visible par cet utilisateur ? (sans utilisateur : seulement les contacts de tout le monde) */
export function contactVisibleTo(c, user) {
  const v = c.visibility || { scope: "all" };
  if (v.scope === "users") return !!user && (v.users || []).includes(String(user.id));
  if (v.scope === "roles") return !!user && (v.roles || []).includes(user.options?.role || "user");
  return true;
}

export const PHONE_TYPES = { work: "Bureau", mobile: "Mobile", home: "Domicile", other: "Autre" };
const clean = (s, max = 60) => String(s ?? "").replace(/[\r\n<>"\\|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const contactName = (c) => `${c.first_name} ${c.last_name}`.trim() || c.company || "Sans nom";

export function validateContact(input, cc = "33") {
  const c = {
    first_name: clean(input.first_name, 40), last_name: clean(input.last_name, 40), company: clean(input.company, 80),
    email: String(input.email || "").trim().toLowerCase().slice(0, 120), notes: String(input.notes || "").replace(/\r/g, "").slice(0, 500),
    phones: [],
  };
  if (!c.first_name && !c.last_name && !c.company) throw new UserError("Indique au moins un nom ou une société.", "last_name");
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new UserError("Adresse e-mail invalide.", "email");
  for (const p of Array.isArray(input.phones) ? input.phones : []) {
    if (!String(p?.number || "").trim()) continue;
    const raw = String(p.number).trim();
    const n = nationalNumber(raw, cc) || (/^\+?\d{6,15}$/.test(raw.replace(/[\s.\-()]/g, "")) ? raw.replace(/[\s.\-()]/g, "") : null);
    if (!n) throw new UserError(`Numéro invalide : ${raw}.`, "phones");
    c.phones.push({ type: PHONE_TYPES[p.type] ? p.type : "work", number: n });
  }
  if (!c.phones.length) throw new UserError("Ajoute au moins un numéro.", "phones");
  c.phones = c.phones.slice(0, 6);
  c.visibility = validateVisibility(input.visibility);
  return c;
}

/** Lit un CSV (séparateur ; ou ,) : en-têtes reconnus en français ou en anglais. */
export function parseCsv(text) {
  const t = String(text || "").replace(/^\ufeff/, "");
  const first = t.split(/\r?\n/)[0] || "";
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const data = rows.filter((r) => r.some((x) => x.trim()));
  if (!data.length) return [];
  const n = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  const map = { prenom: "first_name", firstname: "first_name", nom: "last_name", lastname: "last_name", name: "last_name", societe: "company", entreprise: "company", company: "company", organisation: "company",
    telephone: "work", tel: "work", telephonebureau: "work", bureau: "work", phone: "work", work: "work", fixe: "work", mobile: "mobile", portable: "mobile", cell: "mobile", gsm: "mobile",
    domicile: "home", home: "home", autre: "other", other: "other", fax: "other", email: "email", mail: "email", courriel: "email", notes: "notes", commentaire: "notes" };
  const head = data[0].map((h) => map[n(h)] || "");
  if (!head.some(Boolean)) throw new UserError("En-têtes non reconnus : Prénom ; Nom ; Société ; Téléphone ; Mobile ; E-mail.", "file");
  return data.slice(1).map((r) => {
    const o = { phones: [] };
    head.forEach((k, i) => {
      const v = (r[i] || "").trim();
      if (!k || !v) return;
      if (PHONE_TYPES[k]) o.phones.push({ type: k, number: v }); else o[k] = v;
    });
    return o;
  });
}

const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
/** Annuaire distant Yealink : collègues (postes) puis contacts de l'entreprise. */
export function yealinkPhonebook(users, contacts) {
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', "<YealinkIPPhoneDirectory>"];
  for (const u of users) L.push(`  <DirectoryEntry><Name>${xml(u.name)}</Name><Telephone>${xml(u.id)}</Telephone></DirectoryEntry>`);
  for (const c of contacts) {
    const label = contactName(c) + (c.company && (c.first_name || c.last_name) ? ` (${c.company})` : "");
    L.push(`  <DirectoryEntry><Name>${xml(label)}</Name>${c.phones.map((p) => `<Telephone label="${xml(PHONE_TYPES[p.type])}">${xml(p.number)}</Telephone>`).join("")}</DirectoryEntry>`);
  }
  L.push("</YealinkIPPhoneDirectory>", "");
  return L.join("\n");
}

/** Contexte [phonebook] : nom de l'appelant à partir de son numéro (appels entrants). */
/** Ce qu'affiche un téléphone sur un appel entrant d'un contact de l'annuaire */
export const CID_DISPLAYS = { name_number: "Nom du contact puis numéro", number_name: "Numéro puis nom du contact", name: "Nom du contact seul", number: "Numéro seul" };
export const validCidDisplay = (v) => (CID_DISPLAYS[v] ? v : "name");

export function buildPhonebookDialplan(contacts) {
  const L = ["", "; Annuaire : nom affiché pour les appels entrants (écrit par la console)", "[phonebook]"];
  const seen = new Set();
  for (const c of contacts) {
    const name = (contactName(c) + (c.company && (c.first_name || c.last_name) ? ` ${c.company}` : "")).replace(/[(),;\\[\]{}$"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    for (const p of c.phones) {
      if (!/^\+?\d{6,15}$/.test(p.number) || seen.has(p.number)) continue;
      seen.add(p.number);
      L.push(`exten => ${p.number.replace("+", "")},1,Set(CALLERID(name)=${name})`, ` same => n,Set(__CXNAME=${name})`, " same => n,Return()");
    }
  }
  L.push("exten => _X.,1,Return()", "");
  return L.join("\n");
}
