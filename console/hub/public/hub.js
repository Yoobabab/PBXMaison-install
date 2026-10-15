// Console du serveur multi-tenant Callikoe — page unique sans dépendance.
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
let state = { user: null, server: {}, roles: {} };
let flash = null;
const takeFlash = () => { const f = flash; flash = null; return f ? `<div class="flash ${f.cls || ""}">${esc(f.text)}</div>` : ""; };

const url = new URL(location.href);
if (url.searchParams.get("jeton")) { sessionStorage.setItem("cxhub_setup", url.searchParams.get("jeton")); history.replaceState(null, "", "/" + location.hash); }
const setupToken = () => sessionStorage.getItem("cxhub_setup") || "";

async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: "same-origin",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(setupToken() ? { "x-setup-token": setupToken() } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { data = null; }
  if (res.status === 401 && !path.startsWith("/api/login") && path !== "/api/state" && !(data?.field === "code")) { state.user = null; route(); throw new Error(data?.error || "Session expirée"); }
  if (!res.ok) { const e = new Error(data?.error || `Erreur ${res.status}`); e.field = data?.field; throw e; }
  return data;
}

const ICONS = {
  pbx: '<path d="M4 5h16v10H4z"/><path d="M8 19h8M12 15v4"/>',
  add: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h3"/>',
  out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
};
const icon = (k, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ""}</svg>`;
const can = (...roles) => roles.includes(state.user?.role);

function setNav(active, label = "") {
  const on = !!state.user;
  document.body.classList.toggle("no-side", !on);
  document.body.classList.remove("side-open");
  const items = [["#/", "PBX clients", "pbx"], ...(can("super", "admin") ? [["#/nouveau", "Nouveau PBX", "add"]] : []),
    ...(can("super") ? [["#/comptes", "Comptes du serveur", "users"]] : []), ...(can("super", "admin") ? [["#/journal", "Journal", "log"]] : [])];
  $("#nav").innerHTML = on ? `<div class="ng">${items.map(([h, l, k]) => `<a href="${h}" class="${k === active ? "on" : ""}">${icon(k)}<span>${l}</span></a>`).join("")}</div>` : "";
  $("#user").innerHTML = on ? `<div class="sf-user"><span class="sf-av">${esc(state.user.email.charAt(0).toUpperCase())}</span>
    <span class="sf-mail" title="${esc(state.user.email)} · ${esc(state.user.role_label)}">${esc(state.user.email)}</span>
    <button id="logout" title="Se déconnecter" aria-label="Se déconnecter">${icon("out", 17)}</button></div>` : "";
  $("#logout")?.addEventListener("click", async () => { await api("POST", "/api/logout"); state.user = null; location.hash = "#/"; route(); });
  $("#crumb").innerHTML = on && label ? `<strong>${esc(label)}</strong>` : "";
  $("#srv-name").textContent = state.server?.name || "Serveur Callikoe";
  document.title = `${label ? label + " · " : ""}${state.server?.name || "Console du serveur"}`;
}
document.addEventListener("click", (e) => {
  if (e.target.closest("#burger")) document.body.classList.toggle("side-open");
  else if (e.target.closest("#sidescrim") || e.target.closest("#nav a")) document.body.classList.remove("side-open");
  const c = e.target.closest("[data-copy]");
  if (c) copyText(c.dataset.copy).then((ok) => { const t = c.textContent; c.textContent = ok ? "Copié ✓" : "Sélectionne et copie à la main"; setTimeout(() => (c.textContent = t), 1800); });
});
// navigator.clipboard n'existe qu'en HTTPS : repli tant que la console est en HTTP (avant le certificat)
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* repli */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove(); return ok;
}
const formError = (form, err) => {
  form.querySelectorAll(".has-err").forEach((x) => x.classList.remove("has-err"));
  const msg = `<div class="flash bad">${esc(err?.message || "Erreur inattendue : recharge la page et réessaie.")}</div>`;
  const near = form.querySelector(".form-near"); if (near) near.innerHTML = msg;
  const box = form.querySelector(".form-msg"); if (box && !near) box.innerHTML = msg;
  const f = err?.field && form.querySelector(`[name="${err.field}"]`);
  if (f) { f.closest("label")?.classList.add("has-err"); f.focus(); } else (near || box)?.scrollIntoView({ block: "center" });
};
/** Formulaire : envoi par Entrée ou par le bouton, bouton bloqué pendant l'envoi, toute erreur affichée. */
function bindForm(form, handler) {
  const btn = form.querySelector("button.btn:not(.link):not(.ghost)");
  const run = async (e) => {
    e?.preventDefault?.();
    if (btn?.disabled) return;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Patiente…"; }
    form.querySelectorAll(".form-msg, .form-near").forEach((x) => (x.innerHTML = ""));
    try { await handler(Object.fromEntries(new FormData(form)), form); }
    catch (err) { console.error(err); formError(form, err); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
  };
  form.addEventListener("submit", run);
  if (btn) { btn.type = "button"; btn.addEventListener("click", run); }
}
// Œil pour afficher / masquer les mots de passe
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/></svg>';
function addPasswordEyes(root = document) {
  for (const input of root.querySelectorAll('input[type="password"]:not([data-eye])')) {
    input.dataset.eye = "1";
    const wrap = document.createElement("span"); wrap.className = "pw-wrap";
    input.replaceWith(wrap);
    const b = document.createElement("button");
    b.type = "button"; b.className = "pw-eye"; b.innerHTML = EYE; b.title = b.ariaLabel = "Afficher le mot de passe";
    b.addEventListener("click", (e) => { e.preventDefault(); const show = input.type === "password"; input.type = show ? "text" : "password";
      b.innerHTML = show ? EYE_OFF : EYE; b.title = b.ariaLabel = show ? "Masquer le mot de passe" : "Afficher le mot de passe"; input.focus(); });
    wrap.append(input, b);
  }
}
new MutationObserver(() => addPasswordEyes()).observe(document.body, { childList: true, subtree: true });
window.addEventListener("unhandledrejection", (e) => console.error("Callikoe :", e.reason));
const recoveryBox = (codes) => `<div class="warnbox"><strong>Codes de secours</strong> : à garder en lieu sûr (Psono). Chacun remplace une fois le code du téléphone.
  <pre class="code">${esc(codes.join("\n"))}</pre><button class="copy" data-copy="${esc(codes.join("\n"))}">Copier les codes</button></div>`;
const totpBlock = (t) => `<div class="totp"><div class="totp-qr">${t.qr}</div><div class="totp-steps"><ol>
  <li>Dans <strong>Psono</strong> (ou ton application) : nouvelle entrée <em>TOTP</em>, scanne ce QR code ou saisis la clé <code class="mono">${esc(t.secret.replace(/(.{4})/g, "$1 ").trim())}</code>.</li>
  <li>Tape le code à 6 chiffres affiché :</li></ol>
  <label>Code de vérification<input name="totp_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></label></div></div>`;

// ---------------------------------------------------------------- Première connexion
async function renderSetup() {
  setNav();
  let t;
  try { t = await api("POST", "/api/setup/totp"); }
  catch (e) { app.innerHTML = `<div class="wizard"><h1>Console du serveur</h1><div class="flash bad">${esc(e.message)}</div>
    <p class="hint">Ouvre l'adresse complète affichée à la fin de l'installation (avec « ?jeton=… »).</p></div>`; return; }
  app.innerHTML = `<div class="wizard"><h1>Bienvenue sur ${esc(state.server.name)}</h1>
    <p class="sub">Crée le compte <strong>super administrateur</strong> du serveur. Il pourra ensuite inviter les autres comptes IRT.</p>
    <div class="panel"><form id="sf" class="grid" novalidate><div class="form-msg full"></div>
      <label>Identifiant de connexion<input value="${esc(t.email)}" readonly autocomplete="username" name="login_email" style="background:var(--bg)">
        <span class="hint">C'est avec cet e-mail que tu te connecteras (choisi dans le portail).</span></label>
      <label>Ton nom<input name="name" maxlength="80" autocomplete="name"><span class="hint">Affiché dans la console et le journal ; ce n'est pas l'identifiant.</span></label>
      <label>Mot de passe<input type="password" name="password" autocomplete="new-password"><span class="hint">10 caractères minimum, lettres et chiffres.</span></label>
      <label>Confirmation<input type="password" name="confirm" autocomplete="new-password"></label>
      <div class="full">${totpBlock(t)}</div>
      <div class="form-near full"></div>
      <div class="actions"><button class="btn">Créer le compte</button></div></form></div></div>`;
  bindForm($("#sf"), async (f) => {
    if (f.password !== f.confirm) throw Object.assign(new Error("Les deux mots de passe sont différents."), { field: "confirm" });
    if (!/^\d{6}$/.test(String(f.totp_code || "").trim())) throw Object.assign(new Error("Tape le code à 6 chiffres affiché par Psono."), { field: "totp_code" });
    const r = await api("POST", "/api/setup/admin", { name: f.name, password: f.password, totp_code: String(f.totp_code).trim() });
    sessionStorage.removeItem("cxhub_setup");
    await loadState();
    $(".wizard .panel").innerHTML = `<div class="pad stack"><div class="flash">Compte créé. Identifiant : <strong>${esc(t.email)}</strong></div>${recoveryBox(r.recovery_codes)}<div class="actions"><a class="btn" href="#/">Ouvrir la console du serveur</a></div></div>`;
    $(".wizard .panel a.btn").onclick = (ev) => { ev.preventDefault(); location.hash = "#/"; route(); };
  });
}

// ---------------------------------------------------------------- Connexion
function renderLogin(ticket = null) {
  setNav();
  app.innerHTML = `<div class="login"><div class="panel"><div class="ph"><h2>${esc(state.server.name)}</h2></div>
    <form id="login">${takeFlash()}
      ${ticket ? `<p class="hint" style="margin:0">Tape le code à 6 chiffres de Psono (ou de ton application). Code perdu : utilise un code de secours.</p>
        <label>Code de double authentification<input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus placeholder="123456"></label>
        <button class="btn">Valider</button><button type="button" class="btn link" id="back">Recommencer</button>`
      : `<p class="hint" style="margin:0">Console du serveur multi-tenant : comptes IRT uniquement. Les clients se connectent à l'adresse de leur PBX.</p>
        <label>E-mail (identifiant)<input type="email" name="email" autocomplete="username" required autofocus></label>
        <label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn">Se connecter</button>`}</form></div></div>`;
  $("#back")?.addEventListener("click", () => renderLogin());
  bindForm($("#login"), async (f) => {
    try {
      if (ticket) { await api("POST", "/api/login/totp", { ticket, code: f.code }); await loadState(); route(); return; }
      const r = await api("POST", "/api/login", f);
      renderLogin(r.ticket);
    } catch (err) { flash = { cls: "bad", text: err.message }; renderLogin(ticket); }
  });
}

async function renderInvite(token) {
  setNav();
  let inv;
  try { inv = await api("GET", `/api/invite/${token}`); } catch (e) { app.innerHTML = `<div class="wizard"><div class="flash bad">${esc(e.message)}</div></div>`; return; }
  app.innerHTML = `<div class="wizard"><h1>Bienvenue${inv.name ? " " + esc(inv.name) : ""}</h1>
    <p class="sub">Identifiant de connexion : <strong>${esc(inv.email)}</strong> · ${esc(inv.role)}. Choisis ton mot de passe et active la double authentification.</p>
    <div class="panel"><form id="invf" class="grid" novalidate><div class="form-msg full"></div>
      <label>Mot de passe<input type="password" name="password" autocomplete="new-password"><span class="hint">10 caractères minimum, lettres et chiffres.</span></label>
      <label>Confirmation<input type="password" name="confirm" autocomplete="new-password"></label>
      <div class="full">${totpBlock(inv)}</div>
      <div class="form-near full"></div>
      <div class="actions"><button class="btn">Activer mon compte</button></div></form></div></div>`;
  bindForm($("#invf"), async (f) => {
    if (f.password !== f.confirm) throw Object.assign(new Error("Les deux mots de passe sont différents."), { field: "confirm" });
    const r = await api("POST", `/api/invite/${token}`, { password: f.password, totp_code: String(f.totp_code || "").trim() });
    await loadState();
    $(".wizard .panel").innerHTML = `<div class="pad stack">${recoveryBox(r.recovery_codes)}<div class="actions"><a class="btn" href="#/">Ouvrir la console du serveur</a></div></div>`;
  });
}

// ---------------------------------------------------------------- PBX clients (vue globale, recherche)
let pbxFilter = "";
async function renderList() {
  setNav("pbx", "PBX clients");
  let d;
  try { d = await api("GET", "/api/pbx"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const pill = (s, l) => `<span class="pill ${s === "active" ? "ok" : s === "activating" ? "wait" : "bad"}">${l} ${s === "active" ? "actif" : s === "activating" ? "démarre" : "arrêté"}</span>`;
  const draw = () => {
    const q = pbxFilter.trim().toLowerCase();
    const list = d.pbx.filter((p) => !q || [p.name, p.slug, p.fqdn].join(" ").toLowerCase().includes(q));
    $("#cards").innerHTML = list.length ? list.map((p) => `<a class="pbx-card" href="/ouvrir/${encodeURIComponent(p.slug)}" title="Ouvrir la console de ce PBX">
        <strong>${esc(p.name)}</strong><span class="mono">${esc(p.fqdn)}</span><span class="hint">${esc(p.slug)} · n°${p.n}</span>
        <span class="row">${pill(p.engine, "Moteur")}${pill(p.console, "Console")}</span></a>`).join("")
      : `<div class="empty" style="grid-column:1/-1">${d.pbx.length ? "Aucun PBX ne correspond à la recherche." : `Aucun PBX sur ce serveur pour l'instant.${can("super", "admin") ? ` <a href="#/nouveau">Créer le premier PBX</a>` : ""}`}</div>`;
    $("#count").textContent = `${list.length} sur ${d.pbx.length} PBX (${d.max} au maximum)`;
  };
  app.innerHTML = takeFlash() + `<div class="bar"><div class="grow"><h1>PBX clients</h1>
      <p class="sub" style="margin:0">Clique sur un PBX pour ouvrir sa console, sans te reconnecter.</p></div>
      ${can("super", "admin") ? `<a class="btn" href="#/nouveau">+ Nouveau PBX</a>` : ""}</div>
    <div class="panel pad stack"><label>Rechercher<input id="q" type="search" placeholder="Nom, adresse, identifiant…" value="${esc(pbxFilter)}" autocomplete="off"></label>
      <div class="hint" id="count"></div><div class="pbx-grid" id="cards"></div></div>`;
  $("#q").oninput = (e) => { pbxFilter = e.target.value; draw(); };
  draw();
}

// ---------------------------------------------------------------- Nouveau PBX
const toSlug = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/--+/g, "-").slice(0, 24).replace(/-+$/, "");
function renderNew() {
  setNav("add", "Nouveau PBX");
  app.innerHTML = `<h1>Nouveau PBX</h1>
    <p class="sub">Crée d'abord le PBX dans le portail (licence, adresse), puis dépose ici son <strong>pbx-config.json</strong> ou colle le texte copié depuis le portail.</p>
    <div class="panel"><form id="nf" class="stack pad" novalidate><div class="form-msg"></div>
      <div class="drop" id="drop">Dépose <strong>pbx-config.json</strong> ici, ou <label style="display:inline;color:var(--accent);cursor:pointer">choisis le fichier<input type="file" accept=".json" id="file" hidden></label></div>
      <label>Ou colle le texte du portail<textarea name="config" rows="4" spellcheck="false" placeholder="eyJ2ZXJzaW9uIjox… ou { &quot;version&quot;: 1, … }"></textarea></label>
      <div id="summary"></div>
      <label>Nom sur le serveur<input name="slug" maxlength="24" spellcheck="false" autocapitalize="off" placeholder="boulangerie-dupont"><span class="hint">Identifiant technique : minuscules, chiffres et tirets.</span></label>
      <div class="actions"><button class="btn">Créer le PBX</button></div></form></div>
    <div id="job"></div>`;
  const form = $("#nf");
  const parse = (txt) => { const s = txt.trim(); try { return JSON.parse(s.startsWith("{") ? s : decodeURIComponent(escape(atob(s.replace(/\s+/g, ""))))); } catch { return null; } };
  const show = () => {
    const c = parse(form.config.value);
    $("#summary").innerHTML = c?.pbx ? `<div class="note">PBX <strong>${esc(c.pbx.name)}</strong> · ${esc(c.pbx.company || "")} · <span class="mono">${esc(c.pbx.fqdn)}</span> · licence ${esc(c.license?.key || "")}</div>` : "";
    if (c?.pbx && !form.slug.dataset.touched) form.slug.value = toSlug(/\.callikoe\.(fr|com)$/.test(c.pbx.fqdn) ? c.pbx.fqdn.split(".")[0] : c.pbx.company || c.pbx.name);
  };
  form.config.oninput = show;
  form.slug.oninput = () => (form.slug.dataset.touched = "1");
  const load = async (file) => { form.config.value = await file.text(); show(); };
  $("#file").onchange = (e) => e.target.files[0] && load(e.target.files[0]);
  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("on"); };
  drop.ondragleave = () => drop.classList.remove("on");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("on"); e.dataTransfer.files[0] && load(e.dataTransfer.files[0]); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button"); btn.disabled = true;
    try {
      const job = await api("POST", "/api/pbx", { slug: form.slug.value, config: form.config.value });
      form.closest(".panel").hidden = true;
      followJob(job.id, (j) => j.ok ? `<div class="actions"><a class="btn" href="/ouvrir/${encodeURIComponent(form.slug.value)}">Ouvrir la console du PBX</a><a class="btn ghost" href="#/">Tous les PBX</a></div>`
        : `<div class="actions"><a class="btn ghost" href="#/nouveau" onclick="location.reload()">Réessayer</a></div>`);
    } catch (err) { btn.disabled = false; formError(form, err); }
  };
}
async function followJob(id, after) {
  const box = $("#job");
  for (;;) {
    let j; try { j = await api("GET", `/api/jobs/${id}`); } catch (e) { box.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
    box.innerHTML = `<div class="panel"><div class="ph"><h2>${esc(j.label)}</h2><span class="pill ${j.running ? "wait" : j.ok ? "ok" : "bad"}">${j.running ? "En cours" : j.ok ? "Terminé" : "Échec"}</span></div>
      <div class="pad stack"><div class="joblog">${esc(j.lines.join("\n")) || "…"}</div>${j.running ? "" : after(j)}</div></div>`;
    if (!j.running) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---------------------------------------------------------------- Comptes du serveur
async function renderAccounts() {
  setNav("users", "Comptes du serveur");
  let d; try { d = await api("GET", "/api/accounts"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const opts = (cur) => Object.entries(d.roles).map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
  app.innerHTML = takeFlash() + `<h1>Comptes du serveur</h1>
    <p class="sub">Comptes IRT : ils voient tous les PBX du serveur selon leur rôle. Les comptes des clients se créent dans la console de chaque PBX (Administration › Comptes).</p>
    <div class="panel"><div class="table-wrap"><table><thead><tr><th>Compte</th><th>Rôle</th><th>Dernière connexion</th><th></th></tr></thead><tbody>
      ${d.accounts.map((a) => `<tr><td><strong>${esc(a.name || a.email)}</strong><div class="hint">${esc(a.email)}</div></td>
        <td>${a.email === state.user.email ? esc(d.roles[a.role]) : `<select data-role="${esc(a.email)}">${opts(a.role)}</select>`}</td>
        <td>${fmtDate(a.last_login_at)}</td>
        <td>${a.email === state.user.email ? `<span class="hint">toi</span>` : `<button class="btn danger sm" data-del="${esc(a.email)}">Supprimer</button>`}</td></tr>`).join("")}
      ${d.invites.map((i) => `<tr><td><strong>${esc(i.name || i.email)}</strong><div class="hint">${esc(i.email)}</div></td><td>${esc(d.roles[i.role])}</td>
        <td><span class="pill wait">Invitation jusqu'au ${fmtDate(i.expires_at)}</span></td><td></td></tr>`).join("")}
    </tbody></table></div></div>
    <div class="panel" style="margin-top:20px"><div class="ph"><h2>Inviter un compte</h2></div>
      <form id="af" class="grid pad" novalidate><div class="form-msg full"></div>
        <label>E-mail<input type="email" name="email" autocomplete="off"></label>
        <label>Nom<input name="name" maxlength="80"></label>
        <label>Rôle<select name="role">${opts("tech")}</select></label>
        <div class="actions full"><button class="btn">Créer le lien d'invitation</button></div></form><div id="invlink"></div></div>`;
  $("#af").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/accounts", Object.fromEntries(new FormData(e.target)));
      const link = location.origin + r.path;
      $("#invlink").innerHTML = `<div class="pad"><div class="note">Envoie ce lien à la personne (valable ${r.expires_in_hours} h, une seule fois) :
        <pre class="code">${esc(link)}</pre><button class="copy" data-copy="${esc(link)}">Copier le lien</button></div></div>`;
    } catch (err) { formError(e.target, err); }
  };
  app.querySelectorAll("[data-role]").forEach((s) => (s.onchange = async () => {
    try { await api("PUT", `/api/accounts/${encodeURIComponent(s.dataset.role)}`, { role: s.value }); flash = { text: "Rôle modifié." }; } catch (e) { flash = { cls: "bad", text: e.message }; }
    renderAccounts();
  }));
  app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Supprimer le compte ${b.dataset.del} ? Il perd aussitôt l'accès à tous les PBX.`)) return;
    try { await api("DELETE", `/api/accounts/${encodeURIComponent(b.dataset.del)}`); flash = { text: "Compte supprimé." }; } catch (e) { flash = { cls: "bad", text: e.message }; }
    renderAccounts();
  }));
}

async function renderAudit() {
  setNav("log", "Journal");
  let d; try { d = await api("GET", "/api/audit"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  app.innerHTML = `<h1>Journal du serveur</h1><p class="sub">Connexions, ouvertures de PBX, créations et suppressions (300 dernières actions).</p>
    <div class="panel"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Compte</th><th>Action</th><th>IP</th></tr></thead><tbody>
    ${d.entries.map((x) => `<tr><td>${fmtDate(x.at)}</td><td>${esc(x.email || "—")}</td><td><span class="pill ${x.ok ? "ok" : "bad"}">${x.ok ? "OK" : "Refusé"}</span> ${esc(x.action)}${x.detail ? `<div class="hint">${esc(x.detail)}</div>` : ""}</td><td class="mono">${esc(x.ip)}</td></tr>`).join("")}
    </tbody></table></div></div>`;
}

// ---------------------------------------------------------------- Routage
async function loadState() { Object.assign(state, await api("GET", "/api/state")); }
function route() {
  const h = location.hash || "#/";
  let m;
  if ((m = h.match(/^#\/invitation\/([0-9a-f]{48})$/))) return renderInvite(m[1]);
  if (state.setup_needed) return renderSetup();
  if (!state.user) return renderLogin();
  if (h === "#/nouveau" && can("super", "admin")) return renderNew();
  if (h === "#/comptes" && can("super")) return renderAccounts();
  if (h === "#/journal" && can("super", "admin")) return renderAudit();
  return renderList();
}
window.addEventListener("hashchange", route);
loadState().then(route).catch((e) => { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; });
