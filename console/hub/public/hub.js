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
  call: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  phone: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M10 18h4"/>',
  trunk: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="16" cy="17" r="1"/>',
  lic: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  sip: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9s1.3-6.3 3.8-9z"/>',
  watch: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  paint: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.4-.9.1-2.2 1.3-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="14.5" cy="7" r="1.2"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7"/><path d="M4 4v4.7h4.7"/><path d="M12 8v4l3 2"/>',
};
const icon = (k, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ""}</svg>`;
const can = (...roles) => roles.includes(state.user?.role);

function setNav(active, label = "") {
  const on = !!state.user;
  document.body.classList.toggle("no-side", !on);
  document.body.classList.remove("side-open");
  const items = [["#/", "Tableau de bord", "pbx"], ...(can("super", "admin") ? [["#/nouveau", "Nouveau PBX", "add"], ["#/restaurer", "Restaurer un PBX", "restore"]] : []), ["#/licences", "Licences", "lic"]];
  // Paramètres : regroupés dans un menu repliable (ouvert quand on est sur une de ses pages)
  const settings = [...(can("super") ? [["#/comptes", "Comptes du serveur", "users"], ["#/cle", "Clé de signature", "key"]] : []), ["#/apparence", "Apparence", "paint"], ["#/surveillance", "Surveillance", "watch"],
    ["#/protection", "Protection anti-intrusion", "shield"], ["#/pays", "IP Pays autorisés", "globe"], ["#/telephonie", "Logs d'erreur", "sip"], ...(can("super", "admin") ? [["#/journal", "Journal", "log"]] : [])];
  const link = ([h, l, k]) => `<a href="${h}" class="${k === active ? "on" : ""}">${icon(k)}<span>${l}</span></a>`;
  let setOpen = settings.some(([, , k]) => k === active);
  try { if (!setOpen) setOpen = localStorage.getItem("cxhub_settings") === "1"; } catch { /* */ }
  $("#nav").innerHTML = on ? `<div class="ng">${items.map(link).join("")}</div>
    <details class="ng-set" ${setOpen ? "open" : ""}><summary>${icon("gear")}<span>Paramètres</span></summary><div class="ng">${settings.map(link).join("")}</div></details>` : "";
  $("#nav .ng-set")?.addEventListener("toggle", (e) => { try { localStorage.setItem("cxhub_settings", e.target.open ? "1" : "0"); } catch { /* */ } });
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

// ---------------------------------------------------------------- Tableau de bord + PBX clients (vue globale, recherche)
let pbxFilter = "", pbxStatus = "", listTimer = null, pbxSort = { k: "name", dir: 1 };
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const kpi = (ic, k, v, s, cls = "") => `<div class="kpi ${cls}"><span class="kpi-ic">${icon(ic, 20)}</span><div><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div></div>`;
function pbxState(p) {
  if (p.suspended) return ["off", "Désactivé"];
  if (p.engine === "active") return ["ok", "En ligne"];
  if (p.engine === "activating") return ["wait", "Démarre"];
  return ["bad", "Hors ligne"];
}
async function renderList() {
  setNav("pbx", "Tableau de bord");
  clearInterval(listTimer);
  let d;
  try { d = await api("GET", "/api/pbx"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const t = d.totals || {};
  const dash = () => `<div class="kpis">
      ${kpi("pbx", "PBX", `${t.online ?? 0} <small>/ ${t.pbx ?? 0} en ligne</small>`, `${t.offline ? `<span style="color:var(--bad)">${t.offline} hors ligne</span>` : "0 hors ligne"} · ${t.suspended || 0} désactivé${t.suspended > 1 ? "s" : ""}`, t.offline ? "warn" : "good")}
      ${kpi("call", "Appels en cours", `${t.calls ?? 0} <small>/ ${t.max_calls ?? 0}</small>`, "appels simultanés autorisés (total des licences)")}
      ${kpi("phone", "Postes connectés", `${t.phones_online ?? 0} <small>/ ${t.phones ?? 0}</small>`, "téléphones et softphones enregistrés")}
      ${kpi("trunk", "Trunks", `${t.trunks_ok ?? 0} <small>/ ${t.trunks ?? 0}</small>`, "enregistrés chez l'opérateur", t.trunks && t.trunks_ok < t.trunks ? "warn" : "good")}
      <a href="#/licences" class="kpi-link">${kpi("lic", "Licences", `${t.expiring || 0}`, "expirent dans moins de 30 jours", t.expiring ? "warn" : "good")}</a>
    </div>`;
  // Liste en tableau (prévue pour beaucoup de PBX) : « Ouvrir » + menu « ⋯ » pour le reste
  const SORTS = { name: (p) => p.name.toLowerCase(), state: (p) => ["ok", "wait", "bad", "off"].indexOf(pbxState(p)[0]), calls: (p) => -(p.calls || 0),
    phones: (p) => -(p.phones_online || 0), lic: (p) => p.expires_at ? Date.parse(p.expires_at) : Infinity };
  const th = (k, l, cls = "") => `<th class="${cls}"><button type="button" class="sorth ${pbxSort.k === k ? "on" : ""}" data-sort="${k}">${l}${pbxSort.k === k ? (pbxSort.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
  const row = (p) => {
    const [cls, label] = pbxState(p);
    const exp = p.expires_at ? Date.parse(p.expires_at) - Date.now() : null;
    const menu = [
      !p.suspended && can("super", "admin", "tech") ? `<a href="/ouvrir/${encodeURIComponent(p.slug)}?page=sauvegardes">Sauvegardes</a>` : "",
      can("super", "admin") ? `<a href="/api/pbx/${encodeURIComponent(p.slug)}/config">Télécharger la configuration</a>` : "",
      can("super", "admin") ? (p.suspended ? `<button type="button" data-react="${esc(p.slug)}">Réactiver</button>` : `<button type="button" data-susp="${esc(p.slug)}">Désactiver</button>`) : "",
      can("super", "admin") ? `<hr><button type="button" class="danger" data-del="${esc(p.slug)}">Supprimer…</button>` : "",
    ].join("");
    return `<tr class="${p.suspended ? "off" : ""}">
      <td class="pn"><strong>${esc(p.name)}</strong><span class="mono">${esc(p.fqdn)}</span>${p.company && p.company !== p.name ? `<span class="s">${esc(p.company)}</span>` : ""}</td>
      <td data-l="État"><span class="pill ${cls}">${label}</span></td>
      <td data-l="Appels" title="Appels en cours / appels simultanés">${p.calls || 0}<span class="s"> / ${p.max_calls || "—"}</span></td>
      <td data-l="Postes" title="Postes connectés / postes">${p.phones_online || 0}<span class="s"> / ${p.phones || 0}</span></td>
      <td data-l="Trunks" class="${p.trunks && p.trunks_ok < p.trunks ? "warnc" : ""}" title="Trunks enregistrés / trunks">${p.trunks_ok || 0}<span class="s"> / ${p.trunks || 0}</span></td>
      <td data-l="Licence" class="${exp !== null && exp < 30 * 86400000 ? "warnc" : ""}">${fmtDay(p.expires_at)}${p.edition ? `<span class="s">${esc(({ basic: "Basic", pro: "Essentiel", enterprise: "Intégral" })[p.edition] || p.edition)}</span>` : ""}</td>
      <td class="pa">${p.suspended ? "" : `<a class="btn sm" href="/ouvrir/${encodeURIComponent(p.slug)}">Ouvrir</a>`}
        ${menu ? `<span class="more"><button type="button" class="btn ghost sm" data-more aria-label="Plus d'actions" title="Plus d'actions">⋯</button><span class="more-menu" hidden>${menu}</span></span>` : ""}</td></tr>`;
  };
  const draw = () => {
    const q = pbxFilter.trim().toLowerCase();
    const list = d.pbx.filter((p) => (!q || [p.name, p.slug, p.fqdn, p.company, p.license].join(" ").toLowerCase().includes(q))
      && (!pbxStatus || pbxState(p)[0] === pbxStatus));
    $("#dash").innerHTML = dash();
    const f = SORTS[pbxSort.k] || SORTS.name;
    list.sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * pbxSort.dir || a.name.localeCompare(b.name); });
    $("#cards").innerHTML = list.length ? `<div class="table-wrap"><table class="pbxt"><thead><tr>${th("name", "PBX")}${th("state", "État")}${th("calls", "Appels")}${th("phones", "Postes")}<th>Trunks</th>${th("lic", "Licence")}<th></th></tr></thead>
        <tbody>${list.map(row).join("")}</tbody></table></div>`
      : `<div class="empty">${d.pbx.length ? "Aucun PBX ne correspond à la recherche." : `Aucun PBX sur ce serveur pour l'instant.${can("super", "admin") ? ` <a href="#/nouveau">Créer le premier PBX</a>` : ""}`}</div>`;
    $("#count").textContent = `${list.length} sur ${d.pbx.length} PBX (${d.max} au maximum)`;
  };
  app.innerHTML = takeFlash() + `<div class="bar"><div class="grow"><h1>Tableau de bord</h1>
      <p class="sub" style="margin:0">Tous les PBX du serveur. « Ouvrir » ouvre la console d'un PBX sans te reconnecter.</p></div>
      ${can("super", "admin") ? `<a class="btn ghost" href="#/restaurer">Restaurer un PBX</a><a class="btn" href="#/nouveau">+ Nouveau PBX</a>` : ""}</div>
    ${d.watch_pending ? `<div class="flash warn">${d.watch_pending} événement${d.watch_pending > 1 ? "s" : ""} à vérifier (appels vers l'étranger ou surtaxés, appareils connectés depuis une nouvelle adresse) : <a href="#/surveillance">Surveillance</a>.</div>` : ""}
    ${!d.signing?.configured && can("super") ? `<div class="flash warn">Pour créer des PBX ici, installe d'abord la clé de signature des licences : <a href="#/cle">Clé de signature</a>.</div>` : ""}
    <div id="dash"></div>
    <div class="panel pad stack">
      <div class="row" style="gap:12px;align-items:flex-end">
        <label style="flex:1;min-width:220px">Rechercher<input id="q" type="search" placeholder="Nom, entreprise, adresse, licence…" value="${esc(pbxFilter)}" autocomplete="off"></label>
        <label>État<select id="st"><option value="">Tous</option><option value="ok">En ligne</option><option value="bad">Hors ligne</option><option value="off">Désactivés</option></select></label>
      </div>
      <div class="hint" id="count"></div></div>
    <div class="panel" id="cards"></div>`;
  $("#st").value = pbxStatus;
  $("#q").oninput = (e) => { pbxFilter = e.target.value; draw(); };
  $("#st").onchange = (e) => { pbxStatus = e.target.value; draw(); };
  app.onclick = async (e) => {
    const srt = e.target.closest("[data-sort]");
    if (srt) { const k = srt.dataset.sort; pbxSort = { k, dir: pbxSort.k === k ? -pbxSort.dir : 1 }; draw(); return; }
    const mb = e.target.closest("[data-more]");
    const open = app.querySelector(".more-menu:not([hidden])");
    if (open && (!mb || open.previousElementSibling !== mb)) open.hidden = true;
    if (mb) { const m = mb.nextElementSibling; m.hidden = !m.hidden; m.classList.toggle("up", mb.getBoundingClientRect().bottom + 200 > innerHeight); return; }
    const del = e.target.closest("[data-del]");
    if (del) {
      const slug = del.dataset.del;
      const conf = prompt(`Supprimer définitivement le PBX « ${slug} » (utilisateurs, messages, enregistrements) ?\nFais d'abord une sauvegarde. Pour confirmer, tape son nom : ${slug}`);
      if (conf === null) return;
      const code = prompt("Code de double authentification (Psono) :");
      if (code === null) return;
      try { const j = await api("DELETE", `/api/pbx/${encodeURIComponent(slug)}`, { confirm: conf.trim(), code: code.trim() }); app.innerHTML = `<div id="job"></div>`;
        followJob(j.id, () => `<div class="actions"><a class="btn" href="#/" onclick="setTimeout(()=>location.reload(),50)">Retour au tableau de bord</a></div>`); }
      catch (err) { flash = { cls: "bad", text: err.message }; renderList(); }
      return;
    }
    const s = e.target.closest("[data-susp]"), r = e.target.closest("[data-react]");
    if (!s && !r) return;
    const slug = (s || r).dataset.susp || (s || r).dataset.react;
    if (s && !confirm(`Désactiver le PBX « ${slug} » ? Ses téléphones et ses appels s'arrêtent ; ses données sont gardées.`)) return;
    try { const j = await api("POST", `/api/pbx/${encodeURIComponent(slug)}/${s ? "suspendre" : "reactiver"}`); app.innerHTML = `<div id="job"></div>`;
      followJob(j.id, () => `<div class="actions"><a class="btn" href="#/" onclick="setTimeout(()=>location.reload(),50)">Retour au tableau de bord</a></div>`); }
    catch (err) { flash = { cls: "bad", text: err.message }; renderList(); }
  };
  draw();
  // Mise à jour toutes les 15 s tant que la page est affichée
  listTimer = setInterval(async () => {
    if (location.hash && location.hash !== "#/") return clearInterval(listTimer);
    if (app.querySelector(".more-menu:not([hidden])")) return;
    try { d = await api("GET", "/api/pbx"); Object.assign(t, d.totals); draw(); } catch { /* prochain essai */ }
  }, 15000);
}

// ---------------------------------------------------------------- Nouveau PBX (licence créée et signée ici)
const toSlug = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/--+/g, "-").slice(0, 24).replace(/-+$/, "");
function importPanel() {
  return `<div class="panel" id="imp">
      <form id="if" class="stack pad" novalidate><div class="form-msg"></div>
        <p class="hint" style="margin:0">Sauvegarde faite depuis la console du PBX (Administration › Sauvegardes) : fichier <code>pbxmaison-….tar.gz</code>. Utilisateurs, trunks, messages, comptes et licence reviennent tels quels.</p>
        <label>Fichier de sauvegarde<input type="file" name="file" accept=".gz,.tgz,application/gzip"></label>
        <label>Nom sur le serveur<input name="slug" maxlength="24" spellcheck="false" autocapitalize="off" placeholder="boulangerie-dupont"></label>
        <div class="form-near"></div>
        <div class="actions"><button class="btn">Restaurer le PBX</button></div></form></div>`;
}
function bindImport() {
  const imp = $("#if");
  imp.file.addEventListener("change", () => { const n = imp.file.files[0]?.name || ""; if (!imp.slug.value) imp.slug.value = toSlug(n.replace(/^pbxmaison-|\.tar\.gz$|\.tgz$/g, "").replace(/-?\d{8}-\d{6}$/, "")).slice(0, 24); });
  bindForm(imp, async (f) => {
    const file = imp.file.files[0];
    if (!file) throw Object.assign(new Error("Choisis le fichier de sauvegarde."), { field: "file" });
    const res = await fetch(`/api/pbx/import?slug=${encodeURIComponent(String(f.slug || "").trim().toLowerCase())}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { field: data.field });
    $("#imp").hidden = true; const nfp = $("#nf")?.closest(".panel"); if (nfp) nfp.hidden = true;
    followJob(data.id, (j) => j.ok ? `<div class="actions"><a class="btn" href="/ouvrir/${encodeURIComponent(String(f.slug).trim().toLowerCase())}">Ouvrir la console du PBX</a><a class="btn ghost" href="#/">Tableau de bord</a></div>`
      : `<div class="actions"><a class="btn ghost" href="#/nouveau" onclick="setTimeout(()=>location.reload(),50)">Réessayer</a></div>`);
  });
}
function renderRestore() {
  setNav("restore", "Restaurer un PBX");
  app.innerHTML = `<h1>Restaurer un PBX</h1>
    <p class="sub">Remet sur ce serveur un PBX à partir de sa sauvegarde : PBX installé seul sur un autre VPS, ou PBX supprimé de ce serveur.
    Pour restaurer un PBX déjà présent, utilise plutôt le bouton « Sauvegardes » de sa carte.</p>
    ${importPanel()}<div id="job"></div>`;
  bindImport();
}
async function renderNew() {
  setNav("add", "Nouveau PBX");
  let o; try { o = await api("GET", "/api/pbx/options"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  if (!o.signing.configured) {
    app.innerHTML = `<h1>Nouveau PBX</h1><div class="panel pad stack"><div class="flash warn" style="margin:0">La clé de signature des licences n'est pas encore installée sur ce serveur.</div>
      ${can("super") ? `<p>Installe-la une fois (fichier <code>pbx-cle-privee.pem</code> rangé dans Psono) : <a class="btn sm" href="#/cle">Clé de signature</a></p>` : `<p>Demande au super administrateur de l'installer.</p>`}</div>
      <div id="job"></div>`;
    return;
  }
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(l)}</option>`).join("");
  let free = []; try { free = (await api("GET", "/api/licenses")).licenses.filter((l) => l.available); } catch { free = []; }
  const wanted = new URLSearchParams(location.hash.split("?")[1] || "").get("licence");
  app.innerHTML = `<h1>Nouveau PBX</h1>
    <p class="sub">La licence est créée et signée ici (ou prise parmi les licences disponibles) ; le PBX est prêt en environ une minute.</p>
    <div class="panel"><form id="nf" class="grid" novalidate><div class="form-msg full"></div>
      <fieldset><legend>Client</legend>
        <label>Nom du PBX<input name="name" maxlength="80" placeholder="Standard Boulangerie Dupont" autofocus></label>
        <label>Nom de l'entreprise<input name="company" maxlength="120" placeholder="Boulangerie Dupont SARL"></label>
        <label>Numéro de téléphone<input name="phone" type="tel" placeholder="04 12 34 56 78"><span class="hint">Numéro principal de l'entreprise.</span></label>
        <label>Adresse du PBX<div class="addr"><input name="label" placeholder="boulangerie-dupont" autocapitalize="off" spellcheck="false" maxlength="42">
          <select name="domain">${o.domains.map((dm) => `<option value="${dm}">.${dm}</option>`).join("")}<option value="custom">Autre (FQDN personnalisé)</option></select></div>
          <input name="fqdn" placeholder="pbx.domaine-du-client.fr" autocapitalize="off" spellcheck="false" hidden style="margin-top:8px">
          <span class="hint" id="addrhint">L'adresse est créée automatiquement, avec son certificat HTTPS.</span></label>
      </fieldset>
      <fieldset><legend>Région</legend>
        <label>Pays<select name="country">${opt(o.countries.map((c) => [c.code, `${c.name} (+${c.dial})`]), "FR")}</select></label>
        <label>Fuseau horaire<select name="timezone">${opt(o.timezones.map((z) => [z, z]), "Europe/Paris")}</select></label>
        <label>Langue<select name="language">${opt(Object.entries(o.languages), "fr")}</select></label>
      </fieldset>
      <fieldset><legend>Licence</legend>
        <div class="seg lic-mode">${o.signing.portal ? "" : `<label class="on"><input type="radio" name="license_mode" value="new" checked>Nouvelle licence</label>`}<label class="${free.length ? "" : "dim"}"><input type="radio" name="license_mode" value="existing" ${free.length ? "" : "disabled"}>Licence dispo${free.length ? ` <span class="cnt">${free.length}</span>` : ""}</label></div>
        <div class="stack lic-new">
          <label>Édition<select name="edition">${opt(Object.entries(o.editions), "pro")}</select></label>
          <label>Appels simultanés<select name="simultaneous_calls">${opt(o.sc.map((n) => [n, `${n} appels`]), 8)}</select></label>
          <label>Durée<select name="duration_months">${opt(Object.entries(o.durations), 12)}</select></label>
        </div>
        <div class="stack lic-old" hidden>
          <label>Licence disponible<select name="license_key">${free.map((l) => `<option value="${esc(l.key)}">${esc(l.key)} · ${esc(o.editions[l.edition] || l.edition)} · ${l.simultaneous_calls} appels · jusqu'au ${fmtDay(l.expires_at)}${l.note ? " · " + esc(l.note) : ""}</option>`).join("")}</select>
          <span class="hint">Licences créées dans le menu Licences et attribuées à aucun PBX. Édition, appels et date d'expiration sont ceux de la licence.</span></label>
        </div>
        ${free.length ? "" : o.signing.portal ? `<div class="flash warn" style="margin:0">Aucune licence dispo : <a href="${esc(o.signing.buy_url)}" target="_blank" rel="noopener">achète des licences dans ton portail pro</a>, elles arrivent ici toutes seules.</div>`
          : `<span class="hint">Aucune licence disponible pour l'instant (menu <a href="#/licences">Licences</a>).</span>`}
      </fieldset>
      <fieldset><legend>Contact du client</legend>
        <label>E-mail du client<input name="admin_email" type="email" placeholder="contact@entreprise.fr" autocapitalize="off"><span class="hint">Pour les alertes du PBX. Les comptes de connexion se créent ensuite dans la console du PBX.</span></label>
        <label>Nom sur le serveur<input name="slug" maxlength="24" spellcheck="false" autocapitalize="off" placeholder="boulangerie-dupont"><span class="hint">Identifiant technique, rempli tout seul.</span></label>
      </fieldset>
      <div class="form-near full"></div>
      <div class="actions"><a class="btn ghost" href="#/">Annuler</a><button class="btn">Créer le PBX</button></div></form></div>
    <div id="job"></div>`;

  const form = $("#nf");
  if (o.signing.portal && free.length) form.querySelector('[value="existing"]').checked = true;
  const licMode = () => {
    const ex = (form.querySelector('[name="license_mode"]:checked')?.value || "existing") === "existing";
    form.querySelectorAll(".lic-mode label").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
    form.querySelector(".lic-new").hidden = ex; form.querySelector(".lic-old").hidden = !ex;
  };
  form.querySelectorAll('[name="license_mode"]').forEach((r) => r.addEventListener("change", licMode));
  if (o.signing.portal) licMode();
  if (wanted && free.some((l) => l.key === wanted)) { form.license_key.value = wanted; form.querySelector('[value="existing"]').checked = true; licMode(); }
  for (const k of ["label", "slug"]) form[k].addEventListener("keydown", () => { form[k].dataset.touched = "1"; });
  const auto = () => {
    const base = toSlug(form.company.value || form.name.value);
    if (!form.label.dataset.touched) form.label.value = base.slice(0, 42);
    if (!form.slug.dataset.touched) form.slug.value = (form.domain.value === "custom" ? base : toSlug(form.label.value)).slice(0, 24);
    check();
  };
  form.name.addEventListener("input", auto); form.company.addEventListener("input", auto);
  form.label.addEventListener("input", () => { if (!form.slug.dataset.touched) form.slug.value = toSlug(form.label.value); check(); });
  form.label.addEventListener("blur", () => { form.label.value = toSlug(form.label.value); });
  form.country.addEventListener("change", () => { const c = o.countries.find((x) => x.code === form.country.value); if (c) form.timezone.value = c.tz; });
  let timer = null, seq = 0;
  function check() {
    clearTimeout(timer);
    const custom = form.domain.value === "custom";
    form.fqdn.hidden = !custom; form.label.hidden = custom; form.label.disabled = custom;
    const h = $("#addrhint");
    const fqdn = custom ? form.fqdn.value.trim().toLowerCase() : (toSlug(form.label.value) ? `${toSlug(form.label.value)}.${form.domain.value}` : "");
    if (!fqdn) { h.className = "hint"; h.textContent = custom ? "Le DNS de ce nom devra pointer vers l'IP du serveur." : "L'adresse est créée automatiquement, avec son certificat HTTPS."; return; }
    h.className = "hint"; h.textContent = `${fqdn} : vérification…`;
    const my = ++seq;
    timer = setTimeout(async () => {
      try {
        const r = await api("GET", `/api/fqdn-check?fqdn=${encodeURIComponent(fqdn)}`);
        if (my !== seq) return;
        h.className = r.available ? "ok-text" : r.available === null ? "hint" : "err";
        h.textContent = r.available ? (r.custom ? `✔ ${fqdn} : fais pointer son DNS vers l'IP du serveur` : `✔ ${fqdn} est disponible`) : `${r.available === null ? "⚠" : "✖"} ${r.reason || "déjà utilisée"}`;
      } catch { /* ignoré */ }
    }, 350);
  }
  form.domain.addEventListener("change", () => { auto(); });
  form.fqdn.addEventListener("input", check);
  bindForm(form, async (f) => {
    f.domain = form.domain.value; f.label = toSlug(form.label.value);
    const job = await api("POST", "/api/pbx/new", f);
    form.closest(".panel").hidden = true;
    followJob(job.id, (j) => j.ok ? `<div class="actions"><a class="btn" href="/ouvrir/${encodeURIComponent(f.slug)}">Ouvrir la console du PBX</a><a class="btn ghost" href="#/">Tableau de bord</a></div>`
      : `<div class="actions"><a class="btn ghost" href="#/nouveau" onclick="setTimeout(()=>location.reload(),50)">Réessayer</a></div>`);
  });
}
// ---------------------------------------------------------------- Licences : liste, tri, filtres, création, renouvellement, attribution, suppression
const LIC_STATUS = { valide: ["ok", "À jour"], bientot: ["wait", "Expire bientôt"], expiree: ["bad", "Expirée"], revoquee: ["off", "Supprimée"] };
let licFilter = "", licQuery = "", licSort = { k: "exp", dir: 1 };
async function renderLicenses() {
  setNav("lic", "Licences");
  clearInterval(listTimer);
  let d;
  try { d = await api("GET", "/api/licenses"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const edit = can("super", "admin");
  const PM = !!d.signing?.portal, buy = d.signing?.buy_url || "", purl = d.signing?.portal_url || "";
  const L = d.licenses, P = Object.fromEntries(d.pbx.map((p) => [p.slug, p]));
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(l)}</option>`).join("");
  const days = (l) => Math.ceil((Date.parse(l.expires_at) - Date.now()) / 86400000);
  const FILTERS = [["", "Toutes", () => true], ["valide", "À jour", (l) => l.status === "valide"], ["bientot", "Expirent bientôt", (l) => l.status === "bientot"],
    ["expiree", "Expirées", (l) => l.status === "expiree"], ["dispo", "Disponibles", (l) => l.available], ["attribuee", "Attribuées", (l) => l.slug && !l.revoked_at],
    ["revoquee", "Supprimées", (l) => l.status === "revoquee"]];
  const SORTS = { key: (l) => l.key, pbx: (l) => (P[l.slug]?.name || l.slug || "~").toLowerCase(), ed: (l) => l.edition, sc: (l) => l.simultaneous_calls,
    exp: (l) => Date.parse(l.expires_at), st: (l) => ["bientot", "expiree", "valide", "revoquee"].indexOf(l.status) };
  const n = (f) => L.filter(FILTERS.find((x) => x[0] === f)[2]).length;
  const th = (k, l) => `<th><button type="button" class="sorth ${licSort.k === k ? "on" : ""}" data-sort="${k}">${l}${licSort.k === k ? (licSort.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
  const row = (l) => {
    const [cls, label] = LIC_STATUS[l.status] || ["off", l.status];
    const p = l.slug ? P[l.slug] : null;
    const dl = days(l);
    const menu = edit ? [
      !l.revoked_at ? (PM ? `<a href="${esc(purl)}/#/licences?renew=${encodeURIComponent(l.key)}" target="_blank" rel="noopener">Renouveler dans le portail pro ↗</a>`
        : `<button type="button" data-renew="${esc(l.key)}">Renouveler / modifier…</button>`) : "",
      l.available ? `<button type="button" data-assign="${esc(l.key)}">Attribuer à un PBX existant…</button><a href="#/nouveau?licence=${encodeURIComponent(l.key)}">Créer un PBX avec cette licence</a>` : "",
      `<button type="button" data-copy="${esc(l.key)}">Copier le numéro</button>`,
      `<hr><button type="button" class="danger" data-ldel="${esc(l.key)}">${l.slug && !l.revoked_at ? "Supprimer (désactive le PBX)…" : "Supprimer…"}</button>`,
    ].join("") : "";
    return `<tr class="${l.revoked_at ? "off" : ""}">
      <td class="lk"><strong class="mono">${esc(l.key)}</strong>${l.note ? `<span class="s">${esc(l.note)}</span>` : ""}</td>
      <td data-l="PBX">${p ? `<strong>${esc(p.name)}</strong><span class="s">${esc(p.fqdn || l.slug)}${p.suspended ? " · désactivé" : ""}</span>` : l.slug ? esc(l.slug) : `<span class="pill ok" style="background:var(--accent-soft);color:var(--accent)">Disponible</span>`}</td>
      <td data-l="Édition">${esc(d.editions[l.edition] || l.edition)}</td>
      <td data-l="Appels">${l.simultaneous_calls}</td>
      <td data-l="Expire" class="${l.status === "bientot" || l.status === "expiree" ? "warnc" : ""}">${fmtDay(l.expires_at)}<span class="s">${l.revoked_at ? `supprimée le ${fmtDay(l.revoked_at)}` : dl > 0 ? `dans ${dl} jour${dl > 1 ? "s" : ""}` : `depuis ${-dl} jour${dl < -1 ? "s" : ""}`}</span></td>
      <td data-l="État"><span class="pill ${cls}">${label}</span></td>
      <td class="pa">${menu ? `<span class="more"><button type="button" class="btn ghost sm" data-more aria-label="Actions" title="Actions">⋯</button><span class="more-menu" hidden>${menu}</span></span>` : ""}</td></tr>`;
  };
  const draw = () => {
    const q = licQuery.trim().toLowerCase();
    const fil = FILTERS.find((x) => x[0] === licFilter) || FILTERS[0];
    const list = L.filter((l) => fil[2](l) && (!q || [l.key, l.note, l.slug, P[l.slug]?.name, P[l.slug]?.company, P[l.slug]?.fqdn].join(" ").toLowerCase().includes(q)));
    const f = SORTS[licSort.k] || SORTS.exp;
    list.sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * licSort.dir || a.key.localeCompare(b.key); });
    $("#lfil").innerHTML = FILTERS.map(([k, lab]) => `<label class="${k === licFilter ? "on" : ""}"><input type="radio" name="lf" value="${k}" ${k === licFilter ? "checked" : ""}>${lab}<span class="cnt">${n(k)}</span></label>`).join("");
    $("#lrows").innerHTML = list.length ? `<div class="table-wrap"><table class="pbxt lict"><thead><tr>${th("key", "Licence")}${th("pbx", "PBX")}${th("ed", "Édition")}${th("sc", "Appels")}${th("exp", "Expire")}${th("st", "État")}<th></th></tr></thead>
      <tbody>${list.map(row).join("")}</tbody></table></div>` : `<div class="empty">${L.length ? "Aucune licence ne correspond." : "Aucune licence pour l'instant."}</div>`;
  };
  const form = (title, body, btn) => `<div class="panel" id="lform"><div class="ph"><h2>${title}</h2><button type="button" class="btn ghost sm" data-close>Fermer</button></div>
    <form class="stack pad" novalidate><div class="form-msg"></div>${body}<div class="form-near"></div><div class="actions"><button type="button" class="btn ghost" data-close>Annuler</button><button class="btn">${btn}</button></div></form></div>`;
  const licInputs = (cur = null) => `<div class="grid" style="padding:0">
      <label>Édition<select name="edition">${opt(Object.entries(d.editions), cur?.edition || "pro")}</select></label>
      <label>Appels simultanés<select name="simultaneous_calls">${opt(d.sc.map((x) => [x, `${x} appels`]), cur?.simultaneous_calls || 8)}</select></label>
      <label>${cur ? "Prolonger de" : "Durée"}<select name="duration_months">${opt([...(cur ? [[0, "Ne pas prolonger"]] : []), ...Object.entries(d.durations)], 12)}</select>
        ${cur ? `<span class="hint">Ajouté à la date d'expiration actuelle (${fmtDay(cur.expires_at)}), ou à aujourd'hui si elle est passée.</span>` : ""}</label>
      <label>Note<input name="note" maxlength="120" value="${esc(cur?.note || "")}" placeholder="Client, devis, commande…"></label></div>`;
  const openForm = (html, submit) => {
    $("#lslot").innerHTML = html; const f = $("#lslot form");
    $("#lslot").querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => ($("#lslot").innerHTML = "")));
    bindForm(f, async (vals) => { const msg = await submit(vals); flash = { cls: "", text: msg }; renderLicenses(); });
    $("#lslot").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const t = { all: L.length, ok: n("valide"), soon: n("bientot"), exp: n("expiree"), free: n("dispo") };
  app.innerHTML = takeFlash() + `<div class="bar"><div class="grow"><h1>Licences</h1>
      <p class="sub" style="margin:0">Toutes les licences des PBX du serveur. Une licence disponible peut servir pour un nouveau PBX ou remplacer celle d'un PBX existant.${PM ? ` Elles viennent de ton portail pro Callikoe${d.signing.partner ? ` (${esc(d.signing.partner)})` : ""} : achat, renouvellement et suppression y sont repris ici automatiquement.` : ""}</p></div>
      ${edit ? (PM ? `<a class="btn" href="${esc(buy)}" target="_blank" rel="noopener">+ Acheter des licences ↗</a>` : `<button type="button" class="btn" id="lnew">+ Nouvelle licence</button>`) : ""}</div>
    ${d.portal_error ? `<div class="flash warn">Portail pro : ${esc(d.portal_error)} (liste affichée telle qu'au dernier contact).</div>` : ""}
    ${!d.signing?.configured ? `<div class="flash warn">Clé de signature des licences non installée : création et renouvellement impossibles. ${can("super") ? `<a href="#/cle">Clé de signature</a>` : ""}</div>` : ""}
    <div class="kpis kpis5">
      ${kpi("lic", "Licences", `${t.all}`, `${n("attribuee")} attribuée${n("attribuee") > 1 ? "s" : ""} à un PBX`)}
      ${kpi("shield", "À jour", `${t.ok}`, "plus de 30 jours restants", "good")}
      ${kpi("watch", "Expirent bientôt", `${t.soon}`, "dans moins de 30 jours", t.soon ? "warn" : "good")}
      ${kpi("log", "Expirées", `${t.exp}`, "à renouveler", t.exp ? "warn" : "good")}
      ${kpi("add", "Disponibles", `${t.free}`, "attribuées à aucun PBX")}
    </div>
    <div id="lslot"></div>
    <div class="panel pad stack">
      <div class="row" style="gap:12px;align-items:flex-end;flex-wrap:wrap">
        <label style="flex:1;min-width:220px">Rechercher<input id="lq" type="search" placeholder="Numéro, PBX, client, note…" value="${esc(licQuery)}" autocomplete="off"></label>
      </div>
      <div class="seg" id="lfil"></div></div>
    <div class="panel" id="lrows"></div><div id="job"></div>`;
  $("#lq").oninput = (e) => { licQuery = e.target.value; draw(); };
  $("#lfil").onchange = (e) => { licFilter = e.target.value; draw(); };
  $("#lnew")?.addEventListener("click", () => openForm(form("Nouvelle licence", `${licInputs()}<p class="hint" style="margin:0">La licence est créée disponible : attribue-la ensuite à un PBX existant ou choisis-la en créant un PBX.</p>`, "Créer la licence"),
    async (v) => { const r = await api("POST", "/api/licenses", v); return `Licence ${r.key} créée (disponible).`; }));
  app.onclick = async (e) => {
    const srt = e.target.closest("[data-sort]");
    if (srt) { const k = srt.dataset.sort; licSort = { k, dir: licSort.k === k ? -licSort.dir : 1 }; draw(); return; }
    const mb = e.target.closest("[data-more]");
    const open = app.querySelector(".more-menu:not([hidden])");
    if (open && (!mb || open.previousElementSibling !== mb)) open.hidden = true;
    if (mb) { const m = mb.nextElementSibling; m.hidden = !m.hidden; m.classList.toggle("up", mb.getBoundingClientRect().bottom + 220 > innerHeight); return; }
    const get = (k) => L.find((l) => l.key === k);
    const rn = e.target.closest("[data-renew]");
    if (rn) {
      const l = get(rn.dataset.renew), p = l.slug ? P[l.slug] : null;
      openForm(form(`Renouveler ${esc(l.key)}`, `${p ? `<div class="flash" style="margin:0">Attribuée au PBX <strong>${esc(p.name)}</strong> : la nouvelle licence lui est envoyée tout de suite, sans coupure.</div>` : ""}${licInputs(l)}`, "Renouveler"),
        async (v) => { const r = await api("POST", `/api/licenses/${encodeURIComponent(l.key)}/renew`, v); return `Licence ${r.key} : jusqu'au ${fmtDay(r.expires_at)}${p ? `, appliquée au PBX ${p.name}` : ""}.`; });
      return;
    }
    const as = e.target.closest("[data-assign]");
    if (as) {
      const l = get(as.dataset.assign);
      const cur = (slug) => L.find((x) => x.slug === slug && !x.revoked_at);
      const choices = d.pbx.map((p) => [p.slug, `${p.name} (${p.fqdn || p.slug})${cur(p.slug) ? ` · remplace ${cur(p.slug).key}` : " · sans licence valide"}`]);
      if (!choices.length) { flash = { cls: "warn", text: "Aucun PBX sur ce serveur : crée un PBX avec cette licence." }; renderLicenses(); return; }
      openForm(form(`Attribuer ${esc(l.key)}`, `<label>PBX<select name="slug">${opt(choices, "")}</select>
        <span class="hint">La licence actuelle du PBX redevient disponible. Un PBX désactivé parce que sa licence a été supprimée pourra ensuite être réactivé.</span></label>`, "Attribuer"),
        async (v) => { const r = await api("POST", `/api/licenses/${encodeURIComponent(l.key)}/assign`, v); return `Licence ${r.key} attribuée au PBX ${P[r.slug]?.name || r.slug}.`; });
      return;
    }
    const del = e.target.closest("[data-ldel]");
    if (del) {
      const l = get(del.dataset.ldel), p = l.slug && !l.revoked_at ? P[l.slug] : null;
      const conf = prompt(`${p ? `ATTENTION : le PBX « ${p.name} » sera désactivé (plus de téléphones ni d'appels). Ses données sont gardées ; il pourra revivre avec une autre licence.\n\n` : ""}Supprimer la licence ${l.key} ?\nPour confirmer, tape ses 4 derniers caractères : ${l.key.slice(-4)}`);
      if (conf === null) return;
      const code = prompt("Code de double authentification (Psono) :");
      if (code === null) return;
      try {
        const r = await api("DELETE", `/api/licenses/${encodeURIComponent(l.key)}`, { confirm: conf.trim(), code: code.trim() });
        if (r.deleted) { flash = { cls: "", text: `Licence ${l.key} supprimée.` }; renderLicenses(); return; }
        $("#lrows").innerHTML = ""; followJob(r.id, () => `<div class="actions"><a class="btn" href="#/licences" onclick="setTimeout(()=>location.reload(),50)">Retour aux licences</a></div>`);
      } catch (err) { flash = { cls: "bad", text: err.message }; renderLicenses(); }
    }
  };
  draw();
}

// ---------------------------------------------------------------- Apparence (couleur, logo, fond d'écran) : console du serveur et tous ses PBX
function refreshThemeCss() {
  const l = document.querySelector('link[href^="/theme.css"]');
  if (l) l.href = `/theme.css?t=${Date.now()}`;
}
// Fonds d'écran des téléphones de bureau (Yealink) : dessinés ici aux couleurs du thème, avec le logo, une image par taille d'écran
async function drawWalls(d) {
  const t = d.theme;
  if (t.color === d.default && !t.logo) { if (t.walls) await api("DELETE", "/api/theme/walls"); return null; }
  const stops = d.shades.grad.match(/#[0-9a-f]{6}/gi) || [d.shades.accent, d.shades.accent, d.shades.accent];
  let logo = null;
  if (t.logo) { logo = new Image(); logo.src = `/theme/logo?v=${t.v}`; try { await logo.decode(); } catch { logo = null; } }
  const images = {};
  for (const sz of d.wall_sizes) {
    const [w, h] = sz.split("x").map(Number), c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d");
    const lg = g.createLinearGradient(0, 0, w, h);
    lg.addColorStop(0, d.shades.hover); lg.addColorStop(0.55, stops[1] || d.shades.accent); lg.addColorStop(1, stops[2] || d.shades.accent);
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, 0, w, h);                 // un peu plus sombre : heure et touches restent lisibles
    const cx = w / 2, cy = h * 0.62, u = h / 272;
    g.strokeStyle = "rgba(255,255,255,.09)"; g.lineWidth = Math.max(1, u);
    for (let r = 1; r <= 5; r++) { g.beginPath(); g.arc(cx, cy, 34 * u * r, 0, Math.PI * 2); g.stroke(); }
    const s = Math.round(h * 0.3), x = cx - s / 2, y = cy - s / 2, rad = s * 0.22;
    g.save(); g.shadowColor = "rgba(0,0,0,.25)"; g.shadowBlur = 12 * u;
    g.beginPath(); g.roundRect(x, y, s, s, rad); g.fillStyle = logo ? "#fff" : "rgba(255,255,255,.16)"; g.fill(); g.restore();
    if (logo) {
      const pad = s * 0.12, iw = logo.naturalWidth || s, ih = logo.naturalHeight || s, k = Math.min((s - 2 * pad) / iw, (s - 2 * pad) / ih);
      g.drawImage(logo, cx - iw * k / 2, cy - ih * k / 2, iw * k, ih * k);
    } else { g.beginPath(); g.arc(cx, cy, s * 0.2, 0, Math.PI * 2); g.lineWidth = s * 0.08; g.strokeStyle = "#fff"; g.stroke(); }
    images[sz] = c.toDataURL("image/png");
  }
  return api("POST", "/api/theme/walls", { images });
}
async function renderTheme() {
  setNav("paint", "Apparence");
  let d; try { d = await api("GET", "/api/theme"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const lock = d.branding?.locked;
  const edit = can("super", "admin") && !lock, t = d.theme;
  const mb = (n) => `${Math.round(n / 1024 / 1024)} Mo`;
  const asset = (kind, title, hint) => `<div class="panel"><div class="ph"><h2>${title}</h2>${t[kind] ? `<span class="pill ok">Personnalisé</span>` : `<span class="pill off">Par défaut</span>`}</div>
    <div class="pad stack">
      <div class="th-prev th-${kind}">${t[kind] ? `<img src="/theme/${kind}?v=${t.v}" alt="">` : `<span class="hint">${kind === "logo" ? "Logo Callikoe (rond sur fond de couleur)" : "Fond uni"}</span>`}</div>
      <p class="hint" style="margin:0">${hint}</p>
      ${edit ? `<div class="row" style="gap:8px;flex-wrap:wrap"><label class="btn sm" style="cursor:pointer">${t[kind] ? "Remplacer" : "Importer"}…<input type="file" data-up="${kind}" accept="${d.limits[kind].types.join(",")}" hidden></label>
        ${t[kind] ? `<button type="button" class="btn ghost sm" data-rm="${kind}">Retirer</button>` : ""}</div>` : ""}</div></div>`;
  const eur = (n) => Number(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  // Option Marque blanche (serveur relié au portail pro) : sans elle, la page est en lecture seule et tout reste aux couleurs Callikoe
  const lockBox = lock ? `<div class="mb-lock"><span class="mb-ic"></span><div class="grow"><strong>Option Marque blanche</strong>
      <p>Mets ta couleur, ton logo et ton fond d'écran sur cette console, tous tes PBX, le softphone, l'appli et les téléphones de tes clients.
      ${d.branding.price_ht === 0 ? "Incluse dans ton tarif : active-la dans le portail pro." : d.branding.price_ht ? `${esc(eur(d.branding.price_ht))} HT par an, pour tous tes serveurs.` : ""}
      ${t.color !== d.default || t.logo || t.bg ? " Tes réglages ci-dessous sont gardés : ils reviennent dès que l'option est active." : ""}</p></div>
      ${d.branding.order_url ? `<a class="btn" href="${esc(d.branding.order_url)}" target="_blank" rel="noopener">Commander l'option</a>` : ""}</div>` : "";
  app.innerHTML = takeFlash() + lockBox + `<div class="bar"><div class="grow"><h1>Apparence</h1>
      <p class="sub" style="margin:0">Couleur, logo et fond d'écran de la console du serveur et de <strong>tous ses PBX</strong> (console, softphone, appli). Le changement s'applique tout de suite.${d.branding?.until && !lock ? ` <span class="pill ok">Marque blanche jusqu'au ${esc(new Date(d.branding.until).toLocaleDateString("fr-FR"))}</span>` : ""}</p></div>
      ${edit ? `<button type="button" class="btn ghost" id="threset">Rétablir le thème Callikoe</button>` : ""}</div>
    <div class="${lock ? "mb-off" : ""}">
    <div class="panel"><div class="ph"><h2>Couleur</h2><span class="hint">remplace le rouge partout</span></div>
      <div class="pad stack">
        <div class="th-sw">${d.palette.map((p) => `<button type="button" class="th-c ${p.color === t.color ? "on" : ""}" data-color="${p.color}" title="${esc(p.name)}" ${edit ? "" : "disabled"}>
          <span style="background:${p.color}"></span><small>${esc(p.name)}</small></button>`).join("")}
          <label class="th-c th-custom ${d.palette.some((p) => p.color === t.color) ? "" : "on"}" title="Autre couleur"><span style="background:${esc(t.color)}"><input type="color" id="thpick" value="${esc(t.color)}" ${edit ? "" : "disabled"}></span><small>Autre…</small></label></div>
        <div class="th-demo"><span class="th-mark"></span><button type="button" class="btn sm">Bouton</button><a href="#/apparence">Lien</a><span class="pill ok">En ligne</span><span class="th-grad">Carte de la licence</span></div>
        <p class="hint" style="margin:0">Une couleur trop claire est foncée automatiquement pour que le texte des boutons reste lisible.</p></div></div>
    <div class="grid2" style="margin-top:16px">
      ${asset("logo", "Logo", `Affiché en haut du menu, dans le softphone et sur les pages de connexion. PNG, JPEG, WebP ou SVG, ${mb(d.limits.logo.max)} au maximum ; idéalement carré, fond transparent.`)}
      ${asset("bg", "Fond d'écran", `Affiché derrière les pages de connexion (console du serveur, consoles des PBX, softphone). PNG, JPEG ou WebP, ${mb(d.limits.bg.max)} au maximum ; 1920 × 1080 conseillé.`)}
    </div>
    <div class="panel" style="margin-top:16px"><div class="ph"><h2>Téléphones de bureau</h2>${t.walls ? `<span class="pill ok">Aux couleurs du thème</span>` : `<span class="pill off">Fond Callikoe</span>`}</div>
      <div class="pad stack"><div class="th-prev th-wall"><img src="${t.walls ? `/phone/theme/wall-480x272-${t.walls}.png` : "/c/phone/callikoe-v3-480x272.png"}" alt="" onerror="this.remove()"></div>
        <p class="hint" style="margin:0">Fond d'écran des téléphones Yealink à écran couleur, dessiné automatiquement avec ta couleur et ton logo (4 tailles d'écran). Les téléphones le chargent à leur prochaine synchronisation ou à leur redémarrage.</p></div></div></div>`;
  const done = async (nd, text) => {
    try { await drawWalls(nd); } catch (e) { text += ` (fonds d'écran des téléphones non mis à jour : ${e.message})`; }
    flash = { text }; refreshThemeCss(); renderTheme();
  };
  const fail = (e) => { flash = { cls: "bad", text: e.message }; renderTheme(); };
  app.querySelectorAll("[data-color]").forEach((b) => (b.onclick = async () => { try { done(await api("PUT", "/api/theme", { color: b.dataset.color }), "Couleur appliquée à la console du serveur et à tous ses PBX."); } catch (e) { fail(e); } }));
  $("#thpick")?.addEventListener("change", async (e) => { try { done(await api("PUT", "/api/theme", { color: e.target.value }), "Couleur appliquée à la console du serveur et à tous ses PBX."); } catch (er) { fail(er); } });
  app.querySelectorAll("[data-up]").forEach((inp) => inp.addEventListener("change", async () => {
    const f = inp.files[0]; if (!f) return;
    const kind = inp.dataset.up;
    if (f.size > d.limits[kind].max) return fail(new Error(`Fichier trop lourd (${mb(d.limits[kind].max)} au maximum).`));
    try {
      const res = await fetch(`/api/theme/${kind}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      done(data, kind === "logo" ? "Logo importé : visible partout." : "Fond d'écran importé.");
    } catch (e) { fail(e); }
  }));
  app.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = async () => { try { done(await api("DELETE", `/api/theme/${b.dataset.rm}`), "Retiré."); } catch (e) { fail(e); } }));
  $("#threset")?.addEventListener("click", async () => {
    if (!confirm("Revenir au rouge Callikoe, sans logo ni fond d'écran, sur le serveur et tous ses PBX ?")) return;
    try { done(await api("POST", "/api/theme/reset"), "Thème Callikoe rétabli."); } catch (e) { fail(e); }
  });
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

// ---------------------------------------------------------------- Clé de signature des licences (super administrateur)
async function renderSigning() {
  setNav("key", "Clé de signature");
  let s; try { s = await api("GET", "/api/signing"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  app.innerHTML = takeFlash() + `<h1>Clé de signature des licences</h1>
    <p class="sub">C'est elle qui signe la licence et la configuration de chaque PBX créé sur ce serveur. Les PBX n'acceptent que les fichiers signés par la clé d'IRT.</p>
    <div class="panel pad stack">
      ${s.configured ? `<div class="flash" style="margin:0">✔ Clé installée · empreinte <code>${esc(s.fingerprint)}</code></div>` : `<div class="flash warn" style="margin:0">Aucune clé installée : la création de PBX est bloquée.</div>`}
      <form id="kf" class="stack" novalidate><div class="form-msg"></div>
        <label>Fichier <code>pbx-cle-privee.pem</code> (rangé dans Psono)<input type="file" accept=".pem,.txt" id="kfile"></label>
        <label>Ou colle son contenu<textarea name="pem" rows="5" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"></textarea></label>
        <label>Code de double authentification<input name="code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></label>
        <p class="hint" style="margin:0">La clé est gardée sur le serveur, lisible par la console du serveur seulement (pas par les PBX clients). Garde ta copie dans Psono.</p>
        <div class="form-near"></div>
        <div class="actions"><button class="btn">${s.configured ? "Remplacer la clé" : "Installer la clé"}</button></div></form></div>`;
  const form = $("#kf");
  $("#kfile").onchange = async (e) => { if (e.target.files[0]) form.pem.value = (await e.target.files[0].text()).trim(); };
  bindForm(form, async (f) => {
    const r = await api("POST", "/api/signing", { pem: f.pem, code: String(f.code || "").trim() });
    flash = { text: `Clé installée (empreinte ${r.fingerprint}). Tu peux créer des PBX.` }; renderSigning();
  });
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

// ---------------------------------------------------------------- Surveillance (appels étranger / surtaxés, changements d'adresse)
const WATCH_KINDS = { intl: ["bad", "Étranger"], premium: ["wait", "Surtaxé"], ip: ["off", "Nouvelle adresse"] };
const WATCH_CATS = { phone: "Téléphones", softphone: "Softphones", app: "Applis" };
let watchF = { days: 30, state: "todo", kinds: new Set(["intl", "premium", "ip"]), cats: new Set(["phone", "softphone", "app"]), pbx: "", q: "" };
async function renderWatch() {
  setNav("watch", "Surveillance");
  app.innerHTML = `<div class="bar"><div class="grow"><h1>Surveillance</h1>
      <p class="sub" style="margin:0">Appels vers l'étranger ou des numéros surtaxés, et téléphones, softphones ou applis connectés depuis une nouvelle adresse, sur tous les PBX du serveur. Vérifie-les puis marque-les « OK » : il ne reste que ce qui n'a pas encore été regardé.</p></div>
      <label>Période<select id="wdays">${[[7, "7 derniers jours"], [30, "30 derniers jours"], [90, "90 derniers jours"]].map(([v, l]) => `<option value="${v}" ${v === watchF.days ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div id="wbody"><div class="empty"><span class="spin"></span></div></div>`;
  $("#wdays").onchange = (e) => { watchF.days = Number(e.target.value); load(); };
  let d = null;
  async function load() {
    try { d = await api("GET", `/api/surveillance?days=${watchF.days}`); } catch (e) { $("#wbody").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
    if (location.hash === "#/surveillance") draw();
  }
  function draw() {
    const pbxs = [...new Map(d.events.map((e) => [e.pbx, e.pbx_name])).entries()];
    const q = watchF.q.trim().toLowerCase();
    const base = d.events.filter((e) => (!watchF.pbx || e.pbx === watchF.pbx) && (!q || `${e.text} ${e.pbx_name} ${e.extension}`.toLowerCase().includes(q)));
    const list = base.filter((e) => watchF.kinds.has(e.kind) && (e.kind !== "ip" || watchF.cats.has(e.category))
      && (watchF.state === "all" || (watchF.state === "todo" ? !e.reviewed_at : !!e.reviewed_at)));
    const cnt = (k) => base.filter((e) => e.kind === k && !e.reviewed_at).length;
    const chk = (set, k, l, n) => `<label class="check wchk"><input type="checkbox" data-${set}="${k}" ${watchF[set].has(k) ? "checked" : ""}> ${l}${n !== undefined ? ` <span class="s">(${n})</span>` : ""}</label>`;
    $("#wbody").innerHTML = `<div class="kpis">
        ${kpi("call", "Appels vers l'étranger", cnt("intl"), "à vérifier", cnt("intl") ? "warn" : "good")}
        ${kpi("lic", "Numéros surtaxés", cnt("premium"), "à vérifier", cnt("premium") ? "warn" : "good")}
        ${kpi("phone", "Nouvelles adresses", cnt("ip"), "appareils connectés d'ailleurs", cnt("ip") ? "warn" : "good")}
      </div>
      <div class="panel pad stack">
        <div class="row" style="gap:12px;align-items:flex-end;flex-wrap:wrap">
          <label style="flex:1;min-width:200px">Rechercher<input id="wq" type="search" placeholder="Numéro, poste, PBX, adresse IP…" value="${esc(watchF.q)}" autocomplete="off"></label>
          <label>PBX<select id="wpbx"><option value="">Tous</option>${pbxs.map(([k, n]) => `<option value="${esc(k)}" ${k === watchF.pbx ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
          <label>Afficher<select id="wstate"><option value="todo" ${watchF.state === "todo" ? "selected" : ""}>À vérifier</option><option value="done" ${watchF.state === "done" ? "selected" : ""}>Déjà vérifiés</option><option value="all" ${watchF.state === "all" ? "selected" : ""}>Tout</option></select></label>
        </div>
        <div class="wfil"><span class="dl">Types</span>${chk("kinds", "intl", "Appels vers l'étranger")}${chk("kinds", "premium", "Numéros surtaxés")}${chk("kinds", "ip", "Changements d'adresse")}</div>
        <div class="wfil ${watchF.kinds.has("ip") ? "" : "dim"}"><span class="dl">Appareils</span>${Object.entries(WATCH_CATS).map(([k, l]) => chk("cats", k, l, base.filter((e) => e.kind === "ip" && e.category === k && !e.reviewed_at).length)).join("")}</div>
      </div>
      <div class="panel"><div class="ph"><h2>Événements</h2><span class="s">${list.length}</span></div>
        ${list.length ? list.slice(0, 500).map((e) => `<div class="sipev-row"><div class="sipev-meta"><span class="s">${fmtDate(e.at)}</span>
            <span class="pill ${(WATCH_KINDS[e.kind] || ["off"])[0]}">${esc((WATCH_KINDS[e.kind] || [, e.kind])[1])}${e.kind === "ip" ? ` · ${esc(({ phone: "Téléphone", softphone: "Softphone", app: "Appli" })[e.category] || "")}` : ""}</span>
            <strong>${esc(e.pbx_name)}</strong>
            <span class="grow"></span>
            ${e.reviewed_at ? `<span class="s">✓ Vérifié par ${esc(e.reviewed_by)} le ${fmtDate(e.reviewed_at)}</span>`
              : can("super", "admin", "tech") ? `<button class="btn ghost sm" data-wok="${esc(e.pbx)}|${esc(e.id)}">${e.kind === "ip" ? "OK, c'est normal" : "OK, pas une fraude"}</button>` : ""}</div>
            <div>${esc(e.text)}</div></div>`).join("")
          : `<div class="empty">${watchF.state === "todo" ? "Rien à vérifier : tout a été regardé." : "Aucun événement."}</div>`}</div>`;
    $("#wq").oninput = (e) => { watchF.q = e.target.value; const p = e.target.selectionStart; draw(); const i = $("#wq"); i.focus(); i.setSelectionRange(p, p); };
    $("#wpbx").onchange = (e) => { watchF.pbx = e.target.value; draw(); };
    $("#wstate").onchange = (e) => { watchF.state = e.target.value; draw(); };
    app.querySelectorAll("[data-kinds],[data-cats]").forEach((cb) => cb.onchange = () => {
      const set = cb.dataset.kinds ? watchF.kinds : watchF.cats, k = cb.dataset.kinds || cb.dataset.cats;
      cb.checked ? set.add(k) : set.delete(k); draw();
    });
    app.querySelectorAll("[data-wok]").forEach((b) => b.onclick = async () => {
      const [pbx, id] = b.dataset.wok.split("|");
      b.disabled = true;
      try {
        await api("POST", "/api/surveillance/ok", { pbx, id, text: b.closest(".sipev-row").lastElementChild.textContent });
        const ev = d.events.find((x) => x.pbx === pbx && String(x.id) === id);
        if (ev) { ev.reviewed_at = new Date().toISOString(); ev.reviewed_by = state.user.email; }
        draw();
      } catch (err) { b.disabled = false; $("#wbody").insertAdjacentHTML("afterbegin", `<div class="flash bad">${esc(err.message)}</div>`); }
    });
  }
  await load();
}

// ---------------------------------------------------------------- Protection anti-intrusion (commune à tous les PBX du serveur)
async function renderProtection() {
  setNav("shield", "Protection anti-intrusion");
  let p, t;
  try { [p, t] = await Promise.all([api("GET", "/api/protection"), api("GET", "/api/telephonie?minutes=15")]); }
  catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const edit = can("super", "admin");
  const blocked = new Map();
  for (const b of t.banned) { const x = blocked.get(b.ip) || { ip: b.ip, why: [] }; x.why.push(b.label); blocked.set(b.ip, x); }
  for (const ip of t.ignored) { const x = blocked.get(ip) || { ip, why: [] }; x.why.push("Ignorée 1 minute par l'anti-flood"); blocked.set(ip, x); }
  app.innerHTML = `${takeFlash()}<h1>Protection anti-intrusion</h1>
    <p class="sub">Commune à tous les PBX du serveur : une adresse qui se trompe trop souvent de mot de passe est bloquée pour la téléphonie (SIP 5060 / 5061). Le web et les consoles restent joignables.</p>
    <div class="kpis">
      ${kpi("shield", "Protection", p.active ? "Active" : "Arrêtée", `${p.maxretry} échecs en ${p.findtime} min → blocage ${p.bantime} min`, p.active ? "good" : "warn")}
      ${kpi("lic", "Adresses bloquées", blocked.size, t.client_ip ? `ton adresse : <span class="mono">${esc(t.client_ip)}</span>` : "", blocked.has(t.client_ip) ? "warn" : "")}
      ${kpi("users", "Liste blanche", p.whitelist.length, "adresses jamais bloquées")}
    </div>
    ${blocked.has(t.client_ip) ? `<div class="flash bad">Ton adresse actuelle (${esc(t.client_ip)}) est bloquée : tes téléphones ne peuvent pas s'enregistrer. ${edit ? `<button class="btn sm" data-unban="${esc(t.client_ip)}">Débloquer mon adresse</button>` : ""}</div>` : ""}
    <div class="grid2">
      <div class="panel"><div class="ph"><h2>Adresses bloquées</h2><span class="s">${blocked.size}</span></div>
        ${blocked.size ? `<div class="table-wrap"><table><thead><tr><th>Adresse</th><th>Raison</th><th></th></tr></thead><tbody>
          ${[...blocked.values()].map((b) => `<tr><td class="mono">${esc(b.ip)}${b.ip === t.client_ip ? ' <span class="pill bad">toi</span>' : ""}</td><td>${b.why.map(esc).join("<br>")}</td><td class="acts">${edit ? `<button class="btn ghost sm" data-unban="${esc(b.ip)}">Débloquer</button>` : ""}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="empty">Aucune adresse bloquée.</div>`}
        ${edit ? `<form id="banf" class="pad" style="border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end" novalidate>
          <label style="flex:1;min-width:200px">Bloquer une adresse définitivement<input name="ip" placeholder="203.0.113.7" autocomplete="off"></label>
          <button class="btn ghost">Bloquer</button><div class="form-near" style="flex-basis:100%"></div></form>` : ""}
        <p class="hint pad" style="margin:0;border-top:1px solid var(--line)">Le détail de ce que chaque adresse a tenté est dans <a href="#/telephonie">Logs d'erreur</a>.</p></div>
      <form id="protf" class="panel" novalidate><div class="ph"><h2>Protection automatique</h2></div><div class="pad stack">
        <div class="grid3" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:end">
          <label>Échecs autorisés<input type="number" name="maxretry" min="2" max="50" value="${p.maxretry}" ${edit ? "" : "disabled"}></label>
          <label>Sur une fenêtre de (min)<input type="number" name="findtime" min="1" max="1440" value="${p.findtime}" ${edit ? "" : "disabled"}></label>
          <label>Blocage pendant (min)<input type="number" name="bantime" min="1" max="525600" value="${p.bantime}" ${edit ? "" : "disabled"}></label></div>
        <label>Adresses jamais bloquées (liste blanche)<textarea name="whitelist" rows="4" placeholder="Une adresse ou un réseau par ligne : IP fixe des bureaux d'un client, d'IRT, d'un opérateur…" ${edit ? "" : "disabled"}>${esc(p.whitelist.join("\n"))}</textarea>
          <span class="hint">Ces adresses ne sont jamais bloquées, même après des erreurs de mot de passe. Les appareils réglés sur une adresse de PBX inconnue sont bloqués beaucoup plus tard (40 essais en 10 min, 30 min de blocage).</span></label>
        <div class="form-near"></div>
        ${edit ? `<div class="actions"><button class="btn">Enregistrer et appliquer</button></div>` : ""}</div></form>
    </div>`;
  app.querySelectorAll("[data-unban]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await api("POST", "/api/telephonie/debloquer", { ip: b.dataset.unban }); flash = { text: `Adresse ${b.dataset.unban} débloquée.` }; renderProtection(); }
    catch (err) { b.disabled = false; flash = { cls: "bad", text: err.message }; renderProtection(); }
  });
  const bf = $("#banf");
  if (bf) bindForm(bf, async (f) => {
    const ip = String(f.ip || "").trim();
    if (ip === t.client_ip) throw Object.assign(new Error("C'est ton adresse actuelle : tu bloquerais tes propres téléphones."), { field: "ip" });
    await api("POST", "/api/telephonie/bloquer", { ip });
    flash = { text: `Adresse ${ip} bloquée.` }; renderProtection();
  });
  if (edit) bindForm($("#protf"), async (f) => {
    const r = await api("POST", "/api/protection", { maxretry: Number(f.maxretry), findtime: Number(f.findtime), bantime: Number(f.bantime), whitelist: String(f.whitelist || "").split(/\s+/).filter(Boolean) });
    flash = { text: `Enregistré : ${r.maxretry} échecs en ${r.findtime} min → blocage ${r.bantime} min.` }; renderProtection();
  });
}

// ---------------------------------------------------------------- Pays autorisés (téléphonie bloquée ailleurs)
const GEO_COUNTRIES = [["FR", "France"], ["BE", "Belgique"], ["CH", "Suisse"], ["LU", "Luxembourg"], ["MC", "Monaco"], ["AD", "Andorre"],
  ["DE", "Allemagne"], ["ES", "Espagne"], ["IT", "Italie"], ["PT", "Portugal"], ["GB", "Royaume-Uni"], ["IE", "Irlande"], ["NL", "Pays-Bas"],
  ["AT", "Autriche"], ["DK", "Danemark"], ["SE", "Suède"], ["NO", "Norvège"], ["FI", "Finlande"], ["IS", "Islande"], ["PL", "Pologne"],
  ["CZ", "Tchéquie"], ["SK", "Slovaquie"], ["HU", "Hongrie"], ["RO", "Roumanie"], ["BG", "Bulgarie"], ["GR", "Grèce"], ["HR", "Croatie"],
  ["SI", "Slovénie"], ["EE", "Estonie"], ["LV", "Lettonie"], ["LT", "Lituanie"], ["MT", "Malte"], ["CY", "Chypre"],
  ["GP", "Guadeloupe"], ["MQ", "Martinique"], ["GF", "Guyane"], ["RE", "La Réunion"], ["YT", "Mayotte"], ["PM", "Saint-Pierre-et-Miquelon"],
  ["NC", "Nouvelle-Calédonie"], ["PF", "Polynésie française"],
  ["MA", "Maroc"], ["DZ", "Algérie"], ["TN", "Tunisie"], ["SN", "Sénégal"], ["CI", "Côte d'Ivoire"], ["CM", "Cameroun"], ["MG", "Madagascar"], ["MU", "Maurice"],
  ["US", "États-Unis"], ["CA", "Canada"], ["BR", "Brésil"], ["MX", "Mexique"], ["TR", "Turquie"], ["IL", "Israël"], ["AE", "Émirats arabes unis"],
  ["IN", "Inde"], ["CN", "Chine"], ["JP", "Japon"], ["AU", "Australie"], ["UA", "Ukraine"], ["RU", "Russie"]];
async function renderGeo() {
  setNav("globe", "IP Pays autorisés");
  let d;
  try { d = await api("GET", "/api/pays"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  const sel = new Set(d.countries || []);
  const edit = can("super", "admin");
  app.innerHTML = `${takeFlash()}<h1>IP Pays autorisés</h1>
    <p class="sub">Les téléphones, softphones, applis et opérateurs ne peuvent joindre les PBX du serveur (SIP 5060 / 5061) que depuis les pays cochés. Tout le reste est bloqué avant même d'arriver au PBX. Les opérateurs de tes trunks et les adresses de la liste ci-dessous sont toujours acceptés.</p>
    <div class="kpis">
      ${kpi("globe", "Filtre", d.active ? "Actif" : "Inactif", d.active ? `${sel.size} pays autorisé${sel.size > 1 ? "s" : ""}` : "téléphonie acceptée de partout", d.active ? "good" : "warn")}
      ${kpi("sip", "Tentatives bloquées", d.blocked_packets || 0, "messages venus d'autres pays depuis le dernier redémarrage")}
      ${kpi("lic", "Listes d'adresses", d.ranges4 || 0, d.updated_at ? `mises à jour le ${fmtDate(d.updated_at)} (chaque jour)` : "pas encore téléchargées")}
    </div>
    ${d.message ? `<div class="flash ${d.active ? "" : "warn"}">${esc(d.message)}</div>` : ""}
    <form id="geof" class="panel" novalidate><div class="ph"><h2>Pays</h2><span class="s" id="gcount"></span></div><div class="pad stack">
      <div class="row" style="gap:12px;align-items:flex-end;flex-wrap:wrap">
        <label style="flex:1;min-width:200px">Rechercher un pays<input id="gq" type="search" placeholder="Belgique, Maroc…" autocomplete="off"></label>
        ${edit ? `<button type="button" class="btn ghost sm" id="gnone">Tout décocher</button>` : ""}</div>
      <div class="geo-grid" id="ggrid">${GEO_COUNTRIES.map(([c, n]) => `<label class="check geo-c" data-n="${esc(n.toLowerCase())}"><input type="checkbox" name="c" value="${c}" ${sel.has(c) ? "checked" : ""} ${edit ? "" : "disabled"}> ${esc(n)}</label>`).join("")}</div>
      <label>Adresses toujours acceptées<textarea name="always" rows="3" placeholder="203.0.113.7&#10;198.51.100.0/24" ${edit ? "" : "disabled"}>${esc((d.always || []).join("\n"))}</textarea>
        <span class="hint">Une par ligne (IPv4, avec /masque possible) : un client ou un technicien à l'étranger, un opérateur hors des pays cochés…</span></label>
      <div class="form-near"></div>
      ${edit ? `<div class="actions"><button class="btn">Enregistrer et appliquer</button></div>` : ""}
      <p class="hint" style="margin:0">Sans aucun pays coché, la téléphonie est acceptée depuis tous les pays. Les listes d'adresses par pays viennent d'ipdeny.com (gratuit) et sont mises à jour chaque jour. Les consoles web ne sont pas concernées.</p>
    </div></form>`;
  const count = () => { $("#gcount").textContent = `${app.querySelectorAll("[name=c]:checked").length} coché(s)`; };
  count();
  app.querySelectorAll("[name=c]").forEach((cb) => cb.onchange = count);
  $("#gq").oninput = (e) => { const q = e.target.value.trim().toLowerCase(); app.querySelectorAll(".geo-c").forEach((l) => { l.hidden = !!q && !l.dataset.n.includes(q); }); };
  $("#gnone")?.addEventListener("click", () => { app.querySelectorAll("[name=c]").forEach((cb) => (cb.checked = false)); count(); });
  if (edit) bindForm($("#geof"), async (f, form) => {
    const countries = [...form.querySelectorAll("[name=c]:checked")].map((x) => x.value);
    if (!countries.length && !confirm("Aucun pays coché : la téléphonie sera acceptée depuis tous les pays. Continuer ?")) return;
    if (countries.length && !countries.includes("FR") && !confirm("La France n'est pas cochée : les téléphones et opérateurs en France seront bloqués. Continuer ?")) return;
    const r = await api("POST", "/api/pays", { countries, always: String(f.always || "").split(/\s+/).filter(Boolean) });
    flash = { cls: r.active || !countries.length ? "" : "warn", text: r.message || "Enregistré." };
    renderGeo();
  });
}

// ---------------------------------------------------------------- Journal de la téléphonie (aiguilleur SIP)
const SIP_KINDS = { erreur: ["bad", "Erreur"], auth: ["wait", "Mot de passe refusé"], refus: ["off", "Adresse inconnue"], robot: ["off", "Robot / fraude"], flood: ["wait", "Trop de messages"] };
let sipMin = 60, sipFilter = "", sipKind = "", sipTimer = null, sipShow = 200;
async function renderTelephonie() {
  setNav("sip", "Logs d'erreur");
  clearInterval(sipTimer);
  app.innerHTML = `<div class="bar"><div class="grow"><h1>Logs d'erreur</h1>
      <p class="sub" style="margin:0">Ce que l'aiguilleur SIP du serveur a refusé ou n'a pas pu transmettre, et les adresses bloquées. Utile quand un téléphone ou un trunk n'arrive pas à s'enregistrer.</p></div>
      <label>Période<select id="sipmin">${[[15, "15 dernières minutes"], [60, "Dernière heure"], [360, "6 dernières heures"], [1440, "24 dernières heures"], [10080, "7 derniers jours"], [43200, "30 derniers jours"]].map(([v, l]) => `<option value="${v}" ${v === sipMin ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <button class="btn ghost" id="siprefresh">Actualiser</button></div>
    <div id="sipbody"><div class="empty"><span class="spin"></span></div></div>`;
  $("#sipmin").onchange = (e) => { sipMin = Number(e.target.value); load(); };
  $("#siprefresh").onclick = () => load();
  async function load() {
    let d;
    try { d = await api("GET", `/api/telephonie?minutes=${sipMin}`); }
    catch (e) { $("#sipbody").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
    if (location.hash !== "#/telephonie") return;
    draw(d);
  }
  function draw(d) {
    const c = d.counts || {};
    const blocked = new Map();
    for (const b of d.banned) { const x = blocked.get(b.ip) || { ip: b.ip, why: [] }; x.why.push(b.label); blocked.set(b.ip, x); }
    for (const ip of d.ignored) { const x = blocked.get(ip) || { ip, why: [] }; x.why.push("Ignorée 1 minute par l'anti-flood"); blocked.set(ip, x); }
    const mine = d.client_ip && blocked.has(d.client_ip);
    const act = (ip, isBlocked) => can("super", "admin") ? (isBlocked ? `<button class="btn ghost sm" data-unban="${esc(ip)}">Débloquer</button>`
      : `<button class="btn ghost sm" data-ban="${esc(ip)}">Bloquer</button>`) : "";
    const q = sipFilter.trim().toLowerCase();
    const ev = d.events.filter((e) => (!sipKind || e.kind === sipKind) && (!q || e.ip.includes(q) || e.text.toLowerCase().includes(q)));
    $("#sipbody").innerHTML = `
      ${mine ? `<div class="flash bad">Ton adresse actuelle (${esc(d.client_ip)}) est bloquée pour la téléphonie : tes téléphones ne peuvent pas s'enregistrer. ${can("super", "admin") ? `<button class="btn sm" data-unban="${esc(d.client_ip)}">Débloquer mon adresse</button>` : ""}</div>` : ""}
      <div class="kpis">
        ${kpi("sip", "Erreurs", c.erreur || 0, "demandes non transmises aux PBX", c.erreur ? "warn" : "good")}
        ${kpi("key", "Mots de passe refusés", c.auth || 0, "postes ou trunks mal configurés", c.auth ? "warn" : "")}
        ${kpi("phone", "Adresses inconnues", c.refus || 0, "appareils réglés sur une adresse qui n'existe pas ici")}
        ${kpi("call", "Robots refusés", c.robot || 0, "tentatives d'appels frauduleux bloquées")}
        ${kpi("lic", "Adresses bloquées", blocked.size, d.client_ip ? `ton adresse : <span class="mono">${esc(d.client_ip)}</span>` : "", mine ? "warn" : "")}
      </div>
      <div class="flash">${blocked.size} adresse${blocked.size > 1 ? "s" : ""} bloquée${blocked.size > 1 ? "s" : ""} en ce moment : liste, blocage et réglages dans <a href="#/protection">Protection anti-intrusion</a>.</div>
      ${d.by_ip.length ? `<div class="panel"><div class="ph"><h2>Adresses les plus actives</h2><span class="s">sur la période</span></div><div class="table-wrap"><table>
        <thead><tr><th>Adresse</th><th>Événements</th><th>Types</th><th>État</th><th></th></tr></thead><tbody>
        ${d.by_ip.slice(0, 15).map((x) => `<tr><td class="mono"><a href="#" data-ip="${esc(x.ip)}">${esc(x.ip)}</a>${x.ip === d.client_ip ? ' <span class="pill ok">toi</span>' : ""}</td><td>${x.count}</td>
          <td>${Object.entries(x.kinds).map(([k, n]) => `<span class="pill ${(SIP_KINDS[k] || ["off"])[0]}">${esc((SIP_KINDS[k] || [k, k])[1])} × ${n}</span>`).join(" ")}</td>
          <td>${x.banned || x.ignored ? '<span class="pill bad">Bloquée</span>' : '<span class="pill off">Libre</span>'}</td><td class="acts">${act(x.ip, x.banned || x.ignored)}</td></tr>`).join("")}
        </tbody></table></div></div>` : ""}
      <div class="panel"><div class="ph"><h2>Événements</h2><span class="s">${d.total > d.events.length ? `${d.events.length} plus récents sur ${d.total}` : d.total}</span></div>
        <div class="pad" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;border-bottom:1px solid var(--line)">
          <label style="flex:1;min-width:200px">Rechercher<input id="sipq" type="search" placeholder="Adresse IP, numéro de poste, PBX…" value="${esc(sipFilter)}" autocomplete="off"></label>
          <label>Type<select id="sipk"><option value="">Tous</option>${Object.entries(SIP_KINDS).map(([k, [, l]]) => `<option value="${k}" ${k === sipKind ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
        ${ev.length ? `<div class="sipev">
          ${ev.slice(0, sipShow).map((e) => `<div class="sipev-row"><div class="sipev-meta"><span class="s">${e.at ? new Date(e.at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</span>
            <span class="pill ${(SIP_KINDS[e.kind] || ["off"])[0]}">${esc((SIP_KINDS[e.kind] || [e.kind, e.kind])[1])}</span>
            ${e.ip ? `<a href="#" class="mono" data-ip="${esc(e.ip)}">${esc(e.ip)}</a>` : ""}</div><div>${esc(e.text)}</div></div>`).join("")}
          </div>${ev.length > sipShow ? `<div class="pad" style="text-align:center;border-top:1px solid var(--line)"><button class="btn ghost" id="sipmore">Afficher plus (${ev.length - sipShow} restants)</button></div>` : ""}` : `<div class="empty">${d.total ? "Aucun événement ne correspond." : "Rien à signaler sur la période : aucun refus ni erreur."}</div>`}
      </div>`;
    $("#sipq").oninput = (e) => { sipFilter = e.target.value; const pos = e.target.selectionStart; draw(d); const i = $("#sipq"); i.focus(); i.setSelectionRange(pos, pos); };
    $("#sipk").onchange = (e) => { sipKind = e.target.value; draw(d); };
    $("#sipmore")?.addEventListener("click", () => { sipShow += 300; draw(d); });
    app.querySelectorAll("[data-ip]").forEach((a) => a.onclick = (e) => { e.preventDefault(); sipFilter = a.dataset.ip; draw(d); $("#sipq").scrollIntoView({ block: "center" }); });
    const act2 = async (path, ip, b) => {
      b.disabled = true;
      try { await api("POST", path, { ip }); load(); }
      catch (err) { b.disabled = false; $("#sipbody").insertAdjacentHTML("afterbegin", `<div class="flash bad">${esc(err.message)}</div>`); }
    };
    app.querySelectorAll("[data-unban]").forEach((b) => b.onclick = () => act2("/api/telephonie/debloquer", b.dataset.unban, b));
    app.querySelectorAll("[data-ban]").forEach((b) => b.onclick = () => {
      if (!confirm(`Bloquer définitivement ${b.dataset.ban} ? Plus aucun appareil à cette adresse ne pourra joindre les PBX du serveur.`)) return;
      act2("/api/telephonie/bloquer", b.dataset.ban, b);
    });
  }
  await load();
  sipTimer = setInterval(() => { if (location.hash === "#/telephonie" && sipMin <= 1440 && !document.hidden && !document.activeElement?.closest?.("#sipbody")) load(); else if (location.hash !== "#/telephonie") clearInterval(sipTimer); }, 30_000);
}

// ---------------------------------------------------------------- Routage
async function loadState() { Object.assign(state, await api("GET", "/api/state")); }
function route() {
  const h = location.hash || "#/";
  let m;
  if ((m = h.match(/^#\/invitation\/([0-9a-f]{48})$/))) return renderInvite(m[1]);
  if (state.setup_needed) return renderSetup();
  if (!state.user) return renderLogin();
  if (h.split("?")[0] === "#/nouveau" && can("super", "admin")) return renderNew();
  if (h === "#/restaurer" && can("super", "admin")) return renderRestore();
  if (h === "#/comptes" && can("super")) return renderAccounts();
  if (h === "#/cle" && can("super")) return renderSigning();
  if (h === "#/journal" && can("super", "admin")) return renderAudit();
  if (h === "#/licences") return renderLicenses();
  if (h === "#/apparence") return renderTheme();
  if (h === "#/telephonie") return renderTelephonie();
  if (h === "#/surveillance") return renderWatch();
  if (h === "#/pays") return renderGeo();
  if (h === "#/protection") return renderProtection();
  return renderList();
}
window.addEventListener("hashchange", route);
loadState().then(route).catch((e) => { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; });
