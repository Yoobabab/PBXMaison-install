// Gestion d'appels › Routages : éditeur visuel (glisser-déposer de gauche à droite) et routage décrit en texte.
let h = null, cf = null;
const esc = (v) => h.esc(v);
const fmtP = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const objs = (kind) => cf.objects.filter((o) => o.kind === kind);
const userName = (id) => cf.users.find((u) => u.id === id)?.name || id;
const ICON = { conf: "🎥", did: "☎", schedule: "🕘", ring: "🔔", group: "👥", queue: "⏳", prompt: "🔊", ivr: "☰", user: "👤", user_vm: "✉", groupvm: "📮", external: "↗", hangup: "✕" };
const PALETTE = [
  ["Entrée", [["did", "SDA (numéro appelé)"], ["schedule", "Horaires"]]],
  ["Étapes (l'appel continue si personne ne répond)", [["ring", "Faire sonner des utilisateurs"], ["group", "Groupe d'appel"], ["queue", "File d'attente"], ["prompt", "Lire une annonce"]]],
  ["Fin du routage", [["user_vm", "Boîte vocale d'un utilisateur"], ["groupvm", "Boîte vocale de groupe"], ["ivr", "Répondeur numérique (SVI)"], ["conf", "Salle de réunion"], ["user", "Utilisateur (avec ses renvois)"], ["external", "Numéro externe"], ["hangup", "Terminer l'appel"]]],
];
const SHORT = { conf: "Réunion", ring: "Sonnerie", group: "Groupe d'appel", queue: "File d'attente", prompt: "Annonce", ivr: "SVI", user: "Utilisateur", user_vm: "Boîte vocale", groupvm: "Boîte de groupe", external: "Numéro externe", hangup: "Fin de l'appel" };
const TERMINAL = ["ivr", "user", "user_vm", "groupvm", "conf", "external", "hangup"];
const BR = { open: "Heures d'ouverture", closed: "Bureau fermé", break: "Pause", holiday: "Jour férié / congés" };

let flow = null, sel = null, activeRow = "open", errAt = null, cur = null;

export function flowSummary(cfData, helpers, d) {
  h = helpers; cf = cfData;
  return (d.branches.open || []).map((s, i) => `${i + 1}. ${describe(s)}`).join(" → ");
}

export function renderFlowEditor(helpers, cfData, head, id) {
  h = helpers; cf = cfData;
  cur = id && id !== "nouveau" ? cf.objects.find((o) => o.kind === "flow" && o.id === id) : null;
  flow = cur ? structuredClone(cur.data) : { name: "", dids: [], is_default: false, schedule: "", branches: { open: [], closed: null, break: null, holiday: null } };
  sel = null; activeRow = "open"; errAt = null;
  document.body.classList.add("wide");
  window.addEventListener("hashchange", () => document.body.classList.remove("wide"), { once: true });
  h.app.innerHTML = `${h.takeFlash()}${head}<div class="panel tabbed fe">
    <div class="pad"><p style="margin:0 0 12px"><a href="#/gestion/routages">← Routages</a></p>
      <div class="fe-nl">
        <label for="nlt" class="dl">Décris le routage, je le construis pour toi</label>
        <textarea id="nlt" rows="3" placeholder="Ex. : Quand on appelle le 04 65 00 15 40 : Accueil sonne 30 s puis groupe avec Paul et Julie pendant 15 s puis messagerie de Marine. En dehors des horaires : annonce Fermé puis raccrocher."></textarea>
        <div class="row"><button type="button" class="btn" id="nlgo">Proposer le routage</button><span class="hint">Rien n'est appliqué tant que tu n'as pas cliqué sur « Valider et appliquer ».</span></div>
        <div id="nlres"></div>
      </div>
    </div>
    <div class="fe-grid">
      <aside class="fe-pal">${PALETTE.map(([title, items]) => `<div class="fe-pg"><span class="fe-pt">${esc(title)}</span>${items.map(([t, l]) => `<div class="fe-pi ${TERMINAL.includes(t) ? "end" : t === "did" || t === "schedule" ? "in" : ""}" draggable="true" data-new="${t}" title="Glisse-moi dans le schéma (ou clique pour ajouter à la ligne active)"><span class="fe-ic">${ICON[t]}</span>${esc(l)}</div>`).join("")}</div>`).join("")}
        <p class="hint">Glisse les cadres de gauche à droite dans le schéma, ou clique dessus pour les ajouter à la ligne active.</p></aside>
      <section class="fe-canvas" id="canvas"></section>
      <aside class="fe-side" id="side"></aside>
    </div>
    <div class="pad fe-foot"><div class="grow"><label class="fe-name">Nom du routage<input id="fname" maxlength="50" value="${esc(flow.name)}" placeholder="Routage standard"></label>
      <label class="check"><input type="checkbox" id="fdef" ${flow.is_default ? "checked" : ""}> Routage par défaut (toutes les SDA qui n'ont pas de règle)</label></div>
      <div class="row">${cur ? '<button type="button" class="btn ghost" id="fdel">Supprimer</button>' : ""}${cur?.data.dids[0] ? `<a class="btn ghost" href="#/gestion/traceur/${esc(cur.data.dids[0])}">Tracer</a>` : ""}<button type="button" class="btn" id="fsave">Valider et appliquer</button></div>
      <div id="fmsg" style="flex-basis:100%"></div></div>
  </div>`;
  h.$("#fname").oninput = (e) => { flow.name = e.target.value; };
  h.$("#fdef").onchange = (e) => { flow.is_default = e.target.checked; };
  h.$("#fsave").onclick = save;
  h.$("#fdel")?.addEventListener("click", del);
  h.$("#nlgo").onclick = propose;
  h.app.querySelectorAll("[data-new]").forEach((p) => {
    p.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", `new:${p.dataset.new}`); e.dataTransfer.effectAllowed = "copy"; document.body.classList.add("fe-dragging"); });
    p.addEventListener("dragend", () => document.body.classList.remove("fe-dragging"));
    p.addEventListener("click", () => addNew(p.dataset.new, activeRow, (flow.branches[activeRow] || flow.branches.open).length));
  });
  draw();
}

// ---------------------------------------------------------------- Schéma
function draw() {
  const c = h.$("#canvas");
  const rows = ["open", ...(flow.schedule ? ["closed", "break", "holiday"] : [])];
  c.innerHTML = `<div class="fe-entry">
      <div class="fe-did dz-in" data-drop="did"><span class="fe-ic">☎</span><div class="grow"><strong>SDA</strong>
        <div class="fe-chips">${flow.dids.map((d) => `<span class="fe-chip">${esc(fmtP(d))}<button type="button" data-rmdid="${esc(d)}" title="Retirer">✕</button></span>`).join("") || (flow.is_default ? '<span class="s">Par défaut : toutes les SDA sans règle</span>' : '<span class="s">Glisse une SDA ici</span>')}</div>
        <select id="adddid" class="fe-mini"><option value="">+ Ajouter une SDA…</option>${freeDids().map((d) => `<option value="${esc(d.did)}">${esc(fmtP(d.did))} (${esc(d.trunk)})</option>`).join("")}<option value="__autre">Autre numéro…</option></select></div></div>
      <div class="fe-arrow">→</div>
      <div class="fe-sch dz-in" data-drop="schedule"><span class="fe-ic">🕘</span><div class="grow"><strong>Horaires</strong>
        <select id="fsched" class="fe-mini"><option value="">Aucun : toujours ouvert</option>${objs("schedule").map((s) => `<option value="${esc(s.id)}" ${flow.schedule === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
        ${objs("schedule").length ? "" : '<a class="s" href="#/gestion/horaires/nouveau">Créer des horaires</a>'}</div></div>
    </div>
    ${rows.map((b) => {
      const list = flow.branches[b];
      const same = b !== "open" && !list;
      return `<div class="fe-row ${activeRow === b ? "active" : ""}" data-row="${b}">
        <div class="fe-rl"><button type="button" class="fe-rbtn" data-act="${b}" title="Ligne active : les cadres cliqués s'ajoutent ici">${flow.schedule ? esc(BR[b]) : "Tous les appels"}</button>
          ${b !== "open" ? `<label class="switch sm"><input type="checkbox" data-same="${b}" ${same ? "checked" : ""}><span></span> Comme ouvert</label>` : ""}</div>
        <div class="fe-chain">${same ? '<div class="fe-same">Même routage qu\'aux heures d\'ouverture</div>' : chain(b, list)}</div></div>`;
    }).join("")}`;
  wire(c);
}
function chain(b, list) {
  const parts = [];
  list.forEach((st, i) => {
    parts.push(dz(b, i));
    if (i > 0) parts.push(`<div class="fe-link"><span>${esc(linkLabel(list[i - 1]))}</span>→</div>`);
    const bad = errAt && errAt.b === b && errAt.i === i;
    const after = i > 0 && TERMINAL.includes(list[i - 1].type);
    parts.push(`<div class="fe-card ${TERMINAL.includes(st.type) ? "end" : ""} ${sel?.b === b && sel?.i === i ? "sel" : ""} ${bad || after || !valid(st) ? "bad" : ""}" draggable="true" data-card="${b}:${i}">
      <div class="fe-ch"><span class="fe-ic">${ICON[st.type]}</span><strong>${esc(SHORT[st.type])}</strong><button type="button" class="fe-x" data-rm="${b}:${i}" title="Retirer">✕</button></div>
      <div class="fe-cs">${esc(describe(st))}</div>
      ${after ? '<div class="fe-err">Rien ne peut suivre l\'étape précédente.</div>' : !valid(st) ? '<div class="fe-err">À compléter : clique pour régler.</div>' : bad ? `<div class="fe-err">${esc(errAt.msg)}</div>` : ""}</div>`);
  });
  const last = list.at(-1);
  if (list.length) parts.push(`<div class="fe-link"><span>${esc(last && TERMINAL.includes(last.type) ? "" : linkLabel(last))}</span>${last && TERMINAL.includes(last.type) ? "" : "→"}</div>`);
  parts.push(`<div class="dz end" data-dz="${b}:${list.length}">${list.length ? (last && TERMINAL.includes(last.type) ? "Fin" : "Glisse l'étape suivante ici (sinon : raccroche)") : "Glisse la première étape ici"}</div>`);
  return parts.join("");
}
const dz = (b, i) => `<div class="dz" data-dz="${b}:${i}"></div>`;
const linkLabel = (st) => !st ? "" : st.type === "prompt" ? "puis" : st.type === "queue" ? "attente dépassée" : "sans réponse";
function valid(st) {
  switch (st.type) {
    case "ring": return st.users?.length > 0;
    case "hangup": return true;
    case "external": return /^0[1-9]\d{8}$/.test(String(st.target || "").replace(/\D/g, ""));
    default: return !!st.target;
  }
}
function describe(st) {
  const o = (kind, id) => cf.objects.find((x) => x.kind === kind && x.id === id);
  switch (st.type) {
    case "ring": return st.users?.length ? `${st.time || 20} s · ${st.users.map(userName).join(", ")}${st.users.length > 1 ? (st.strategy === "hunt" ? " (l'un après l'autre)" : " (en même temps)") : ""}` : "Choisis qui sonne";
    case "group": { const g = o("group", st.target); return g ? `${g.number} · ${g.name} · ${st.time || g.data.ring_time} s` : "Choisis le groupe"; }
    case "queue": { const q = o("queue", st.target); return q ? `${q.number} · ${q.name}` : "Choisis la file"; }
    case "ivr": { const q = o("ivr", st.target); return q ? `${q.number} · ${q.name}` : "Choisis le SVI"; }
    case "conf": { const q = o("conf", st.target); return q ? `${q.number} · ${q.name}` : "Choisis la salle"; }
    case "prompt": return o("prompt", st.target)?.name || "Choisis l'annonce";
    case "groupvm": { const q = o("groupvm", st.target); return q ? `${q.number} · ${q.name}` : "Choisis la boîte"; }
    case "user": case "user_vm": return st.target ? `${st.target} · ${userName(st.target)}` : "Choisis l'utilisateur";
    case "external": return st.target ? fmtP(st.target) : "Saisis le numéro";
    case "hangup": return "L'appel est raccroché";
    default: return "";
  }
}
function freeDids() {
  const used = new Set(); for (const o of cf.objects) if (o.id !== cur?.id) for (const d of o.data.dids || []) used.add(d);
  for (const u of cf.users) for (const d of u.dids || []) used.add(d);
  return cf.trunk_dids.filter((d) => !used.has(d.did) && !flow.dids.includes(d.did));
}

function wire(c) {
  c.querySelectorAll("[data-card]").forEach((el) => {
    el.addEventListener("click", (e) => { if (e.target.closest("[data-rm]")) return; const [b, i] = el.dataset.card.split(":"); sel = { b, i: Number(i) }; activeRow = b; draw(); panel(); });
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", `move:${el.dataset.card}`); e.dataTransfer.effectAllowed = "move"; document.body.classList.add("fe-dragging"); });
    el.addEventListener("dragend", () => document.body.classList.remove("fe-dragging"));
  });
  c.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => { const [r, i] = b.dataset.rm.split(":"); flow.branches[r].splice(Number(i), 1); sel = null; errAt = null; draw(); panel(); });
  c.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => { activeRow = b.dataset.act; draw(); });
  c.querySelectorAll("[data-same]").forEach((x) => x.onchange = () => { const b = x.dataset.same; flow.branches[b] = x.checked ? null : []; activeRow = x.checked ? "open" : b; sel = null; draw(); panel(); });
  c.querySelectorAll("[data-rmdid]").forEach((x) => x.onclick = () => { flow.dids = flow.dids.filter((d) => d !== x.dataset.rmdid); draw(); });
  h.$("#adddid").onchange = (e) => {
    let v = e.target.value;
    if (v === "__autre") v = (prompt("Numéro de la SDA :", "") || "").replace(/[\s.]/g, "").replace(/^\+33/, "0");
    if (/^0[1-9]\d{8}$/.test(v) && !flow.dids.includes(v)) flow.dids.push(v);
    draw();
  };
  h.$("#fsched").onchange = (e) => { flow.schedule = e.target.value; if (!flow.schedule) { flow.branches.closed = flow.branches.break = flow.branches.holiday = null; activeRow = "open"; } else if (flow.branches.closed === null) flow.branches.closed = []; draw(); };
  const drop = (target, data) => {
    if (data === "new:did") { h.$("#adddid").focus(); h.$("#adddid").showPicker?.(); return; }
    if (data === "new:schedule") { h.$("#fsched").focus(); h.$("#fsched").showPicker?.(); return; }
    if (!target) return;
    const [b, i] = target.split(":"); const at = Number(i);
    if (data.startsWith("new:")) return addNew(data.slice(4), b, at);
    const [, fb, fi] = data.split(":"); const from = Number(fi);
    const [st] = flow.branches[fb].splice(from, 1);
    const to = fb === b && from < at ? at - 1 : at;
    flow.branches[b].splice(to, 0, st);
    sel = { b, i: to }; draw(); panel();
  };
  c.querySelectorAll("[data-dz], [data-drop]").forEach((z) => {
    z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
    z.addEventListener("dragleave", () => z.classList.remove("over"));
    z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("over"); document.body.classList.remove("fe-dragging"); drop(z.dataset.dz, e.dataTransfer.getData("text/plain")); });
  });
}
function addNew(type, b, at) {
  if (type === "did") { h.$("#adddid").focus(); return; }
  if (type === "schedule") { h.$("#fsched").focus(); return; }
  if (!flow.branches[b]) flow.branches[b] = [];
  const st = { type, ...(type === "ring" ? { users: [], strategy: "all", time: 20 } : type === "group" ? { target: objs("group")[0]?.id || "", time: null } : type === "hangup" ? {} : { target: "" }) };
  if (["queue", "ivr", "prompt", "groupvm", "conf"].includes(type) && objs(type).length === 1) st.target = objs(type)[0].id;
  flow.branches[b].splice(at, 0, st);
  sel = { b, i: at }; activeRow = b; errAt = null; draw(); panel();
}

// ---------------------------------------------------------------- Réglages de l'étape sélectionnée
function panel() {
  const side = h.$("#side");
  const st = sel && flow.branches[sel.b]?.[sel.i];
  h.$(".fe-grid")?.classList.toggle("has-side", !!st);
  if (!st) { side.innerHTML = `<div class="fe-help"><strong>Comment ça marche ?</strong><ol><li>Glisse une <b>SDA</b> dans le cadre « SDA ».</li><li>Glisse les étapes de gauche à droite : si personne ne répond, l'appel passe au cadre suivant.</li><li>Termine par une <b>boîte vocale</b>, un SVI ou « terminer l'appel ».</li><li>Clique sur un cadre pour le régler (qui sonne, combien de temps…).</li><li>Avec des <b>horaires</b>, une ligne apparaît pour le bureau fermé, les pauses et les jours fériés.</li></ol></div>`; return; }
  const opt = (list, v, empty) => `<option value="">${esc(empty)}</option>${list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
  const objOpts = (kind) => objs(kind).map((o) => [o.id, `${o.number ? o.number + " · " : ""}${o.name}`]);
  const users = cf.users.map((u) => [u.id, `${u.id} · ${u.name}`]);
  const create = { group: "groupes", queue: "files", ivr: "svi", groupvm: "messageries", conf: "reunions", prompt: "annonces" }[st.type];
  let body = "";
  if (st.type === "ring") {
    body = `<span class="dl">Qui sonne ?</span><div class="chips fe-uchips">${cf.users.map((u) => `<button type="button" class="chip ${st.users.includes(u.id) ? "on" : ""}" data-u="${esc(u.id)}">${esc(u.id)} · ${esc(u.name)}</button>`).join("")}</div>
      <label>Comment ?<select data-f="strategy"><option value="all" ${st.strategy !== "hunt" ? "selected" : ""}>Tous en même temps</option><option value="hunt" ${st.strategy === "hunt" ? "selected" : ""}>L'un après l'autre (dans l'ordre choisi)</option></select></label>
      <label>Durée de sonnerie (secondes)${st.strategy === "hunt" ? " par personne" : ""}<input type="number" min="5" max="300" data-f="time" value="${esc(st.time || 20)}"></label>
      <p class="hint">Les personnes Absentes ou en Ne pas déranger ne sonnent pas.</p>`;
  } else if (st.type === "group") {
    body = `<label>Groupe d'appel<select data-f="target">${opt(objOpts("group"), st.target, "— Choisir —")}</select></label>
      <label>Durée de sonnerie (secondes)<input type="number" min="5" max="300" data-f="time" value="${esc(st.time || "")}" placeholder="Celle du groupe (${esc(objs("group").find((g) => g.id === st.target)?.data.ring_time ?? 20)} s)"></label>
      ${st.target ? `<p><a href="#/gestion/groupes/${esc(st.target)}">Modifier les membres du groupe</a></p>` : ""}`;
  } else if (["queue", "ivr", "groupvm", "conf", "prompt"].includes(st.type)) {
    body = `<label>${esc(cf.options.step_types[st.type])}<select data-f="target">${opt(objOpts(st.type), st.target, "— Choisir —")}</select></label>
      ${st.type === "prompt" && st.target ? `<audio controls src="/api/prompts/${esc(st.target)}/audio"></audio>` : ""}`;
  } else if (st.type === "user" || st.type === "user_vm") {
    body = `<label>Utilisateur<select data-f="target">${opt(users, st.target, "— Choisir —")}</select></label>
      <p class="hint">${st.type === "user" ? "L'appel suit ensuite les renvois réglés dans sa fiche." : "L'appelant laisse un message dans la boîte vocale de cet utilisateur."}</p>`;
  } else if (st.type === "external") {
    body = `<label>Numéro<input data-f="target" inputmode="tel" placeholder="06 12 34 56 78" value="${esc(fmtP(st.target))}"></label>`;
  } else body = '<p class="hint">L\'appel est raccroché.</p>';
  side.innerHTML = `<div class="fe-pan"><div class="fe-ch"><span class="fe-ic">${ICON[st.type]}</span><strong>${esc(cf.options.step_types[st.type])}</strong></div>
    <div class="stack">${body}${create ? `<p class="hint"><a href="#/gestion/${create}/nouveau" target="_blank">+ Créer (nouvel onglet)</a> puis recharge cette page.</p>` : ""}</div>
    <div class="row" style="margin-top:14px"><button type="button" class="btn ghost sm" id="pdel">Retirer l'étape</button><button type="button" class="btn sm" id="pok">OK</button></div></div>`;
  side.querySelectorAll("[data-u]").forEach((b) => b.onclick = () => { const id = b.dataset.u; st.users = st.users.includes(id) ? st.users.filter((x) => x !== id) : [...st.users, id]; b.classList.toggle("on"); draw(); });
  side.querySelectorAll("[data-f]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    const f = el.dataset.f; let v = el.value;
    if (f === "time") v = v ? Number(v) : (st.type === "group" ? null : 20);
    if (f === "target" && st.type === "external") v = v.replace(/[\s.]/g, "").replace(/^\+33/, "0");
    st[f] = v; errAt = null; draw();
    if (f === "strategy" || (f === "target" && st.type === "prompt")) panel();
  }));
  h.$("#pdel").onclick = () => { flow.branches[sel.b].splice(sel.i, 1); sel = null; draw(); panel(); };
  h.$("#pok").onclick = () => { sel = null; draw(); panel(); };
}

// ---------------------------------------------------------------- Texte → proposition
async function propose() {
  const text = h.$("#nlt").value.trim(); const box = h.$("#nlres");
  if (!text) return;
  box.innerHTML = '<p class="hint">Analyse…</p>';
  try {
    const r = await h.api("POST", "/api/callflow-parse", { text });
    if (!r.proposal) { box.innerHTML = `<div class="warnbox">${r.warnings.map(esc).join("<br>")}</div>`; return; }
    const p = r.proposal;
    flow.dids = p.dids.length ? p.dids : flow.dids;
    flow.is_default = p.is_default || flow.is_default;
    flow.schedule = p.schedule || "";
    flow.branches = { open: p.branches.open, closed: p.branches.closed, break: p.branches.break, holiday: p.branches.holiday };
    if (flow.schedule && flow.branches.closed === null) flow.branches.closed = null;
    if (!flow.name) { flow.name = p.name; h.$("#fname").value = p.name; }
    h.$("#fdef").checked = flow.is_default;
    sel = null; errAt = null; draw(); panel();
    box.innerHTML = `<div class="fe-prop"><strong>Voici ce que j'ai compris</strong> : vérifie le schéma ci-dessous, ajuste si besoin, puis clique sur « Valider et appliquer ».
      <ul>${r.understood.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${r.warnings.length ? `<div class="fe-warn"><strong>À vérifier :</strong><ul>${r.warnings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}</div>`;
    h.$("#canvas").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { box.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; }
}

// ---------------------------------------------------------------- Enregistrement
async function save() {
  const msg = h.$("#fmsg"); msg.innerHTML = "";
  flow.name = h.$("#fname").value.trim() || flow.name;
  const body = { name: flow.name, dids: flow.dids, is_default: flow.is_default, schedule: flow.schedule, branches: flow.branches };
  try {
    await h.api(cur ? "PUT" : "POST", `/api/callflow/flow${cur ? "/" + cur.id : ""}`, body);
    h.setFlash({ text: "Routage validé et appliqué." }); location.hash = "#/gestion/routages";
  } catch (e) {
    const m = /^branches\.(\w+)\.(\d+)$/.exec(e.field || "");
    if (m) { errAt = { b: m[1], i: Number(m[2]), msg: e.message }; draw(); }
    msg.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`;
  }
}
async function del() {
  if (!confirm(`Supprimer le routage « ${cur.name} » ? Ses SDA iront vers la règle par défaut.`)) return;
  try { await h.api("DELETE", `/api/callflow/flow/${cur.id}?force=1`); h.setFlash({ text: "Routage supprimé." }); location.hash = "#/gestion/routages"; }
  catch (e) { h.$("#fmsg").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; }
}
