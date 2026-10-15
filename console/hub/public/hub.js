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
};
const icon = (k, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ""}</svg>`;
const can = (...roles) => roles.includes(state.user?.role);

function setNav(active, label = "") {
  const on = !!state.user;
  document.body.classList.toggle("no-side", !on);
  document.body.classList.remove("side-open");
  const items = [["#/", "Tableau de bord", "pbx"], ...(can("super", "admin") ? [["#/nouveau", "Nouveau PBX", "add"]] : []),
    ...(can("super") ? [["#/comptes", "Comptes du serveur", "users"], ["#/cle", "Clé de signature", "key"]] : []), ...(can("super", "admin") ? [["#/journal", "Journal", "log"]] : [])];
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

// ---------------------------------------------------------------- Tableau de bord + PBX clients (vue globale, recherche)
let pbxFilter = "", pbxStatus = "", listTimer = null;
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
      ${kpi("lic", "Licences", `${t.expiring || 0}`, "expirent dans moins de 30 jours", t.expiring ? "warn" : "good")}
    </div>`;
  const card = (p) => {
    const [cls, label] = pbxState(p);
    const exp = p.expires_at ? Date.parse(p.expires_at) - Date.now() : null;
    return `<div class="pbx-card${p.suspended ? " off" : ""}">
      <div class="row" style="justify-content:space-between;margin:0"><strong>${esc(p.name)}</strong><span class="pill ${cls}">${label}</span></div>
      <span class="mono">${esc(p.fqdn)}</span>
      <span class="hint">${esc(p.company || p.slug)}${p.edition ? ` · ${esc(p.edition)}` : ""}</span>
      <div class="pbx-stats">
        <span title="Appels en cours / appels simultanés">${icon("call", 15)} ${p.calls || 0}/${p.max_calls || "—"}</span>
        <span title="Postes connectés / postes">${icon("phone", 15)} ${p.phones_online || 0}/${p.phones || 0}</span>
        <span title="Trunks enregistrés / trunks" class="${p.trunks && p.trunks_ok < p.trunks ? "warn" : ""}">${icon("trunk", 15)} ${p.trunks_ok || 0}/${p.trunks || 0}</span>
        <span title="Fin de licence" class="${exp !== null && exp < 30 * 86400000 ? "warn" : ""}">${icon("lic", 15)} ${fmtDay(p.expires_at)}</span>
      </div>
      <div class="row" style="margin-top:6px">
        ${p.suspended ? "" : `<a class="btn sm" href="/ouvrir/${encodeURIComponent(p.slug)}">Ouvrir</a>`}
        ${can("super", "admin") ? (p.suspended ? `<button class="btn ghost sm" data-react="${esc(p.slug)}">Réactiver</button>`
          : `<button class="btn ghost sm" data-susp="${esc(p.slug)}">Désactiver</button>`) : ""}
        ${!p.suspended && can("super", "admin", "tech") ? `<a class="btn ghost sm" href="/ouvrir/${encodeURIComponent(p.slug)}?page=sauvegardes" title="Sauvegarder ou restaurer ce PBX">Sauvegardes</a>` : ""}
        ${can("super", "admin") ? `<a class="btn ghost sm" href="/api/pbx/${encodeURIComponent(p.slug)}/config" title="Fichier pbx-config.json signé (réinstallation)">⬇ Config</a>
          <button class="btn link sm" data-del="${esc(p.slug)}" style="color:var(--bad)">Supprimer</button>` : ""}
      </div></div>`;
  };
  const draw = () => {
    const q = pbxFilter.trim().toLowerCase();
    const list = d.pbx.filter((p) => (!q || [p.name, p.slug, p.fqdn, p.company, p.license].join(" ").toLowerCase().includes(q))
      && (!pbxStatus || pbxState(p)[0] === pbxStatus));
    $("#dash").innerHTML = dash();
    $("#cards").innerHTML = list.length ? list.map(card).join("")
      : `<div class="empty" style="grid-column:1/-1">${d.pbx.length ? "Aucun PBX ne correspond à la recherche." : `Aucun PBX sur ce serveur pour l'instant.${can("super", "admin") ? ` <a href="#/nouveau">Créer le premier PBX</a>` : ""}`}</div>`;
    $("#count").textContent = `${list.length} sur ${d.pbx.length} PBX (${d.max} au maximum)`;
  };
  app.innerHTML = takeFlash() + `<div class="bar"><div class="grow"><h1>Tableau de bord</h1>
      <p class="sub" style="margin:0">Tous les PBX du serveur. « Ouvrir » ouvre la console d'un PBX sans te reconnecter.</p></div>
      ${can("super", "admin") ? `<a class="btn" href="#/nouveau">+ Nouveau PBX</a>` : ""}</div>
    ${!d.signing?.configured && can("super") ? `<div class="flash warn">Pour créer des PBX ici, installe d'abord la clé de signature des licences : <a href="#/cle">Clé de signature</a>.</div>` : ""}
    <div id="dash"></div>
    <div class="panel pad stack">
      <div class="row" style="gap:12px;align-items:flex-end">
        <label style="flex:1;min-width:220px">Rechercher<input id="q" type="search" placeholder="Nom, entreprise, adresse, licence…" value="${esc(pbxFilter)}" autocomplete="off"></label>
        <label>État<select id="st"><option value="">Tous</option><option value="ok">En ligne</option><option value="bad">Hors ligne</option><option value="off">Désactivés</option></select></label>
      </div>
      <div class="hint" id="count"></div><div class="pbx-grid" id="cards"></div></div>`;
  $("#st").value = pbxStatus;
  $("#q").oninput = (e) => { pbxFilter = e.target.value; draw(); };
  $("#st").onchange = (e) => { pbxStatus = e.target.value; draw(); };
  app.onclick = async (e) => {
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
    try { d = await api("GET", "/api/pbx"); Object.assign(t, d.totals); draw(); } catch { /* prochain essai */ }
  }, 15000);
}

// ---------------------------------------------------------------- Nouveau PBX (licence créée et signée ici)
const toSlug = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/--+/g, "-").slice(0, 24).replace(/-+$/, "");
function importPanel() {
  return `<details class="panel" style="margin-top:20px" id="imp"><summary class="ph" style="cursor:pointer"><h2>Ou restaurer un PBX depuis une sauvegarde</h2><span class="hint">PBX installé seul, ou PBX supprimé de ce serveur</span></summary>
      <form id="if" class="stack pad" novalidate><div class="form-msg"></div>
        <p class="hint" style="margin:0">Sauvegarde faite depuis la console du PBX (Administration › Sauvegardes) : fichier <code>pbxmaison-….tar.gz</code>. Utilisateurs, trunks, messages, comptes et licence reviennent tels quels.</p>
        <label>Fichier de sauvegarde<input type="file" name="file" accept=".gz,.tgz,application/gzip"></label>
        <label>Nom sur le serveur<input name="slug" maxlength="24" spellcheck="false" autocapitalize="off" placeholder="boulangerie-dupont"></label>
        <div class="form-near"></div>
        <div class="actions"><button class="btn">Restaurer le PBX</button></div></form></details>`;
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
async function renderNew() {
  setNav("add", "Nouveau PBX");
  let o; try { o = await api("GET", "/api/pbx/options"); } catch (e) { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  if (!o.signing.configured) {
    app.innerHTML = `<h1>Nouveau PBX</h1><div class="panel pad stack"><div class="flash warn" style="margin:0">La clé de signature des licences n'est pas encore installée sur ce serveur.</div>
      ${can("super") ? `<p>Installe-la une fois (fichier <code>pbx-cle-privee.pem</code> rangé dans Psono) : <a class="btn sm" href="#/cle">Clé de signature</a></p>` : `<p>Demande au super administrateur de l'installer.</p>`}</div>
      ${importPanel()}<div id="job"></div>`;
    bindImport();
    return;
  }
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(l)}</option>`).join("");
  app.innerHTML = `<h1>Nouveau PBX</h1>
    <p class="sub">La licence est créée et signée ici ; le PBX est prêt en environ une minute.</p>
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
        <label>Édition<select name="edition">${opt(Object.entries(o.editions), "pro")}</select></label>
        <label>Appels simultanés<select name="simultaneous_calls">${opt(o.sc.map((n) => [n, `${n} appels`]), 8)}</select></label>
        <label>Durée<select name="duration_months">${opt(Object.entries(o.durations), 12)}</select></label>
      </fieldset>
      <fieldset><legend>Contact du client</legend>
        <label>E-mail du client<input name="admin_email" type="email" placeholder="contact@entreprise.fr" autocapitalize="off"><span class="hint">Pour les alertes du PBX. Les comptes de connexion se créent ensuite dans la console du PBX.</span></label>
        <label>Nom sur le serveur<input name="slug" maxlength="24" spellcheck="false" autocapitalize="off" placeholder="boulangerie-dupont"><span class="hint">Identifiant technique, rempli tout seul.</span></label>
      </fieldset>
      <div class="form-near full"></div>
      <div class="actions"><a class="btn ghost" href="#/">Annuler</a><button class="btn">Créer le PBX</button></div></form></div>
    ${importPanel()}
    <div id="job"></div>`;
  bindImport();
  const form = $("#nf");
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
  if (h === "#/cle" && can("super")) return renderSigning();
  if (h === "#/journal" && can("super", "admin")) return renderAudit();
  return renderList();
}
window.addEventListener("hashchange", route);
loadState().then(route).catch((e) => { app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; });
