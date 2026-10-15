// Console web Callikoe — application monopage sans dépendance.
import { renderCallflow } from "./callflow-ui.js";
import { renderAdmin } from "./admin-ui.js";
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const FORMAT_LABELS = { national: "National (0412345678)", e164: "E.164 sans + (33412345678)", e164_plus: "E.164 avec + (+33412345678)", keep: "Inchangé" };
const fmtPhone = (n) => /^\+33\d{9}$/.test(n || "") ? ("0" + n.slice(3)).replace(/(\d{2})(?=\d)/g, "$1 ")
  : /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "—");

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
    copyText(b.dataset.copy).then((ok) => { const t = b.textContent; b.textContent = ok ? "Copié ✓" : "Sélectionne et copie (Ctrl+C)"; setTimeout(() => (b.textContent = t), 2000); });
  }));
}
// navigator.clipboard n'existe qu'en HTTPS : repli sur execCommand tant que le PBX est en HTTP.
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* repli */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove(); return ok;
}

const NI = {
  home: '<path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
  ext: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.3.2 4 1.7 4.5 4.5"/>',
  phones: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M9 17h6"/>',
  gw: '<rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 12.5h.01M11 12.5h.01M8 8V5M16 8V4"/>',
  cf: '<path d="M5 4v6a4 4 0 0 0 4 4h10"/><path d="m15 10 4 4-4 4"/><circle cx="5" cy="4" r="1.5"/>',
  out: '<path d="M7 17 17 7M9 7h8v8"/><path d="M4 20h7"/>',
  trunks: '<path d="M3 12h18M7 7l-4 5 4 5M17 7l4 5-4 5"/>',
  codes: '<path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M10 16h4" stroke-width="2.4"/><rect x="3" y="4" width="18" height="16" rx="3"/>',
  cdr: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  rec: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><circle cx="12" cy="10" r="2.3"/><path d="M8.5 16c.6-1.8 2-2.6 3.5-2.6s2.9.8 3.5 2.6"/>',
  sec: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  backup: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  updates: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
  alerts: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  licence: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h6M7 14h4"/><circle cx="17" cy="12" r="2"/>',
  sys: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  soft: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
  out2: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
};
const nicon = (k, s = 19) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NI[k] || ""}</svg>`;
const NAV = [
  ["", [["#/", "Tableau de bord", "home"]]],
  ["Téléphonie", [["#/utilisateurs", "Utilisateurs", "ext"], ["#/telephones", "Téléphones", "phones"], ["#/passerelles", "Passerelles et DECT", "gw"],
    ["#/gestion", "Gestion d'appels", "cf"], ["#/sortants", "Règles sortantes", "out"], ["#/trunks", "Trunks", "trunks"], ["#/codes", "Codes de raccourci", "codes"]]],
  ["Activité", [["#/journal", "Journal des appels", "cdr"], ["#/enregistrements", "Enregistrements", "rec"], ["#/annuaire", "Annuaire", "book"]]],
  ["Administration", [["#/securite", "Sécurité", "sec"], ["#/sauvegardes", "Sauvegardes", "backup"], ["#/mises-a-jour", "Mises à jour", "updates"],
    ["#/alertes", "Alertes", "alerts"], ["#/licence", "Licence", "licence"], ["#/systeme", "Système", "sys"]]],
];
const NAV_LABEL = Object.fromEntries(NAV.flatMap(([g, items]) => items.map(([, l, k]) => [k, [g, l]])));
function setNav(active) {
  const on = !!state?.logged_in;
  document.body.classList.toggle("no-side", !on);
  document.body.classList.remove("side-open");
  $("#nav").innerHTML = on ? NAV.map(([g, items]) => `<div class="ng">${g ? `<span class="ngl">${g}</span>` : ""}${items.map(([h, l, k]) =>
    `<a href="${h}" class="${k === active ? "on" : ""}" ${k === active ? 'aria-current="page"' : ""}>${nicon(k)}<span>${l}</span></a>`).join("")}</div>`).join("") : "";
  $("#user").innerHTML = on ? `<a class="sf-link" href="/softphone" target="_blank" rel="noopener">${nicon("soft", 17)}<span>Softphone web</span></a>
    <div class="sf-user"><span class="sf-av">${esc((state.email || "?").charAt(0).toUpperCase())}</span><span class="sf-mail" title="${esc(state.email || "")}">${esc(state.email || "")}</span>
    <button id="logout" title="Se déconnecter" aria-label="Se déconnecter">${nicon("out2", 17)}</button></div>` : "";
  $("#logout")?.addEventListener("click", async () => { await api("POST", "/api/logout"); state.logged_in = false; location.hash = "#/"; route(); });
  const [g, l] = NAV_LABEL[active] || ["", ""];
  $("#crumb").innerHTML = on && l ? `${g ? `<span>${g}</span><b>›</b>` : ""}<strong>${l}</strong>` : "";
  $("#pbx-name").textContent = state?.pbx?.name || "Console PBX";
  document.title = state?.pbx?.name ? `${l ? l + " · " : ""}${state.pbx.name}` : "Console Callikoe";
}
document.addEventListener("click", (e) => {
  if (e.target.closest("#burger")) document.body.classList.toggle("side-open");
  else if (e.target.closest("#sidescrim") || e.target.closest("#nav a")) document.body.classList.remove("side-open");
});

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
  if (n.dns_managed && !n.dns_ok) n.auto = true;
  const dnsLine = n.auto ? `<span class="pill ok">Automatique</span> ${esc(p.fqdn)} sera créé vers ${esc(n.public_ip)} pendant l'installation`
    : n.dns_ok ? `<span class="pill ok">OK</span> ${esc(p.fqdn)} → ${esc(n.dns_ip)}`
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
    ${n.dns_ok || n.auto ? "" : `<div class="pad"><div class="note">Sans DNS correct, le PBX fonctionne mais <strong>sans certificat HTTPS</strong>.
      Crée l'enregistrement <strong>A</strong> <code>${esc(p.fqdn)}</code> → <code>${esc(n.public_ip)}</code> chez ton hébergeur DNS,
      puis vérifie à nouveau (la propagation peut prendre quelques minutes). Tu pourras aussi obtenir le certificat plus tard, depuis « Système ».</div></div>`}
    ${n.behind_nat ? `<div class="pad"><div class="note">Machine derrière une box : redirige vers <code>${esc(n.local_ip)}</code> les ports UDP 5060, TCP 5060-5061, UDP 10000-20000, TCP 80 et 443, et désactive le « SIP ALG ».</div></div>` : ""}
    <div class="pad row" style="border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn ghost" id="back">Autre fichier</button>
      ${n.dns_ok || n.auto ? "" : `<button class="btn ghost" id="recheck">Vérifier à nouveau le DNS</button>`}
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
  let fails = 0, last = null;
  // Adresse HTTPS obtenue pendant l'installation : l'assistant continue là-bas (même jeton)
  const httpsUrl = (steps) => {
    const m = /https:\/\/([A-Za-z0-9.-]+)/.exec((steps || []).find((x) => x.step === "certificat" && x.status === "ok")?.message || "");
    return m && location.protocol === "http:" ? `https://${m[1]}/?jeton=${encodeURIComponent(setupToken())}` : null;
  };
  const poll = async () => {
    let p;
    try { p = await api("GET", "/api/setup/progress"); fails = 0; } catch (e) {
      // Le serveur web a pu basculer en HTTPS (certificat obtenu) : proposer d'y continuer
      if (++fails === 6) {
        const u = httpsUrl(last?.steps) || (wiz.check?.pbx?.fqdn ? `https://${wiz.check.pbx.fqdn}/?jeton=${encodeURIComponent(setupToken())}` : null);
        $("#prog").insertAdjacentHTML("beforeend", `<div class="pad" id="lost" style="border-top:1px solid var(--line)"><p style="margin-top:0"><strong>La page ne reçoit plus l'avancement.</strong> Le serveur web vient probablement de passer en HTTPS : l'installation continue de son côté.</p>
          ${u ? `<a class="btn" href="${esc(u)}">Continuer en HTTPS</a>` : `<button class="btn" onclick="location.reload()">Recharger la page</button>`}</div>`);
      }
      return;
    }
    last = p;
    $("#prog").innerHTML = p.steps.length ? progressList(p.steps) : `<div class="pad hint">Démarrage…</div>`;
    if (!p.running && p.ok !== null) {
      clearInterval(timer);
      const u = p.ok && httpsUrl(p.steps);
      if (u) { $("#prog").insertAdjacentHTML("beforeend", `<div class="pad hint" style="border-top:1px solid var(--line)">Passage en HTTPS…</div>`); setTimeout(() => location.assign(u), 1500); return; }
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
      <a class="card" href="#/utilisateurs"><div class="k">Postes connectés</div><div class="v">${d.extensions.registered}<small> / ${d.extensions.total}</small></div>
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
          <li>${d.extensions.total ? "✔ " : ""}<a href="#/utilisateurs">Créer les postes</a> et les saisir dans les téléphones</li>
          <li><a href="#/routes">Choisir qui sonne</a> sur les appels entrants et le trunk de sortie</li>
        </ol></div></div>
    </div>
    <div class="panel" style="margin-top:18px"><div class="ph"><h2>Appels en cours</h2><a href="#/appels" class="s">Plein écran</a></div><div id="dcalls"><div class="empty"><span class="spin"></span></div></div></div>`;
  const drawCalls = async () => {
    if ((location.hash || "#/") !== "#/" || !$("#dcalls")) return clearInterval(timer);
    let c; try { c = await api("GET", "/api/calls"); } catch { return; }
    $("#dcalls").innerHTML = callsTable(c);
  };
  clearInterval(timer); await drawCalls(); timer = setInterval(drawCalls, 3000);
}

function callsTable(d) {
  if (!d.available) return `<div class="empty">Moteur téléphonique injoignable.</div>`;
  if (!d.calls.length) return `<div class="empty">Aucun appel en cours.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Sens</th><th>De</th><th>Vers</th><th class="hide-sm">Trunk</th><th>État</th><th>Durée</th></tr></thead>
    <tbody>${d.calls.map((c) => `<tr><td>${esc(c.direction)}</td><td class="mono">${esc(c.from)}</td><td class="mono">${esc(c.to)}</td>
      <td class="hide-sm">${esc(c.trunk || "—")}</td><td><span class="pill ${c.state === "En communication" ? "ok" : "wait"}">${esc(c.state)}</span></td>
      <td class="mono">${fmtDur(c.duration)}</td></tr>`).join("")}</tbody></table></div>`;
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
        <td>${esc(fmtPhone(t.number.startsWith("33") ? "+" + t.number : t.number))}<div class="s">présenté : ${esc(t.outbound_cid)}${t.dids.length ? ` · ${t.dids.length} SDA` : ""}</div></td>
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
    host: existing.host, proxy: existing.proxy, cid_format: existing.cid_format, dial_format: existing.dial_format, caller_format: existing.caller_format,
    dids: compactDids(existing.dids).join("\n") } : { template: "" });
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
      ${field("dids", "SDA de ce trunk", `<textarea name="dids" rows="4" placeholder="04 65 00 15 30&#10;04 65 00 15 40 - 04 65 00 15 49">${esc(v.dids || "")}</textarea>`, "Un numéro ou une tranche par ligne (ex. 04 65 00 15 40 - 04 65 00 15 49). Ils sont ensuite proposés dans les fiches utilisateurs et les règles entrantes.", "full")}
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

/** Regroupe les SDA consécutives en tranches lisibles. */
function compactDids(list = []) {
  const out = []; let start = null, prev = null;
  const flush = () => { if (start) out.push(start === prev ? fmtPhone(start) : `${fmtPhone(start)} - ${fmtPhone(prev)}`); };
  for (const d of [...list].sort()) {
    if (prev && d.length === prev.length && d.slice(0, -4) === prev.slice(0, -4) && Number(d.slice(-4)) === Number(prev.slice(-4)) + 1) { prev = d; continue; }
    flush(); start = d; prev = d;
  }
  flush(); return out;
}

// ---------------------------------------------------------------- Icônes d'appareils
const DEV_ICONS = {
  phone: '<path d="M4 4h16v9H4z M7 16h10v4H7z M9 13v3 M15 13v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  pc: '<path d="M3 4h18v12H3z M8 20h8 M12 16v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  mobile: '<path d="M7 2h10v20H7z M11 18h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  web: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18 M12 3c3 3.5 3 14.5 0 18 M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  unknown: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14 M12 17h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
const KIND_LABELS = { phone: "Téléphone de bureau", pc: "Softphone sur PC", mobile: "Appli mobile", web: "Softphone web", unknown: "Appareil inconnu" };
const deviceIcon = (kind = "unknown", extra = "") => `<span class="dev ${kind}" title="${esc(KIND_LABELS[kind] || "")}${extra ? " · " + esc(extra) : ""}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${DEV_ICONS[kind] || DEV_ICONS.unknown}</svg></span>`;
const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} j`;
};

/** Bouton « Incarner » : ouvre le softphone web connecté en tant que l'utilisateur. */
function wireImpersonate(root) {
  root.querySelectorAll("[data-imp]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const w = window.open("about:blank", "_blank"); // ouvert tout de suite pour ne pas être bloqué
    try {
      const r = await api("POST", `/api/extensions/${b.dataset.imp}/impersonate`);
      if (w) w.location = r.url; else location.href = r.url;
    } catch (err) { w?.close(); alert(err.message); }
  });
}

/** Boutons « Reprovisionner » / « Redémarrer » (data-resync / data-reboot = poste). */
function wireResync(root) {
  root.querySelectorAll("[data-resync],[data-reboot]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const reboot = !!b.dataset.reboot, id = b.dataset.reboot || b.dataset.resync;
    if (reboot && !confirm(`Redémarrer le téléphone du poste ${id} ? Un appel en cours serait coupé.`)) return;
    const t = b.textContent; b.disabled = true;
    try { await api("POST", `/api/extensions/${id}/phone/notify`, { action: reboot ? "reboot" : "resync" }); b.textContent = "Envoyé ✓"; }
    catch (err) { b.textContent = "Échec"; b.title = err.message; }
    setTimeout(() => { b.textContent = t; b.disabled = false; }, 2500);
  });
}

// ---------------------------------------------------------------- Téléphones
async function renderPhones() {
  setNav("phones");
  const d = await api("GET", "/api/phones");
  const filter = sessionStorage.getItem("pbxm_phones_f") || "all";
  const on = d.phones.filter((p) => p.online).length;
  app.innerHTML = `${takeFlash()}<div class="bar"><div class="grow"><h1>Téléphones</h1><p class="sub" style="margin:0">Tous les appareils : téléphones de bureau, softphones et applis.</p></div>
    ${on ? `<button class="btn ghost" id="resyncall">Reprovisionner tous les connectés (${on})</button>` : ""}</div>
    <div class="cards"><div class="card"><div class="k">Connectés</div><div class="v">${on}</div></div>
      <div class="card"><div class="k">Déconnectés</div><div class="v">${d.phones.length - on}</div></div>
      <div class="card"><div class="k">Lien de provisioning</div><div class="s mono" style="word-break:break-all;margin-top:6px">${esc(d.provisioning_url)}</div>
        <button class="copy" style="margin-top:6px" data-copy="${esc(d.provisioning_url)}">Copier</button></div></div>
    <div class="panel"><div class="filters"><div class="seg" id="pf">${[["all", "Tous"], ["on", "Connectés"], ["off", "Déconnectés"]].map(([k, l]) => `<label class="${filter === k ? "on" : ""}"><input type="radio" name="pf" value="${k}" ${filter === k ? "checked" : ""}>${l}</label>`).join("")}</div></div>
    ${d.phones.length ? `<div class="table-wrap"><table>
      <thead><tr><th>État</th><th>Appareil</th><th class="hide-sm">MAC</th><th>Utilisateur</th><th>Depuis</th><th class="hide-sm">IP publique / locale</th><th class="hide-sm">Connexion</th><th></th></tr></thead>
      <tbody id="prows"></tbody></table></div>`
      : `<div class="empty">Aucun appareil pour l'instant. Renseigne le modèle et l'adresse MAC dans la fiche d'un utilisateur (onglet Téléphone IP), ou connecte un softphone.</div>`}</div>`;
  copyButtons();
  const draw = () => {
    const f = app.querySelector("#pf input:checked")?.value || "all";
    sessionStorage.setItem("pbxm_phones_f", f);
    app.querySelectorAll("#pf label").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
    const rows = $("#prows"); if (!rows) return;
    rows.innerHTML = d.phones.filter((p) => f === "all" || (f === "on") === p.online).map((p) => `<tr class="click" data-href="#/utilisateurs/${esc(p.user.id)}/telephone">
      <td>${p.online ? '<span class="pill ok">Connecté</span>' : '<span class="pill off">Déconnecté</span>'}</td>
      <td><span class="devcell">${deviceIcon(p.device.kind)}<span>${esc(p.model || "—")}${p.firmware ? `<div class="s">firmware ${esc(p.firmware)}</div>` : !p.model && p.user_agent ? `<div class="s">${esc(p.user_agent)}</div>` : ""}</span></span></td>
      <td class="hide-sm mono">${esc(fmtMac(p.mac)) || "—"}</td>
      <td><a href="#/utilisateurs/${esc(p.user.id)}">${esc(p.user.id)} · ${esc(p.user.name)}</a></td>
      <td>${p.since ? `${p.online ? "connecté depuis" : "déconnecté depuis"} <strong>${esc(ago(p.since))}</strong><div class="s">${esc(fmtDateTime(p.since))}</div>` : p.provisioned ? `<span class="s">jamais connecté · provisionné le ${esc(fmtDateTime(p.provisioned.at))}</span>` : '<span class="s">jamais connecté</span>'}</td>
      <td class="hide-sm mono">${esc(p.source_ip || "—")}${p.local_ip && p.local_ip !== p.source_ip ? `<div class="s">local ${esc(p.local_ip)}</div>` : ""}</td>
      <td class="hide-sm">${p.connection ? esc(p.connection.label) : "—"}</td>
      <td class="acts">${p.online ? `<button class="btn ghost sm" data-resync="${esc(p.user.id)}">Reprovisionner</button> <button class="btn ghost sm" data-reboot="${esc(p.user.id)}">Redémarrer</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="empty">Aucun appareil dans cette catégorie.</td></tr>';
    wireResync(rows);
    rows.querySelectorAll("tr.click").forEach((tr) => tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; });
  };
  app.querySelectorAll("#pf input").forEach((i) => i.addEventListener("change", draw));
  $("#resyncall")?.addEventListener("click", async (e) => {
    if (!confirm("Envoyer la configuration à tous les téléphones connectés ? Ils la rechargent sans redémarrer.")) return;
    const r = await api("POST", "/api/phones/resync"); e.target.textContent = `Envoyé à ${r.sent} appareil(s) ✓`;
  });
  draw();
  clearInterval(timer);
  timer = setInterval(() => location.hash === "#/telephones" && renderPhones(), 20000);
}

// ---------------------------------------------------------------- Utilisateurs
const STATUS_LABELS = { available: "Disponible", away: "Absent", dnd: "Ne pas déranger" };
const STATUS_CLS = { available: "ok", away: "wait", dnd: "bad" };
const DEST_LABELS = { voicemail: "Messagerie vocale", extension: "Autre utilisateur", external: "Numéro externe", hangup: "Raccrocher" };
const statusPill = (u) => u.disabled || u.options?.disabled ? '<span class="pill off">Désactivé</span>'
  : `<span class="pill ${STATUS_CLS[u.status]}">${STATUS_LABELS[u.status]}</span>`;

/** Lit un formulaire en objet imbriqué : name="forwarding.busy.type" → {forwarding:{busy:{type}}}. Cases à cocher : true/false. */
function formData(form) {
  const out = {};
  const put = (path, v) => { const k = path.split("."); let o = out; k.slice(0, -1).forEach((x) => (o = o[x] ??= {})); o[k.at(-1)] = v; };
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") put(el.name, el.checked);
    else if (el.type === "radio") { if (el.checked) put(el.name, el.value); }
    else put(el.name, el.value);
  }
  return out;
}

/** Affiche l'erreur du serveur sous le champ concerné (sans recharger : la saisie est conservée). */
function showFormError(form, err) {
  form.querySelectorAll(".has-err").forEach((l) => l.classList.remove("has-err"));
  form.querySelectorAll(".err.live").forEach((x) => x.remove());
  let label = err.field && [...form.querySelectorAll("[name]")].find((el) => el.name === err.field || el.name.startsWith(err.field + "."))?.closest("label, .dest");
  const box = document.createElement("span");
  box.className = "err live"; box.textContent = err.message;
  if (label) { label.classList.add("has-err"); label.append(box); label.scrollIntoView({ block: "center", behavior: "smooth" }); }
  else { const top = form.querySelector(".form-msg") || form; top.prepend(box); box.scrollIntoView({ block: "center" }); }
}

async function renderUsers() {
  setNav("ext");
  const d = await api("GET", "/api/extensions");
  const q = sessionStorage.getItem("pbxm_users_q") || "";
  const onlyFw = sessionStorage.getItem("pbxm_users_fw") === "1";
  app.innerHTML = `${takeFlash()}<div class="bar"><div class="grow"><h1>Utilisateurs</h1><p class="sub" style="margin:0">Un utilisateur = un poste (téléphone, softphone, DECT), ses renvois et sa messagerie.</p></div>
    <a class="btn" href="#/utilisateurs/nouveau">+ Ajouter un utilisateur</a></div>
    <div class="panel">
      <div class="filters"><input id="uq" type="search" placeholder="Rechercher : nom, poste, SDA, numéro de renvoi…" value="${esc(q)}">
        <label class="check"><input type="checkbox" id="ufw" ${onlyFw ? "checked" : ""}> Seulement ceux avec un renvoi actif</label></div>
      ${d.extensions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Poste</th><th>Nom</th><th>Statut</th><th class="hide-sm">Téléphone</th><th>Renvois</th><th></th></tr></thead>
      <tbody id="urows"></tbody></table></div><div id="unone" class="empty" hidden>Aucun utilisateur ne correspond.</div>`
      : `<div class="empty"><p>Aucun utilisateur pour l'instant.</p><a class="btn" href="#/utilisateurs/nouveau">Créer le premier utilisateur</a></div>`}</div>`;
  const rows = $("#urows");
  if (!rows) return;
  const draw = () => {
    const words = $("#uq").value.toLowerCase().replace(/\s+/g, " ").trim();
    const digits = words.replace(/[^\d]/g, "");
    const fw = $("#ufw").checked;
    sessionStorage.setItem("pbxm_users_q", $("#uq").value); sessionStorage.setItem("pbxm_users_fw", fw ? "1" : "0");
    const list = d.extensions.filter((x) => {
      if (fw && !x.forwards.length) return false;
      if (!words) return true;
      const hay = [x.id, x.name, x.email, x.mobile, ...x.dids, ...x.forwards.map((f) => f.text)].join(" ").toLowerCase();
      return hay.includes(words) || (digits.length >= 3 && hay.replace(/[^\d]/g, " ").replace(/(\d) (?=\d)/g, "$1").includes(digits));
    });
    rows.innerHTML = list.map((x) => `<tr class="click" data-href="#/utilisateurs/${esc(x.id)}">
      <td><strong>${esc(x.id)}</strong></td>
      <td><a href="#/utilisateurs/${esc(x.id)}">${esc(x.name)}</a>${x.email ? `<div class="s">${esc(x.email)}</div>` : ""}${x.dids.length ? `<div class="s">SDA ${x.dids.map(fmtPhone).map(esc).join(", ")}</div>` : ""}</td>
      <td>${statusPill(x)}</td>
      <td class="hide-sm">${x.registered ? `<span class="devs">${x.contacts.map((c) => deviceIcon(c.device?.kind, `${c.device?.label || c.user_agent} · ${c.ip}`)).join("")}<span class="pill ok">Connecté</span></span>` : '<span class="pill off">Non connecté</span>'}</td>
      <td>${x.forwards.length ? x.forwards.map((f) => `<div class="fw ${f.level}">${esc(f.text)}</div>`).join("") : '<span class="s">—</span>'}</td>
      <td class="acts"><button class="btn ghost sm" data-imp="${esc(x.id)}" title="Ouvrir le softphone web de cet utilisateur">Incarner</button>
        ${x.registered ? `<button class="btn ghost sm" data-resync="${esc(x.id)}" title="Renvoyer la configuration au téléphone">Reprovisionner</button>` : ""}</td></tr>`).join("");
    wireImpersonate(rows);
    wireResync(rows);
    $("#unone").hidden = list.length > 0;
    rows.querySelectorAll("tr.click").forEach((tr) => tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; });
  };
  $("#uq").addEventListener("input", draw);
  $("#ufw").addEventListener("change", draw);
  draw();
  clearInterval(timer);
  timer = setInterval(async () => {
    if (location.hash !== "#/utilisateurs" || document.activeElement === $("#uq")) return;
    renderUsers();
  }, 15000);
}

async function renderUserNew(from) {
  setNav("ext");
  clearInterval(timer);
  const d = await api("GET", "/api/extensions");
  const src = from ? d.extensions.find((x) => x.id === from) : null;
  app.innerHTML = `<h1>${src ? `Dupliquer ${esc(src.id)} · ${esc(src.name)}` : "Ajouter un utilisateur"}</h1>
    <p class="sub">${src ? "Copiés : renvois, statut, options, messagerie (nouveau code), numéro présenté, réglages du téléphone et touches BLF. Nouveaux identifiants SIP générés. Non copiés : SDA et adresse MAC." : "Le poste est créé avec ses identifiants SIP ; renvois et messagerie se règlent ensuite dans sa fiche."}</p>
    <div class="panel"><form method="post" class="grid" id="nf" novalidate><div class="form-msg full"></div>
      <label>Numéro de poste<input name="number" value="${esc(d.next)}" inputmode="numeric" maxlength="3" required><span class="hint">3 chiffres, de 100 à 999.</span></label>
      <span class="hide-sm"></span>
      <label>Prénom<input name="first_name" maxlength="40" autocomplete="off"></label>
      <label>Nom<input name="last_name" maxlength="40" autocomplete="off"></label>
      <label>E-mail<input name="email" type="email" maxlength="120" autocomplete="off"></label>
      <label>Mobile<input name="mobile" inputmode="tel" placeholder="06 12 34 56 78" autocomplete="off"><span class="hint">Pour les renvois et la sonnerie simultanée.</span></label>
      ${src ? `<input type="hidden" name="copy_from" value="${esc(src.id)}">` : ""}
      <div class="actions"><a class="btn ghost" href="${src ? `#/utilisateurs/${esc(src.id)}` : "#/utilisateurs"}">Annuler</a><button class="btn">${src ? "Créer la copie" : "Créer l'utilisateur"}</button></div>
    </form></div>`;
  $("#nf").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      const r = await api("POST", "/api/extensions", formData(e.target));
      flash = { text: `Utilisateur ${r.id} « ${r.name} » créé. Saisis ces identifiants dans le téléphone.` };
      location.hash = `#/utilisateurs/${r.id}/telephone`;
    } catch (err) { showFormError(e.target, err); btn.disabled = false; }
  };
}

const USER_TABS = [["general", "Général"], ["renvois", "Renvois d'appels"], ["telephone", "Téléphone IP"], ["touches", "Touches BLF"], ["messagerie", "Messagerie vocale"], ["options", "Options"]];
let phoneOpts = null;
const fmtMac = (m) => (m || "").toUpperCase().replace(/(..)(?=.)/g, "$1:");
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
const optList = (obj, cur, labelOf = (v) => Array.isArray(v) ? v[0] : v) =>
  Object.entries(obj).map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(cur) ? "selected" : ""}>${esc(labelOf(v))}</option>`).join("");

function destField(name, label, dest, users, selfId) {
  const others = users.filter((x) => x.id !== selfId);
  return `<div class="dest" data-dest="${name}"><span class="dl">${label}</span>
    <div class="row"><select name="${name}.type">${Object.entries(DEST_LABELS).map(([k, l]) => `<option value="${k}" ${dest.type === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select name="${name}.target" data-for="extension" ${dest.type === "extension" ? "" : "hidden disabled"}>
      <option value="">— Choisir —</option>${others.map((x) => `<option value="${esc(x.id)}" ${dest.type === "extension" && dest.target === x.id ? "selected" : ""}>${esc(x.id)} · ${esc(x.name)}</option>`).join("")}</select>
    <input name="${name}.target" data-for="external" inputmode="tel" placeholder="06 12 34 56 78" value="${dest.type === "external" ? esc(fmtPhone(dest.target)) : ""}" ${dest.type === "external" ? "" : "hidden disabled"}></div></div>`;
}
function wireDest(root) {
  root.querySelectorAll(".dest").forEach((box) => {
    const sel = box.querySelector("select[name$='.type']");
    const sync = () => box.querySelectorAll("[data-for]").forEach((el) => { const on = el.dataset.for === sel.value; el.hidden = !on; el.disabled = !on; });
    sel.addEventListener("change", sync);
  });
}

async function renderUser(id, tab = "general") {
  setNav("ext");
  clearInterval(timer);
  const [{ user: u, server }, list] = await Promise.all([api("GET", `/api/extensions/${id}`), api("GET", "/api/extensions")]);
  if ((tab === "telephone" || tab === "touches") && !phoneOpts) phoneOpts = await api("GET", "/api/phone-options");
  const users = list.extensions;
  const fw = u.forwarding;
  const tabs = `<nav class="tabs">${USER_TABS.map(([k, l]) => `<a href="#/utilisateurs/${esc(u.id)}${k === "general" ? "" : "/" + k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>`;
  const head = `<a class="back" href="#/utilisateurs">← Utilisateurs</a>
    <div class="bar"><div class="grow"><h1>${esc(u.id)} · ${esc(u.name)}</h1>
      <p class="sub" style="margin:0">${statusPill(u)} ${u.registered ? '<span class="pill ok">Téléphone connecté</span>' : '<span class="pill off">Téléphone non connecté</span>'}
      ${u.updated_by ? `<span class="s">· modifié le ${esc(new Date(u.updated_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))} par ${esc(u.updated_by)}</span>` : ""}</p></div>
      <a class="btn ghost" href="#/utilisateurs/nouveau?depuis=${esc(u.id)}">Dupliquer</a></div>
    ${u.forwards.length ? `<div class="note fwsum"><strong>En ce moment :</strong> ${u.forwards.map((f) => esc(f.text)).join(" · ")}</div>` : ""}${tabs}`;
  const save = `<div class="actions"><button class="btn">Enregistrer</button></div>`;
  let body = "";

  if (tab === "general") {
    body = `<form method="post" class="grid" id="uf" novalidate><div class="form-msg full"></div>
      <label>Numéro de poste<input value="${esc(u.id)}" readonly></label><span class="hide-sm"></span>
      <label>Prénom<input name="first_name" value="${esc(u.first_name)}" maxlength="40"></label>
      <label>Nom<input name="last_name" value="${esc(u.last_name)}" maxlength="40"></label>
      <label>E-mail<input name="email" type="email" value="${esc(u.email)}" maxlength="120"></label>
      <label>Mobile<input name="mobile" inputmode="tel" value="${esc(fmtPhone(u.mobile) === "—" ? "" : fmtPhone(u.mobile))}" placeholder="06 12 34 56 78"></label>
      <label>Numéro présenté (appels sortants)<input name="outbound_cid" inputmode="tel" value="${esc(u.outbound_cid ? fmtPhone(u.outbound_cid) : "")}" placeholder="Celui du trunk"><span class="hint">Vide = numéro du trunk. Doit être un numéro de ta ligne, sinon l'opérateur peut refuser l'appel.</span></label>
      <label>SDA attribuées<textarea name="dids" rows="3" placeholder="04 12 34 56 78">${esc(u.dids.map(fmtPhone).join("\n"))}</textarea><span class="hint">Un numéro par ligne. Les appels vers ces numéros sonnent directement chez cet utilisateur.</span><span class="hint" id="freedids"></span></label>
      ${save}</form>
      <div class="pad appbox" style="border-top:1px solid var(--line)">
        <h3 class="sec" style="margin:0 0 8px">Espace utilisateur et softphone web</h3>
        <p class="hint" style="margin:0 0 12px">L'utilisateur se connecte sur <a href="/softphone" target="_blank" rel="noopener">${esc(location.origin)}/softphone</a>
          avec son numéro de poste <strong>${esc(u.id)}</strong>${u.email ? ` ou son e-mail <strong>${esc(u.email)}</strong>` : ""} pour appeler depuis son navigateur.</p>
        <p style="margin:0 0 12px">${u.has_web_password ? '<span class="pill ok">Mot de passe défini</span>' : '<span class="pill off">Pas encore de mot de passe</span>'}</p>
        <div id="webpw"></div>
        <div class="row"><button type="button" class="btn ghost sm" id="genweb">${u.has_web_password ? "Générer un nouveau mot de passe" : "Générer le mot de passe"}</button>
          <button type="button" class="btn ghost sm" data-imp="${esc(u.id)}">Incarner (ouvrir son softphone)</button></div>
      </div>
      <div class="pad appbox" id="appqr" style="border-top:1px solid var(--line)"></div>`;
  } else if (tab === "renvois") {
    body = `<form method="post" id="uf" novalidate class="pad stack"><div class="form-msg"></div>
      <div><span class="dl">Statut actuel</span><div class="seg">${Object.entries(STATUS_LABELS).map(([k, l]) => `<label class="${u.status === k ? "on" : ""}"><input type="radio" name="status" value="${k}" ${u.status === k ? "checked" : ""}>${l}</label>`).join("")}</div>
        <span class="hint">Le statut choisit les règles appliquées ci-dessous.</span></div>
      <fieldset><legend>Disponible</legend>
        <label class="short">Délai de non-réponse<span class="suffix"><input name="forwarding.timeout" type="number" min="5" max="120" value="${esc(fw.timeout)}"><span>secondes</span></span></label>
        ${destField("forwarding.no_answer", "Si pas de réponse, transférer vers", fw.no_answer, users, u.id)}
        ${destField("forwarding.busy", "Si occupé ou téléphone non connecté, transférer vers", fw.busy, users, u.id)}
      </fieldset>
      <fieldset><legend>Absent</legend>${destField("forwarding.away", "Transférer tous les appels vers", fw.away, users, u.id)}</fieldset>
      <fieldset><legend>Ne pas déranger</legend>${destField("forwarding.dnd", "Transférer tous les appels vers", fw.dnd, users, u.id)}</fieldset>
      <fieldset><legend>Options</legend>
        <label class="check"><input type="checkbox" name="options.ring_mobile" ${u.options.ring_mobile ? "checked" : ""}> Faire sonner aussi mon mobile${u.mobile ? ` (${esc(fmtPhone(u.mobile))})` : " (renseigne-le dans Général)"}</label>
        <label class="check"><input type="checkbox" name="options.accept_group_calls" ${u.options.accept_group_calls ? "checked" : ""}> Recevoir les appels des groupes (route entrante « tous les postes »)</label>
      </fieldset>
      <p class="hint" style="margin:0">Les renvois vers l'extérieur passent par le trunk sortant et présentent le numéro du trunk. International et surtaxés interdits.</p>
      <div class="actions" style="padding-top:16px"><button class="btn">Enregistrer</button></div></form>`;
  } else if (tab === "telephone") {
    const host = server.host || server.fqdn;
    const ph = u.phone, st = ph.settings, o = phoneOpts;
    const lp = ph.last_provisioned;
    const localIp = u.contacts[0]?.local_ip;
    body = `<form method="post" id="uf" novalidate>
      <div class="grid nogap-top"><div class="form-msg full"></div>
        <h3 class="full sec">Téléphone et provisioning automatique</h3>
        <label>Modèle<select name="phone.model"><option value="">— Saisie manuelle / softphone —</option>${o.models.map((m) => `<option value="${m.id}" ${ph.model === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
        <label>Adresse MAC<input name="phone.mac" value="${esc(fmtMac(ph.mac))}" placeholder="44:DB:D2:29:FA:7B" autocomplete="off"><span class="hint">Sur l'étiquette sous le téléphone.</span></label>
        ${ph.mac ? `<div class="full provbox">
          <div><span class="dl">Lien de provisioning</span><span class="mono">${esc(o.provisioning_url)}</span> <button class="copy" type="button" data-copy="${esc(o.provisioning_url)}">Copier</button>
            <div class="hint">À saisir dans le téléphone (page web › Paramètres › Auto Provision › Server URL) ou en option DHCP 66. Le téléphone télécharge ensuite <span class="mono">${esc(ph.mac)}.cfg</span>.</div></div>
          <div class="row"><a class="btn ghost sm" href="/api/extensions/${esc(u.id)}/phone.cfg" download>Télécharger le .cfg</a>
            <button type="button" class="btn ghost sm" data-notify="resync" ${u.registered ? "" : "disabled"}>Reprovisionner</button>
            <button type="button" class="btn ghost sm" data-notify="reboot" ${u.registered ? "" : "disabled"}>Redémarrer</button></div>
          <div class="hint">Dernier provisioning : ${lp ? `${esc(fmtDateTime(lp.at))} depuis ${esc(lp.ip)}` : "jamais"}</div>
          <div><span class="dl">Page web du téléphone</span>${localIp ? `<a href="http://${esc(localIp)}" target="_blank" rel="noopener" class="mono">http://${esc(localIp)}</a> · ` : ""}utilisateur <span class="mono">admin</span> · mot de passe
            <span class="secret"><input type="password" readonly value="${esc(ph.admin_password)}" id="adminpw"></span> <button class="copy" type="button" data-copy="${esc(ph.admin_password)}">Copier</button>
            <button type="button" class="btn link" id="adminreset">Réinitialiser</button>
            <div class="hint">Appliqué au prochain provisioning.</div></div></div>` : ""}
        <h3 class="full sec">Réglages du téléphone</h3>
        <label>Langue<select name="phone.settings.language">${optList(o.languages, st.language)}</select></label>
        <label>Fuseau horaire<select name="phone.settings.timezone">${optList(o.timezones, st.timezone)}</select></label>
        <label>Format de la date<select name="phone.settings.date_format">${optList(o.date_formats, st.date_format)}</select></label>
        <label>Format de l'heure<select name="phone.settings.time_format">${optList(o.time_formats, st.time_format)}</select></label>
        <label>Délai d'extinction du rétroéclairage<select name="phone.settings.backlight">${optList(o.backlight, st.backlight)}</select></label>
        <label>Délai de l'économiseur d'écran<select name="phone.settings.screensaver">${optList(o.screensaver, st.screensaver)}</select></label>
        <label>Touche de transfert (BLF / numérotation rapide)<select name="phone.settings.transfer">${optList(o.transfer, st.transfer)}</select></label>
        <label>Voyant d'alimentation (LED) clignote pour<select name="phone.settings.led">${optList(o.led, st.led)}</select></label>
        <label>Transport SIP<select name="phone.settings.transport">${optList(o.transports, st.transport)}</select>${!server.tls ? '<span class="hint">TLS disponible une fois le certificat obtenu.</span>' : ""}</label>
        <label class="check" style="align-self:end"><input type="checkbox" name="phone.settings.lldp" ${st.lldp ? "checked" : ""}> LLDP activé (détection du VLAN voix)</label>
        ${save}</div></form>
      <h3 class="sec pad" style="border-top:1px solid var(--line);margin:0">Identifiants SIP (saisie manuelle ou softphone)</h3>
      <dl class="creds">
        <div><dt>Serveur / domaine</dt><dd><span class="mono">${esc(host)}</span> <button class="copy" data-copy="${esc(host)}">Copier</button>
          ${!server.dns_ok ? `<div class="s">Le FQDN ${esc(server.fqdn)} ne pointe pas encore vers ce serveur : utilise l'IP en attendant.</div>` : ""}</dd></div>
        <div><dt>Port</dt><dd>5060 (UDP ou TCP)${server.tls ? " · 5061 en TLS" : ""}</dd></div>
        <div><dt>Numéro / utilisateur</dt><dd><span class="mono">${esc(u.id)}</span> <button class="copy" data-copy="${esc(u.id)}">Copier</button></dd></div>
        <div><dt>ID d'authentification</dt><dd id="authid"><span class="s">…</span></dd></div>
        <div><dt>Mot de passe</dt><dd id="pw"><span class="s">…</span></dd></div>
        <div><dt>Appareil connecté</dt><dd>${u.contacts.length ? u.contacts.map((c) => `${esc(c.user_agent || "—")} · <span class="mono">${esc(c.ip)}</span>`).join("<br>") : '<span class="s">Aucun pour l\'instant</span>'}</dd></div>
      </dl>
      <div class="pad" style="border-top:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn ghost sm" id="regen">Générer un nouveau mot de passe SIP</button>
        <span class="hint">Avec le provisioning, le téléphone le reprend tout seul (bouton Reprovisionner).</span></div>`;
  } else if (tab === "touches") {
    const ph = u.phone, o = phoneOpts;
    const model = o.models.find((m) => m.id === ph.model);
    body = `<form method="post" id="kf" novalidate class="pad stack"><div class="form-msg"></div>
      <p class="hint" style="margin:0">${model ? `${esc(model.label)} : ${model.keys} touches programmables (sur plusieurs pages).` : "Choisis le modèle dans « Téléphone IP » pour connaître le nombre de touches."}
        Une touche <strong>BLF</strong> s'allume quand le collègue est en ligne, clignote quand il sonne : un appui intercepte l'appel.</p>
      <div class="keys" id="keys"></div>
      <div class="row"><button type="button" class="btn ghost sm" id="addkey">+ Ajouter une touche</button>
        <button type="button" class="btn ghost sm" id="addall">+ BLF pour tous les utilisateurs</button></div>
      <div class="actions" style="padding-top:16px"><button class="btn">Enregistrer</button></div></form>`;
  } else if (tab === "messagerie") {
    const vm = u.voicemail;
    body = `<form method="post" class="grid" id="uf" novalidate><div class="form-msg full"></div>
      <label class="check full"><input type="checkbox" name="voicemail.enabled" ${vm.enabled ? "checked" : ""}> Activer la messagerie vocale</label>
      <label>Code PIN<input name="voicemail.pin" type="password" inputmode="numeric" maxlength="8" value="${esc(vm.pin)}" autocomplete="new-password"><span class="hint">4 à 8 chiffres.</span></label>
      <span class="hide-sm"></span>
      <label class="check full"><input type="checkbox" name="voicemail.skip_pin" ${vm.skip_pin ? "checked" : ""}> Ne pas demander le code depuis son propre poste</label>
      <div class="note full">Consulter : <strong>*97</strong> depuis son poste, <strong>*98</strong> depuis un autre poste (numéro de boîte + code).
        Envoi des messages par e-mail : prévu dans une prochaine version.</div>
      ${save}</form>`;
  } else if (tab === "options") {
    body = `<form method="post" class="grid" id="uf" novalidate><div class="form-msg full"></div>
      <label class="check full"><input type="checkbox" name="options.disabled" ${u.options.disabled ? "checked" : ""}> Désactiver l'utilisateur <span class="hint">(ne reçoit plus d'appels, n'appelle plus que les urgences)</span></label>
      <label class="check full"><input type="checkbox" name="options.block_external" ${u.options.block_external ? "checked" : ""}> Interdire les appels externes <span class="hint">(appels internes et urgences toujours possibles)</span></label>
      <div class="note full">L'audio passe toujours par le PBX (indispensable derrière une box ou un pare-feu).</div>
      ${save}</form>
      <div class="pad" style="border-top:1px solid var(--line)" id="delzone"><h2 style="margin-bottom:8px">Supprimer l'utilisateur</h2>
        <p class="hint">Le poste ${esc(u.id)}, ses identifiants et sa messagerie seront supprimés.</p>
        <button class="btn danger sm" id="udel">Supprimer ${esc(u.id)}…</button></div>`;
  }

  app.innerHTML = `${takeFlash()}${head}<div class="panel tabbed">${body}</div>`;
  copyButtons();
  wireDest(app);
  app.querySelectorAll(".seg input").forEach((i) => i.addEventListener("change", () => app.querySelectorAll(".seg label").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked))));

  const form = $("#uf");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    const data = formData(form);
    if (typeof data.dids === "string") data.dids = data.dids.split("\n");
    try {
      await api("PUT", `/api/extensions/${u.id}`, data);
      flash = { text: "Enregistré et appliqué." };
      renderUser(u.id, tab);
    } catch (err) { showFormError(form, err); if (btn) btn.disabled = false; }
  };
  if (tab === "touches") wireKeys(u, users);
  if (tab === "general") {
    wireAppQr(u);
    wireImpersonate(app);
    $("#genweb").onclick = async () => {
      if (u.has_web_password && !confirm("Générer un nouveau mot de passe ? L'ancien ne fonctionnera plus.")) return;
      const r = await api("POST", `/api/extensions/${u.id}/web-password`);
      $("#webpw").innerHTML = `<div class="note" style="margin-bottom:12px">Mot de passe de l'espace utilisateur : <span class="mono" style="font-size:15px;font-weight:600">${esc(r.password)}</span>
        <button class="copy" data-copy="${esc(r.password)}">Copier</button><br><span class="hint">Note-le maintenant : il ne sera plus affiché. À transmettre à ${esc(u.name)}.</span></div>`;
      copyButtons($("#webpw"));
    };
    api("GET", "/api/trunks").then((trunks) => {
      const used = new Set(users.flatMap((x) => x.dids));
      const free = trunks.flatMap((t) => t.dids).filter((x) => !used.has(x));
      if (free.length && $("#freedids")) $("#freedids").textContent = `Libres sur les trunks : ${compactDids(free).slice(0, 6).join(", ")}${free.length > 6 ? "…" : ""}`;
    }).catch(() => {});
  }
  if (tab === "telephone") {
    app.querySelectorAll("[data-notify]").forEach((b) => b.onclick = async () => {
      if (b.dataset.notify === "reboot" && !confirm("Redémarrer le téléphone ? Un appel en cours serait coupé.")) return;
      try { await api("POST", `/api/extensions/${u.id}/phone/notify`, { action: b.dataset.notify }); b.textContent = "Envoyé ✓"; }
      catch (err) { flash = { cls: "bad", text: err.message }; renderUser(u.id, tab); }
    });
    $("#adminreset")?.addEventListener("click", async () => {
      if (!confirm("Générer un nouveau mot de passe pour la page web du téléphone ?")) return;
      await api("POST", `/api/extensions/${u.id}/phone/admin`); flash = { text: "Nouveau mot de passe généré : il sera appliqué au prochain provisioning." }; renderUser(u.id, tab);
    });
    const showSecret = (s) => {
      $("#authid").innerHTML = `<span class="mono">${esc(s.auth_id)}</span> <button class="copy" data-copy="${esc(s.auth_id)}">Copier</button>`;
      $("#pw").innerHTML = `<span class="secret"><input type="password" readonly value="${esc(s.password)}" class="mono"></span> <button class="copy" data-copy="${esc(s.password)}">Copier</button>`;
      copyButtons($("#authid")); copyButtons($("#pw"));
    };
    showSecret(await api("GET", `/api/extensions/${u.id}/secret`));
    $("#regen").onclick = async () => {
      if (!confirm("Générer un nouveau mot de passe ? L'ancien ne fonctionnera plus.")) return;
      showSecret(await api("POST", `/api/extensions/${u.id}/secret`));
    };
  }
  $("#udel")?.addEventListener("click", async () => {
    const imp = await api("GET", `/api/extensions/${u.id}/impact`);
    const items = [
      ...imp.forwards.map((f) => `<li><strong>${esc(f.id)} · ${esc(f.name)}</strong> renvoie vers ce poste ${esc(f.rules.join(", "))} → sera remplacé par <strong>${esc(f.replaced_by)}</strong>.</li>`),
      ...(imp.dids.length ? [`<li>SDA attribuées (${imp.dids.map(fmtPhone).map(esc).join(", ")}) : elles iront à la route entrante générale.</li>`] : []),
      ...(imp.inbound_alone ? ['<li><strong>C\'est le seul poste de la route entrante :</strong> les appels entrants n\'auront plus de destination.</li>']
        : imp.inbound_route ? ["<li>Il sera retiré de la route entrante.</li>"] : []),
    ];
    $("#delzone").innerHTML = `<div class="warnbox"><h2>${items.length ? "⚠ Attention" : "Confirmer la suppression"}</h2>
      ${items.length ? `<p>Supprimer <strong>${esc(u.id)} · ${esc(u.name)}</strong> aura ces conséquences :</p><ul>${items.join("")}</ul>`
        : `<p>Aucun renvoi ni aucune route ne dépend de <strong>${esc(u.id)} · ${esc(u.name)}</strong>.</p>`}
      <div class="row"><button class="btn ghost sm" id="delno">Annuler</button><button class="btn danger sm" id="delyes">${items.length ? "Supprimer quand même" : `Supprimer ${esc(u.id)}`}</button></div></div>`;
    $("#delzone").scrollIntoView({ block: "center", behavior: "smooth" });
    $("#delno").onclick = () => renderUser(u.id, tab);
    $("#delyes").onclick = async () => {
      try {
        await api("DELETE", `/api/extensions/${u.id}?force=1`);
        flash = { text: `Utilisateur ${u.id} supprimé.${imp.forwards.length ? ` Renvois modifiés : ${imp.forwards.map((f) => f.id).join(", ")}.` : ""}` };
        location.hash = "#/utilisateurs";
      } catch (err) { flash = { cls: "bad", text: err.message }; renderUser(u.id, tab); }
    };
  });
}

async function wireAppQr(u) {
  const box = $("#appqr"); if (!box) return;
  const idle = (st) => {
    box.innerHTML = `<h3 class="sec" style="margin:0 0 8px">Application mobile</h3>
      <p class="hint" style="margin:0 0 12px">Un QR code à scanner dans l'application Callikoe pour configurer le poste ${esc(u.id)} sans rien saisir. Valable 2 jours.</p>
      ${st ? `<p style="margin:0 0 12px">Un QR code est actif jusqu'au <strong>${esc(fmtDateTime(st.expires_at))}</strong>${st.used_at ? ` · scanné le ${esc(fmtDateTime(st.used_at))}` : " · pas encore scanné"}.</p>` : ""}
      <div class="row"><button type="button" class="btn ghost sm" id="qrgen">${st ? "Générer un nouveau QR code" : "Générer le QR code"}</button>
      ${st ? '<button type="button" class="btn ghost sm" id="qrrev">Révoquer</button>' : ""}</div>`;
    $("#qrgen").onclick = async () => show(await api("POST", `/api/extensions/${u.id}/app-token`));
    $("#qrrev")?.addEventListener("click", async () => { await api("DELETE", `/api/extensions/${u.id}/app-token`); idle(null); });
  };
  const show = (t) => {
    box.innerHTML = `<h3 class="sec" style="margin:0 0 8px">Application mobile</h3>
      <div class="qr"><div class="qrimg">${t.qr_svg}</div><div>
        <p style="margin-top:0">Scanne ce QR code avec l'application Callikoe.<br>Valable jusqu'au <strong>${esc(fmtDateTime(t.expires_at))}</strong>.</p>
        <p class="hint">Il donne accès aux identifiants du poste ${esc(u.id)} : ne l'envoie qu'à son utilisateur. Un nouveau QR code annule le précédent.</p>
        <div class="row"><button type="button" class="btn ghost sm" id="qrrev">Révoquer</button><button type="button" class="btn ghost sm" id="qrprint">Imprimer</button></div></div></div>`;
    $("#qrrev").onclick = async () => { await api("DELETE", `/api/extensions/${u.id}/app-token`); idle(null); };
    $("#qrprint").onclick = () => { const w = window.open("", "_blank"); w.document.write(`<title>QR ${esc(u.id)}</title><body style="font:16px system-ui;text-align:center;padding:40px"><h2>${esc(u.id)} · ${esc(u.name)}</h2><div style="width:280px;margin:auto">${t.qr_svg}</div><p>Valable jusqu'au ${esc(fmtDateTime(t.expires_at))}</p></body>`); w.document.close(); w.print(); };
  };
  try { idle((await api("GET", `/api/extensions/${u.id}/app-token`)).active); } catch { box.remove(); }
}

function wireKeys(u, users) {
  const o = phoneOpts;
  let keys = u.phone.keys.map((k) => ({ ...k }));
  const others = users.filter((x) => x.id !== u.id);
  const box = $("#keys");
  const draw = () => {
    box.innerHTML = keys.length ? keys.map((k, i) => `<div class="keyrow" data-i="${i}">
      <span class="kn">${i + 1}</span>
      <select data-f="type">${Object.entries(o.key_types).map(([t, l]) => `<option value="${t}" ${k.type === t ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      ${k.type === "blf" ? `<select data-f="value"><option value="">— Utilisateur —</option>${others.map((x) => `<option value="${esc(x.id)}" ${k.value === x.id ? "selected" : ""}>${esc(x.id)} · ${esc(x.name)}</option>`).join("")}</select>`
        : k.type === "speed" ? `<input data-f="value" value="${esc(k.value)}" placeholder="Numéro" inputmode="tel">` : '<span class="kv"></span>'}
      ${k.type === "none" ? '<span class="kv"></span>' : `<input data-f="label" value="${esc(k.label)}" placeholder="${k.type === "line" ? "Libellé (facultatif)" : "Libellé"}" maxlength="24">`}
      <span class="kb"><button type="button" class="btn ghost sm" data-mv="-1" ${i === 0 ? "disabled" : ""} title="Monter">↑</button><button type="button" class="btn ghost sm" data-mv="1" ${i === keys.length - 1 ? "disabled" : ""} title="Descendre">↓</button><button type="button" class="btn ghost sm" data-rm title="Supprimer">✕</button></span>
    </div>`).join("") : '<p class="hint">Aucune touche.</p>';
    box.querySelectorAll(".keyrow").forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelectorAll("[data-f]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
        keys[i][el.dataset.f] = el.value;
        if (el.dataset.f === "type") { keys[i].value = ""; keys[i].label = ""; draw(); }
        if (el.dataset.f === "value" && keys[i].type === "blf") { keys[i].label = others.find((x) => x.id === el.value)?.name || ""; draw(); }
      }));
      row.querySelector("[data-rm]").onclick = () => { keys.splice(i, 1); draw(); };
      row.querySelectorAll("[data-mv]").forEach((b) => b.onclick = () => { const j = i + Number(b.dataset.mv); [keys[i], keys[j]] = [keys[j], keys[i]]; draw(); });
    });
  };
  $("#addkey").onclick = () => { keys.push({ type: "blf", value: "", label: "" }); draw(); };
  $("#addall").onclick = () => {
    const have = new Set(keys.filter((k) => k.type === "blf").map((k) => k.value));
    for (const x of others) if (!have.has(x.id)) keys.push({ type: "blf", value: x.id, label: x.name });
    draw();
  };
  draw();
  $("#kf").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("PUT", `/api/extensions/${u.id}`, { phone: { keys } });
      flash = { text: "Touches enregistrées. Le téléphone les reçoit au prochain provisioning (bouton Reprovisionner dans Téléphone IP)." };
      renderUser(u.id, "touches");
    } catch (err) { showFormError(e.target, err); }
  };
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
        <p class="hint" style="margin-top:0">Les postes cochés sonnent en même temps (45 s). Ceux qui sont absents, en « ne pas déranger », désactivés ou qui refusent les appels de groupe ne sonnent pas. Les SDA attribuées à un utilisateur (fiche utilisateur › Général) vont directement chez lui.</p>
        ${ext.extensions.length ? `<div class="chips">${ext.extensions.map((x) => `<label class="chip ${sel.has(x.id) ? "on" : ""}">
          <input type="checkbox" name="inbound" value="${esc(x.id)}" ${sel.has(x.id) ? "checked" : ""}> ${esc(x.id)} · ${esc(x.name)}</label>`).join("")}</div>`
          : `<p>Aucun poste : <a href="#/utilisateurs">crée d'abord un poste</a>.</p>`}
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
      <div class="panel">${callsTable(d)}</div>`;
  };
  clearInterval(timer); await draw(); timer = setInterval(draw, 2000);
}

// ---------------------------------------------------------------- Journal des appels
const DIR = { in: ["↙", "Entrant"], out: ["↗", "Sortant"], internal: ["⇄", "Interne"] };
const CST = { answered: ["ok", "Répondu"], missed: ["bad", "Manqué"], voicemail: ["wait", "Messagerie"], busy: ["wait", "Occupé"], failed: ["off", "Échec"] };
async function renderCdr() {
  setNav("cdr");
  clearInterval(timer);
  const f = JSON.parse(sessionStorage.getItem("pbxm_cdr") || '{"days":"7","direction":"","status":"","q":""}');
  const qs = new URLSearchParams(f).toString();
  const [d, live] = await Promise.all([api("GET", `/api/cdr?${qs}`), api("GET", "/api/calls").catch(() => ({ calls: [] }))]);
  const fmtWhen = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
  const sel = (name, opts) => `<select data-f="${name}">${opts.map(([v, l]) => `<option value="${v}" ${f[name] === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  app.innerHTML = `<div class="bar"><div class="grow"><h1>Journal des appels</h1><p class="sub" style="margin:0">Tous les appels du PBX : qui a appelé, qui a répondu, combien de temps.</p></div>
    <a class="btn ghost" href="/api/cdr.csv?${qs}">Exporter (CSV, Excel)</a></div>
    ${live.calls?.length ? `<div class="panel" style="margin-bottom:18px"><div class="ph"><h2>En cours (${live.calls.length})</h2><a href="#/appels" class="s">Suivre en direct</a></div>${callsTable(live)}</div>` : ""}
    <div class="panel"><div class="filters">
      <input type="search" data-f="q" placeholder="Numéro, nom, SDA, poste…" value="${esc(f.q)}">
      ${sel("days", [["1", "Aujourd'hui et hier"], ["7", "7 derniers jours"], ["30", "30 jours"], ["90", "90 jours"], ["366", "1 an"]])}
      ${sel("direction", [["", "Tous les sens"], ["in", "Entrants"], ["out", "Sortants"], ["internal", "Internes"]])}
      ${sel("status", [["", "Tous les statuts"], ["answered", "Répondus"], ["missed", "Manqués"], ["voicemail", "Messagerie"], ["busy", "Occupés"], ["failed", "Échecs"]])}
      <span class="s">${d.total} appel${d.total > 1 ? "s" : ""}</span></div>
    ${d.calls.length ? `<div class="table-wrap"><table class="cdr"><thead><tr><th>Date</th><th>Sens</th><th>De</th><th>Vers</th><th>Répondu par</th><th>Durée</th><th>Statut</th></tr></thead><tbody>
      ${d.calls.map((c) => `<tr><td>${esc(fmtWhen(c.start))}</td><td title="${DIR[c.direction]?.[1] || ""}"><span class="dirc ${c.direction}">${DIR[c.direction]?.[0] || ""}</span></td>
        <td><strong>${esc(fmtPhone(c.from.number))}</strong>${c.from.name ? `<div class="s">${esc(c.from.name)}</div>` : ""}</td>
        <td>${esc(fmtPhone(c.to.number))}${c.rule ? `<div class="s">Règle « ${esc(c.rule)} »</div>` : ""}${c.direction === "in" && c.did ? `<div class="s"><a href="#/gestion/traceur/${esc(c.did)}">Tracer la SDA</a></div>` : ""}</td>
        <td>${c.answered_by ? esc(c.answered_by) : c.voicemail ? `Messagerie ${esc(c.voicemail)}` : "—"}${c.rang.length > (c.answered_by ? 1 : 0) ? `<div class="s">A sonné : ${esc(c.rang.join(", "))}</div>` : ""}</td>
        <td>${c.talk ? fmtDur(c.talk) : "—"}<div class="s">total ${fmtDur(c.duration)}</div></td>
        <td><span class="pill ${CST[c.status]?.[0] || "off"}">${CST[c.status]?.[1] || esc(c.status)}</span></td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Aucun appel sur cette période.</div>'}</div>`;
  const save = () => { app.querySelectorAll("[data-f]").forEach((el) => { f[el.dataset.f] = el.value; }); sessionStorage.setItem("pbxm_cdr", JSON.stringify(f)); renderCdr(); };
  app.querySelectorAll("select[data-f]").forEach((el) => el.onchange = save);
  let t; app.querySelector("input[data-f=q]").oninput = () => { clearTimeout(t); t = setTimeout(() => { sessionStorage.setItem("pbxm_cdr_focus", "1"); save(); }, 400); };
  if (sessionStorage.getItem("pbxm_cdr_focus")) { sessionStorage.removeItem("pbxm_cdr_focus"); const i = app.querySelector("input[data-f=q]"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

// ---------------------------------------------------------------- Annuaire de l'entreprise
const PTYPES = { work: "Bureau", mobile: "Mobile", home: "Domicile", other: "Autre" };
async function renderContacts(editId) {
  setNav("book");
  clearInterval(timer);
  const q = sessionStorage.getItem("pbxm_book_q") || "";
  const { contacts } = await api("GET", `/api/contacts?q=${encodeURIComponent(q)}`);
  const all = q ? (await api("GET", "/api/contacts")).contacts : contacts;
  const cur = editId && editId !== "nouveau" ? all.find((c) => c.id === editId) : null;
  const editing = editId === "nouveau" || cur;
  const c = cur || { first_name: "", last_name: "", company: "", email: "", notes: "", phones: [{ type: "work", number: "" }, { type: "mobile", number: "" }] };
  app.innerHTML = `${takeFlash()}<div class="bar"><div class="grow"><h1>Annuaire</h1><p class="sub" style="margin:0">Contacts de l'entreprise : visibles dans le softphone et sur les téléphones Yealink, et nom affiché quand ils appellent.</p></div>
    <a class="btn ghost" href="/api/contacts.csv">Exporter</a><button class="btn ghost" id="imp">Importer un CSV</button><a class="btn" href="#/annuaire/nouveau">+ Ajouter un contact</a></div>
    <input type="file" id="impf" accept=".csv,text/csv" hidden>
    <div id="impbox"></div>
    ${editing ? `<div class="panel" style="margin-bottom:18px"><div class="ph"><h2>${cur ? "Modifier le contact" : "Nouveau contact"}</h2></div>
      <form id="cf" class="grid" novalidate>
        <label>Prénom<input name="first_name" value="${esc(c.first_name)}"></label><label>Nom<input name="last_name" value="${esc(c.last_name)}"></label>
        <label>Société<input name="company" value="${esc(c.company)}"></label><label>E-mail<input name="email" type="email" value="${esc(c.email)}"></label>
        <div class="full" id="phs"></div>
        <label class="full">Notes<textarea name="notes" rows="2">${esc(c.notes)}</textarea></label>
        <div class="form-msg full"></div>
        <div class="actions">${cur ? '<button type="button" class="btn ghost" id="cdel">Supprimer</button>' : ""}<a class="btn ghost" href="#/annuaire">Annuler</a><button class="btn">Enregistrer</button></div>
      </form></div>` : ""}
    <div class="panel"><div class="filters"><input type="search" id="bq" placeholder="Rechercher : nom, société, numéro…" value="${esc(q)}"><span class="s">${contacts.length} contact${contacts.length > 1 ? "s" : ""}</span></div>
    ${contacts.length ? `<div class="table-wrap"><table><thead><tr><th>Nom</th><th>Société</th><th>Numéros</th><th>E-mail</th><th></th></tr></thead><tbody>
      ${contacts.map((x) => `<tr><td><a href="#/annuaire/${esc(x.id)}">${esc(`${x.first_name} ${x.last_name}`.trim() || "—")}</a></td><td>${esc(x.company)}</td>
        <td>${x.phones.map((p) => `${esc(fmtPhone(p.number))} <span class="s">${PTYPES[p.type]}</span>`).join("<br>")}</td><td>${esc(x.email)}</td>
        <td class="acts"><a class="btn ghost sm" href="#/annuaire/${esc(x.id)}">Modifier</a></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">${q ? "Aucun résultat." : "L'annuaire est vide : ajoute des contacts ou importe un fichier CSV (Prénom ; Nom ; Société ; Téléphone ; Mobile ; E-mail)."}</div>`}</div>`;
  let t; $("#bq").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { sessionStorage.setItem("pbxm_book_q", e.target.value); renderContacts(editId).then(() => { const i = $("#bq"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); };
  $("#imp").onclick = () => $("#impf").click();
  $("#impf").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const buf = await f.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("\ufffd")) text = new TextDecoder("windows-1252").decode(buf); // CSV Excel en ANSI
    const replace = confirm("Remplacer tout l'annuaire par ce fichier ?\n\nOK : remplacer — Annuler : ajouter / mettre à jour (même numéro = même contact)");
    try {
      const r = await api("POST", "/api/contacts/import", { csv: text, replace });
      $("#impbox").innerHTML = `<div class="flash">${r.imported} contact${r.imported > 1 ? "s" : ""} importé${r.imported > 1 ? "s" : ""}.${r.errors.length ? ` ${r.errors.length} ligne(s) ignorée(s) : ${r.errors.slice(0, 5).map((x) => `ligne ${x.line} (${esc(x.error)})`).join(", ")}${r.errors.length > 5 ? "…" : ""}` : ""}</div>`;
      setTimeout(() => renderContacts(), 2500);
    } catch (err) { $("#impbox").innerHTML = `<div class="flash bad">${esc(err.message)}</div>`; }
  };
  if (!editing) return;
  const phones = c.phones.map((p) => ({ ...p }));
  const drawPh = () => {
    $("#phs").innerHTML = `<span class="dl">Numéros</span>${phones.map((p, i) => `<div class="phrow"><select data-pt="${i}">${Object.entries(PTYPES).map(([k, l]) => `<option value="${k}" ${p.type === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      <input data-pn="${i}" inputmode="tel" value="${esc(fmtPhone(p.number) === "—" ? "" : fmtPhone(p.number))}" placeholder="04 12 34 56 78"><button type="button" class="ic" data-pr="${i}">✕</button></div>`).join("")}
      <button type="button" class="btn ghost sm" id="padd">+ Numéro</button>`;
    app.querySelectorAll("[data-pt]").forEach((x) => x.onchange = () => { phones[x.dataset.pt].type = x.value; });
    app.querySelectorAll("[data-pn]").forEach((x) => x.oninput = () => { phones[x.dataset.pn].number = x.value; });
    app.querySelectorAll("[data-pr]").forEach((x) => x.onclick = () => { phones.splice(Number(x.dataset.pr), 1); drawPh(); });
    $("#padd").onclick = () => { phones.push({ type: "work", number: "" }); drawPh(); };
  };
  drawPh();
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    try { await api(cur ? "PUT" : "POST", `/api/contacts${cur ? "/" + cur.id : ""}`, { ...formData(e.target), phones }); flash = { text: "Contact enregistré." }; location.hash = "#/annuaire"; }
    catch (err) { showFormError(e.target, err); }
  };
  $("#cdel")?.addEventListener("click", async () => { if (!confirm("Supprimer ce contact ?")) return; await api("DELETE", `/api/contacts/${cur.id}`); flash = { text: "Contact supprimé." }; location.hash = "#/annuaire"; });
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

// ---------------------------------------------------------------- Gestion d'appels (module callflow-ui.js)
const cfHelpers = { api, esc, $, app, setNav, formData, showFormError, takeFlash: () => takeFlash(), setFlash: (f) => { flash = f; } };

// Pages d'administration (module admin-ui.js)
const adminHelpers = { ...cfHelpers, fmtPhone, copyButtons,
  /** Rappelle fn toutes les ms jusqu'à ce qu'elle renvoie true (arrêté en changeant de page). */
  poll: (fn, ms) => { clearInterval(timer); const run = async () => { try { if (await fn()) clearInterval(timer); } catch { /* réessaie */ } }; timer = setInterval(run, ms); run(); } };

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
    else if (h === "#/postes" || h === "#/utilisateurs") await renderUsers();
    else if (h === "#/telephones") await renderPhones();
    else if ((m = h.match(/^#\/utilisateurs\/nouveau(?:\?depuis=(\d{3}))?$/))) await renderUserNew(m[1]);
    else if ((m = h.match(/^#\/utilisateurs\/(\d{3})(?:\/(\w+))?$/))) await renderUser(m[1], m[2] || "general");
    else if ((m = h.match(/^#\/gestion(?:\/([\w-]+))?(?:\/(.+))?$/))) await renderCallflow(cfHelpers, m[1] || "routages", m[2] || null);
    else if (h === "#/routes") await renderRoutes();
    else if ((m = h.match(/^#\/(sortants|passerelles|codes|enregistrements|securite|sauvegardes|mises-a-jour|alertes|licence)(?:\/(.+))?$/))) await renderAdmin(adminHelpers, m[1], m[2] || null);
    else if (h === "#/appels") await renderCalls();  // accessible depuis le tableau de bord et le journal
    else if (h === "#/journal") await renderCdr();
    else if ((m = h.match(/^#\/annuaire(?:\/(\w+))?$/))) await renderContacts(m[1]);
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

// ---------------------------------------------------------------- Œil sur les mots de passe
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/></svg>';
function addPasswordEyes(root = document) {
  for (const input of root.querySelectorAll('input[type="password"]:not([data-eye])')) {
    input.dataset.eye = "1";
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.replaceWith(wrap);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "pw-eye"; btn.innerHTML = EYE;
    btn.title = btn.ariaLabel = "Afficher le mot de passe";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.title = btn.ariaLabel = show ? "Masquer le mot de passe" : "Afficher le mot de passe";
      input.focus();
    });
    wrap.append(input, btn);
  }
}
new MutationObserver(() => addPasswordEyes()).observe(document.body, { childList: true, subtree: true });
addPasswordEyes();
