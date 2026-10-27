// Gestion d'appels › Routages : éditeur visuel simplifié (étapes de gauche à droite, glisser-déposer ou bouton +)
// et routage décrit en texte (proposition à valider).
let h = null, cf = null, kit = null; // kit : champs partagés avec les fiches (annonces, destinations, horaires)
const esc = (v) => h.esc(v);
const fmtP = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const objs = (kind) => cf.objects.filter((o) => o.kind === kind);
const userName = (id) => cf.users.find((u) => u.id === id)?.name || id;

// Icônes au trait (24×24), cohérentes avec le reste de la console
const P = {
  did: '<path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/><path d="M15 3v6h6M21 3l-6 6"/>',
  schedule: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  ring: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  group: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.3.2 4 1.7 4.5 4.5"/>',
  queue: '<path d="M4 6h10M4 12h10M4 18h7"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M18.5 15v1.7l1 .8"/>',
  prompt: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  ivr: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" stroke-width="2.6"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.8 3.7-6 7-6s6.2 2.2 7 6"/>',
  user_vm: '<circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/>',
  groupvm: '<path d="M3 13l2.5-7h13L21 13v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  conf: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="m15.5 10.5 5.5-3v9l-5.5-3"/>',
  external: '<path d="M7 17 17 7M9 7h8v8"/>',
  ai: '<path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  ai_msg: '<path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/><path d="M4 18h9"/>',
  hangup: '<path d="M3.5 13.5c4.7-4 12.3-4 17 0l-2 2.5-3-1.2v-2.3a10 10 0 0 0-7 0v2.3l-3 1.2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.8"/>',
  arrow: '<path d="M4 12h15M14 6l6 6-6 6"/>', spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};
const icon = (k, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k] || ""}</svg>`;

const STEPS = [
  ["ring", "Sonnerie", "Faire sonner une ou plusieurs personnes"], ["group", "Groupe d'appel", "Un groupe existant"], ["queue", "File d'attente", "Mise en attente avec musique"],
  ["prompt", "Annonce", "Jouer un message puis continuer"], ["ivr", "SVI", "Menu « tapez 1, tapez 2 »"],
];
const ENDS = [
  ["user_vm", "Boîte vocale", "Messagerie d'un utilisateur"], ["groupvm", "Boîte de groupe", "Messagerie partagée"],
  ["user", "Utilisateur", "Avec ses propres renvois"], ["conf", "Réunion", "Salle de réunion"], ["external", "Numéro externe", "Renvoi vers un mobile…"], ["hangup", "Fin de l'appel", "Raccrocher"],
  ["ai", "Standardiste IA", "Répond, renseigne, transfère"], ["ai_msg", "Standardiste IA (message)", "Prend un message"],
];
const LABEL = Object.fromEntries([...STEPS, ...ENDS].map(([k, l]) => [k, l]));
const TERMINAL = [...ENDS.map(([k]) => k), "ivr"]; // le SVI termine le routage : ce sont ses touches qui envoient l'appel ailleurs
const BR = { open: "Heures d'ouverture", closed: "Bureau fermé", break: "Pause", holiday: "Jour férié / congés" };

let flow = null, sel = null, tab = "open", errAt = null, cur = null, adding = null;

export function flowSummary(cfData, helpers, d) {
  h = helpers; cf = cfData;
  return (d.branches.open || []).map((s, i) => `${i + 1}. ${describe(s)}`).join(" → ");
}

export function renderFlowEditor(helpers, cfData, head, id, shared) {
  h = helpers; cf = cfData; kit = shared;
  cur = id && id !== "nouveau" ? cf.objects.find((o) => o.kind === "flow" && o.id === id) : null;
  // Nouveau routage : horaires généraux du PBX proposés d'office
  const gen = cf.objects.find((o) => o.kind === "schedule" && o.data.general);
  flow = cur ? structuredClone(cur.data) : { name: "", dids: [], is_default: false, schedule: gen?.id || "", branches: { open: [], closed: gen ? [] : null, break: null, holiday: null } };
  sel = null; tab = "open"; errAt = null; adding = null;
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed fx">
    <div class="fx-top">
      <a href="#/gestion/routages" class="fx-back">← Routages</a>
      <input id="fname" class="fx-name" maxlength="50" value="${esc(flow.name)}" placeholder="Nom du routage (ex. Standard principal)" aria-label="Nom du routage">
      <div class="fx-actions">${cur ? '<button type="button" class="btn ghost" id="fdel">Supprimer</button>' : ""}${cur?.data.dids[0] ? `<a class="btn ghost" href="#/gestion/traceur/${esc(cur.data.dids[0])}">Tracer</a>` : ""}${kit.simButton("Simuler")}<button type="button" class="btn" id="fsave">Valider et appliquer</button></div>
    </div>
    <details class="fx-nl" ${cur ? "" : "open"}><summary>${icon("spark", 18)} Décrire le routage en une phrase</summary>
      <div class="fx-nlb"><textarea id="nlt" rows="2" placeholder="Ex. : Quand on appelle le 04 65 00 15 40 : Paul sonne 30 s puis groupe Accueil puis messagerie de Julie. En dehors des horaires Bureau : annonce Fermé puis raccrocher."></textarea>
      <div class="fx-row"><button type="button" class="btn" id="nlgo">Proposer le routage</button><span class="hint">Je construis le schéma ci-dessous ; rien n'est appliqué avant « Valider ».</span></div>
      <div id="nlres"></div></div></details>
    <div class="fx-entry">
      <div class="fx-box"><span class="fx-bi">${icon("did", 18)}</span><div class="fx-bc"><span class="fx-bl">Numéros appelés (SDA)</span>
        <div class="fx-chips" id="dids"></div></div></div>
      <div class="fx-box"><span class="fx-bi">${icon("schedule", 18)}</span><div class="fx-bc"><span class="fx-bl">Horaires</span>
        <div class="fx-srow"><select id="fsched"></select><button type="button" class="btn ghost sm" id="fsedit" hidden>Modifier</button></div></div></div>
      <label class="check fx-def"><input type="checkbox" id="fdef" ${flow.is_default ? "checked" : ""}> Routage par défaut (SDA sans règle)</label>
    </div>
    <nav class="fx-tabs" id="tabs"></nav>
    <div class="fx-stage"><div class="fx-chain" id="chain"></div></div>
    <div class="fx-pickhost" id="pickhost"></div>
    <div class="fx-msg" id="fmsg"></div><div class="fx-msg" id="fsim"></div>
  </div>
  <div class="fx-drawer" id="fxpop" aria-hidden="true"></div><div class="fx-scrim" id="scrim"></div>`;
  h.$("#fname").oninput = (e) => { flow.name = e.target.value; };
  h.$("#fdef").onchange = (e) => { flow.is_default = e.target.checked; drawDids(); };
  h.$("#fsave").onclick = save;
  kit.wireSim(h.app.querySelector(".fx-actions"), h.$("#fsim"), () => ({ kind: "flow", id: cur?.id || null,
    input: { name: h.$("#fname").value.trim() || flow.name || "Routage", dids: flow.dids, is_default: flow.is_default, schedule: flow.schedule, branches: flow.branches } }));
  h.$("#fdel")?.addEventListener("click", del);
  h.$("#nlgo").onclick = propose;
  h.$("#fsched").onchange = (e) => {
    if (e.target.value === "__new") { e.target.value = flow.schedule; schedPanel(null); return; }
    setSchedule(e.target.value);
  };
  h.$("#fsedit").onclick = () => schedPanel(flow.schedule);
  drawSched();
  h.$("#scrim").onclick = () => { sel = null; closePanel(); draw(); };
  drawDids(); draw();
}

// ---------------------------------------------------------------- Horaires (créés et modifiés sans quitter l'éditeur)
function drawSched() {
  const sel2 = h.$("#fsched");
  sel2.innerHTML = `<option value="">Toujours ouvert</option>${objs("schedule").map((s) => `<option value="${esc(s.id)}" ${flow.schedule === s.id ? "selected" : ""}>${esc(s.name)}${s.data.general ? " (généraux)" : ""}</option>`).join("")}<option value="__new">+ Nouveaux horaires…</option>`;
  sel2.value = flow.schedule || "";
  h.$("#fsedit").hidden = !flow.schedule;
}
function setSchedule(v) {
  flow.schedule = v;
  if (!flow.schedule) { flow.branches.closed = flow.branches.break = flow.branches.holiday = null; tab = "open"; }
  else if (flow.branches.closed === null) flow.branches.closed = [];
  drawSched(); draw();
}
function schedPanel(id) {
  const o = id ? cf.objects.find((x) => x.kind === "schedule" && x.id === id) : null;
  const d = o ? structuredClone(o.data) : kit.defaults("schedule");
  const side = h.$("#fxpop");
  side.classList.add("wide");
  side.innerHTML = `<div class="fx-ph"><span class="fx-ci">${icon("schedule")}</span><strong>${o ? "Horaires" : "Nouveaux horaires"}</strong><button type="button" class="fx-x" id="pclose2" aria-label="Fermer">${icon("x", 16)}</button></div>
    <form class="fx-pb stack" id="fxform" novalidate><label>Nom<input name="name" maxlength="50" value="${esc(d.name || "")}" placeholder="ex. Bureau"></label>${kit.scheduleFields(d)}
      <p class="hint" style="margin:0">Hors de ces plages, les onglets « Bureau fermé », « Pause » et « Jour férié » du routage s'appliquent.</p><div class="fx-perr" id="perr"></div></form>
    <div class="fx-pf"><button type="button" class="btn ghost" id="pdel">Annuler</button><button type="button" class="btn" id="pok">${o ? "Enregistrer" : "Créer"}</button></div>`;
  side.classList.add("open"); h.$("#scrim").classList.add("on");
  const form = h.$("#fxform");
  kit.wireSchedule(form, d);
  h.$("#pclose2").onclick = h.$("#pdel").onclick = closePanel;
  h.$("#pok").onclick = async () => {
    const btn = h.$("#pok"); btn.disabled = true;
    try {
      const r = await h.api(o ? "PUT" : "POST", `/api/callflow/schedule${o ? "/" + o.id : ""}`, kit.collect(form, "schedule"));
      cf.objects = (await h.api("GET", "/api/callflow")).objects;
      closePanel(); setSchedule(r.id || id);
    } catch (err) { h.$("#perr").textContent = err.message; btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- Entrée (SDA)
function freeDids() {
  const used = new Set(); for (const o of cf.objects) if (o.id !== cur?.id) for (const d of o.data.dids || []) used.add(d);
  for (const u of cf.users) for (const d of u.dids || []) used.add(d);
  return cf.trunk_dids.filter((d) => !used.has(d.did) && !flow.dids.includes(d.did));
}
function drawDids() {
  const box = h.$("#dids");
  box.innerHTML = `${flow.dids.map((d) => `<span class="fx-chip">${esc(fmtP(d))}<button type="button" data-rmdid="${esc(d)}" aria-label="Retirer ${esc(fmtP(d))}">${icon("x", 12)}</button></span>`).join("")}
    ${flow.is_default && !flow.dids.length ? '<span class="s">Toutes les SDA sans règle</span>' : ""}
    <select id="adddid" class="fx-add"><option value="">+ Ajouter</option>${freeDids().map((d) => `<option value="${esc(d.did)}">${esc(fmtP(d.did))}</option>`).join("")}<option value="__autre">Autre numéro…</option></select>
    <input id="otherdid" class="fx-other" placeholder="04 12 34 56 78" hidden>`;
  box.querySelectorAll("[data-rmdid]").forEach((x) => x.onclick = () => { flow.dids = flow.dids.filter((d) => d !== x.dataset.rmdid); drawDids(); });
  const sel2 = h.$("#adddid"), other = h.$("#otherdid");
  sel2.onchange = () => {
    if (sel2.value === "__autre") { other.hidden = false; other.focus(); sel2.value = ""; return; }
    if (sel2.value) { flow.dids.push(sel2.value); drawDids(); }
  };
  other.onkeydown = (e) => { if (e.key !== "Enter") return; e.preventDefault(); const v = other.value.replace(/[\s.]/g, "").replace(/^\+33/, "0"); if (/^0[1-9]\d{8}$/.test(v) && !flow.dids.includes(v)) { flow.dids.push(v); drawDids(); } else other.classList.add("bad"); };
}

// ---------------------------------------------------------------- Étapes
function draw() {
  const tabs = ["open", ...(flow.schedule ? ["closed", "break", "holiday"] : [])];
  if (!tabs.includes(tab)) tab = "open";
  h.$("#tabs").innerHTML = tabs.length > 1 ? tabs.map((b) => `<button type="button" class="${b === tab ? "on" : ""}" data-tab="${b}">${esc(BR[b])}<span class="s">${b !== "open" && !flow.branches[b] ? "comme ouvert" : `${(flow.branches[b] || []).length} étape${(flow.branches[b] || []).length > 1 ? "s" : ""}`}</span></button>`).join("") : "";
  h.$("#tabs").hidden = tabs.length < 2;
  h.$("#tabs").querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; sel = null; adding = null; closePanel(); draw(); });
  const c = h.$("#chain");
  if (tab !== "open" && !flow.branches[tab]) {
    h.$("#pickhost").innerHTML = "";
    c.innerHTML = `<div class="fx-same"><p><strong>${esc(BR[tab])}</strong> : les appels suivent le même routage qu'aux heures d'ouverture.</p><button type="button" class="btn" id="custom">Définir un routage différent</button></div>`;
    h.$("#custom").onclick = () => { flow.branches[tab] = []; draw(); };
    return;
  }
  const list = flow.branches[tab];
  const parts = [`<div class="fx-start">${icon("did", 22)}<span>Appel entrant</span></div>`];
  list.forEach((st, i) => {
    parts.push(link(i === 0 ? "" : linkLabel(list[i - 1]), i));
    const after = i > 0 && TERMINAL.includes(list[i - 1].type);
    const bad = (errAt && errAt.b === tab && errAt.i === i) || after || !valid(st);
    parts.push(`<div class="fx-card ${TERMINAL.includes(st.type) ? "end" : ""} ${sel === i ? "sel" : ""} ${bad ? "bad" : ""}" draggable="true" data-card="${i}" tabindex="0" role="button" aria-label="${esc(LABEL[st.type])} : régler">
      <div class="fx-ch"><span class="fx-ci">${icon(st.type)}</span><span class="fx-ct">${esc(LABEL[st.type])}</span><span class="fx-grip" title="Glisser pour déplacer">${icon("grip", 16)}</span></div>
      <div class="fx-cs">${esc(describe(st))}</div>
      ${after ? '<div class="fx-err">Rien ne peut suivre l\'étape précédente</div>' : !valid(st) ? '<div class="fx-err">À régler</div>' : errAt?.b === tab && errAt.i === i ? `<div class="fx-err">${esc(errAt.msg)}</div>` : ""}</div>`);
  });
  const last = list.at(-1);
  if (!last || !TERMINAL.includes(last.type)) {
    parts.push(link(last ? linkLabel(last) : "", list.length, true));
    parts.push(`<button type="button" class="fx-addbtn ${adding === list.length ? "on" : ""}" data-add="${list.length}">${icon("plus", 22)}<span>${list.length ? "Ajouter la suite" : "Ajouter la première étape"}</span></button>`);
    if (last) parts.push(`<div class="fx-endnote">sinon : raccroche</div>`);
  }
  c.innerHTML = parts.join("");
  h.$("#pickhost").innerHTML = adding !== null ? picker() : "";
  wireChain(c); wireChain(h.$("#pickhost"));
}
function link(label, i, isEnd = false) {
  return `<div class="fx-link" data-dz="${i}"><span>${esc(label)}</span>${icon("arrow", 18)}${isEnd ? "" : `<button type="button" class="fx-ins" data-add="${i}" title="Insérer une étape ici">${icon("plus", 14)}</button>`}</div>`;
}
const linkLabel = (st) => !st ? "" : st.type === "prompt" ? "puis" : st.type === "queue" ? "attente dépassée" : "sans réponse";
function picker() {
  const prevTerminal = adding > 0 && TERMINAL.includes(flow.branches[tab][adding - 1]?.type);
  const tile = ([k, l, d]) => `<button type="button" class="fx-tile ${ENDS.some((e) => e[0] === k) ? "end" : ""}" data-new="${k}" draggable="true"><span class="fx-ci">${icon(k)}</span><span><strong>${esc(l)}</strong><small>${esc(d)}</small></span></button>`;
  return `<div class="fx-picker" id="picker"><div class="fx-ph"><strong>Que doit-il se passer ${adding === 0 ? "en premier" : "ensuite"} ?</strong><button type="button" class="fx-x" id="pclose" aria-label="Fermer">${icon("x", 16)}</button></div>
    ${prevTerminal ? "" : `<span class="fx-pl">Étapes (si personne ne répond, l'appel passe à la suite)</span><div class="fx-tiles">${STEPS.map(tile).join("")}</div>`}
    <span class="fx-pl">Fin du routage</span><div class="fx-tiles">${ENDS.map(tile).join("")}</div></div>`;
}
function wireChain(c) {
  c.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => { adding = adding === Number(b.dataset.add) ? null : Number(b.dataset.add); sel = null; closePanel(); draw(); h.$("#picker")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
  h.$("#pclose")?.addEventListener("click", () => { adding = null; draw(); });
  c.querySelectorAll("[data-new]").forEach((b) => {
    b.onclick = () => addStep(b.dataset.new, adding);
    b.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", `new:${b.dataset.new}`); document.body.classList.add("fx-dragging"); });
    b.addEventListener("dragend", () => document.body.classList.remove("fx-dragging"));
  });
  c.querySelectorAll("[data-card]").forEach((el) => {
    const open = () => { sel = Number(el.dataset.card); adding = null; draw(); panel(); };
    el.onclick = open; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", `move:${el.dataset.card}`); document.body.classList.add("fx-dragging"); el.classList.add("dragging"); });
    el.addEventListener("dragend", () => { document.body.classList.remove("fx-dragging"); el.classList.remove("dragging"); });
  });
  c.querySelectorAll("[data-dz]").forEach((z) => {
    z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
    z.addEventListener("dragleave", () => z.classList.remove("over"));
    z.addEventListener("drop", (e) => {
      e.preventDefault(); z.classList.remove("over"); document.body.classList.remove("fx-dragging");
      const data = e.dataTransfer.getData("text/plain"), at = Number(z.dataset.dz);
      if (data.startsWith("new:")) return addStep(data.slice(4), at);
      const from = Number(data.split(":")[1]); const list = flow.branches[tab];
      const [st] = list.splice(from, 1); const to = from < at ? at - 1 : at; list.splice(to, 0, st);
      sel = null; errAt = null; draw();
    });
  });
}
function addStep(type, at) {
  const list = flow.branches[tab];
  const st = { type, ...(type === "ring" ? { users: [], strategy: "all", time: 20 } : type === "group" ? { target: objs("group")[0]?.id || "", time: null } : ["hangup", "ai", "ai_msg"].includes(type) ? {} : { target: "" }) };
  if (["queue", "ivr", "prompt", "groupvm", "conf"].includes(type) && objs(type).length === 1) st.target = objs(type)[0].id;
  list.splice(at ?? list.length, 0, st);
  adding = null; errAt = null; sel = null;
  draw();
}
function valid(st) {
  switch (st.type) {
    case "ring": return st.users?.length > 0;
    case "hangup": case "ai": case "ai_msg": return true;
    case "external": return /^0[1-9]\d{8}$/.test(String(st.target || "").replace(/\D/g, ""));
    default: return !!st.target;
  }
}
function describe(st) {
  const o = (kind, id) => cf.objects.find((x) => x.kind === kind && x.id === id);
  const num = (x) => x ? `${x.number ? x.number + " · " : ""}${x.name}` : "";
  switch (st.type) {
    case "ring": return st.users?.length ? `${st.users.map(userName).join(", ")} · ${st.time || 20} s${st.users.length > 1 ? (st.strategy === "hunt" ? " l'un après l'autre" : " ensemble") : ""}` : "Choisis qui sonne";
    case "group": { const g = o("group", st.target); return g ? `${num(g)} · ${st.time || g.data.ring_time} s` : "Choisis le groupe"; }
    case "user": case "user_vm": return st.target ? `${st.target} · ${userName(st.target)}` : "Choisis l'utilisateur";
    case "external": return st.target ? fmtP(st.target) : "Saisis le numéro";
    case "hangup": return "L'appel est raccroché";
    case "ai": return "La voix IA répond, renseigne et transfère";
    case "ai_msg": return "La voix IA prend un message";
    default: return num(o(st.type, st.target)) || "À choisir";
  }
}

// ---------------------------------------------------------------- Réglage d'une étape (fenêtre au clic sur un cadre)
const EDIT = { group: "groupe d'appel", queue: "file d'attente", ivr: "SVI", groupvm: "messagerie de groupe", conf: "salle de réunion" };
const RANGES = { group: 600, queue: 700, ivr: 800, groupvm: 900, conf: 500 };
function nextNumber(kind) {
  const used = new Set([...cf.objects.map((o) => o.number).filter(Boolean), ...cf.users.map((u) => u.id)]);
  for (let n = RANGES[kind] || 600; n < 1000; n++) if (!used.has(String(n))) return String(n);
  return "";
}
function closePanel() { h.$("#fxpop")?.classList.remove("open", "wide"); h.$("#scrim")?.classList.remove("on"); }
function panel() {
  const side = h.$("#fxpop");
  const st = sel !== null && flow.branches[tab]?.[sel];
  if (!st) { closePanel(); return; }
  side.classList.toggle("wide", st.type === "ivr");
  const opt = (list, v, empty) => `${empty !== null ? `<option value="">${esc(empty)}</option>` : ""}${list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
  const objOpts = (kind) => objs(kind).map((o) => [o.id, `${o.number ? o.number + " · " : ""}${o.name}`]);
  const users = cf.users.map((u) => [u.id, `${u.id} · ${u.name}`]);
  const memberList = (sel2) => `<input type="search" placeholder="Rechercher" class="fx-uq" data-uq><div class="fx-users">${cf.users.map((u) => `<label class="fx-u"><input type="checkbox" data-member value="${esc(u.id)}" ${sel2.includes(u.id) ? "checked" : ""}><span><strong>${esc(u.name)}</strong> <span class="s">${esc(u.id)}</span></span></label>`).join("")}</div>`;
  let body = "", ed = null;
  if (EDIT[st.type]) {
    // Élément existant à modifier, ou nouveau créé ici même
    const o = cf.objects.find((x) => x.kind === st.type && x.id === st.target);
    ed = o ? { id: o.id, number: o.number, ...structuredClone(o.data) } : { id: "", number: nextNumber(st.type), name: "", members: [], strategy: st.type === "queue" ? "ringall" : "all", ring_time: 20, member_timeout: 15, max_wait: 300, pin: "", greeting: "", moh: "",
      prompt: "", timeout: 5, retries: 2, direct_dial: true, options: {}, invalid: { type: "hangup", target: "" } };
    const list = objs(st.type);
    body = `${list.length ? `<label>${esc(LABEL[st.type])}<select data-pick>${opt([["", `+ Nouveau ${EDIT[st.type]}`], ...objOpts(st.type)], ed.id, null)}</select></label>` : ""}
      <div class="fx-g2"><label>Nom<input data-e="name" value="${esc(ed.name)}" placeholder="ex. Accueil"></label><label>Numéro interne<input data-e="number" value="${esc(ed.number)}" inputmode="numeric" maxlength="3"></label></div>`;
    if (st.type === "group") body += `<div class="fx-g2"><label>Comment ça sonne<select data-e="strategy">${opt(Object.entries(cf.options.group_strategies).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v).split(" (")[0]]), ed.strategy, null)}</select></label>
        <label>Sonnerie (secondes)<input type="number" min="5" max="300" data-e="ring_time" value="${esc(ed.ring_time)}"></label></div>
      <div class="fx-f"><span class="dl">Membres</span>${memberList(ed.members)}</div>
      ${kit.promptField("greeting", ed.greeting, "Message d'accueil (facultatif)", "Joué à l'appelant avant de faire sonner le groupe. WAV, MP3, M4A… ou micro : converti automatiquement.")}`;
    else if (st.type === "queue") body += `<div class="fx-g2"><label>Distribution<select data-e="strategy">${opt(Object.entries(cf.options.queue_strategies).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v).split(" (")[0]]), ed.strategy, null)}</select></label>
        <label>Sonnerie par agent (s)<input type="number" min="5" max="120" data-e="member_timeout" value="${esc(ed.member_timeout)}"></label></div>
      <label>Attente maximum (secondes)<input type="number" min="10" max="3600" data-e="max_wait" value="${esc(ed.max_wait)}"></label>
      <div class="fx-f"><span class="dl">Agents</span>${memberList(ed.members)}</div>
      ${kit.promptField("greeting", ed.greeting, "Message d'accueil (facultatif)", "Joué entièrement avant d'appeler les agents.")}
      ${kit.promptField("moh", ed.moh, "Musique d'attente", "Vide : musique par défaut du PBX. WAV, MP3, M4A… converti automatiquement.")}
      <p class="hint" style="margin:0">Annonces répétées pendant l'attente, position dans la file : <a href="#/gestion/files${ed.id ? "/" + esc(ed.id) : ""}" target="_blank" rel="noopener">réglages complets de la file</a>.</p>`;
    else if (st.type === "ivr") body += `${kit.promptField("prompt", ed.prompt, "Annonce du menu", "« Pour le service commercial, tapez 1… ». WAV, MP3, M4A… ou micro : converti automatiquement.")}
      <div class="fx-f"><span class="dl">Touches</span><table class="ivrkeys fx-keys"><tbody>
      ${kit.IVR_KEYS.map((k) => `<tr><td><span class="kbadge">${esc(k)}</span></td><td>${kit.destPicker(`options.${k}`, ed.options[k], { selfId: ed.id, allowNone: true, noneLabel: "Rien", withPrompt: false, keyLabels: true })}</td></tr>`).join("")}</tbody></table></div>
      <div class="fx-g2"><label>Délai pour choisir (s)<input type="number" min="1" max="30" name="timeout" value="${esc(ed.timeout)}"></label><label>Répéter le menu (fois)<input type="number" min="0" max="5" name="retries" value="${esc(ed.retries)}"></label></div>
      <label class="check"><input type="checkbox" name="direct_dial" ${ed.direct_dial ? "checked" : ""}> L'appelant peut composer directement un numéro de poste</label>
      ${kit.destPicker("invalid", ed.invalid, { label: "Aucun choix ou touche invalide", selfId: ed.id })}`;
    else if (st.type === "groupvm") body += `<label>Code PIN (4 à 8 chiffres)<input data-e="pin" inputmode="numeric" value="${esc(ed.pin)}" placeholder="généré si vide"></label>
      <div class="fx-f"><span class="dl">Membres (voyant de messagerie)</span>${memberList(ed.members)}</div>`;
    else if (st.type === "conf") body += `<label>Code PIN (facultatif)<input data-e="pin" inputmode="numeric" value="${esc(ed.pin)}" placeholder="aucun"></label>`;
  } else if (st.type === "ring") {
    body = `<div class="fx-f"><span class="dl">Qui sonne ?</span>${memberList(st.users)}</div>
      <div class="fx-g2"><label>Comment ?<select data-f="strategy"><option value="all" ${st.strategy !== "hunt" ? "selected" : ""}>Tous ensemble</option><option value="hunt" ${st.strategy === "hunt" ? "selected" : ""}>L'un après l'autre</option></select></label>
      <label>Sonnerie (secondes)<input type="number" min="5" max="300" data-f="time" value="${esc(st.time || 20)}"></label></div>`;
  } else if (st.type === "prompt") {
    body = kit.promptField("target", st.target, "Message joué à l'appelant", "Choisis une annonce, envoie un fichier (WAV, MP3, M4A…) ou enregistre-la au micro. L'appel passe ensuite à l'étape suivante.");
  } else if (st.type === "user" || st.type === "user_vm") {
    body = `<label>Utilisateur<select data-f="target">${opt(users, st.target, "— Choisir —")}</select></label>
      <p class="hint" style="margin:0">${st.type === "user" ? "L'appel suit ensuite les renvois de sa fiche." : "L'appelant laisse un message dans sa boîte vocale."}</p>`;
  } else if (st.type === "external") {
    body = `<label>Numéro<input data-f="target" inputmode="tel" placeholder="06 12 34 56 78" value="${esc(fmtP(st.target))}"></label>`;
  } else if (st.type === "ai" || st.type === "ai_msg") {
    body = `<p class="hint" style="margin:0">${st.type === "ai" ? "Une voix IA répond à l'appelant, le renseigne (horaires, adresse…), le transfère vers le bon service ou prend un message." : "Une voix IA prend le message de l'appelant (nom, numéro, motif) : il arrive par e-mail et dans « À rappeler »."}
      Réglages (nom de l'entreprise, informations, transferts) : <a href="#/ia">Administration › IA</a>.</p>`;
  } else body = '<p class="hint" style="margin:0">L\'appel est raccroché.</p>';
  side.innerHTML = `<div class="fx-ph"><span class="fx-ci">${icon(st.type)}</span><strong>${esc(LABEL[st.type])}</strong><button type="button" class="fx-x" id="pclose2" aria-label="Fermer">${icon("x", 16)}</button></div>
    <form class="fx-pb stack" id="fxform" novalidate>${body}<div class="fx-perr" id="perr"></div></form>
    <div class="fx-pf"><button type="button" class="btn ghost" id="pdel">Retirer l'étape</button><button type="button" class="btn" id="pok">${ed ? (ed.id ? "Enregistrer" : "Créer") : "Terminé"}</button></div>`;
  side.classList.add("open"); h.$("#scrim").classList.add("on");
  side.querySelector("[data-uq]")?.addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); side.querySelectorAll(".fx-u").forEach((l) => { l.hidden = q && !l.textContent.toLowerCase().includes(q); }); });
  const form = h.$("#fxform");
  kit.wirePromptFields(form); kit.wireDests(form);
  const members = () => [...side.querySelectorAll("[data-member]:checked")].map((i) => i.value);
  if (st.type === "prompt") { const ps = form.querySelector("[name=target]"); const upd = () => { st.target = ps.value; errAt = null; draw(); }; ps.onchange = upd; new MutationObserver(upd).observe(ps, { childList: true }); }
  if (!ed) {
    side.querySelectorAll("[data-member]").forEach((i) => i.onchange = () => { st.users = members(); draw(); });
    side.querySelectorAll("[data-f]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const f = el.dataset.f; let v = el.value;
      if (f === "time") v = v ? Number(v) : 20;
      if (f === "target" && st.type === "external") v = v.replace(/[\s.]/g, "").replace(/^\+33/, "0");
      st[f] = v; errAt = null; draw();
      if (f === "target" && st.type === "prompt") panel();
    }));
  }
  side.querySelector("[data-pick]")?.addEventListener("change", (e) => { st.target = e.target.value; panel(); });
  h.$("#pdel").onclick = () => { flow.branches[tab].splice(sel, 1); sel = null; closePanel(); draw(); };
  h.$("#pclose2").onclick = () => { sel = null; closePanel(); draw(); };
  h.$("#pok").onclick = async () => {
    if (!ed) { if (st.type === "prompt") st.target = form.querySelector("[name=target]").value; sel = null; closePanel(); draw(); return; }
    const val = (k) => side.querySelector(`[data-e="${k}"]`)?.value;
    const named = (k) => form.querySelector(`[name="${k}"]`)?.value ?? "";
    const body2 = { name: val("name"), number: val("number") };
    if (st.type === "group") Object.assign(body2, { strategy: val("strategy"), ring_time: Number(val("ring_time")), members: members(), greeting: named("greeting") });
    if (st.type === "queue") Object.assign(body2, { strategy: val("strategy"), member_timeout: Number(val("member_timeout")), max_wait: Number(val("max_wait")), members: members(), greeting: named("greeting"), moh: named("moh") });
    if (st.type === "ivr") {
      // Mêmes champs que la fiche SVI ; on ne touche ni aux SDA ni aux horaires propres au SVI
      const all = kit.collect(form, "ivr");
      for (const k of ["dids", "schedule", "closed", "break", "holiday", "name", "number"]) delete all[k];
      Object.assign(body2, all, { options: all.options || {} });
    }
    if (st.type === "groupvm") Object.assign(body2, { pin: val("pin"), members: members() });
    if (st.type === "conf") Object.assign(body2, { pin: val("pin") });
    const btn = h.$("#pok"); btn.disabled = true;
    try {
      const o = await h.api(ed.id ? "PUT" : "POST", `/api/callflow/${st.type}${ed.id ? "/" + ed.id : ""}`, body2);
      const fresh = await h.api("GET", "/api/callflow");
      cf.objects = fresh.objects;
      st.target = o.id; if (st.type === "group") st.time = null;
      sel = null; errAt = null; closePanel(); draw();
    } catch (err) { h.$("#perr").textContent = err.message; btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- Texte → proposition
async function propose() {
  const text = h.$("#nlt").value.trim(); const box = h.$("#nlres");
  if (!text) return;
  box.innerHTML = '<p class="hint">Analyse…</p>';
  try {
    const r = await h.api("POST", "/api/callflow-parse", { text });
    if (!r.proposal) { box.innerHTML = `<div class="fx-warn">${r.warnings.map(esc).join("<br>")}</div>`; return; }
    const p = r.proposal;
    if (p.dids.length) flow.dids = p.dids;
    flow.is_default = p.is_default || flow.is_default;
    flow.schedule = p.schedule || "";
    flow.branches = { open: p.branches.open, closed: p.branches.closed, break: p.branches.break, holiday: p.branches.holiday };
    if (!flow.name) { flow.name = p.name; h.$("#fname").value = p.name; }
    h.$("#fdef").checked = flow.is_default; h.$("#fsched").value = flow.schedule;
    sel = null; errAt = null; adding = null; tab = "open"; closePanel(); drawDids(); draw();
    box.innerHTML = `<div class="fx-prop">${r.ai_text ? `<p class="hint" style="margin:0 0 6px"><span class="ai-badge">IA</span> Reformulé : « ${esc(r.ai_text)} »</p>` : ""}<strong>Ce que j'ai compris</strong><ul>${r.understood.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${r.warnings.length ? `<div class="fx-warn"><strong>À vérifier</strong><ul>${r.warnings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <p class="hint" style="margin:6px 0 0">Vérifie le schéma ci-dessous, ajuste si besoin, puis « Valider et appliquer ».</p></div>`;
  } catch (e) { box.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; }
}

// ---------------------------------------------------------------- Enregistrement
async function save() {
  const msg = h.$("#fmsg"); msg.innerHTML = "";
  flow.name = h.$("#fname").value.trim() || flow.name || (flow.dids[0] ? `Routage ${fmtP(flow.dids[0])}` : "");
  const body = { name: flow.name, dids: flow.dids, is_default: flow.is_default, schedule: flow.schedule, branches: flow.branches };
  try {
    await h.api(cur ? "PUT" : "POST", `/api/callflow/flow${cur ? "/" + cur.id : ""}`, body);
    h.setFlash({ text: "Routage validé et appliqué." }); location.hash = "#/gestion/routages";
  } catch (e) {
    const m = /^branches\.(\w+)\.(\d+)$/.exec(e.field || "");
    if (m) { errAt = { b: m[1], i: Number(m[2]), msg: e.message }; tab = m[1]; draw(); }
    msg.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`;
    msg.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
let armed = false;
async function del() {
  const b = h.$("#fdel");
  if (!armed) { armed = true; b.textContent = "Confirmer la suppression"; setTimeout(() => { armed = false; if (b.isConnected) b.textContent = "Supprimer"; }, 4000); return; }
  try { await h.api("DELETE", `/api/callflow/flow/${cur.id}?force=1`); h.setFlash({ text: "Routage supprimé." }); location.hash = "#/gestion/routages"; }
  catch (e) { h.$("#fmsg").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; }
}
