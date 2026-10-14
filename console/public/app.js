// Console web PBXMaison — application monopage sans dépendance.
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const FORMAT_LABELS = { national: "National (0412345678)", e164: "E.164 sans + (33412345678)", e164_plus: "E.164 avec + (+33412345678)", keep: "Inchangé" };
const fmtPhone = (n) => /^\+33\d{9}$/.test(n || "") ? ("0" + n.slice(3)).replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "—");

// ---------------------------------------------------------------- API
const url = new URL(location.href);
if (url.searchParams.get("jeton")) {
  sessionStorage.setItem("pbxm_setup_token", url.searchParams.get("jeton"));
  history.replaceState(null, "", "/" + location.hash);
}
const setupToken = () => sessionStorage.getItem("pbxm_setup_token") || "";

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(setupToken() ? { "x-setup-token": setupToken() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401 && path !== "/api/login") { state.logged_in = false; route(); throw new Error(data?.error || "Session expirée"); }
  if (!res.ok) { const e = new Error(data?.error || `Erreur ${res.status}`); e.field = data?.field; throw e; }
  return data;
}

let state = null;
let flash = null;
let timer = null;
const takeFlash = () => { const f = flash; flash = null; return f ? `<div class="flash ${f.cls || ""}">${esc(f.text)}</div>` : ""; };

function copyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    navigator.clipboard?.writeText(b.dataset.copy).then(() => { const t = b.textContent; b.textContent = "Copié ✓"; setTimeout(() => (b.textContent = t), 1500); });
  }));
}

function setNav(active) {
  const links = [["#/", "Tableau de bord", "home"], ["#/trunks", "Trunks", "trunks"], ["#/postes", "Postes", "ext"],
    ["#/routes", "Routes", "routes"], ["#/appels", "Appels en cours", "calls"], ["#/systeme", "Système", "sys"]];
  $("#nav").innerHTML = state?.logged_in ? links.map(([h, l, k]) => `<a href="${h}" class="${k === active ? "on" : ""}">${l}</a>`).join("") : "";
  $("#user").innerHTML = state?.logged_in ? `<span class="hide-sm">${esc(state.email || "")}</span><button id="logout">Déconnexion</button>` : "";
  $("#logout")?.addEventListener("click", async () => { await api("POST", "/api/logout"); state.logged_in = false; location.hash = "#/"; route(); });
  $("#pbx-name").textContent = state?.pbx?.name || "Console PBX";
  document.title = state?.pbx?.name ? `${state.pbx.name} · Console` : "Console PBX";
}

// ---------------------------------------------------------------- Assistant d'installation
const wiz = { step: 1, config: null, check: null };

function wizardFrame(step, body) {
  const names = ["Fichier de config", "Vérification", "Installation", "Administrateur", "Terminé"];
  return `<div class="wizard">
    <h1>Installation du PBX</h1>
    <p class="sub">Quelques étapes et le standard est prêt.</p>
    <ol class="steps">${names.map((n, i) => `<li class="${i + 1 === step ? "on" : i + 1 < step ? "done" : ""}">${i + 1}. ${n}</li>`).join("")}</ol>
    ${takeFlash()}${body}</div>`;
}

function renderWizard() {
  setNav();
  clearInterval(timer);
  if (!state.logged_in && !setupToken()) {
    app.innerHTML = wizardFrame(1, `<div class="panel pad"><p><strong>Lien d'installation requis.</strong></p>
      <p class="hint">Ouvre l'adresse complète affichée à la fin de l'installation dans PuTTY (elle se termine par <code>?jeton=…</code>).</p></div>`);
    return;
  }
  if (state.configured && !state.has_admin && wiz.step < 4) wiz.step = 4;
  ({ 1: wizFile, 2: wizCheck, 3: wizApply, 4: wizAdmin, 5: wizDone })[wiz.step]();
}

function wizFile() {
  app.innerHTML = wizardFrame(1, `<div class="panel">
    <div class="pad">
      <p>Dépose le fichier <strong>pbx-config.json</strong> téléchargé sur le portail pour ce PBX.</p>
      <label class="drop" id="drop"><input type="file" accept=".json,application/json" hidden id="file">
        <strong>Glisser le fichier ici</strong><span class="hint">ou cliquer pour le choisir</span></label>
    </div></div>`);
  const drop = $("#drop");
  const read = async (f) => {
    try {
      wiz.config = JSON.parse(await f.text());
    } catch { flash = { cls: "bad", text: "Ce fichier n'est pas un pbx-config.json valide." }; return wizFile(); }
    wiz.step = 2; renderWizard();
  };
  $("#file").addEventListener("change", (e) => e.target.files[0] && read(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && read(e.dataTransfer.files[0]); });
}

async function wizCheck() {
  app.innerHTML = wizardFrame(2, `<div class="panel empty"><span class="spin"></span> Vérification…</div>`);
  let c;
  try { c = await api("POST", "/api/setup/check", { config: wiz.config }); } catch (e) { flash = { cls: "bad", text: e.message }; wiz.step = 1; return renderWizard(); }
  wiz.check = c;
  if (!c.ok) {
    app.innerHTML = wizardFrame(2, `<div class="panel"><div class="ph"><h2>Fichier refusé</h2><span class="pill bad">Licence invalide</span></div>
      <div class="pad"><ul>${c.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
      <div class="pad" style="border-top:1px solid var(--line)"><button class="btn ghost" id="back">Choisir un autre fichier</button></div></div>`);
    $("#back").onclick = () => { wiz.step = 1; renderWizard(); };
    return;
  }
  const p = c.pbx, n = c.network;
  const dnsLine = n.dns_ok ? `<span class="pill ok">OK</span> ${esc(p.fqdn)} → ${esc(n.dns_ip)}`
    : n.dns_ip ? `<span class="pill bad">À corriger</span> ${esc(p.fqdn)} pointe vers ${esc(n.dns_ip)} au lieu de ${esc(n.public_ip)}`
    : `<span class="pill wait">Absent</span> ${esc(p.fqdn)} ne pointe nulle part`;
  app.innerHTML = wizardFrame(2, `<div class="panel">
    <div class="ph"><h2>${esc(p.name)}</h2><span class="pill ok">Licence valide</span></div>
    <dl>
      <div><dt>Entreprise</dt><dd>${esc(p.company)} · ${esc(fmtPhone(p.phone))}</dd></div>
      <div><dt>Licence</dt><dd class="mono">${esc(p.license)}</dd></div>
      <div><dt>Édition</dt><dd>${esc(p.edition)} · ${p.simultaneous_calls} appels simultanés · expire le ${fmtDate(p.expires_at)}</dd></div>
      <div><dt>Administrateur</dt><dd>${esc(p.admin_email)}</dd></div>
      <div><dt>Adresse</dt><dd class="mono">${esc(p.fqdn)}</dd></div>
      <div><dt>IP publique</dt><dd class="mono">${esc(n.public_ip)}${n.behind_nat ? ` <span class="hint">(derrière un routeur, IP locale ${esc(n.local_ip)})</span>` : ""}</dd></div>
      <div><dt>DNS</dt><dd>${dnsLine}</dd></div>
    </dl>
    ${n.dns_ok ? "" : `<div class="pad"><div class="note">Sans DNS correct, le PBX fonctionne mais <strong>sans certificat HTTPS</strong>.
      Crée l'enregistrement <strong>A</strong> <code>${esc(p.fqdn)}</code> → <code>${esc(n.public_ip)}</code> chez ton hébergeur DNS,
      puis vérifie à nouveau (la propagation peut prendre quelques minutes). Tu pourras aussi obtenir le certificat plus tard, depuis « Système ».</div></div>`}
    ${n.behind_nat ? `<div class="pad"><div class="note">Machine derrière une box : redirige vers <code>${esc(n.local_ip)}</code> les ports UDP 5060, TCP 5060-5061, UDP 10000-20000, TCP 80 et 443, et désactive le « SIP ALG ».</div></div>` : ""}
    <div class="pad row" style="border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn ghost" id="back">Autre fichier</button>
      ${n.dns_ok ? "" : `<button class="btn ghost" id="recheck">Vérifier à nouveau le DNS</button>`}
      <button class="btn" id="go">Installer ce PBX</button>
    </div></div>`);
  $("#back").onclick = () => { wiz.step = 1; renderWizard(); };
  $("#recheck")?.addEventListener("click", () => wizCheck());
  $("#go").onclick = async () => {
    try { await api("POST", "/api/setup/apply", { config: wiz.config }); wiz.step = 3; renderWizard(); }
    catch (e) { flash = { cls: "bad", text: e.message }; wizCheck(); }
  };
}

const ICONS = { run: '<span class="spin"></span>', ok: "✔", warn: "⚠", error: "✖" };
const STEP_LABELS = { verification: "Licence", asterisk: "Moteur téléphonique", certificat: "Certificat HTTPS", demarrage: "Démarrage", termine: "Code d'installation", erreur: "Erreur" };
function progressList(steps) {
  return `<ul class="progress">${steps.filter((s) => s.step !== "termine").map((s) => `<li class="${s.status}"><span class="ic">${ICONS[s.status] || "•"}</span>
    <div><strong>${esc(STEP_LABELS[s.step] || s.step)}</strong><div class="hint">${esc(s.message)}</div></div></li>`).join("")}</ul>`;
}

function wizApply() {
  app.innerHTML = wizardFrame(3, `<div class="panel"><div class="ph"><h2>Installation en cours</h2><span class="spin"></span></div><div id="prog"><div class="pad hint">Démarrage…</div></div></div>`);
  const poll = async () => {
    let p;
    try { p = await api("GET", "/api/setup/progress"); } catch (e) { return; }
    $("#prog").innerHTML = p.steps.length ? progressList(p.steps) : `<div class="pad hint">Démarrage…</div>`;
    if (!p.running && p.ok !== null) {
      clearInterval(timer);
      if (p.ok) { state.configured = true; wiz.step = state.has_admin ? 5 : 4; setTimeout(renderWizard, 800); }
      else {
        $(".ph").innerHTML = `<h2>L'installation a échoué</h2><span class="pill bad">Erreur</span>`;
        $("#prog").insertAdjacentHTML("beforeend", `<div class="pad" style="border-top:1px solid var(--line)"><button class="btn ghost" id="retry">Revenir à la vérification</button></div>`);
        $("#retry").onclick = () => { wiz.step = 2; renderWizard(); };
      }
    }
  };
  clearInterval(timer); timer = setInterval(poll, 1200); poll();
}

async function wizAdmin() {
  let p = null;
  try { p = await api("GET", "/api/setup/progress"); } catch {}
  const email = wiz.check?.pbx?.admin_email || "l'e-mail choisi sur le portail";
  app.innerHTML = wizardFrame(4, `<div class="panel">
    ${p?.steps?.length ? `<div class="ph"><h2>Installation terminée</h2><span class="pill ok">OK</span></div>${progressList(p.steps)}` : ""}
    <div class="ph" style="border-top:1px solid var(--line)"><h2>Mot de passe administrateur</h2></div>
    <form method="post" class="grid" id="adm" novalidate>
      <p class="full hint" style="margin:0">Identifiant de connexion : <strong>${esc(email)}</strong></p>
      <label>Mot de passe<input type="password" name="password" autocomplete="new-password" required minlength="10"><span class="hint">10 caractères minimum, lettres et chiffres.</span></label>
      <label>Confirmation<input type="password" name="confirm" autocomplete="new-password" required></label>
      <div class="actions"><button class="btn">Créer le compte et ouvrir la console</button></div>
    </form></div>`);
  $("#adm").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.password !== f.confirm) { flash = { cls: "bad", text: "Les deux mots de passe sont différents." }; return wizAdmin(); }
    try {
      const r = await api("POST", "/api/setup/admin", { password: f.password });
      sessionStorage.removeItem("pbxm_setup_token");
      Object.assign(state, { has_admin: true, logged_in: true, email: r.email });
      wiz.step = 5; renderWizard();
    } catch (err) { flash = { cls: "bad", text: err.message }; wizAdmin(); }
  };
}

async function wizDone() {
  let d = null;
  try { d = await api("GET", "/api/dashboard"); } catch {}
  const st = await api("GET", "/api/state"); Object.assign(state, st);
  const httpsUrl = d?.network?.tls ? `https://${d.pbx.fqdn}` : null;
  app.innerHTML = wizardFrame(5, `<div class="panel">
    <div class="ph"><h2>Le PBX est prêt</h2><span class="pill ok">Installé</span></div>
    <div class="pad stack">
      <div><strong>Dernière étape côté portail</strong>
        <p class="hint" style="margin:4px 0 10px">Dans le portail, fiche du PBX → « Enregistrer l'installation » → colle ce code :</p>
        <pre class="code">${esc(d?.activation_code || "—")}</pre>
        <p style="margin:8px 0 0"><button class="copy" data-copy="${esc(d?.activation_code || "")}">Copier le code</button></p></div>
      ${httpsUrl ? `<div class="note">La console est maintenant accessible en HTTPS : <a href="${httpsUrl}">${httpsUrl}</a></div>`
        : `<div class="note">Pas encore de certificat HTTPS : tu pourras l'obtenir depuis <strong>Système</strong> une fois le DNS corrigé.</div>`}
      <div><a class="btn" href="${httpsUrl ? httpsUrl + "/#/trunks" : "#/trunks"}">Configurer le premier trunk</a></div>
    </div></div>`);
  copyButtons();
}

// ---------------------------------------------------------------- Connexion
function renderLogin() {
  setNav();
  clearInterval(timer);
  app.innerHTML = `<div class="login"><div class="panel"><div class="ph"><h2>Connexion</h2></div>
    <form method="post" id="login">${takeFlash()}
      <label>E-mail<input type="email" name="email" autocomplete="username" required autofocus></label>
      <label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn">Se connecter</button></form></div></div>`;
  $("#login").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/login", Object.fromEntries(new FormData(e.target)));
      Object.assign(state, { logged_in: true, email: r.email }); route();
    } catch (err) { flash = { cls: "bad", text: err.message }; renderLogin(); }
  };
}

// ---------------------------------------------------------------- Tableau de bord
async function renderDashboard() {
  setNav("home");
  const d = await api("GET", "/api/dashboard");
  const left = Math.floor((new Date(d.pbx.expires_at) - Date.now()) / 86400000);
  app.innerHTML = `${takeFlash()}<div class="bar"><div class="grow"><h1>${esc(d.pbx.name)}</h1>
    <p class="sub" style="margin:0">${esc(d.pbx.company)} · <span class="mono">${esc(d.pbx.fqdn)}</span></p></div></div>
    <div class="cards">
      <a class="card" href="#/trunks"><div class="k">Trunks enregistrés</div><div class="v">${d.trunks.registered}<small> / ${d.trunks.total}</small></div>
        <div class="s">${d.trunks.total === 0 ? "Aucun trunk : ajoute ton opérateur" : d.trunks.registered === d.trunks.total ? "Tous opérationnels" : "Au moins un trunk en défaut"}</div></a>
      <a class="card" href="#/postes"><div class="k">Postes connectés</div><div class="v">${d.extensions.registered}<small> / ${d.extensions.total}</small></div>
        <div class="s">${d.extensions.total === 0 ? "Aucun poste créé" : "téléphones enregistrés"}</div></a>
      <a class="card" href="#/appels"><div class="k">Appels en cours</div><div class="v">${d.calls.available ? d.calls.active : "—"}<small> / ${d.pbx.max_calls}</small></div>
        <div class="s">${d.calls.available ? "limite de la licence" : "moteur injoignable"}</div></a>
      <div class="card"><div class="k">Licence</div><div class="v" style="font-size:18px">${esc(d.pbx.edition)}</div>
        <div class="s">expire le ${fmtDate(d.pbx.expires_at)}${left < 30 ? ` · <strong style="color:var(--warn)">${left} jours</strong>` : ""}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><div class="ph"><h2>Serveur</h2></div><dl>
        <div><dt>Adresse</dt><dd class="mono">${esc(d.pbx.fqdn)}</dd></div>
        <div><dt>IP publique</dt><dd class="mono">${esc(d.network.public_ip)}${d.network.behind_nat ? ` <span class="hint">(locale ${esc(d.network.local_ip)})</span>` : ""}</dd></div>
        <div><dt>Certificat</dt><dd>${d.network.tls ? '<span class="pill ok">HTTPS + SIP TLS</span>' : '<span class="pill wait">Absent</span> <a href="#/systeme">Obtenir</a>'}</dd></div>
        <div><dt>Licence</dt><dd class="mono">${esc(d.pbx.license)}</dd></div>
      </dl></div>
      <div class="panel"><div class="ph"><h2>Pour démarrer</h2></div><div class="pad">
        <ol style="margin:0;padding-left:20px;line-height:2">
          <li>${d.trunks.total ? "✔ " : ""}<a href="#/trunks/nouveau">Ajouter le trunk de l'opérateur</a></li>
          <li>${d.extensions.total ? "✔ " : ""}<a href="#/postes">Créer les postes</a> et les saisir dans les téléphones</li>
          <li><a href="#/routes">Choisir qui sonne</a> sur les appels entrants et le trunk de sortie</li>
        </ol></div></div>
    </div>`;
}

// ---------------------------------------------------------------- Trunks
async function renderTrunks() {
  setNav("trunks");
  const trunks = await api("GET", "/api/trunks");
  app.innerHTML = `${takeFlash()}<div class="bar"><div class="grow"><h1>Trunks</h1><p class="sub" style="margin:0">Lignes de l'opérateur (SIP).</p></div>
    <a class="btn" href="#/trunks/nouveau">+ Ajouter un trunk</a></div>
    <div class="panel">${trunks.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Nom</th><th>Opérateur</th><th>Numéro</th><th class="hide-sm">Serveur</th><th>État</th><th></th></tr></thead>
      <tbody>${trunks.map((t) => `<tr>
        <td><strong>${esc(t.id)}</strong></td>
        <td>${esc(t.operator)}<div class="s">${esc(t.codecs.join(", "))}</div></td>
        <td>${esc(fmtPhone(t.number.startsWith("33") ? "+" + t.number : t.number))}<div class="s">présenté : ${esc(t.outbound_cid)}</div></td>
        <td class="hide-sm mono">${esc(t.host)}<div class="s">${esc(t.transport.toUpperCase())} · ${esc(t.username)}</div></td>
        <td><span class="pill ${t.status.cls}">${esc(t.status.label)}</span></td>
        <td style="text-align:right;white-space:nowrap"><a class="btn ghost sm" href="#/trunks/${esc(t.id)}">Modifier</a>
          <button class="btn ghost sm" data-del="${esc(t.id)}">Supprimer</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty"><p>Aucun trunk pour l'instant.</p><a class="btn" href="#/trunks/nouveau">Ajouter le trunk de l'opérateur</a></div>`}</div>`;
  app.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Supprimer le trunk « ${b.dataset.del} » ? Les appels ne passeront plus par lui.`)) return;
    await api("DELETE", `/api/trunks/${encodeURIComponent(b.dataset.del)}`);
    flash = { text: `Trunk « ${b.dataset.del} » supprimé.` }; renderTrunks();
  });
  clearInterval(timer);
  if (trunks.some((t) => t.status.code !== "Registered")) timer = setInterval(() => location.hash === "#/trunks" && renderTrunks(), 5000);
}

async function renderTrunkForm(id, errorField, errorMsg, draft) {
  setNav("trunks");
  clearInterval(timer);
  const [templates, trunks] = await Promise.all([api("GET", "/api/templates"), id ? api("GET", "/api/trunks") : []]);
  const existing = id ? trunks.find((t) => t.id === id) : null;
  if (id && !existing) { app.innerHTML = `<div class="panel empty">Trunk introuvable. <a href="#/trunks">Retour</a></div>`; return; }
  const v = draft || (existing ? { name: existing.id, template: existing.template, number: existing.number, username: existing.username,
    host: existing.host, proxy: existing.proxy, cid_format: existing.cid_format, dial_format: existing.dial_format, caller_format: existing.caller_format } : { template: "" });
  const field = (name, label, input, hint, cls = "") => `<label class="${cls} ${errorField === name ? "has-err" : ""}">${label}${input}
    ${errorField === name ? `<span class="err">${esc(errorMsg)}</span>` : hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
  const opts = (list, cur) => list.map(([val, lab]) => `<option value="${esc(val)}" ${String(val) === String(cur ?? "") ? "selected" : ""}>${esc(lab)}</option>`).join("");
  const fmt = (name, cur, withKeep) => `<select name="${name}"><option value="">Selon l'opérateur</option>${opts(Object.entries(FORMAT_LABELS).filter(([k]) => withKeep || k !== "keep"), cur)}</select>`;

  app.innerHTML = `<h1>${existing ? `Trunk « ${esc(existing.id)} »` : "Ajouter un trunk"}</h1>
    <p class="sub">${existing ? "Laisse le mot de passe vide pour garder l'actuel." : "Choisis l'opérateur : les réglages techniques sont remplis automatiquement."}</p>
    ${errorMsg && !errorField ? `<div class="flash bad">${esc(errorMsg)}</div>` : ""}
    <div class="panel"><form method="post" class="grid" id="tf" novalidate>
      ${field("template", "Opérateur", `<select name="template" required><option value="">— Choisir —</option>${opts(templates.map((t) => [t.id, t.label]), v.template)}</select>`, "", "full")}
      <div class="op-info" id="opinfo" hidden></div>
      ${field("name", "Nom du trunk", `<input name="name" value="${esc(v.name || "")}" ${existing ? "readonly" : ""} placeholder="ex. dstny" autocapitalize="off">`, "Lettres minuscules, chiffres, tirets.")}
      ${field("number", "Numéro principal", `<input name="number" value="${esc(v.number || "")}" placeholder="04 12 34 56 78" inputmode="tel">`, "Numéro présenté par défaut sur les appels sortants.")}
      ${field("username", "Identifiant SIP", `<input name="username" value="${esc(v.username || "")}" autocapitalize="off" autocomplete="off">`, "<span id='userhint'>Fourni par l'opérateur.</span>")}
      ${field("password", "Mot de passe SIP", `<input name="password" type="password" autocomplete="new-password" placeholder="${existing ? "inchangé" : ""}">`, "")}
      ${field("host", "Serveur (registrar)", `<input name="host" value="${esc(v.host || "")}" autocapitalize="off" placeholder="sip.operateur.fr">`, "<span id='hosthint'></span>")}
      ${field("proxy", "Proxy sortant", `<input name="proxy" value="${esc(v.proxy ?? "")}" autocapitalize="off" placeholder="aucun">`, "<span id='proxyhint'>Facultatif : serveur ou serveur:port.</span>")}
      <details ${v.cid_format || v.dial_format || v.caller_format ? "open" : ""}><summary>Formats des numéros (avancé)</summary><div class="inner">
        ${field("cid_format", "Numéro présenté", fmt("cid_format", v.cid_format), "Envoyé à l'opérateur.")}
        ${field("dial_format", "Numéros composés", fmt("dial_format", v.dial_format), "Envoyés à l'opérateur.")}
        ${field("caller_format", "Appelant entrant", fmt("caller_format", v.caller_format, true), "Affiché sur les postes.")}
      </div></details>
      <div class="actions"><a class="btn ghost" href="#/trunks">Annuler</a><button class="btn" type="submit">${existing ? "Enregistrer" : "Ajouter le trunk"}</button></div>
    </form></div>`;

  const form = $("#tf");
  const applyTemplate = (prefill) => {
    const t = templates.find((x) => x.id === form.template.value);
    const info = $("#opinfo");
    if (!t) { info.hidden = true; return; }
    info.hidden = false;
    info.innerHTML = `<span>Transport <b>${t.transport.toUpperCase()}</b></span><span>Port <b>${t.registrar.port}</b></span>
      <span>Codecs <b>${t.codecs.join(" → ")}</b></span><span>Ré-enregistrement <b>${t.registration.interval} s</b></span>
      ${t.verified ? "" : `<span style="color:var(--warn)">Réglages à valider par un appel test</span>`}`;
    if (prefill) {
      form.host.value = t.registrar.host || "";
      form.proxy.value = t.proxy ? `${t.proxy.host}:${t.proxy.port}` : "";
      if (!existing && !form.name.value) form.name.value = t.id === "generique" ? "" : t.id;
    }
    // Les aides sont remplacées par le message d'erreur du champ concerné : elles peuvent être absentes
    const hh = $("#hosthint"), uh = $("#userhint");
    if (hh) hh.textContent = t.registrar.host ? "Rempli d'après l'opérateur (modifiable)." : "À demander à l'opérateur (propre à ton compte).";
    if (uh) uh.textContent = t.auth_username_default === "trunk_number" ? "Laisser vide : le numéro du trunk est utilisé." : "Fourni par l'opérateur.";
    form.host.placeholder = t.registrar.host ? t.registrar.host : (/eqinoxe/.test(t.notes) ? "ex. pbx.eqinoxe.com" : "fourni par l'opérateur");
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    for (const k of ["cid_format", "dial_format", "caller_format"]) if (!f[k]) delete f[k];
    const btn = form.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      if (existing) await api("PUT", `/api/trunks/${encodeURIComponent(existing.id)}`, f);
      else await api("POST", "/api/trunks", f);
      flash = { text: `Trunk « ${f.name || existing.id} » enregistré. L'état d'enregistrement s'actualise automatiquement.` };
      location.hash = "#/trunks";
    } catch (err) { renderTrunkForm(id, err.field, err.message, { ...f, name: f.name || existing?.id }); }
  });
  form.template.addEventListener("change", () => applyTemplate(true));
  if (v.template) applyTemplate(!existing && !draft);

}

// ---------------------------------------------------------------- Postes
function credentialsPanel(server, ext) {
  return `<div class="panel" id="cred"><div class="ph"><h2>Identifiants du poste ${esc(ext.id)}</h2><button class="btn ghost sm" id="credclose">Fermer</button></div>
    <dl>
      <div><dt>Serveur</dt><dd class="mono">${esc(server.fqdn)} <button class="copy" data-copy="${esc(server.fqdn)}">Copier</button></dd></div>
      <div><dt>Port</dt><dd>5060 (UDP ou TCP)${server.tls ? " · 5061 en TLS" : ""}</dd></div>
      <div><dt>Utilisateur</dt><dd class="mono">${esc(ext.id)}</dd></div>
      <div><dt>Identifiant d'auth.</dt><dd class="mono">${esc(ext.id)}</dd></div>
      <div><dt>Mot de passe</dt><dd class="mono">${esc(ext.password)} <button class="copy" data-copy="${esc(ext.password)}">Copier</button></dd></div>
    </dl></div>`;
}

async function renderExtensions(showCred) {
  setNav("ext");
  const d = await api("GET", "/api/extensions");
  app.innerHTML = `${takeFlash()}<div class="bar"><div class="grow"><h1>Postes</h1><p class="sub" style="margin:0">Téléphones, softphones et postes DECT.</p></div></div>
    <div class="stack">
    ${showCred ? credentialsPanel(d.server, showCred) : ""}
    <div class="panel"><div class="ph"><h2>Nouveau poste</h2></div>
      <form method="post" class="grid" id="ef" novalidate>
        <label>Numéro<input name="number" value="${esc(d.next)}" inputmode="numeric" maxlength="3"><span class="hint">3 chiffres, de 100 à 999.</span></label>
        <label>Nom affiché<input name="name" placeholder="ex. Accueil" maxlength="40"></label>
        <div class="actions"><button class="btn">Créer le poste</button></div>
      </form></div>
    <div class="panel">${d.extensions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Poste</th><th>Nom</th><th>État</th><th class="hide-sm">Appareil</th><th></th></tr></thead>
      <tbody>${d.extensions.map((x) => `<tr>
        <td><strong>${esc(x.id)}</strong></td><td>${esc(x.name)}</td>
        <td>${x.registered ? '<span class="pill ok">Connecté</span>' : '<span class="pill off">Non connecté</span>'}</td>
        <td class="hide-sm">${x.contacts.map((c) => `${esc(c.user_agent || "—")}<div class="s mono">${esc(c.ip)}</div>`).join("") || '<span class="s">—</span>'}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-cred="${esc(x.id)}">Identifiants</button>
          <button class="btn ghost sm" data-del="${esc(x.id)}">Supprimer</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">Aucun poste pour l'instant.</div>`}</div></div>`;
  copyButtons();
  $("#credclose")?.addEventListener("click", () => renderExtensions());
  $("#ef").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/extensions", Object.fromEntries(new FormData(e.target)));
      flash = { text: `Poste ${r.id} « ${r.name} » créé. Saisis ces identifiants dans le téléphone.` };
      renderExtensions(r);
    } catch (err) { flash = { cls: "bad", text: err.message }; renderExtensions(); }
  };
  app.querySelectorAll("[data-cred]").forEach((b) => b.onclick = async () => renderExtensions(await api("GET", `/api/extensions/${b.dataset.cred}/secret`)));
  app.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Supprimer le poste ${b.dataset.del} ?`)) return;
    await api("DELETE", `/api/extensions/${b.dataset.del}`);
    flash = { text: `Poste ${b.dataset.del} supprimé.` }; renderExtensions();
  });
  clearInterval(timer);
  timer = setInterval(async () => {
    if (location.hash !== "#/postes" || $("#cred") || document.activeElement?.closest("#ef")) return;
    renderExtensions();
  }, 10000);
}

// ---------------------------------------------------------------- Routes
async function renderRoutes() {
  setNav("routes");
  clearInterval(timer);
  const [routes, ext, trunks] = await Promise.all([api("GET", "/api/routes"), api("GET", "/api/extensions"), api("GET", "/api/trunks")]);
  const sel = new Set(routes.inbound);
  app.innerHTML = `${takeFlash()}<h1>Routes</h1><p class="sub">Qui sonne quand on appelle, et par où sortent les appels.</p>
    <form method="post" id="rf" class="stack">
      <div class="panel"><div class="ph"><h2>Appels entrants</h2></div><div class="pad">
        <p class="hint" style="margin-top:0">Les postes cochés sonnent en même temps (45 s).</p>
        ${ext.extensions.length ? `<div class="chips">${ext.extensions.map((x) => `<label class="chip ${sel.has(x.id) ? "on" : ""}">
          <input type="checkbox" name="inbound" value="${esc(x.id)}" ${sel.has(x.id) ? "checked" : ""}> ${esc(x.id)} · ${esc(x.name)}</label>`).join("")}</div>`
          : `<p>Aucun poste : <a href="#/postes">crée d'abord un poste</a>.</p>`}
      </div></div>
      <div class="panel"><div class="ph"><h2>Appels sortants</h2></div><div class="pad">
        <label style="max-width:420px">Trunk utilisé<select name="outbound_trunk"><option value="">— Aucun (appels sortants impossibles) —</option>
          ${trunks.map((t) => `<option value="${esc(t.id)}" ${t.id === routes.outbound_trunk ? "selected" : ""}>${esc(t.id)} · ${esc(t.operator)} (${esc(t.outbound_cid)})</option>`).join("")}</select></label>
        <p class="hint">Numéros nationaux, numéros courts (3xxx) et urgences autorisés. International et 089x bloqués.</p>
      </div></div>
      <div><button class="btn">Enregistrer les routes</button></div>
    </form>`;
  app.querySelectorAll(".chip input").forEach((i) => i.addEventListener("change", () => i.closest(".chip").classList.toggle("on", i.checked)));
  $("#rf").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("PUT", "/api/routes", { inbound: fd.getAll("inbound"), outbound_trunk: fd.get("outbound_trunk") });
      flash = { text: "Routes enregistrées et appliquées." }; renderRoutes();
    } catch (err) { flash = { cls: "bad", text: err.message }; renderRoutes(); }
  };
}

// ---------------------------------------------------------------- Appels en cours
async function renderCalls() {
  setNav("calls");
  const draw = async () => {
    if (location.hash !== "#/appels") return clearInterval(timer);
    let d;
    try { d = await api("GET", "/api/calls"); } catch { return; }
    app.innerHTML = `<div class="bar"><div class="grow"><h1>Appels en cours</h1><p class="sub" style="margin:0">Actualisation toutes les 2 secondes.</p></div></div>
      <div class="panel">${!d.available ? `<div class="empty">Moteur téléphonique injoignable.</div>`
        : d.calls.length ? `<div class="table-wrap"><table><thead><tr><th>Sens</th><th>De</th><th>Vers</th><th>Trunk</th><th>État</th><th>Durée</th></tr></thead>
        <tbody>${d.calls.map((c) => `<tr><td>${esc(c.direction)}</td><td class="mono">${esc(c.from)}</td><td class="mono">${esc(c.to)}</td>
          <td>${esc(c.trunk || "—")}</td><td><span class="pill ${c.state === "En communication" ? "ok" : "wait"}">${esc(c.state)}</span></td>
          <td class="mono">${fmtDur(c.duration)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Aucun appel en cours.</div>`}</div>`;
  };
  clearInterval(timer); await draw(); timer = setInterval(draw, 2000);
}

// ---------------------------------------------------------------- Système
async function renderSystem() {
  setNav("sys");
  clearInterval(timer);
  const d = await api("GET", "/api/dashboard");
  app.innerHTML = `${takeFlash()}<h1>Système</h1><p class="sub">Certificat, installation et code pour le portail.</p>
    <div class="grid2">
      <div class="panel"><div class="ph"><h2>Certificat et configuration</h2></div>
        <div class="pad stack">
          <p style="margin:0">${d.network.tls ? '<span class="pill ok">Certificat actif</span>' : '<span class="pill wait">Pas de certificat</span>'}
            ${d.network.dns_ok ? "" : `<span class="hint"> — le DNS de ${esc(d.pbx.fqdn)} doit pointer vers ${esc(d.network.public_ip)}.</span>`}</p>
          <p class="hint" style="margin:0">Relance la configuration après avoir corrigé le DNS ou les ports : le certificat est demandé à nouveau, la configuration téléphonique est réécrite (trunks, postes et routes sont conservés).</p>
          <div><button class="btn" id="reapply">Relancer la configuration</button></div>
          <div id="prog"></div>
        </div></div>
      <div class="panel"><div class="ph"><h2>Code d'installation</h2></div><div class="pad">
        <p class="hint" style="margin-top:0">À coller dans le portail (fiche du PBX → « Enregistrer l'installation »).</p>
        <pre class="code">${esc(d.activation_code || "—")}</pre>
        <p style="margin-bottom:0"><button class="copy" data-copy="${esc(d.activation_code || "")}">Copier le code</button></p></div></div>
    </div>`;
  copyButtons();
  $("#reapply").onclick = async () => {
    $("#reapply").disabled = true;
    try { await api("POST", "/api/setup/reapply"); } catch (e) { flash = { cls: "bad", text: e.message }; return renderSystem(); }
    const poll = async () => {
      const p = await api("GET", "/api/setup/progress");
      $("#prog").innerHTML = progressList(p.steps);
      if (!p.running && p.ok !== null) { clearInterval(timer); flash = { cls: p.ok ? "" : "bad", text: p.ok ? "Configuration appliquée." : "La configuration a échoué : voir le détail." }; if (p.ok) setTimeout(renderSystem, 1200); }
    };
    timer = setInterval(poll, 1200);
  };
}

// ---------------------------------------------------------------- Routage
async function route() {
  try {
    if (!state) state = await api("GET", "/api/state");
    if (!state.configured || !state.has_admin) return renderWizard();
    if (!state.logged_in) return renderLogin();
    if (!state.email) state.email = (await api("GET", "/api/me")).email;
    const h = location.hash || "#/";
    let m;
    if (h === "#/trunks") await renderTrunks();
    else if (h === "#/trunks/nouveau") await renderTrunkForm(null);
    else if ((m = h.match(/^#\/trunks\/([\w-]+)$/))) await renderTrunkForm(m[1]);
    else if (h === "#/postes") await renderExtensions();
    else if (h === "#/routes") await renderRoutes();
    else if (h === "#/appels") await renderCalls();
    else if (h === "#/systeme") await renderSystem();
    else await renderDashboard();
    window.scrollTo(0, 0);
  } catch (e) {
    if (state?.logged_in === false) return;
    app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", () => { clearInterval(timer); route(); });
route();
