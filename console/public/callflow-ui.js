// Console : Gestion d'appels (règles entrantes, horaires, groupes, files, SVI, messageries de groupe,
// annonces, traceur de routage, renvois actifs). Module chargé par app.js, qui fournit ses outils (h).
import { renderFlowEditor, flowSummary } from "./flow-editor.js";
import { renderPlanning, planningSummary } from "./planning-ui.js";
import { resolvePlan, localNow } from "./planning-core.js";
let h = null;
const TABS = [["routages", "Routages", "flow"], ["regles", "Règles entrantes", "rule"], ["horaires", "Horaires", "schedule"], ["groupes", "Groupes d'appel", "group"], ["files", "Files d'attente", "queue"],
  ["svi", "SVI", "ivr"], ["messageries", "Messageries", "groupvm"], ["reunions", "Réunions", "conf"], ["annonces", "Annonces", "prompt"], ["depannage", "Dépannage", ""], ["traceur", "Traceur", ""], ["renvois", "Renvois actifs", ""], ["planning", "Planning", "planning"]];
const HIDDEN_TABS = ["planning", "traceur", "renvois"]; // planning : ouvert depuis Routages ; traceur et renvois : dans Dépannage
const DIAG_TABS = [["depannage", "Test d'appel"], ["traceur", "Traceur"], ["renvois", "Renvois actifs"]];
const KIND_TAB = Object.fromEntries(TABS.filter((t) => t[2]).map(([s, , k]) => [k, s]));
const RANGES = { group: 600, queue: 700, ivr: 800, groupvm: 900, conf: 500 };
const IVR_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"];
const DAY_SHORT = { mon: "Lun", tue: "Mar", wed: "Mer", thu: "Jeu", fri: "Ven", sat: "Sam", sun: "Dim" };
let cf = null; // { objects, users, options, trunk_dids, timezone }

const esc = (v) => h.esc(v);
const fmtP = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const objs = (kind) => cf.objects.filter((o) => o.kind === kind);
const objLabel = (o) => `${o.number ? o.number + " · " : ""}${o.name}`;

async function load() { cf = await h.api("GET", "/api/callflow"); return cf; }

export async function renderCallflow(helpers, sub = "routages", id = null) {
  h = helpers;
  h.setNav("cf");
  await load();
  const tab = TABS.find((t) => t[0] === sub) && (sub !== "planning" || id) ? sub : "routages";
  const kind = TABS.find((t) => t[0] === tab)[2];
  const head = `<div class="bar"><div class="grow"><h1>Gestion d'appels</h1><p class="sub" style="margin:0">Où vont les appels entrants : routages par numéro (avec leurs horaires), groupes, files d'attente, SVI.</p></div></div>
    <nav class="tabs">${TABS.filter(([s]) => !HIDDEN_TABS.includes(s) && (s !== "regles" || tab === "regles" || objs("rule").length)).map(([s, l]) => `<a href="#/gestion/${s}" class="${s === tab || (s === "routages" && tab === "planning") || (s === "depannage" && DIAG_TABS.some(([k]) => k === tab)) ? "on" : ""}">${l}</a>`).join("")}</nav>
    ${DIAG_TABS.some(([k]) => k === tab) ? `<nav class="subtabs">${DIAG_TABS.map(([k, l]) => `<a href="#/gestion/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>` : ""}`;
  if (tab === "standard") { location.hash = "#/utilisateurs"; return; }   // déplacé : fiche utilisateur › Renvois d'appels
  if (tab === "depannage") return renderDiag(head, id);
  if (tab === "traceur") return renderTracer(head, id);
  if (tab === "renvois") return renderForwards(head);
  if (id && kind === "planning") {
    const plan = id === "nouveau" ? null : cf.objects.find((o) => o.kind === "planning" && o.id === id);
    if (id !== "nouveau" && !plan) { h.app.innerHTML = `${head}<div class="flash bad">Planning introuvable.</div>`; return; }
    return renderPlanning(h.app, {
      cf, plan, mode: "admin", top: `${h.takeFlash()}${head}`, backHref: "#/gestion/routages", backLabel: "Routages",
      traceHref: (did) => `#/gestion/traceur/${encodeURIComponent(did)}`,
      save: (body) => h.api(plan ? "PUT" : "POST", `/api/callflow/planning${plan ? "/" + plan.id : ""}`, body),
      remove: () => h.api("DELETE", `/api/callflow/planning/${plan.id}?force=1`),
      done: (text) => { h.setFlash({ text }); location.hash = "#/gestion/routages"; },
    });
  }
  if (id && kind === "flow") return renderFlowEditor(h, cf, head, id, { promptField, wirePromptFields, destPicker, wireDests, scheduleFields, wireSchedule, collect, defaults, IVR_KEYS });
  if (id) return kind === "prompt" ? renderPromptForm(head, id) : renderForm(head, kind, id === "nouveau" ? null : id);
  if (kind === "schedule") return renderSchedules(head);
  return renderList(head, kind);
}

// ---------------------------------------------------------------- Standard : ouvert / fermé / renvoyé pour tout le PBX
// Réglé dans la fiche utilisateur › Renvois d'appels (app.js) : les champs « ui.std.* » font partie du formulaire de la fiche.
const STD_LOOK = { open: ["ok", "Ouvert"], closed: ["bad", "Fermé"], forward: ["fwd", "Renvoyé"] };
export async function standardBox(helpers, u, codes) {
  h = helpers;
  const [st] = await Promise.all([h.api("GET", "/api/standard"), load()]);
  const role = u.options.role || "user";
  const locked = role === "manager" || role === "console";
  const can = role !== "user";
  const dids = [...new Set((cf.trunk_dids || []).map((d) => d.did))];
  const code = (id, label, suffix = "") => codeField(id, label, codes, suffix);
  const since = st.since ? `depuis le ${new Date(st.since).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${st.by ? ` · ${esc(st.by)}` : ""}` : "";
  const html = `<section class="fwcard std-card">
    <header><span class="fwic">☎</span><div class="grow"><h3>Standard de l'entreprise</h3><p>Ouvrir ou fermer d'un coup tous les numéros du PBX</p></div></header>
    <label class="switch big"><input type="checkbox" name="ui.std_can" ${can ? "checked" : ""} ${locked ? "disabled" : ""}><span></span>
      Ce poste peut ouvrir et fermer le standard${locked ? ` <em class="hint">(inclus dans le rôle ${role === "manager" ? "Responsable" : "Accès console"})</em>` : ""}</label>
    <div class="std-body" ${can ? "" : "hidden"}>
      <div class="std-now"><span class="dl">En ce moment <em class="hint">${since}</em></span>
        <div class="std-states">${Object.entries(STD_LOOK).map(([k, [cls, l]]) => `<button type="button" class="std-st ${cls} ${st.state === k ? "on" : ""}" data-st="${k}"><i></i>${l}${k === "forward" && st.state === k ? ` <small>${esc(fmtP(st.target))}</small>` : ""}</button>`).join("")}</div>
        <div class="std-fwd" hidden><input id="stdnum" inputmode="tel" placeholder="Numéro, ex. 06 12 34 56 78" value="${st.state === "forward" ? esc(fmtP(st.target)) : ""}"><button type="button" class="btn sm" id="stdgo">Renvoyer</button></div></div>
      ${destPicker("ui.std.closed_dest", st.closed_dest, { label: "Quand le standard est fermé, les appels vont vers", withPrompt: true })}
      <div><span class="dl">Codes à composer sur le téléphone</span>
        <div class="codes">${code("std_close", "Fermer")}${code("std_open", "Ouvrir")}${code("std_forward", "Renvoyer vers un numéro", "+ numéro")}</div></div>
      ${dids.length ? `<div><span class="dl">Numéros qui ne ferment jamais</span>
        <div class="dids">${dids.map((d) => `<button type="button" class="chip" data-skip="${esc(d)}">${esc(fmtP(d))}</button>`).join("")}</div>
        <input type="hidden" name="ui.std.skip_dids" value="${esc((st.skip_dids || []).join(","))}">
        <span class="hint">Touche un numéro pour qu'il ne ferme jamais (ligne directe, fax…). Les numéros directs des utilisateurs ne ferment jamais.</span></div>` : ""}
      <p class="hint" style="margin:0">Réglages communs à tout le PBX${st.standardists.length ? ` · standardistes : ${st.standardists.map((x) => esc(`${x.id} ${x.name}`)).join(", ")}` : ""}. Aussi avec la touche « Standard » (onglet Touches), le softphone et l'appli.</p>
    </div></section>`;
  const wire = (root, onState) => {
    wireDests(root.querySelector(".std-card"));
    const can = root.querySelector("[name='ui.std_can']");
    can.addEventListener("change", () => { root.querySelector(".std-body").hidden = !can.checked; });
    const hid = root.querySelector("[name='ui.std.skip_dids']");
    const chips = root.querySelectorAll("[data-skip]");
    const draw = () => { const set = new Set(hid.value.split(",").filter(Boolean)); chips.forEach((b) => b.classList.toggle("on", set.has(b.dataset.skip))); };
    chips.forEach((b) => (b.onclick = () => {
      const set = new Set(hid.value.split(",").filter(Boolean));
      set.has(b.dataset.skip) ? set.delete(b.dataset.skip) : set.add(b.dataset.skip);
      hid.value = [...set].join(","); draw(); hid.dispatchEvent(new Event("input", { bubbles: true }));
    }));
    if (hid) draw();
    const fwdBox = root.querySelector(".std-fwd");
    const go = async (state, target = "") => {
      try { const r = await h.api("POST", "/api/standard/state", { state, target }); h.setFlash({ text: r.label }); onState(); }
      catch (e) { h.showFormError(root.querySelector("form") || root, { ...e, field: "" }); }
    };
    root.querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => {
      if (b.dataset.st === "forward") { fwdBox.hidden = false; root.querySelector("#stdnum").focus(); return; }
      if (b.dataset.st === "closed" && !confirm("Fermer le standard maintenant ? Tous les numéros du PBX iront vers la destination choisie.")) return;
      go(b.dataset.st);
    }));
    root.querySelector("#stdgo").onclick = () => go("forward", root.querySelector("#stdnum").value);
  };
  return { html, wire, closed: st.closed_dest, skip: st.skip_dids || [] };
}
const escS = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** Champ « code à composer » (commun à tous les postes) */
export function codeField(id, label, codes, suffix = "") {
  const c = codes?.find((x) => x.id === id);
  if (!c) return "";
  return `<label class="sc-code"><span>${escS(label)}</span><span class="code-in"><input name="ui.codes.${id}" value="${escS(c.code)}" maxlength="5" autocomplete="off" spellcheck="false">${suffix ? `<em>${escS(suffix)}</em>` : ""}</span></label>`;
}

// ---------------------------------------------------------------- Horaires : généraux du PBX + par numéro
function renderSchedules(head) {
  const scheds = objs("schedule");
  const general = scheds.find((s) => s.data.general);
  const byId = (id) => scheds.find((s) => s.id === id);
  const stateTxt = (st) => `<span class="pill ${st === "open" ? "ok" : st === "holiday" ? "wait" : st === "break" ? "wait" : "bad"}">${st === "open" ? "Ouvert" : st === "holiday" ? "Férié / congés" : st === "break" ? "Pause" : "Fermé"}</span>`;
  const entry = cf.objects.filter((o) => ["rule", "flow", "planning", "group", "queue", "ivr"].includes(o.kind));
  const def = entry.find((o) => o.data.is_default);
  const hoursOf = (o) => {
    if (!o) return { txt: "Toujours ouvert", st: "open" };
    if (o.kind === "planning") {
      const now = localNow(new Date(), cf.timezone); const r = resolvePlan(o.data, now.ymd, now.minute);
      return { txt: `Planning « ${o.name} » (par tranche horaire)`, st: null, now: o.data.scenarios.find((x) => x.id === r.scenario)?.name || "?" };
    }
    const s = o.data.schedule && byId(o.data.schedule);
    return s ? { txt: `« ${s.name} »${s.data.general ? " (généraux)" : ""} · ${describeWeek(s.data.week)}`, st: scheduleNow(s.data), href: `#/gestion/horaires/${s.id}` } : { txt: "Toujours ouvert (aucun horaire)", st: "open" };
  };
  const destOf = (did) => {
    const u = cf.users.find((x) => (x.dids || []).includes(did));
    if (u) return { label: `Utilisateur ${u.id} · ${u.name}`, href: `#/utilisateurs/${u.id}/general`, obj: null, user: true };
    const o = entry.find((x) => (x.data.dids || []).includes(did)) || null;
    if (o) return { label: `${o.kind === "planning" ? "Planning" : o.kind === "flow" ? "Routage" : o.kind === "rule" ? "Règle" : cf.options.kinds[o.kind]} « ${o.name} »`, href: `#/gestion/${KIND_TAB[o.kind]}/${o.id}`, obj: o };
    if (def) return { label: `Par défaut : « ${def.name} »`, href: `#/gestion/${KIND_TAB[def.kind]}/${def.id}`, obj: def };
    return { label: "Aucune règle (sonnerie générale)", href: "#/routes", obj: null };
  };
  const rows = cf.trunk_dids.map(({ did, trunk }) => {
    const d = destOf(did); const hrs = d.user ? { txt: "Ses propres renvois (fiche utilisateur)", st: null } : hoursOf(d.obj);
    return `<tr><td class="nw"><strong>${esc(fmtP(did))}</strong><div class="s">${esc(trunk)}</div></td>
      <td><a href="${esc(d.href)}">${esc(d.label)}</a></td>
      <td>${hrs.href ? `<a href="${esc(hrs.href)}">${esc(hrs.txt)}</a>` : esc(hrs.txt)}</td>
      <td class="nw">${hrs.st ? stateTxt(hrs.st) : hrs.now ? `<span class="pill ok">${esc(hrs.now)}</span>` : "—"}</td>
      <td class="acts"><a class="btn ghost sm" href="#/gestion/depannage/${encodeURIComponent(did)}">Tester</a></td></tr>`;
  }).join("");
  const used = (id) => cf.objects.filter((o) => o.data.schedule === id).length;
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed">
    <div class="ph"><p class="hint" style="margin:0;max-width:760px">Les horaires généraux s'appliquent par défaut aux nouveaux routages. Chaque numéro peut avoir ses propres horaires dans son routage (ou un planning par tranche horaire).</p>
      <a class="btn" href="#/gestion/horaires/nouveau">+ Nouveaux horaires</a></div>
    <div class="pad"><h3 class="cf-h" style="margin-top:0">Horaires généraux du PBX</h3>
      ${general ? `<div class="sch-gen"><div class="grow"><strong>${esc(general.name)}</strong> ${stateBadge(general)}<div class="s">${esc(describeWeek(general.data.week))}${general.data.holidays_fr ? " · fermé les jours fériés" : ""}${general.data.holidays.length ? ` · ${general.data.holidays.length} période(s) de congés` : ""}</div></div>
        <a class="btn ghost sm" href="#/gestion/horaires/${esc(general.id)}">Modifier</a></div>`
        : `<div class="note">Aucun horaire n'est marqué « généraux ». ${scheds.length ? "Ouvre l'un d'eux et coche « Horaires généraux du PBX »." : '<a href="#/gestion/horaires/nouveau">Crée les horaires du bureau</a> et coche « Horaires généraux du PBX ».'}</div>`}
      <h3 class="cf-h">Horaires par numéro du trunk</h3>
      ${cf.trunk_dids.length ? `<div class="table-wrap"><table><thead><tr><th>Numéro</th><th>Reçu par</th><th>Horaires appliqués</th><th>Maintenant</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="hint">Aucune SDA déclarée dans les trunks (Trunks › SDA).</p>'}
      <h3 class="cf-h">Tous les horaires</h3>
      ${scheds.length ? `<div class="table-wrap"><table><thead><tr><th>Nom</th><th>Semaine</th><th>Utilisé par</th><th></th></tr></thead><tbody>
        ${scheds.map((o) => `<tr><td><a href="#/gestion/horaires/${esc(o.id)}">${esc(o.name)}</a>${o.data.general ? ' <span class="pill ok">Généraux</span>' : ""}<div>${stateBadge(o)}</div></td>
          <td>${summary(o)}</td><td>${used(o.id) ? `${used(o.id)} routage${used(o.id) > 1 ? "s" : ""}` : '<span class="s">rien</span>'}</td>
          <td class="acts"><a class="btn ghost sm" href="#/gestion/horaires/${esc(o.id)}">Modifier</a></td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Aucun horaire pour l\'instant.</div>'}
    </div></div>`;
}

// ---------------------------------------------------------------- Listes
const INTRO = {
  flow: "Le plus simple : décris le routage en une phrase ou construis-le en glissant des cadres de gauche à droite (SDA → sonnerie → groupe → messagerie…). Pour des renvois différents selon le jour et l'heure (lundi 9 h-12 h Paul puis son mobile, 14 h-18 h Julie…), crée un planning de la semaine.",
  rule: "Une règle par numéro appelé (SDA) : où va l'appel pendant les heures d'ouverture, en dehors et les jours fériés. La règle par défaut prend les SDA sans règle.",
  schedule: "Plages d'ouverture de la semaine, jours fériés et congés. Choisis-les (ou crées-les) directement dans l'éditeur de routage.",
  group: "Plusieurs postes sonnent ensemble ou à tour de rôle. Les membres Absents, en Ne pas déranger ou qui refusent les appels de groupe ne sonnent pas.",
  queue: "L'appelant patiente en musique jusqu'à ce qu'un agent se libère ; la position dans la file peut être annoncée.",
  ivr: "Standard automatique : « Tapez 1 pour le service commercial… ». L'appelant peut aussi composer directement un numéro de poste.",
  groupvm: "Une boîte vocale partagée : le voyant s'allume chez tous les membres, qui l'écoutent dans le softphone ou avec *98.",
  conf: "Salles de réunion : on compose le numéro depuis n'importe quel poste. Depuis le softphone web, la réunion est aussi en vidéo.",
  prompt: "Messages audio utilisés par les SVI, les files d'attente et les règles (« Nous sommes fermés… »).",
};
function summary(o) {
  const d = o.data;
  const users = new Map(cf.users.map((u) => [u.id, u]));
  const mem = (list) => list.length ? list.map((x) => `${esc(x)}${users.get(x) ? ` <span class="s">${esc(users.get(x).name)}</span>` : ""}`).join(", ") : '<span class="s">aucun membre</span>';
  switch (o.kind) {
    case "planning": return `${d.is_default ? '<span class="pill ok">Par défaut</span> ' : ""}${d.dids.map(fmtP).map(esc).join(", ")}<div class="s">${esc(planningSummary(d, cf))}</div>`;
    case "flow": return `${d.is_default ? '<span class="pill ok">Par défaut</span> ' : ""}${d.dids.map(fmtP).map(esc).join(", ")}<div class="s">${esc(flowSummary(cf, h, d))}</div>`;
    case "rule": return `${d.is_default ? '<span class="pill ok">Par défaut</span> ' : ""}${d.dids.map(fmtP).map(esc).join(", ")}<div class="s">${d.schedule ? `Horaires « ${esc(cf.objects.find((x) => x.id === d.schedule)?.name || "?")} »` : "Toujours ouvert"} → ${esc(destText(d.open))}</div>`;
    case "schedule": return `${esc(describeWeek(d.week))}<div class="s">${d.holidays_fr ? "Jours fériés fermés" : "Jours fériés ouverts"}${d.holidays.length ? ` · ${d.holidays.length} période${d.holidays.length > 1 ? "s" : ""} de congés` : ""}${d.override !== "auto" ? ` · <strong>forcé ${d.override === "open" ? "ouvert" : "fermé"}</strong>` : ""}</div>`;
    case "group": return `${mem(d.members)}<div class="s">${esc(cf.options.group_strategies[d.strategy])} · ${d.ring_time} s → ${esc(destText(d.no_answer))}</div>`;
    case "queue": return `${mem(d.members)}<div class="s">${esc(cf.options.queue_strategies[d.strategy])} · attente max ${d.max_wait} s → ${esc(destText(d.no_answer))}</div>`;
    case "ivr": return `${Object.keys(d.options).map((k) => `<strong>${esc(k)}</strong> ${esc(destText(d.options[k]))}`).join(" · ") || '<span class="s">aucune touche</span>'}`;
    case "groupvm": return mem(d.members);
    case "conf": return `${d.max_members} participants max${d.pin ? " · code PIN" : ""}${d.video ? " · vidéo" : ""}`;
    default: return "";
  }
}
function describeWeek(week) {
  const days = Object.keys(DAY_SHORT);
  const parts = []; let i = 0;
  while (i < days.length) {
    const key = JSON.stringify(week[days[i]] || []); let j = i;
    while (j + 1 < days.length && JSON.stringify(week[days[j + 1]] || []) === key) j++;
    if ((week[days[i]] || []).length) parts.push(`${DAY_SHORT[days[i]]}${i !== j ? "-" + DAY_SHORT[days[j]] : ""} ${week[days[i]].map(([a, b]) => `${a}-${b}`).join(", ")}`);
    i = j + 1;
  }
  return parts.join(" ; ") || "Jamais ouvert";
}
function destText(d) {
  if (!d) return "comme fermé";
  const u = cf.users.find((x) => x.id === d.target);
  switch (d.type) {
    case "hangup": return "Raccrocher";
    case "user": return `${d.target}${u ? " " + u.name : ""}`;
    case "user_vm": return `Messagerie de ${d.target}`;
    case "external": return fmtP(d.target);
    default: { const o = cf.objects.find((x) => x.kind === d.type && x.id === d.target); return o ? `${cf.options.dest_types[d.type]} ${objLabel(o)}` : "?"; }
  }
}

function renderList(head, kind) {
  // Les routages (éditeur visuel ou texte) sont aussi des règles entrantes : on les montre dans les deux onglets
  const list = kind === "rule" ? [...objs("rule"), ...objs("flow"), ...objs("planning")] : kind === "flow" ? [...objs("flow"), ...objs("planning")] : objs(kind);
  const tab = KIND_TAB[kind];
  const label = cf.options.kinds[kind];
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed">
    <div class="ph"><p class="hint" style="margin:0;max-width:760px">${INTRO[kind]}</p>
      ${kind === "prompt" ? `<a class="btn" href="#/gestion/annonces/nouveau">+ Ajouter une annonce</a>` : kind === "flow" ? `<div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn ghost" href="#/gestion/planning/nouveau">+ Planning de la semaine</a><a class="btn" href="#/gestion/routages/nouveau">+ Nouveau routage</a></div>` : `<a class="btn" href="#/gestion/${tab}/nouveau">+ ${kind === "rule" ? "Nouvelle règle" : kind === "schedule" ? "Nouveaux horaires" : `Nouveau ${label.split(" (")[0].replace(/^Groupe/, "groupe").replace(/^File/, "file").replace(/^SVI/, "SVI").replace(/^Messagerie/, "messagerie").toLowerCase()}`}</a>`}</div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr>${["rule", "schedule", "prompt", "flow"].includes(kind) ? "" : "<th>Numéro</th>"}<th>Nom</th><th>${kind === "prompt" ? "Écoute" : "Configuration"}</th><th></th></tr></thead><tbody>
      ${list.map((o) => `<tr>${["rule", "schedule", "prompt", "flow"].includes(kind) ? "" : `<td><strong>${esc(o.number)}</strong></td>`}
        <td><a href="#/gestion/${KIND_TAB[o.kind]}/${esc(o.id)}">${esc(o.name)}</a>${kind === "rule" && o.kind === "flow" ? ' <span class="pill off">Routage</span>' : ""}${o.kind === "planning" ? ' <span class="pill off">Planning</span>' : ""}${kind === "schedule" ? `<div>${stateBadge(o)}</div>` : ""}</td>
        <td>${kind === "prompt" ? `<audio controls preload="none" src="/api/prompts/${esc(o.id)}/audio"></audio> <span class="s">${o.data.duration} s</span>` : summary(o)}</td>
        <td class="acts">${o.number ? `<a class="btn ghost sm" href="#/gestion/traceur/${esc(o.number)}">Tracer</a> ` : ""}${(kind === "rule" || kind === "flow") && o.data.dids?.[0] ? `<a class="btn ghost sm" href="#/gestion/traceur/${esc(o.data.dids[0])}">Tracer</a> ` : ""}<a class="btn ghost sm" href="#/gestion/${KIND_TAB[o.kind]}/${esc(o.id)}">Modifier</a></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">Aucun élément pour l'instant.</div>`}
  </div>`;
}

function stateBadge(o) {
  const st = scheduleNow(o.data);
  return `<span class="pill ${st === "open" ? "ok" : st === "holiday" ? "wait" : "bad"}">${st === "open" ? "Ouvert" : st === "holiday" ? "Férié / congés" : "Fermé"} maintenant</span>`;
}
function scheduleNow(d) {
  if (d.override !== "auto") return d.override;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: cf.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if ((d.holidays || []).some((x) => day >= x.from && day <= x.to)) return "holiday";
  if (d.holidays_fr && frHolidays(Number(parts.year)).includes(day)) return "holiday";
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return (d.week[parts.weekday.toLowerCase().slice(0, 3)] || []).some(([a, b]) => now >= m(a) && now < m(b)) ? "open" : "closed";
}
function frHolidays(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7, mm = Math.floor((a + 11 * hh + 22 * l) / 451);
  const E = Date.UTC(y, Math.floor((hh + l - 7 * mm + 114) / 31) - 1, ((hh + l - 7 * mm + 114) % 31) + 1);
  const dd = (n) => new Date(E + n * 86400000).toISOString().slice(0, 10);
  return [`${y}-01-01`, dd(1), `${y}-05-01`, `${y}-05-08`, dd(39), dd(50), `${y}-07-14`, `${y}-08-15`, `${y}-11-01`, `${y}-11-11`, `${y}-12-25`];
}

// ---------------------------------------------------------------- Champs communs
const KEY_LABELS = { hangup: "Terminer l'appel", user: "Connecter à un utilisateur", user_vm: "Connecter à une boîte vocale", group: "Connecter à un groupe d'appel",
  ivr: "Connecter à un répondeur numérique", queue: "Connecter à une file d'attente", groupvm: "Connecter à une boîte vocale de groupe", conf: "Connecter à une salle de réunion",
  external: "Transférer vers un numéro externe", prompt: "Lire une annonce puis raccrocher" };
function destPicker(name, dest, { label, selfId, allowNone = false, noneLabel = "— Rien —", withPrompt = true, keyLabels = false } = {}) {
  const type = dest?.type || (allowNone ? "none" : "hangup");
  const types = Object.entries(keyLabels ? KEY_LABELS : cf.options.dest_types);
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
  const users = cf.users.map((u) => [u.id, `${u.id} · ${u.name}`]);
  const targetsFor = (k) => k === "user" || k === "user_vm" ? users : objs(k).filter((o) => o.id !== selfId).map((o) => [o.id, objLabel(o)]);
  return `<div class="dest" data-dest="${esc(name)}">${label ? `<span class="dl">${esc(label)}</span>` : ""}
    <div class="row"><select name="${esc(name)}.type">${allowNone ? `<option value="none" ${type === "none" ? "selected" : ""}>${esc(noneLabel)}</option>` : ""}${opt(types, type)}</select>
    ${["user", "user_vm", "group", "queue", "ivr", "groupvm", "conf", "prompt"].map((k) => {
      const list = targetsFor(k);
      const on = type === k;
      return `<select name="${esc(name)}.target" data-for="${k}" ${on ? "" : "hidden disabled"}><option value="">${list.length ? "— Choisir —" : "— Aucun : crée-le d'abord —"}</option>${opt(list, on ? dest.target : "")}</select>`;
    }).join("")}
    <input name="${esc(name)}.target" data-for="external" inputmode="tel" placeholder="06 12 34 56 78" value="${type === "external" ? esc(fmtP(dest.target)) : ""}" ${type === "external" ? "" : "hidden disabled"}></div>
    ${withPrompt ? `<div class="pplay"><label class="switch"><input type="checkbox" name="${esc(name)}.prompt_on" ${dest?.prompt ? "checked" : ""}><span></span> Lire l'annonce</label>
      <select name="${esc(name)}.prompt" class="psel" data-prompts ${dest?.prompt ? "" : "hidden"}>${promptOptions(dest?.prompt || "", "— Choisir l'annonce —")}</select></div>` : ""}</div>`;
}
function wireDests(root) {
  root.querySelectorAll(".dest").forEach((box) => {
    const sel = box.querySelector("select[name$='.type']");
    const sync = () => box.querySelectorAll("[data-for]").forEach((el) => { const on = el.dataset.for === sel.value; el.hidden = !on; el.disabled = !on; });
    sel.addEventListener("change", sync); sync();
    const on = box.querySelector("[name$='.prompt_on']"), ps = box.querySelector("select[name$='.prompt']");
    const syncP = () => { if (!on) return; const none = sel.value === "none"; on.closest(".pplay").hidden = none; ps.hidden = !on.checked || none; };
    on?.addEventListener("change", syncP); sel.addEventListener("change", syncP); syncP();
  });
}
function membersPicker(name, list, { ordered = false, label = "Membres" } = {}) {
  return `<div class="members" data-members="${esc(name)}" data-ordered="${ordered ? 1 : 0}"><span class="dl">${esc(label)}</span>
    <ol class="mlist"></ol>
    <div class="row"><select class="madd"><option value="">+ Ajouter…</option></select><button type="button" class="btn ghost sm mall">Tout le monde</button></div>
    <input type="hidden" name="${esc(name)}" value="${esc(list.join(","))}"></div>`;
}
function wireMembers(root) {
  root.querySelectorAll(".members").forEach((box) => {
    const input = box.querySelector("input[type=hidden]");
    const ordered = box.dataset.ordered === "1";
    let cur = input.value ? input.value.split(",") : [];
    const draw = () => {
      input.value = cur.join(",");
      box.querySelector(".mlist").innerHTML = cur.map((id, i) => {
        const u = cf.users.find((x) => x.id === id);
        const st = !u ? "" : u.disabled ? '<span class="pill off">Désactivé</span>' : u.status !== "available" ? `<span class="pill wait">${u.status === "away" ? "Absent" : "Ne pas déranger"}</span>` : "";
        return `<li><span class="grow"><strong>${esc(id)}</strong> ${esc(u?.name || "?")} ${st}</span>
          ${ordered ? `<button type="button" class="ic" data-up="${i}" ${i ? "" : "disabled"} title="Monter">↑</button><button type="button" class="ic" data-down="${i}" ${i < cur.length - 1 ? "" : "disabled"} title="Descendre">↓</button>` : ""}
          <button type="button" class="ic" data-rm="${i}" title="Retirer">✕</button></li>`;
      }).join("") || '<li class="s">Aucun membre.</li>';
      box.querySelector(".madd").innerHTML = `<option value="">+ Ajouter…</option>${cf.users.filter((u) => !cur.includes(u.id)).map((u) => `<option value="${esc(u.id)}">${esc(u.id)} · ${esc(u.name)}</option>`).join("")}`;
      box.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => { cur.splice(Number(b.dataset.rm), 1); draw(); });
      box.querySelectorAll("[data-up]").forEach((b) => b.onclick = () => { const i = Number(b.dataset.up); [cur[i - 1], cur[i]] = [cur[i], cur[i - 1]]; draw(); });
      box.querySelectorAll("[data-down]").forEach((b) => b.onclick = () => { const i = Number(b.dataset.down); [cur[i + 1], cur[i]] = [cur[i], cur[i + 1]]; draw(); });
    };
    box.querySelector(".madd").onchange = (e) => { if (e.target.value) { cur.push(e.target.value); draw(); } };
    box.querySelector(".mall").onclick = () => { cur = [...cur, ...cf.users.map((u) => u.id).filter((x) => !cur.includes(x))]; draw(); };
    draw();
  });
}
function nextNumber(kind) {
  const used = new Set([...cf.users.map((u) => u.id), ...cf.objects.map((o) => o.number).filter(Boolean)]);
  for (let n = RANGES[kind]; n < RANGES[kind] + 100; n++) if (!used.has(String(n))) return String(n);
  return "";
}
const promptOptions = (cur, empty = "— Aucune —") => `<option value="">${empty}</option>${objs("prompt").map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? "selected" : ""}>${esc(p.name)} (${p.data.duration} s)</option>`).join("")}`;

/** Choix d'une annonce + envoi d'un fichier ou enregistrement au micro sans quitter la fiche. */
function promptField(name, cur, label, hint = "") {
  return `<div class="pfield"><span class="dl">${esc(label)}</span><div class="prow">
    <select name="${esc(name)}" data-prompts>${promptOptions(cur)}</select>
    <button type="button" class="ic big" data-pup title="Envoyer un fichier audio">⤒</button>
    <button type="button" class="ic big" data-prec title="Enregistrer avec le micro">🎙</button>
    <button type="button" class="ic big" data-pplay title="Écouter">▶</button>
    <input type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg" hidden></div>
    <span class="hint pst">${hint || "Fichier MP3, WAV, M4A… converti automatiquement (WAV 8 kHz, 16 bits, mono)."}</span></div>`;
}
function refreshPromptSelects(root) {
  root.querySelectorAll("select[data-prompts]").forEach((sel) => {
    const cur = sel.value; const empty = sel.options[0]?.textContent || "— Aucune —";
    sel.innerHTML = promptOptions(cur, empty);
  });
}
function wirePromptFields(root) {
  root.querySelectorAll(".pfield").forEach((box) => {
    const sel = box.querySelector("select"), file = box.querySelector("input[type=file]"), st = box.querySelector(".pst");
    let audio = null;
    const add = async (buf, baseName) => {
      st.textContent = "Conversion…";
      try {
        const { wav, secs } = await toPhoneWav(buf);
        st.textContent = "Envoi…";
        const o = await h.api("POST", "/api/prompts", { name: baseName.slice(0, 50) || "Annonce", wav: b64(wav) });
        cf.objects.push(o); refreshPromptSelects(root); sel.value = o.id;
        st.textContent = `Annonce « ${o.name} » ajoutée (${secs.toFixed(1)} s).`;
      } catch (err) { st.textContent = `Erreur : ${err.message}`; }
    };
    box.querySelector("[data-pup]").onclick = () => file.click();
    file.onchange = async () => { const f = file.files[0]; if (f) await add(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, "")); file.value = ""; };
    box.querySelector("[data-pplay]").onclick = () => {
      if (audio) { audio.pause(); audio = null; return; }
      if (!sel.value) return;
      audio = new Audio(`/api/prompts/${encodeURIComponent(sel.value)}/audio`); audio.onended = () => { audio = null; }; audio.play();
    };
    let rec = null;
    const recBtn = box.querySelector("[data-prec]");
    recBtn.onclick = async () => {
      if (rec) { rec.stop(); return; }
      if (!navigator.mediaDevices?.getUserMedia) { st.textContent = "Micro indisponible (il faut le HTTPS)."; return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = []; rec = new MediaRecorder(stream);
        rec.ondataavailable = (ev) => chunks.push(ev.data);
        rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); rec = null; recBtn.textContent = "🎙"; recBtn.classList.remove("rec");
          const nm = prompt("Nom de l'annonce :", "Annonce") || "Annonce"; await add(await new Blob(chunks).arrayBuffer(), nm); };
        rec.start(); recBtn.textContent = "■"; recBtn.classList.add("rec"); st.textContent = "Enregistrement… clique sur ■ pour arrêter.";
      } catch (err) { st.textContent = `Micro refusé : ${err.message}`; }
    };
  });
}
const num = (name, label, v, min, max, hint = "") => `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" value="${esc(v)}">${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;

// ---------------------------------------------------------------- Formulaires
function didChips(d, selfId) {
  const usedElsewhere = new Map();
  for (const o of cf.objects) if (o.id !== selfId) for (const x of o.data.dids || []) usedElsewhere.set(x, o.name);
  const known = cf.trunk_dids.map((x) => x.did);
  const extra = (d.dids || []).filter((x) => !known.includes(x));
  return `<div class="cf-sec"><span class="dl">Numéro(s) SDA assigné(s)</span>
      ${cf.trunk_dids.length ? `<div class="chips">${cf.trunk_dids.map(({ did, trunk }) => {
        const other = usedElsewhere.get(did);
        return `<button type="button" class="chip ${(d.dids || []).includes(did) ? "on" : ""}" data-did="${esc(did)}" ${other ? `disabled title="Déjà utilisée : ${esc(other)}"` : `title="Trunk ${esc(trunk)}"`}>${esc(fmtP(did))}${other ? ` <span class="s">(${esc(other)})</span>` : ""}</button>`;
      }).join("")}</div>` : '<p class="hint" style="margin:0">Aucune SDA déclarée dans les trunks (Trunks › SDA). Tu peux les saisir ci-dessous.</p>'}
      <label style="margin-top:10px">Autres SDA (une par ligne)<textarea name="dids_extra" rows="1" placeholder="04 12 34 56 78">${esc(extra.map(fmtP).join("\n"))}</textarea></label></div>`;
}
function officeFields(d, id) {
  const acc = { allowNone: true, noneLabel: "Accepter quand même (ignorer les heures de bureau)", selfId: id };
  return `<h3 class="cf-h">Heures de bureau</h3>
    <div class="grid2">
      <label>Horaires appliqués<select name="schedule" class="osched"><option value="">Aucun : toujours accepter</option>${objs("schedule").map((s) => `<option value="${esc(s.id)}" ${d.schedule === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
        <span class="hint"><a href="#/gestion/horaires/nouveau">Créer des horaires</a></span></label><div></div>
      <div class="odest">${destPicker("closed", d.closed, { ...acc, label: "Quand le bureau est fermé, router vers" })}</div>
      <div class="odest">${destPicker("break", d.break, { ...acc, label: "Pendant les pauses, router vers" })}</div>
      <div class="odest">${destPicker("holiday", d.holiday, { ...acc, label: "Quand c'est un jour férié, router vers" })}</div>
    </div>`;
}
function wireOffice(form) {
  const sel = form.querySelector(".osched"); if (!sel) return;
  const sync = () => form.querySelectorAll(".odest").forEach((x) => { x.style.opacity = sel.value ? "" : ".45"; x.querySelectorAll("select,input").forEach((el) => { el.dataset.off = sel.value ? "" : "1"; }); });
  sel.onchange = sync; sync();
}

function renderForm(head, kind, id) {
  const o = id ? cf.objects.find((x) => x.kind === kind && x.id === id) : null;
  if (id && !o) { h.app.innerHTML = `${head}<div class="flash bad">Introuvable.</div>`; return; }
  const d = o?.data || defaults(kind);
  const tab = KIND_TAB[kind];
  const numbered = ["group", "queue", "ivr", "groupvm", "conf"].includes(kind);
  let body = "";
  if (kind === "group") {
    body = `${didChips(d, id)}
      <h3 class="cf-h">Stratégie</h3>
      <div class="grid2"><label>Stratégie d'appels<select name="strategy">${Object.entries(cf.options.group_strategies).map(([k, l]) => `<option value="${k}" ${d.strategy === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${num("ring_time", "Durée de sonnerie (secondes)", d.ring_time, 5, 300, "En recherche prioritaire ou cyclique : par membre.")}
      <label>Préfixe du nom affiché<input name="cid_prefix" maxlength="20" value="${esc(d.cid_prefix)}" placeholder="[Accueil]"><span class="hint">Les membres voient d'où vient l'appel.</span></label></div>
      <h3 class="cf-h">Utilisateurs</h3>
      ${membersPicker("members", d.members, { ordered: true, label: "Membres (l'ordre compte en recherche prioritaire et cyclique)" })}
      <h3 class="cf-h">Message d'accueil</h3>
      <div class="grid2">${promptField("greeting", d.greeting || "", "Annonce jouée avant la sonnerie (facultatif)", "WAV, MP3, M4A… ou micro : converti automatiquement (WAV 8 kHz, 16 bits, mono).")}</div>
      <h3 class="cf-h">Destinations</h3>
      <div class="grid2">${destPicker("no_answer", d.no_answer, { label: "Destination de non-réponse", selfId: id })}</div>
      ${officeFields(d, id)}`;
  } else if (kind === "queue") {
    body = `${didChips(d, id)}
      <div class="grid2">${num("max_wait", "Temps d'attente maximum dans la file (secondes)", d.max_wait, 10, 3600)}</div>
      <h3 class="cf-h">Stratégie</h3>
      <div class="grid2"><label>Stratégie de scrutation<select name="strategy">${Object.entries(cf.options.queue_strategies).map(([k, l]) => `<option value="${k}" ${d.strategy === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${num("member_timeout", "Durée de sonnerie par agent (secondes)", d.member_timeout, 5, 120)}
      ${num("wrapup", "Pause d'un agent entre deux appels (secondes)", d.wrapup, 0, 300)}</div>
      <h3 class="cf-h">Agents</h3>
      ${membersPicker("members", d.members, { ordered: true, label: "Agents de la file" })}
      <h3 class="cf-h">Annonces et musique</h3>
      <div class="grid2">${promptField("moh", d.moh, "Musique d'attente", "Vide : musique d'attente par défaut du PBX.")}
      ${promptField("greeting", d.greeting, "Directive d'introduction", "Jouée entièrement à l'appelant avant d'appeler les agents.")}</div>
      <div class="cf-sec"><span class="dl">Annonces d'attente (répétées pendant l'attente)</span>
        <div class="perlist"></div><input type="hidden" name="periodic" value="${esc((d.periodic || []).join(","))}">
        <div class="row"><select class="peradd" data-prompts>${promptOptions("", "+ Ajouter une annonce…")}</select></div>
        <div class="grid2" style="margin-top:10px">${num("periodic_freq", "Délai entre les annonces (secondes)", d.periodic_freq ?? 30, 10, 600)}</div></div>
      <div class="cf-sec"><span class="dl">Annonces de file d'attente</span>
        <label class="check"><input type="checkbox" name="announce_position" ${d.announce_position ? "checked" : ""}> Position dans la file d'attente</label>
        <label class="check"><input type="checkbox" name="announce_holdtime" ${d.announce_holdtime ? "checked" : ""}> Temps d'attente estimé</label></div>
      <h3 class="cf-h">Destinations</h3>
      <div class="grid2">${destPicker("no_answer", d.no_answer, { label: "Destination de non-réponse (attente dépassée ou aucun agent)", selfId: id })}</div>
      ${officeFields(d, id)}`;
  } else if (kind === "ivr") {
    body = `${didChips(d, id)}
      ${promptField("prompt", d.prompt, "Directive (annonce du menu)", "« Pour le service commercial, tapez 1… ». Fichier converti automatiquement (WAV 8 kHz, 16 bits, mono).")}
      <h3 class="cf-h">Menu</h3>
      <table class="ivrkeys"><thead><tr><th>Touche</th><th>Action et destination</th></tr></thead><tbody>
      ${IVR_KEYS.map((k) => `<tr><td><span class="kbadge">${esc(k)}</span></td><td>${destPicker(`options.${k}`, d.options[k], { selfId: id, allowNone: true, noneLabel: "Rien", withPrompt: false, keyLabels: true })}</td></tr>`).join("")}</tbody></table>
      <h3 class="cf-h">Options</h3>
      <div class="grid2">${num("timeout", "Délai pour choisir (secondes)", d.timeout, 1, 30)}
      ${num("retries", "Répéter le menu", d.retries, 0, 5, "fois, si aucun choix ou erreur")}
      <label class="check"><input type="checkbox" name="direct_dial" ${d.direct_dial ? "checked" : ""}> L'appelant peut composer directement un numéro de poste</label></div>
      <div class="grid2">${destPicker("invalid", d.invalid, { label: "Aucun choix ou touche invalide (après les répétitions)", selfId: id })}</div>
      ${officeFields(d, id)}`;
  } else if (kind === "conf") {
    body = `<div class="grid3"><label>Code PIN (facultatif)<input name="pin" inputmode="numeric" value="${esc(d.pin)}" placeholder="Aucun"><span class="hint">Demandé en entrant dans la salle.</span></label>
      ${num("max_members", "Participants maximum", d.max_members, 2, 100)}
      <label class="check"><input type="checkbox" name="video" ${d.video ? "checked" : ""}> Vidéo pour les participants du softphone web</label></div>`;
  } else if (kind === "groupvm") {
    body = `<div class="grid3"><label>Code PIN (4 à 8 chiffres)<input name="pin" inputmode="numeric" value="${esc(d.pin)}" placeholder="Généré si vide"><span class="hint">Pour écouter avec *98 depuis un téléphone.</span></label></div>
      ${membersPicker("members", d.members, { label: "Membres (voyant de messagerie + écoute dans le softphone)" })}`;
  } else if (kind === "schedule") {
    body = scheduleFields(d);
  } else if (kind === "rule") {
    body = ruleFields(d, id);
  }
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed">
    <form id="cff" class="pad stack cf-form" novalidate>
      <p><a href="#/gestion/${tab}">← ${esc(TABS.find((t) => t[0] === tab)[1])}</a></p>
      <div class="grid3"><label>Nom<input name="name" maxlength="50" value="${esc(d.name)}" required></label>
        ${numbered ? `<label>Numéro interne<input name="number" inputmode="numeric" maxlength="3" value="${esc(o?.number || nextNumber(kind))}"><span class="hint">Composable depuis un poste.</span></label>` : ""}</div>
      ${body}
      <div class="form-msg"></div>
      <div class="actions">${o ? `<button type="button" class="btn ghost" id="cfdel">Supprimer</button>` : ""}${o?.number ? `<a class="btn ghost" href="#/gestion/traceur/${esc(o.number)}">Tracer</a>` : ""}<button class="btn" type="submit">${o ? "Enregistrer" : "Créer"}</button></div>
      <div id="cfimpact"></div>
    </form></div>`;
  const form = h.$("#cff");
  wireDests(form); wireMembers(form); wirePromptFields(form); wireOffice(form);
  form.querySelectorAll("[data-did]").forEach((b) => { if (!b.onclick) b.onclick = () => b.classList.toggle("on"); });
  if (kind === "queue") wirePeriodic(form);
  if (kind === "schedule") wireSchedule(form, d);
  if (kind === "rule") wireRule(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = collect(form, kind);
    try {
      await h.api(o ? "PUT" : "POST", `/api/callflow/${kind}${o ? "/" + o.id : ""}`, data);
      h.setFlash({ text: `${o ? "Enregistré" : "Créé"} et appliqué.` });
      location.hash = `#/gestion/${tab}`;
    } catch (err) { h.showFormError(form, err); }
  };
  h.$("#cfdel")?.addEventListener("click", () => askDelete(kind, o, tab));
}
function wirePeriodic(form) {
  const input = form.querySelector("[name=periodic]"); let cur = input.value ? input.value.split(",") : [];
  const draw = () => {
    input.value = cur.join(",");
    form.querySelector(".perlist").innerHTML = cur.map((id, i) => `<div class="perrow"><span class="grow">${i + 1}. ${esc(objs("prompt").find((p) => p.id === id)?.name || "?")}</span><button type="button" class="ic" data-pr="${i}">✕</button></div>`).join("") || '<p class="hint" style="margin:0">Aucune annonce d\'attente.</p>';
    form.querySelectorAll("[data-pr]").forEach((b) => b.onclick = () => { cur.splice(Number(b.dataset.pr), 1); draw(); });
  };
  form.querySelector(".peradd").onchange = (e) => { if (e.target.value) { cur.push(e.target.value); e.target.value = ""; draw(); } };
  draw();
}
function defaults(kind) {
  const hang = { type: "hangup", target: "" };
  const office = { dids: [], schedule: "", closed: null, break: null, holiday: null };
  return {
    group: { name: "", strategy: "all", members: [], ring_time: 20, cid_prefix: "", no_answer: hang, ...office },
    queue: { name: "", strategy: "ringall", members: [], member_timeout: 15, max_wait: 300, wrapup: 5, announce_position: true, announce_holdtime: false, greeting: "", moh: "", periodic: [], periodic_freq: 30, no_answer: hang, ...office },
    ivr: { name: "", prompt: "", timeout: 5, retries: 2, direct_dial: true, options: {}, invalid: hang, ...office },
    groupvm: { name: "", pin: "", members: [] },
    conf: { name: "", pin: "", max_members: 20, video: true },
    schedule: { name: "", week: { mon: [["09:00", "12:00"], ["14:00", "18:00"]], tue: [["09:00", "12:00"], ["14:00", "18:00"]], wed: [["09:00", "12:00"], ["14:00", "18:00"]], thu: [["09:00", "12:00"], ["14:00", "18:00"]], fri: [["09:00", "12:00"], ["14:00", "18:00"]], sat: [], sun: [] }, holidays_fr: true, holidays: [], override: "auto" },
    rule: { name: "", dids: [], is_default: !objs("rule").some((r) => r.data.is_default) && !cf.trunk_dids.length, schedule: "", open: hang, closed: hang, holiday: null },
  }[kind];
}
function collect(form, kind) {
  const raw = h.formData(form);
  const out = { ...raw };
  const dest = (v) => !v || v.type === "none" ? null : { type: v.type, target: v.target || "", ...(v.prompt_on && v.prompt ? { prompt: v.prompt } : {}) };
  for (const f of ["no_answer", "invalid", "open", "closed", "break", "holiday"]) if (raw[f]) out[f] = dest(raw[f]);
  if (["group", "queue", "ivr"].includes(kind)) {
    if (!raw.schedule) { out.closed = null; out.break = null; out.holiday = null; }
    out.dids = [...form.querySelectorAll("[data-did].on")].map((x) => x.dataset.did).concat(String(raw.dids_extra || "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)); delete out.dids_extra;
  }
  if (raw.options) out.options = Object.fromEntries(Object.entries(raw.options).map(([k, v]) => [k, dest(v)]).filter(([, v]) => v));
  if (raw.members !== undefined) out.members = raw.members ? raw.members.split(",") : [];
  if (kind === "schedule") { out.week = readWeek(form); out.holidays = readHolidays(form); delete out.wk; delete out.hol; }
  if (kind === "rule") { out.dids = [...form.querySelectorAll("[data-did].on")].map((x) => x.dataset.did).concat(String(raw.dids_extra || "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)); delete out.dids_extra; }
  return out;
}

// Horaires
function scheduleFields(d) {
  const st = scheduleNow(d);
  return `<label class="check"><input type="checkbox" name="general" ${d.general ? "checked" : ""}> <strong>Horaires généraux du PBX</strong> <span class="hint">(proposés d'office aux nouveaux routages ; un seul jeu d'horaires peut l'être)</span></label>
    <div class="cf-sec"><span class="dl">Mode</span>
      <div class="seg" id="ovr">${[["auto", "Automatique (selon les horaires)"], ["open", "Forcer ouvert"], ["closed", "Forcer fermé"]].map(([k, l]) => `<label class="${d.override === k ? "on" : ""}"><input type="radio" name="override" value="${k}" ${d.override === k ? "checked" : ""}>${l}</label>`).join("")}</div>
      <p class="hint">En ce moment : <strong>${st === "open" ? "ouvert" : st === "holiday" ? "jour férié / congés" : "fermé"}</strong> (fuseau ${esc(cf.timezone)}).</p></div>
    <div class="cf-sec"><span class="dl">Semaine</span><div class="week" id="week">${Object.entries(DAY_SHORT).map(([k]) => `<div class="day" data-day="${k}"></div>`).join("")}</div>
      <p><button type="button" class="btn ghost sm" id="copymon">Copier le lundi sur mardi → vendredi</button></p></div>
    <div class="cf-sec"><span class="dl">Fermetures</span>
      <label class="check"><input type="checkbox" name="holidays_fr" ${d.holidays_fr ? "checked" : ""}> Fermé les jours fériés (France métropolitaine, calculés chaque année)</label>
      <div id="hols"></div><p><button type="button" class="btn ghost sm" id="addhol">+ Ajouter des congés / une fermeture</button></p></div>`;
}
const DAY_LONG = { mon: "Lundi", tue: "Mardi", wed: "Mercredi", thu: "Jeudi", fri: "Vendredi", sat: "Samedi", sun: "Dimanche" };
function wireSchedule(form, d) {
  const week = structuredClone(d.week);
  const hols = structuredClone(d.holidays || []);
  const drawDay = (day) => {
    const box = form.querySelector(`[data-day=${day}]`);
    const r = week[day] || [];
    box.innerHTML = `<label class="check dname"><input type="checkbox" ${r.length ? "checked" : ""} data-open> ${DAY_LONG[day]}</label>
      <div class="ranges">${r.length ? r.map(([a, b], i) => `<span class="rng"><input type="time" value="${a}" data-a="${i}"> – <input type="time" value="${b}" data-b="${i}">${r.length > 1 ? `<button type="button" class="ic" data-rr="${i}" title="Retirer">✕</button>` : ""}</span>`).join("") + (r.length < 4 ? '<button type="button" class="ic add" data-ar title="Ajouter une plage">+</button>' : "") : '<span class="s">Fermé</span>'}</div>`;
    box.querySelector("[data-open]").onchange = (e) => { week[day] = e.target.checked ? [["09:00", "18:00"]] : []; drawDay(day); };
    box.querySelectorAll("[data-a]").forEach((x) => x.onchange = () => { week[day][x.dataset.a][0] = x.value; });
    box.querySelectorAll("[data-b]").forEach((x) => x.onchange = () => { week[day][x.dataset.b][1] = x.value; });
    box.querySelectorAll("[data-rr]").forEach((x) => x.onclick = () => { week[day].splice(Number(x.dataset.rr), 1); drawDay(day); });
    box.querySelector("[data-ar]")?.addEventListener("click", () => { const last = week[day].at(-1)[1]; week[day].push([last < "14:00" ? "14:00" : last, "18:00"]); drawDay(day); });
  };
  Object.keys(DAY_SHORT).forEach(drawDay);
  form.querySelector("#copymon").onclick = () => { for (const k of ["tue", "wed", "thu", "fri"]) { week[k] = structuredClone(week.mon); drawDay(k); } };
  const drawHols = () => {
    form.querySelector("#hols").innerHTML = hols.map((x, i) => `<div class="holrow"><input type="date" value="${esc(x.from)}" data-hf="${i}"> au <input type="date" value="${esc(x.to)}" data-ht="${i}"><input placeholder="Libellé (ex. Congés d'été)" value="${esc(x.label)}" data-hl="${i}"><button type="button" class="ic" data-hr="${i}" title="Retirer">✕</button></div>`).join("");
    form.querySelectorAll("[data-hf]").forEach((x) => x.onchange = () => { hols[x.dataset.hf].from = x.value; if (!hols[x.dataset.hf].to || hols[x.dataset.hf].to < x.value) { hols[x.dataset.hf].to = x.value; drawHols(); } });
    form.querySelectorAll("[data-ht]").forEach((x) => x.onchange = () => { hols[x.dataset.ht].to = x.value; });
    form.querySelectorAll("[data-hl]").forEach((x) => x.oninput = () => { hols[x.dataset.hl].label = x.value; });
    form.querySelectorAll("[data-hr]").forEach((x) => x.onclick = () => { hols.splice(Number(x.dataset.hr), 1); drawHols(); });
  };
  drawHols();
  form.querySelector("#addhol").onclick = () => { const t = new Date().toISOString().slice(0, 10); hols.push({ from: t, to: t, label: "" }); drawHols(); };
  form.querySelectorAll("#ovr input").forEach((i) => i.onchange = () => form.querySelectorAll("#ovr label").forEach((l) => l.classList.toggle("on", l.contains(i) ? i.checked : false)));
  form._week = week; form._hols = hols;
}
const readWeek = (form) => form._week;
const readHolidays = (form) => form._hols;

// Règles entrantes
function ruleFields(d, id) {
  const usedElsewhere = new Map();
  for (const r of objs("rule")) if (r.id !== id) for (const x of r.data.dids) usedElsewhere.set(x, r.name);
  const known = cf.trunk_dids.map((x) => x.did);
  const extra = d.dids.filter((x) => !known.includes(x));
  return `<div class="cf-sec"><span class="dl">Numéros appelés (SDA)</span>
      ${cf.trunk_dids.length ? `<div class="chips">${cf.trunk_dids.map(({ did, trunk }) => {
        const other = usedElsewhere.get(did);
        return `<button type="button" class="chip ${d.dids.includes(did) ? "on" : ""}" data-did="${esc(did)}" ${other ? `disabled title="Déjà dans la règle « ${esc(other)} »"` : `title="Trunk ${esc(trunk)}"`}>${esc(fmtP(did))}${other ? ` <span class="s">(${esc(other)})</span>` : ""}</button>`;
      }).join("")}</div>` : '<p class="hint">Aucune SDA déclarée dans les trunks (Trunks › SDA). Tu peux les saisir ci-dessous.</p>'}
      <label style="margin-top:10px">Autres SDA (une par ligne)<textarea name="dids_extra" rows="2" placeholder="04 12 34 56 78">${esc(extra.map(fmtP).join("\n"))}</textarea></label>
      <label class="check" style="margin-top:10px"><input type="checkbox" name="is_default" ${d.is_default ? "checked" : ""}> Règle par défaut : utilisée pour toutes les SDA qui n'ont pas de règle</label></div>
    <div class="cf-sec"><label style="max-width:420px">Horaires<select name="schedule" id="rsched"><option value="">Toujours ouvert (pas d'horaires)</option>${objs("schedule").map((s) => `<option value="${esc(s.id)}" ${d.schedule === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      <span class="hint"><a href="#/gestion/horaires/nouveau">Créer des horaires</a></span></label></div>
    ${destPicker("open", d.open, { label: "Heures d'ouverture" })}
    <div id="rclosed">${destPicker("closed", d.closed, { label: "En dehors des heures d'ouverture" })}
    ${destPicker("break", d.break, { label: "Pendant les pauses (entre deux plages d'un même jour)", allowNone: true, noneLabel: "Comme « en dehors des heures »" })}
    ${destPicker("holiday", d.holiday, { label: "Jours fériés et congés", allowNone: true, noneLabel: "Comme « en dehors des heures »" })}</div>`;
}
function wireRule(form) {
  form.querySelectorAll("[data-did]").forEach((b) => b.onclick = () => b.classList.toggle("on"));
  const sync = () => { const has = !!form.querySelector("#rsched").value; form.querySelector("#rclosed").hidden = !has; form.querySelectorAll("#rclosed select, #rclosed input").forEach((el) => { if (!has) el.disabled = true; }); if (has) wireDests(form.querySelector("#rclosed")); };
  form.querySelector("#rsched").onchange = sync; sync();
}

async function askDelete(kind, o, tab) {
  let refs = [];
  try { refs = (await h.api("GET", `/api/callflow/${kind}/${o.id}/impact`)).refs; } catch { /* */ }
  const box = h.$("#cfimpact");
  box.innerHTML = `<div class="warnbox"><h2>Supprimer « ${esc(o.name)} » ?</h2>
    ${refs.length ? `<p>Attention, c'est utilisé ici : la destination sera remplacée par « raccrocher » :</p><ul>${refs.map((r) => `<li><strong>${esc(r.kind_label)} « ${esc(r.name)} »</strong> : ${esc(r.where)}</li>`).join("")}</ul>` : "<p>Rien ne l'utilise.</p>"}
    <div class="row"><button type="button" class="btn ghost" id="cfno">Annuler</button><button type="button" class="btn" id="cfyes">Supprimer</button></div></div>`;
  box.scrollIntoView({ block: "center", behavior: "smooth" });
  h.$("#cfno").onclick = () => { box.innerHTML = ""; };
  h.$("#cfyes").onclick = async () => {
    try { await h.api("DELETE", `/api/callflow/${kind}/${o.id}?force=1`); h.setFlash({ text: "Supprimé." }); location.hash = `#/gestion/${tab}`; }
    catch (e) { h.setFlash({ cls: "bad", text: e.message }); location.hash = `#/gestion/${tab}`; }
  };
}

// ---------------------------------------------------------------- Annonces
function renderPromptForm(head, id) {
  const o = id !== "nouveau" ? objs("prompt").find((x) => x.id === id) : null;
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed"><form id="pf" class="pad stack" novalidate>
    <p><a href="#/gestion/annonces">← Annonces</a></p>
    <label style="max-width:420px">Nom<input name="name" maxlength="50" value="${esc(o?.name || "")}" placeholder="Accueil, Fermé, Attente…"></label>
    ${o ? `<div><span class="dl">Annonce actuelle (${o.data.duration} s)</span><audio controls src="/api/prompts/${esc(o.id)}/audio"></audio></div>` : ""}
    <div class="grid2">
      <div class="cf-sec"><span class="dl">${o ? "Remplacer par un fichier" : "Envoyer un fichier audio"}</span><input type="file" id="pfile" accept="audio/*,.wav,.mp3,.m4a,.ogg"><p class="hint">MP3, WAV, M4A, OGG… converti automatiquement au format téléphone.</p></div>
      <div class="cf-sec"><span class="dl">Ou l'enregistrer avec le micro</span><button type="button" class="btn ghost" id="prec">● Enregistrer</button> <span id="precst" class="hint"></span></div>
    </div>
    <div id="ppreview"></div>
    <div class="form-msg"></div>
    <div class="actions">${o ? '<button type="button" class="btn ghost" id="cfdel">Supprimer</button>' : ""}<button class="btn" type="submit">${o ? "Enregistrer" : "Ajouter"}</button></div>
    <div id="cfimpact"></div>
  </form></div>`;
  let wav = null;
  const setWav = (w, secs) => {
    wav = w;
    const url = URL.createObjectURL(new Blob([w], { type: "audio/wav" }));
    h.$("#ppreview").innerHTML = `<div class="note">Prêt : ${secs.toFixed(1)} s, format téléphone (8 kHz). <audio controls src="${url}"></audio></div>`;
    if (!h.$("[name=name]").value) h.$("[name=name]").value = "Annonce";
  };
  h.$("#pfile").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const { wav: w, secs } = await toPhoneWav(await f.arrayBuffer()); setWav(w, secs); if (!h.$("[name=name]").value || h.$("[name=name]").value === "Annonce") h.$("[name=name]").value = f.name.replace(/\.[^.]+$/, "").slice(0, 50); }
    catch (err) { h.$("#ppreview").innerHTML = `<div class="flash bad">Fichier illisible : ${esc(err.message)}</div>`; }
  };
  let rec = null;
  h.$("#prec").onclick = async () => {
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { h.$("#precst").textContent = "Micro indisponible (il faut le HTTPS)."; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (ev) => chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); rec = null;
        h.$("#prec").textContent = "● Enregistrer"; h.$("#precst").textContent = "";
        try { const { wav: w, secs } = await toPhoneWav(await new Blob(chunks).arrayBuffer()); setWav(w, secs); } catch (err) { h.$("#precst").textContent = err.message; }
      };
      rec.start();
      const t0 = Date.now();
      h.$("#prec").textContent = "■ Arrêter";
      const tick = setInterval(() => { if (!rec) return clearInterval(tick); h.$("#precst").textContent = `Enregistrement… ${Math.round((Date.now() - t0) / 1000)} s`; }, 300);
    } catch (err) { h.$("#precst").textContent = `Micro refusé : ${err.message}`; }
  };
  h.$("#pf").onsubmit = async (e) => {
    e.preventDefault();
    const name = h.$("[name=name]").value;
    try {
      const body = { name, ...(wav ? { wav: b64(wav) } : {}) };
      await h.api(o ? "PUT" : "POST", `/api/prompts${o ? "/" + o.id : ""}`, body);
      h.setFlash({ text: "Annonce enregistrée." }); location.hash = "#/gestion/annonces";
    } catch (err) { h.showFormError(h.$("#pf"), err); }
  };
  h.$("#cfdel")?.addEventListener("click", () => askDelete("prompt", o, "annonces"));
}
/** Décode n'importe quel audio lisible par le navigateur → WAV PCM 16 bits mono 8 kHz. */
async function toPhoneWav(buf) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(buf.slice(0)); } finally { ctx.close(); }
  const secs = Math.min(decoded.duration, 600);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(secs * 8000)), 8000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const out = (await off.startRendering()).getChannelData(0);
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 && peak < 0.5 ? 0.9 / peak : 1; // remonte un enregistrement trop faible
  const view = new DataView(new ArrayBuffer(44 + out.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + out.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, out.length * 2, true);
  out.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v * gain)) * 0x7fff, true));
  return { wav: new Uint8Array(view.buffer), secs };
}
function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }

// ---------------------------------------------------------------- Traceur
async function renderTracer(head, q) {
  const query = q ? decodeURIComponent(q) : sessionStorage.getItem("cf_trace") || "";
  h.app.innerHTML = `${head}<div class="panel tabbed"><div class="pad">
    <form id="tf" class="tracebar"><input id="tq" placeholder="Numéro : SDA (04 12 34 56 78), poste, groupe, SVI… ou numéro externe" value="${esc(query)}" autocomplete="off"><button class="btn">Tracer</button></form>
    <p class="hint">Le traceur suit la configuration (pas un appel réel) : règle entrante, horaires, SVI, groupes, utilisateurs, renvois… et signale les boucles, impasses et personnes injoignables. Pour un numéro externe, il liste tout ce qui renvoie vers lui.</p>
    <div id="tres"></div></div></div>`;
  h.$("#tf").onsubmit = (e) => { e.preventDefault(); const v = h.$("#tq").value.trim(); if (v) location.hash = `#/gestion/traceur/${encodeURIComponent(v)}`; };
  if (!query) return;
  sessionStorage.setItem("cf_trace", query);
  try {
    const r = await h.api("GET", `/api/trace?n=${encodeURIComponent(query)}`);
    const issues = []; walk(r.root, (n) => { if (n.status === "bad" || n.status === "warn") issues.push(n); });
    h.$("#tres").innerHTML = `<div class="tsum">${issues.some((n) => n.status === "bad") ? '<span class="pill bad">Problème détecté</span>' : issues.length ? '<span class="pill wait">À vérifier</span>' : '<span class="pill ok">Rien à signaler</span>'}
      <span class="s">${issues.length ? `${issues.length} point${issues.length > 1 ? "s" : ""} en orange ou rouge ci-dessous` : ""}</span></div>
      <ul class="tree">${treeNode(r.root, "")}</ul>`;
  } catch (e) { h.$("#tres").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; }
}
function walk(n, fn) { fn(n); for (const c of n.children || []) walk(c.node, fn); }
const ICON = { did: "☎", rule: "⇢", user: "👤", member: "👤", group: "👥", queue: "⏳", ivr: "☰", voicemail: "✉", external: "↗", prompt: "🔊", hangup: "✕", loop: "⟲", none: "!", legacy: "👥", "external-refs": "↘", multi: "☎" };
function treeNode(n, label, current) {
  return `<li class="tn ${n.status}${current ? " cur" : ""}">${label ? `<span class="tl">${esc(label)}</span>` : ""}
    <div class="tb"><span class="ti">${ICON[n.type] || "•"}</span><div><strong>${esc(n.title)}</strong>${n.detail?.length ? `<div class="td">${n.detail.map(esc).join("<br>")}</div>` : ""}</div></div>
    ${n.children?.length ? `<ul>${n.children.map((c) => treeNode(c.node, c.label, c.current)).join("")}</ul>` : ""}</li>`;
}

// ---------------------------------------------------------------- Dépannage : test d'appel sans déranger le client
const DEV_KIND = { phone: "☎", web: "🖥", mobile: "📱" };
async function renderDiag(head, arg) {
  if (arg) sessionStorage.setItem("cf_diag_mode", "in");
  const mode = sessionStorage.getItem("cf_diag_mode") === "out" ? "out" : "in";
  const users = cf.users;
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed"><div class="pad stack">
    <div class="seg dg-mode">${[["in", "Appel entrant"], ["out", "Appel sortant depuis un poste"]].map(([k, l]) => `<label class="${mode === k ? "on" : ""}"><input type="radio" name="dgm" value="${k}" ${mode === k ? "checked" : ""}>${l}</label>`).join("")}</div>
    <form id="dgf" class="dg-form" novalidate>
      ${mode === "in" ? `<label class="grow">Numéro appelé<input id="dgnum" placeholder="SDA du client (04 12 34 56 78) ou numéro interne (201, 600…)" value="${esc(arg && mode === "in" ? decodeURIComponent(arg) : sessionStorage.getItem("cf_diag_in") || "")}" autocomplete="off"></label>`
        : `<label>Depuis le poste<select id="dgext">${users.map((u) => `<option value="${esc(u.id)}" ${sessionStorage.getItem("cf_diag_ext") === u.id ? "selected" : ""}>${esc(u.id)} · ${esc(u.name)}</option>`).join("")}</select></label>
           <label class="grow">Numéro composé<input id="dgnum" placeholder="06 12 34 56 78, 0032…, 112…" value="${esc(sessionStorage.getItem("cf_diag_out") || "")}" autocomplete="off"></label>`}
      <button class="btn">Lancer le test silencieux</button>
    </form>
    <p class="hint" style="margin:0">${mode === "in"
      ? "Le PBX calcule le chemin de l'appel à cet instant (horaires, planning, statuts, renvois) et interroge chaque téléphone concerné pour vérifier qu'il répond. <strong>Rien ne sonne chez le client.</strong> Ensuite, tu peux faire sonner un poste 2 secondes pour une preuve réelle."
      : "Le PBX vérifie tout ce qu'il ferait si ce poste composait ce numéro : droits du poste, numéros bloqués, pays autorisés, règle sortante, trunk et état chez l'opérateur, numéro présenté. <strong>Aucun appel n'est passé.</strong>"}</p>
    <div id="dgres"></div></div></div>`;
  h.app.querySelectorAll("[name=dgm]").forEach((r) => r.onchange = () => { sessionStorage.setItem("cf_diag_mode", r.value); renderDiag(head); });
  const res = h.$("#dgres");
  const verdictBox = (v, at, extra = "") => `<div class="dg-verdict ${v.level}"><span class="dg-vi">${v.level === "ok" ? "✔" : v.level === "warn" ? "!" : "✖"}</span><div><strong>${esc(v.text)}</strong>
    <div class="s">Test du ${esc(new Date(at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))}${extra}</div></div>
    <button type="button" class="btn ghost sm" data-copytxt="${esc(`Test du ${new Date(at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} : ${v.text}`)}">Copier pour le client</button></div>`;
  const wireCopy = () => res.querySelectorAll("[data-copytxt]").forEach((b) => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copytxt); b.textContent = "Copié ✓"; });
  h.$("#dgf").onsubmit = async (e) => {
    e.preventDefault();
    const number = h.$("#dgnum").value.trim(); if (!number) { h.$("#dgnum").focus(); return; }
    const btn = h.$("#dgf button"); btn.disabled = true;
    res.innerHTML = `<p class="hint">${mode === "in" ? "Calcul du chemin et interrogation des téléphones…" : "Vérification…"}</p>`;
    try {
      if (mode === "in") {
        sessionStorage.setItem("cf_diag_in", number);
        const r = await h.api("POST", "/api/diag/inbound", { number });
        res.innerHTML = `${verdictBox(r.verdict, r.at)}
          ${r.targets.length ? `<h3 class="cf-h">Postes qui sonneraient</h3><div class="dg-targets">${r.targets.map((t) => `<div class="dg-t">
            <div class="dg-th"><strong>${esc(t.ext)} · ${esc(t.name)}</strong>${t.rings ? "" : ` <span class="pill wait">${t.status === "away" ? "Absent" : t.status === "dnd" ? "Ne pas déranger" : "ne sonne pas"}</span>`}</div>
            ${t.devices.length ? `<ul class="dg-devs">${t.devices.map((d) => `<li class="${d.state}"><span>${DEV_KIND[d.kind] || "•"}</span><span class="grow"><strong>${esc(d.label)}</strong> <span class="s">${esc(d.text)}${d.local_ip ? ` · ${esc(d.local_ip)}` : ""}</span></span></li>`).join("")}</ul>` : '<p class="s" style="margin:4px 0">Aucun appareil connecté.</p>'}
            ${t.devices.length ? `<div class="row"><button type="button" class="btn ghost sm" data-ring="${esc(t.ext)}">Faire sonner 2 s (preuve réelle)</button><span class="dg-ringres s"></span></div>` : ""}</div>`).join("")}</div>` : ""}
          <details class="dg-tree" ${r.targets.length ? "" : "open"}><summary>Chemin de l'appel en ce moment</summary><ul class="tree">${treeNode(r.root, "")}</ul></details>`;
        res.querySelectorAll("[data-ring]").forEach((b) => b.onclick = async () => {
          const out = b.parentElement.querySelector(".dg-ringres");
          if (!confirm(`Faire sonner le poste ${b.dataset.ring} pendant environ 2 secondes ? Le nom affiché sera « TEST Callikoe ».`)) return;
          b.disabled = true; out.textContent = "Ça sonne…";
          try {
            const x = await h.api("POST", "/api/diag/ring", { ext: b.dataset.ring });
            out.innerHTML = x.results.map((y) => `<span class="pill ${y.rang ? "ok" : "bad"}">${esc(y.label)} : ${y.rang ? "a sonné ✔" : "n'a pas sonné"}</span>`).join(" ") + (x.answered ? ' <span class="pill wait">quelqu\'un a décroché</span>' : "");
          } catch (err) { out.textContent = err.message; }
          b.disabled = false;
        });
      } else {
        const ext = h.$("#dgext").value;
        sessionStorage.setItem("cf_diag_out", number); sessionStorage.setItem("cf_diag_ext", ext);
        const r = await h.api("POST", "/api/diag/outbound", { ext, number });
        res.innerHTML = `${verdictBox(r.verdict, r.at, ` · poste ${esc(r.ext)} → ${esc(r.number)}`)}
          <ol class="dg-steps">${r.steps.map((s) => `<li class="${s.status}"><span class="dg-vi">${s.status === "ok" ? "✔" : s.status === "bad" ? "✖" : s.status === "warn" ? "!" : "i"}</span><div><strong>${esc(s.title)}</strong>${s.detail ? `<div class="s">${esc(s.detail)}</div>` : ""}</div></li>`).join("")}</ol>`;
      }
      wireCopy();
    } catch (err) { res.innerHTML = `<div class="flash bad">${esc(err.message)}</div>`; }
    btn.disabled = false;
  };
  if (arg && mode === "in") h.$("#dgf").requestSubmit();
}

// ---------------------------------------------------------------- Renvois actifs
async function renderForwards(head) {
  const { forwards } = await h.api("GET", "/api/forwards");
  const only = sessionStorage.getItem("cf_fw_active") !== "0";
  const ext = sessionStorage.getItem("cf_fw_ext") === "1";
  const rows = forwards.filter((r) => (!only || r.active) && (!ext || r.external));
  h.app.innerHTML = `${head}<div class="panel tabbed">
    <div class="filters"><label class="check"><input type="checkbox" id="fa" ${only ? "checked" : ""}> Seulement ceux actifs en ce moment</label>
      <label class="check"><input type="checkbox" id="fe" ${ext ? "checked" : ""}> Seulement vers l'extérieur (mobiles, numéros externes)</label>
      <span class="s">${rows.length} renvoi${rows.length > 1 ? "s" : ""}</span></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Qui</th><th>Quand</th><th>Vers</th><th>État</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.id ? `<a href="#/utilisateurs/${esc(r.id)}/renvois">${esc(r.id)}</a> ` : ""}${esc(r.name)}</td><td>${esc(r.when)}</td>
        <td>${r.external ? "↗ " : ""}${esc(r.to)}</td><td>${r.active ? `<span class="pill ${r.level === "bad" ? "bad" : r.level === "warn" ? "wait" : "ok"}">Actif</span>` : '<span class="pill off">Inactif</span>'}</td></tr>`).join("")}
    </tbody></table></div>` : '<div class="empty">Aucun renvoi.</div>'}
    <p class="hint pad" style="margin:0">Renvois réglés dans les fiches utilisateurs (onglet Renvois) ou par les utilisateurs eux-mêmes dans leur softphone. Les statuts Absent / Ne pas déranger renvoient tous les appels.</p></div>`;
  h.$("#fa").onchange = (e) => { sessionStorage.setItem("cf_fw_active", e.target.checked ? "1" : "0"); renderForwards(head); };
  h.$("#fe").onchange = (e) => { sessionStorage.setItem("cf_fw_ext", e.target.checked ? "1" : "0"); renderForwards(head); };
}
