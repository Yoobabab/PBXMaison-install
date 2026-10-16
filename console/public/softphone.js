import { renderPlanning, planningSummary } from "./planning-ui.js";
// Softphone web Callikoe — WebRTC via JsSIP, connecté au PBX par https://<fqdn>/ws
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = $("#root");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtNum = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const fmtDur = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const clean = (n) => String(n || "").replace(/[\s.\-()]/g, "").replace(/^\+33/, "0").replace(/^0033/, "0");
const isDialable = (s) => /^[\d*#+][\d*#\s.\-()]*$/.test(String(s || "").trim());
const initials = (name, fallback = "?") => {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return fallback;
  return ((p[0][0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
};
const STATUS = { available: "Disponible", away: "Absent", dnd: "Ne pas déranger" };
const fmtWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Aujourd'hui ${t}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Hier ${t}`;
  return `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })} ${t}`;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  let data = null; try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Erreur ${res.status}`), { status: res.status, field: data?.field });
  return data;
}

// ------------------------------------------------------------------ Icônes
const svg = (d, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  phone: (s) => `<svg viewBox="0 0 24 24" width="${s || 18}" height="${s || 18}" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>`,
  team: () => svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.3.2 4 1.7 4.5 4.5"/>'),
  calls: () => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  vm: () => svg('<circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/>'),
  gear: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  cal: () => svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h3M13 14h3M8 17.5h3"/>'),
  keypad: () => svg('<circle cx="6" cy="5" r="1.3"/><circle cx="12" cy="5" r="1.3"/><circle cx="18" cy="5" r="1.3"/><circle cx="6" cy="11" r="1.3"/><circle cx="12" cy="11" r="1.3"/><circle cx="18" cy="11" r="1.3"/><circle cx="6" cy="17" r="1.3"/><circle cx="12" cy="17" r="1.3"/><circle cx="18" cy="17" r="1.3"/><circle cx="12" cy="22" r="1.1"/>'),
  star: (on) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>`,
  x: () => svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  video: (s) => svg('<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="m15.5 10.5 5.5-3v9l-5.5-3"/>', s || 20),
  videooff: () => svg('<path d="M3 3l18 18M15.5 12.5V8.5a2 2 0 0 0-2-2H8M5 6.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8.5a2 2 0 0 0 1.6-.8M15.5 10.5l5.5-3v9"/>'),
  full: () => svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  chat: () => svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  send: () => svg('<path d="M4 12 20 4l-6 16-3-7z"/>'),
  book: () => svg('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><circle cx="12" cy="10" r="2.3"/><path d="M8.5 16c.6-1.8 2-2.6 3.5-2.6s2.9.8 3.5 2.6"/>'),
  back: () => svg('<path d="M15 5 8 12l7 7"/>'),
  search: () => svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', 18),
  mic: () => svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  micoff: () => svg('<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11c0 .8-.1 1.6-.4 2.3M12 17.5V21M3 3l18 18"/>'),
  pause: () => svg('<path d="M9 5v14M15 5v14"/>'),
  play: () => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>`,
  xfer: () => svg('<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>'),
  trash: () => svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 18),
  inArrow: () => svg('<path d="M17 7 7 17M7 9v8h8"/>', 18),
  outArrow: () => svg('<path d="M7 17 17 7M9 7h8v8"/>', 18),
  missed: () => svg('<path d="M4 7l6 6 4-4 6 6M20 10v5h-5"/>', 18),
  logout: () => svg('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>', 18),
  device: (k) => ({ phone: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M9 17h6"/>', 14), web: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 14), mobile: svg('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>', 14) })[k] || "",
};

// ------------------------------------------------------------------ Sons (WebAudio routé vers le périphérique choisi)
let audioCtx = null;
const toneDest = {};
function audioReady() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { return false; }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return true;
}
function toneOut(el) { // un flux WebAudio par sortie (sonnerie / tonalités), lu par un <audio> dont on choisit la sortie
  if (!toneDest[el]) {
    toneDest[el] = audioCtx.createMediaStreamDestination();
    const a = $(`#${el}`); a.srcObject = toneDest[el].stream; a.play().catch(() => {});
  }
  return toneDest[el];
}
function tone(pattern, el = "tones") { // pattern : [[fréquences], durée ms, silence ms]
  if (!audioReady()) return () => {};
  let stopped = false, nodes = [], timers = [];
  const out = toneOut(el);
  $(`#${el}`).play().catch(() => {});
  const play = () => {
    if (stopped) return;
    const [freqs, on, off] = pattern;
    const gain = audioCtx.createGain(); gain.gain.value = el === "ringer" ? 0.12 : 0.06; gain.connect(out);
    nodes = freqs.map((f) => { const o = audioCtx.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); return o; });
    timers.push(setTimeout(() => { nodes.forEach((o) => o.stop()); gain.disconnect(); timers.push(setTimeout(play, off)); }, on));
  };
  play();
  return () => { stopped = true; timers.forEach(clearTimeout); nodes.forEach((o) => { try { o.stop(); } catch { /* déjà arrêté */ } }); };
}
const RINGBACK = [[440], 1500, 3500];          // tonalité de retour d'appel (France : 440 Hz)
const RINGTONE = [[523, 659], 900, 1400];      // sonnerie d'appel entrant
document.addEventListener("pointerdown", () => { audioReady(); $("#sp-unlock")?.remove(); }, { capture: true });

const audioPrefs = () => store.get("callikoe_audio", { mic: "", spk: "", ring: "" });
async function applySinks() {
  const p = audioPrefs();
  for (const [id, dev] of [["remote", p.spk], ["tones", p.spk], ["ringer", p.ring || p.spk]]) {
    const el = $(`#${id}`);
    if (el?.setSinkId) await el.setSinkId(dev || "").catch(() => {});
  }
}
const micConstraint = () => { const m = audioPrefs().mic; return m ? { deviceId: { ideal: m } } : true; };

// ------------------------------------------------------------------ État
let me = null, contacts = [], ua = null, session = null, regState = "off", timer = null, startedAt = 0, stopTone = null;
let callInfo = null; // { direction, number, name }
let vmList = [], vmEnabled = false, drawerOpen = false, poll = null;
let page = "equipe", sub = "";
const histKey = () => `callikoe_hist_${me?.user.id}`;
const favKey = () => `callikoe_fav_${me?.user.id}`;
// Historique : celui du PBX (journal des appels) dès qu'il est chargé, sinon celui de ce navigateur
let serverCalls = null, directory = [];
async function loadDirectory() { try { directory = (await api("GET", "/api/u/contacts")).contacts; } catch { directory = []; } }
const dirByNumber = (n) => directory.find((c) => c.phones.some((p) => p.number === n));
const history = () => serverCalls || store.get(histKey(), []);
async function refreshCalls() {
  try { serverCalls = (await api("GET", "/api/u/calls")).calls; } catch { return; }
  badges();
  if (page === "appels") renderPage();
}
const addHistory = (h) => store.set(histKey(), [h, ...history()].slice(0, 200));
const favs = () => new Set(store.get(favKey(), []));
function toggleFav(id) { const f = favs(); f.has(id) ? f.delete(id) : f.add(id); store.set(favKey(), [...f]); }

function applyTheme() {
  const t = store.get("callikoe_theme", "auto");
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t;
}
applyTheme();

function toast(msg, kind = "ok") {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.append(box); }
  const t = document.createElement("div"); t.className = `toast ${kind}`; t.textContent = msg; box.append(t);
  setTimeout(() => t.classList.add("out"), 3200); setTimeout(() => t.remove(), 3700);
}

// ------------------------------------------------------------------ Connexion
function renderLogin(msg) {
  stopPolling();
  root.innerHTML = `<div class="sp-login-wrap"><div class="sp-login panel">
    <div class="sp-brand"><i></i><span>Callikoe</span></div>
    <h1>Espace utilisateur</h1>
    <p class="sub">Connecte-toi avec ton numéro de poste (ou ton e-mail) et le mot de passe fourni par ton administrateur.</p>
    ${msg ? `<div class="flash bad">${esc(msg)}</div>` : ""}
    <form id="lf" class="stack" method="post" novalidate>
      <label>Numéro de poste ou e-mail<input name="login" autocomplete="username" autofocus required></label>
      <label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Se connecter</button>
    </form></div></div>`;
  addEyes();
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    audioReady();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api("POST", "/api/u/login", fd); start(); } catch (err) { renderLogin(err.message); }
  };
}

// Mail de bienvenue : l'utilisateur choisit son mot de passe puis arrive sur son softphone
async function renderWelcome(token) {
  stopPolling();
  let info;
  try { info = await api("GET", `/api/u/welcome/${encodeURIComponent(token)}`); }
  catch (e) { history.replaceState(null, "", "/softphone"); return renderLogin(e.message); }
  root.innerHTML = `<div class="sp-login-wrap"><div class="sp-login panel">
    <div class="sp-brand"><i></i><span>Callikoe</span></div>
    <h1>Bienvenue${info.first_name ? ` ${esc(info.first_name)}` : ""}</h1>
    <p class="sub">Ton poste <strong>${esc(info.extension)}</strong>${info.pbx ? ` · ${esc(info.pbx)}` : ""} est prêt. Choisis ton mot de passe pour te connecter à ton softphone.</p>
    <div class="flash" style="margin-bottom:12px">Ton identifiant de connexion : <strong>${esc(info.email || info.extension)}</strong></div>
    <form id="wf" class="stack" method="post" novalidate>
      <input type="hidden" name="username" autocomplete="username" value="${esc(info.email || info.extension)}">
      <label>Mot de passe<input name="password" type="password" autocomplete="new-password" required><span class="hint">10 caractères minimum, lettres et chiffres.</span></label>
      <label>Confirmation<input name="confirm" type="password" autocomplete="new-password" required></label>
      <div id="wmsg"></div>
      <button class="btn" type="submit">Enregistrer et ouvrir mon softphone</button>
    </form></div></div>`;
  addEyes();
  $("#wf").onsubmit = async (e) => {
    e.preventDefault();
    audioReady();
    const fd = Object.fromEntries(new FormData(e.target));
    const msg = (t) => { $("#wmsg").innerHTML = `<div class="flash bad">${esc(t)}</div>`; };
    if (fd.password !== fd.confirm) return msg("Les deux mots de passe sont différents.");
    try { await api("POST", `/api/u/welcome/${encodeURIComponent(token)}`, { password: fd.password }); history.replaceState(null, "", "/softphone"); start(); }
    catch (err) { msg(err.message); }
  };
}

async function start() {
  try { me = await api("GET", "/api/u/me"); } catch (e) { if (e.status === 401) return renderLogin(); root.innerHTML = `<div class="flash bad" style="margin:40px">${esc(e.message)}</div>`; return; }
  contacts = me.contacts;
  setTitle();
  renderShell();
  route();
  applySinks();
  connect();
  refreshVoicemail();
  refreshCalls();
  loadChats();
  startEvents();
  loadDirectory().then(() => { if (page === "appels" || page === "contacts") renderPage(); });
  stopPolling();
  poll = setInterval(refreshTeam, 10_000);
  setInterval(refreshVoicemail, 60_000);
}
function stopPolling() { clearInterval(poll); poll = null; }
const setTitle = () => { document.title = `${me.user.id} · ${me.user.name} · Softphone`; };

async function refreshTeam() {
  if (document.hidden) return;
  try { contacts = (await api("GET", "/api/u/team")).contacts; } catch (e) { if (e.status === 401) return renderLogin("Session expirée : reconnecte-toi."); return; }
  if (page === "equipe") drawTeam();
}
async function refreshVoicemail() {
  try { const r = await api("GET", "/api/u/voicemail"); vmList = r.messages; vmEnabled = r.enabled; } catch { return; }
  badges();
  if (page === "messagerie" && !$$("#page audio").some((a) => !a.paused)) renderPage();
}

// ------------------------------------------------------------------ Coquille : menu, en-tête, panneaux
// Dans l'application mobile Callikoe (WebView) : onglets comme une appli de téléphone, menu et comptes gérés par l'appli
const IN_APP = (() => {
  try {
    if (window.CALLIKOE_APP || new URLSearchParams(location.search).get("app") === "1") sessionStorage.setItem("callikoe_app", "1");
    return sessionStorage.getItem("callikoe_app") === "1" || !!window.ReactNativeWebView;
  } catch { return !!window.CALLIKOE_APP; }
})();
const toApp = (type) => { try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type })); } catch { /* hors appli */ } };
if (IN_APP) document.documentElement.classList.add("in-app");
const NAV = IN_APP
  ? [["equipe", "Équipe", I.team], ["contacts", "Contacts", I.book], ["clavier", "Clavier", I.keypad], ["appels", "Récents", I.calls], ["chat", "Chat", I.chat], ["messagerie", "Messagerie", I.vm]]
  : [["equipe", "Équipe", I.team], ["chat", "Chat", I.chat], ["appels", "Appels", I.calls], ["contacts", "Contacts", I.book], ["messagerie", "Messagerie", I.vm], ["reglages", "Réglages", I.gear]];
const TITLES = { equipe: "Équipe", chat: "Chat", appels: "Appels", contacts: "Contacts", messagerie: "Messagerie vocale", reglages: "Réglages", planning: "Plannings d'appels" };
// Responsable : onglet Plannings (dans le menu de l'appli, où la barre du bas est déjà pleine)
const navItems = () => !me?.user?.manager || IN_APP ? NAV : [...NAV.slice(0, -1), ["planning", "Plannings", I.cal], NAV.at(-1)];

function presenceOf(c) {
  if (!c.registered) return { cls: "off", label: "Hors ligne" };
  if (c.line === "busy") return { cls: "busy", label: "En appel" };
  if (c.line === "ringing") return { cls: "ringing", label: "Sonne…" };
  return { cls: c.status, label: STATUS[c.status] || "Disponible" };
}
const myPresence = () => ({ cls: regState === "on" ? me.user.status : "off", label: regState === "on" ? STATUS[me.user.status] : "Hors ligne" });

function renderShell() {
  root.innerHTML = `<div class="sp-app">
    <aside class="rail">
      <a class="rail-logo" href="#/equipe" title="Callikoe"><i></i></a>
      <nav>${navItems().map(([k, l, ic]) => k === "clavier" ? `<a href="#" data-dial>${ic()}<span>${l}</span></a>` : `<a href="#/${k}" data-r="${k}">${ic()}<span>${l}</span><b class="badge" id="b-${k}" hidden></b></a>`).join("")}</nav>
      <button class="rail-me" id="mebtn" title="Mon statut">${avatar(me.user.name, myPresence().cls, "sm", "me-av")}</button>
    </aside>
    <div class="sp-body">
      <header class="sp-top">
        ${IN_APP ? '<button class="ghost-ic app-menu" id="appmenu" aria-label="Menu">☰</button>' : ""}
        <div class="sp-ttl"><h1 id="title">Équipe</h1><span class="s">${esc(me.pbx.name || "")}</span></div>
        <span class="reg ${regState}" id="reg" title="Connexion au PBX">${regLabel()}</span>
        <button class="btn sp-dialbtn" id="opendial" title="Ouvrir le clavier">${I.keypad()}<span>Appeler</span></button>
      </header>
      <div id="banner"></div>
      <main id="page"></main>
    </div>
    <aside class="drawer" id="drawer" aria-hidden="true"></aside>
    <div class="scrim" id="scrim"></div>
    <div id="callbar"></div>
    <div id="incoming"></div>
    <div id="menu"></div>
  </div>`;
  $("#opendial").onclick = () => openDrawer(true);
  $$("[data-dial]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openDrawer(true); });
  $("#appmenu")?.addEventListener("click", () => toApp("menu"));
  $("#scrim").onclick = () => openDrawer(false);
  $("#mebtn").onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  renderBanner();
  renderDrawer();
  badges();
}

function avatar(name, pres, size = "", id = "") {
  return `<span class="av ${size}" ${id ? `id="${id}"` : ""}>${esc(initials(name))}${pres ? `<i class="pres ${pres}"></i>` : ""}</span>`;
}
const regLabel = () => ({ on: "En ligne", wait: "Connexion…", off: "Hors ligne", fail: "Refusé" })[regState];

function renderBanner() {
  const b = [];
  if (me.impersonated_by) b.push(`<div class="sp-banner imp">Mode incarnation : tu es connecté en tant que <strong>${esc(me.user.id)} · ${esc(me.user.name)}</strong> (ouvert par ${esc(me.impersonated_by)}).</div>`);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) b.push(`<div class="sp-banner warn">Le softphone a besoin d'une connexion <strong>HTTPS</strong> pour utiliser le micro. Il fonctionnera dès que l'adresse du PBX aura son certificat (console › Système).</div>`);
  else if (audioCtx?.state !== "running") b.push(`<div class="sp-banner info" id="sp-unlock">Clique n'importe où dans la page pour activer la sonnerie des appels entrants.</div>`);
  $("#banner").innerHTML = b.join("");
}

function badges() {
  if (!me || !$("#b-appels")) return;
  const seen = store.get(`callikoe_seen_${me.user.id}`, "");
  const missed = history().filter((h) => h.status === "missed" && h.at > seen).length;
  const nv = vmList.filter((m) => m.folder === "new").length;
  const unread = chats.reduce((n, c) => n + (c.unread || 0), 0);
  for (const [k, n] of [["appels", page === "appels" ? 0 : missed], ["messagerie", nv], ["chat", unread]]) {
    const b = $(`#b-${k}`); b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n);
  }
}

function toggleMenu(force) {
  const m = $("#menu");
  const open = force ?? !m.innerHTML;
  if (!open) { m.innerHTML = ""; return; }
  m.innerHTML = `<div class="pmenu panel">
    <div class="pm-head">${avatar(me.user.name, myPresence().cls, "")}<div><strong>${esc(me.user.name)}</strong><div class="s">Poste ${esc(me.user.id)}</div></div></div>
    ${Object.entries(STATUS).map(([k, l]) => `<button class="pm-it ${me.user.status === k ? "on" : ""}" data-st="${k}"><i class="pres ${k}"></i>${l}${me.user.status === k ? '<span class="ck">✓</span>' : ""}</button>`).join("")}
    <hr>
    <a class="pm-it" href="#/reglages/transfert">Renvois par statut…</a>
    ${me.user.manager ? `<a class="pm-it" href="#/planning">${I.cal()}Plannings d'appels…</a>` : ""}
    ${IN_APP ? `<button class="pm-it" id="appaccounts">${I.team()}Comptes…</button>` : `<button class="pm-it" id="logout">${I.logout()}${me.impersonated_by ? "Quitter l'incarnation" : "Se déconnecter"}</button>`}
  </div>`;
  m.querySelector(".pmenu").onclick = (e) => e.stopPropagation();
  $$("[data-st]", m).forEach((b) => b.onclick = () => setStatus(b.dataset.st));
  $$("a.pm-it", m).forEach((a) => a.onclick = () => toggleMenu(false));
  $("#appaccounts")?.addEventListener("click", () => { toggleMenu(false); toApp("accounts"); });
  if ($("#logout")) $("#logout").onclick = async () => { try { ua?.stop(); } catch { /* */ } ua = null; await api("POST", "/api/u/logout"); me.impersonated_by ? window.close() : renderLogin(); };
  setTimeout(() => document.addEventListener("click", () => toggleMenu(false), { once: true }));
}
async function setStatus(st) {
  try { const r = await api("PUT", "/api/u/status", { status: st }); me.user.status = r.status; toast(`Statut : ${STATUS[r.status]}`); }
  catch (err) { toast(err.message, "bad"); }
  toggleMenu(false); refreshPresence();
  if (page === "reglages") renderPage();
}
function refreshPresence() {
  const p = myPresence();
  const i = $("#me-av .pres"); if (i) i.className = `pres ${p.cls}`;
}

// ------------------------------------------------------------------ Navigation
function route() {
  const [p, s] = location.hash.replace(/^#\/?/, "").split("/");
  page = TITLES[p] && (p !== "planning" || me.user.manager) ? p : "equipe"; sub = s || "";
  $$(".rail [data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === page));
  $("#title").textContent = TITLES[page];
  if (page === "appels") store.set(`callikoe_seen_${me.user.id}`, new Date().toISOString());
  renderPage(); badges();
}
window.addEventListener("hashchange", () => { if (me && $("#page")) route(); });

function renderPage() {
  const el = $("#page"); if (!el) return;
  el.className = `pg-${page}`;
  ({ equipe: pageTeam, chat: pageChat, appels: pageCalls, contacts: pageContacts, messagerie: pageVoicemail, reglages: pageSettings, planning: pagePlanning })[page](el);
}

// ------------------------------------------------------------------ Plannings d'appels (responsables)
async function pagePlanning(el) {
  el.innerHTML = '<p class="s" style="padding:16px">Chargement…</p>';
  let cf;
  try { cf = await api("GET", "/api/u/plannings"); } catch (err) { el.innerHTML = `<div class="sp-banner warn">${esc(err.message)}</div>`; return; }
  if (sub) {
    const plan = cf.plannings.find((x) => x.id === sub);
    if (!plan) { el.innerHTML = '<div class="sp-banner warn">Planning introuvable.</div>'; return; }
    renderPlanning(el, {
      cf, plan, mode: "manager", backHref: "#/planning", backLabel: "Plannings",
      save: (body) => api("PUT", `/api/u/plannings/${encodeURIComponent(plan.id)}`, body),
      done: (text) => { toast(text); location.hash = "#/planning"; },
    });
    return;
  }
  const fmtN = (n) => /^0\d{9}$/.test(n) ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : n;
  el.innerHTML = `<div class="sp-plans">
    <p class="s" style="margin:0 0 12px">Tu es responsable : choisis qui reçoit les appels selon le jour et l'heure. Les modifications s'appliquent dès que tu valides.</p>
    ${cf.plannings.length ? cf.plannings.map((p) => `<a class="panel sp-plan" href="#/planning/${esc(p.id)}"><strong>${esc(p.name)}</strong>
      <span class="s">${esc(p.data.dids.map(fmtN).join(", ") || "Numéros sans règle")} · ${esc(planningSummary(p.data, cf))}</span></a>`).join("")
    : '<div class="sp-banner info">Aucun planning ne t\'est confié pour l\'instant. L\'administrateur les crée dans la console (Gestion d\'appels › Routages) en cochant « Modifiable par les responsables ».</div>'}</div>`;
}

// ------------------------------------------------------------------ Équipe
let teamFilter = "all";
function pageTeam(el) {
  el.innerHTML = `<div class="tbar">
      <label class="search">${I.search()}<input id="tq" type="search" placeholder="Rechercher un collègue, ou taper un numéro puis Entrée" autocomplete="off"></label>
      <div class="chips-f">${[["all", "Tous"], ["fav", "Favoris"], ["online", "En ligne"]].map(([k, l]) => `<button class="chipf ${teamFilter === k ? "on" : ""}" data-f="${k}">${l}</button>`).join("")}</div>
    </div>
    ${(me.rooms || []).length ? `<div class="rooms"><span class="s">Réunions</span>${me.rooms.map((r) => `<button class="room" data-room="${esc(r.number)}" title="Rejoindre en vidéo${r.pin ? " (code PIN demandé)" : ""}">${I.video(18)}<span><strong>${esc(r.name)}</strong><span class="s">${esc(r.number)}${r.pin ? " · PIN" : ""}</span></span></button>`).join("")}</div>` : ""}
    <div class="tgrid" id="tgrid"></div>`;
  $$("[data-room]", el).forEach((b) => b.onclick = () => call(b.dataset.room, { video: true }));
  const q = $("#tq");
  q.oninput = drawTeam;
  q.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const v = q.value.trim();
    if (isDialable(v)) call(v);
    else { const first = filteredTeam()[0]; if (first) call(first.id); }
  };
  $$("[data-f]", el).forEach((b) => b.onclick = () => { teamFilter = b.dataset.f; $$("[data-f]", el).forEach((x) => x.classList.toggle("on", x === b)); drawTeam(); });
  drawTeam();
}
function filteredTeam() {
  const q = ($("#tq")?.value || "").toLowerCase().trim(), f = favs();
  return contacts
    .filter((c) => !q || `${c.id} ${c.name} ${c.email}`.toLowerCase().includes(q))
    .filter((c) => teamFilter === "all" || (teamFilter === "fav" ? f.has(c.id) : c.registered))
    .sort((a, b) => (f.has(b.id) - f.has(a.id)) || a.id.localeCompare(b.id));
}
function drawTeam() {
  const g = $("#tgrid"); if (!g) return;
  const f = favs(), list = filteredTeam();
  const q = ($("#tq")?.value || "").trim();
  const dialCard = q && isDialable(q) ? `<div class="tcard dial"><span class="av lg num">${I.phone(22)}</span><div class="tname">${esc(fmtNum(clean(q)))}</div><div class="tstat">Numéro</div>
      <div class="tact"><button class="cbtn" data-call="${esc(clean(q))}" title="Appeler">${I.phone()}</button></div></div>` : "";
  g.innerHTML = dialCard + (list.map((c) => {
    const p = presenceOf(c);
    return `<div class="tcard" data-id="${esc(c.id)}">
      <button class="fav ${f.has(c.id) ? "on" : ""}" data-fav="${esc(c.id)}" title="${f.has(c.id) ? "Retirer des favoris" : "Ajouter aux favoris"}">${I.star(f.has(c.id))}</button>
      ${avatar(c.name, p.cls, "lg")}
      <div class="tname" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="text">${esc(c.id)}${c.devices?.length ? ` · <span class="devs-i">${c.devices.map((d) => I.device(d)).join("")}</span>` : ""}</div>
      <div class="tstat ${p.cls}">${p.label}</div>
      <div class="tact"><button class="cbtn" data-call="${esc(c.id)}" title="Appeler ${esc(c.name)}">${I.phone()}</button><button class="cbtn vidb" data-vcall="${esc(c.id)}" title="Appel vidéo">${I.video(18)}</button><button class="cbtn chatb" data-chat="${esc(c.id)}" title="Écrire à ${esc(c.name)}">${I.chat()}</button></div>
    </div>`;
  }).join("") || (dialCard ? "" : `<div class="empty-st">${teamFilter === "fav" ? "Aucun favori : clique sur l'étoile d'un collègue pour l'ajouter." : "Aucun collègue trouvé."}</div>`));
  wireCalls(g);
  $$("[data-chat]", g).forEach((b) => b.onclick = (e) => { e.stopPropagation(); openChatWith([b.dataset.chat]); });
  $$("[data-vcall]", g).forEach((b) => b.onclick = (e) => { e.stopPropagation(); call(b.dataset.vcall, { video: true }); });
  $$("[data-fav]", g).forEach((b) => b.onclick = (e) => { e.stopPropagation(); toggleFav(b.dataset.fav); drawTeam(); });
}
function wireCalls(r) { $$("[data-call]", r).forEach((b) => b.onclick = (e) => { e.stopPropagation(); call(b.dataset.call); }); }

// ------------------------------------------------------------------ Appels (historique)
let callFilter = "all", selNum = "";
function pageCalls(el) {
  const all = history();
  const list = all.filter((h) => callFilter === "all" || (callFilter === "missed" ? h.status === "missed" : h.direction === callFilter));
  if (!selNum && list[0] && window.innerWidth > 860) selNum = list[0].number;
  el.innerHTML = `<div class="split ${selNum ? "has-sel" : ""}">
    <section class="panel listp">
      <div class="ltabs">${[["all", "Tous"], ["missed", "Manqués"], ["in", "Entrants"], ["out", "Sortants"]].map(([k, l]) => `<button class="${callFilter === k ? "on" : ""}" data-cf="${k}">${l}</button>`).join("")}</div>
      <ul class="rows">${list.map((h, i) => `<li class="${h.number === selNum ? "sel" : ""}" data-sel="${esc(h.number)}" data-i="${i}">
          <span class="dir ${h.status === "missed" ? "missed" : h.direction}">${h.status === "missed" ? I.missed() : h.direction === "in" ? I.inArrow() : I.outArrow()}</span>
          <span class="grow"><strong class="${h.status === "missed" ? "red" : ""}">${esc(h.name || nameOf(h.number) || fmtNum(h.number))}</strong><span class="s">${h.name || nameOf(h.number) ? esc(fmtNum(h.number)) + " · " : ""}${statusText(h)}</span></span>
          <span class="when">${esc(fmtWhen(h.at))}</span>
          <button class="cbtn sm" data-call="${esc(h.number)}" title="Rappeler">${I.phone(16)}</button>
        </li>`).join("") || '<li class="empty-st">Aucun appel.</li>'}</ul>
      <p class="hint pad-s">${serverCalls ? "Journal des appels du PBX (90 derniers jours)." : `Historique enregistré dans ce navigateur.${all.length ? ' <a href="#" id="hclear">Effacer</a>' : ""}`}</p>
    </section>
    <section class="panel detp" id="detail"></section>
  </div>`;
  $$("[data-cf]", el).forEach((b) => b.onclick = () => { callFilter = b.dataset.cf; renderPage(); });
  $$("[data-sel]", el).forEach((li) => li.onclick = () => { selNum = li.dataset.sel; renderPage(); });
  wireCalls(el);
  $("#hclear")?.addEventListener("click", (e) => { e.preventDefault(); if (confirm("Effacer tout l'historique des appels de ce navigateur ?")) { store.set(histKey(), []); selNum = ""; renderPage(); badges(); } });
  drawCallDetail(all);
}
function drawCallDetail(all) {
  const d = $("#detail");
  if (!selNum) { d.innerHTML = `<div class="empty-st">Sélectionne un appel pour voir le détail.</div>`; return; }
  const items = all.filter((h) => h.number === selNum);
  const c = contacts.find((x) => x.id === selNum);
  const name = c?.name || items.find((h) => h.name)?.name || "";
  const p = c ? presenceOf(c) : null;
  d.innerHTML = `<button class="ghost-ic back-m" id="dback">${I.back()} Retour</button>
    <div class="det-head">${avatar(name || selNum, p?.cls, "xl")}
      <div class="tname">${esc(name || fmtNum(selNum))}</div>
      <div class="s">${c ? `Poste ${esc(c.id)} · ${p.label}` : esc(fmtNum(selNum))}</div>
      <div class="row-c"><button class="btn" data-call="${esc(selNum)}">${I.phone()} Appeler</button>
      ${c ? `<button class="btn ghost" id="dfav">${I.star(favs().has(c.id))} ${favs().has(c.id) ? "Favori" : "Ajouter aux favoris"}</button>` : ""}</div>
    </div>
    <h3 class="sec">Historique avec ce correspondant</h3>
    <ul class="rows plain">${items.map((h) => `<li><span class="dir ${h.status === "missed" ? "missed" : h.direction}">${h.status === "missed" ? I.missed() : h.direction === "in" ? I.inArrow() : I.outArrow()}</span>
      <span class="grow">${h.status === "missed" ? "Appel manqué" : h.status === "failed" ? "Appel non abouti" : h.status === "voicemail" ? "Message laissé sur ta messagerie" : h.status === "answered_elsewhere" ? `Répondu par ${esc(nameOf(h.answered_by) || h.answered_by)}` : h.direction === "in" ? "Appel entrant" : "Appel sortant"}</span>
      <span class="s">${h.status === "answered" ? fmtDur(h.duration || 0) + " · " : ""}${esc(fmtWhen(h.at))}</span></li>`).join("")}</ul>`;
  wireCalls(d);
  $("#dback").onclick = () => { selNum = ""; renderPage(); };
  $("#dfav")?.addEventListener("click", () => { toggleFav(c.id); drawCallDetail(all); });
}

function statusText(h) {
  return { missed: "Manqué", failed: "Échec", voicemail: "Messagerie", answered_elsewhere: `Répondu par ${nameOf(h.answered_by) || h.answered_by}` }[h.status] || fmtDur(h.duration || 0);
}

// ------------------------------------------------------------------ Chat
let chats = [], chatOnline = new Set(), chatSel = "", chatMsgs = [], chatReads = {}, es = null, newChat = false;
async function loadChats() {
  try { const r = await api("GET", "/api/u/chats"); chats = r.chats; chatOnline = new Set(r.online); } catch { return; }
  badges();
  if (page === "chat") drawChatList();
}
function startEvents() {
  try { es?.close(); } catch { /* */ }
  if (!window.EventSource) return;
  es = new EventSource("/api/u/events");
  es.addEventListener("message", (ev) => onChatMessage(JSON.parse(ev.data)));
  es.addEventListener("read", (ev) => { const d = JSON.parse(ev.data); if (d.conv === chatSel) { chatReads[d.ext] = d.last_read; drawMsgs(false); } });
  es.addEventListener("conv", () => loadChats());
}
const convName = (c) => c.kind === "group" ? (c.name || c.members.filter((x) => x !== me.user.id).map((x) => (nameOf(x) || x).split(" ")[0]).join(", ")) : (nameOf(c.members.find((x) => x !== me.user.id)) || c.members.find((x) => x !== me.user.id));
const convOther = (c) => c.kind === "direct" ? contacts.find((x) => x.id === c.members.find((m) => m !== me.user.id)) : null;
function onChatMessage(m) {
  const c = chats.find((x) => x.id === m.conv);
  if (!c) { loadChats(); }
  else { c.last = { id: m.id, sender: m.sender, body: m.body, at: m.at }; c.updated_at = m.at; chats.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))); }
  const visible = page === "chat" && chatSel === m.conv && !document.hidden;
  if (visible) { chatMsgs.push(m); drawMsgs(true); if (m.sender !== me.user.id) api("POST", `/api/u/chats/${m.conv}/read`, { last: m.id }).catch(() => {}); }
  else if (m.sender !== me.user.id && c) {
    c.unread = (c.unread || 0) + 1;
    const who = nameOf(m.sender) || m.sender;
    if (!session) { const st = tone([[880, 1320], 90, 60000], "tones"); setTimeout(st, 120); }
    if (document.hidden && window.Notification?.permission === "granted") { try { const n = new Notification(who, { body: m.body.slice(0, 120), tag: `chat-${m.conv}` }); n.onclick = () => { window.focus(); location.hash = "#/chat"; chatSel = m.conv; n.close(); }; } catch { /* */ } }
    else if (page !== "chat") toast(`${who} : ${m.body.slice(0, 60)}`);
  }
  badges();
  if (page === "chat") drawChatList();
}
async function openChatWith(members, name = "") {
  try { const r = await api("POST", "/api/u/chats", { members, name }); chatSel = r.id; newChat = false; await loadChats(); location.hash = "#/chat"; if (page === "chat") renderPage(); }
  catch (e) { toast(e.message, "bad"); }
}
function pageChat(el) {
  el.innerHTML = `<div class="split chat ${chatSel || newChat ? "has-sel" : ""}">
    <section class="panel listp"><div class="chat-head"><strong>Discussions</strong><button class="btn sm" id="newc">+ Nouvelle</button></div><ul class="rows" id="clist2"></ul></section>
    <section class="panel detp chatp" id="chatp"></section></div>`;
  $("#newc").onclick = () => { newChat = true; chatSel = ""; renderPage(); };
  drawChatList();
  if (newChat) return drawNewChat();
  if (!chatSel) { $("#chatp").innerHTML = `<div class="empty-st">${chats.length ? "Choisis une discussion." : "Aucune discussion. Écris à un collègue avec « + Nouvelle » ou depuis l'onglet Équipe."}</div>`; return; }
  openConv(chatSel);
}
function drawChatList() {
  const ul = $("#clist2"); if (!ul) return;
  ul.innerHTML = chats.map((c) => {
    const o = convOther(c);
    const pres = o ? presenceOf(o).cls : "";
    const last = c.last ? `${c.last.sender === me.user.id ? "Vous : " : c.kind === "group" ? `${(nameOf(c.last.sender) || c.last.sender).split(" ")[0]} : ` : ""}${c.last.body}` : "Nouvelle discussion";
    return `<li data-conv="${esc(c.id)}" class="${chatSel === c.id ? "sel" : ""}" style="cursor:pointer">${c.kind === "group" ? `<span class="av sm grp">${I.team()}</span>` : avatar(convName(c), pres, "sm")}
      <span class="grow"><strong>${esc(convName(c))}</strong><span class="s ell">${esc(last)}</span></span>
      <span class="cmeta"><span class="when">${c.last ? esc(fmtWhen(c.last.at).replace("Aujourd'hui ", "")) : ""}</span>${c.unread ? `<b class="ubadge">${c.unread}</b>` : ""}</span></li>`;
  }).join("") || '<li class="empty-st">Aucune discussion.</li>';
  $$("[data-conv]", ul).forEach((li) => li.onclick = () => { chatSel = li.dataset.conv; newChat = false; renderPage(); });
}
function drawNewChat() {
  const picked = new Set();
  $("#chatp").innerHTML = `<button class="ghost-ic back-m" id="cback2">${I.back()} Retour</button><h3 class="sec" style="margin-top:0">Nouvelle discussion</h3>
    <label class="search" style="max-width:none">${I.search()}<input id="ncq" placeholder="Rechercher un collègue"></label>
    <div class="nclist" id="ncl"></div>
    <div id="ncname" hidden><label>Nom du groupe (facultatif)<input id="ncn" maxlength="60" placeholder="Ex. : Équipe commerciale"></label></div>
    <div class="row-c" style="margin-top:12px"><button class="btn" id="ncgo" disabled>Démarrer</button><button class="btn ghost" id="ncx">Annuler</button></div>`;
  const draw = () => {
    const q = $("#ncq").value.toLowerCase();
    $("#ncl").innerHTML = contacts.filter((c) => !q || `${c.id} ${c.name}`.toLowerCase().includes(q)).map((c) => `<label class="ncitem ${picked.has(c.id) ? "on" : ""}"><input type="checkbox" value="${esc(c.id)}" ${picked.has(c.id) ? "checked" : ""}>${avatar(c.name, presenceOf(c).cls, "sm")}<span class="grow"><strong>${esc(c.name)}</strong><span class="s">${esc(c.id)}</span></span></label>`).join("");
    $$("#ncl input").forEach((i) => i.onchange = () => { i.checked ? picked.add(i.value) : picked.delete(i.value); i.closest(".ncitem").classList.toggle("on", i.checked); $("#ncgo").disabled = !picked.size; $("#ncname").hidden = picked.size < 2; $("#ncgo").textContent = picked.size > 1 ? `Créer le groupe (${picked.size + 1})` : "Démarrer"; });
  };
  $("#ncq").oninput = draw; draw();
  $("#ncgo").onclick = () => openChatWith([...picked], $("#ncn").value);
  $("#ncx").onclick = $("#cback2").onclick = () => { newChat = false; renderPage(); };
}
async function openConv(id) {
  const c = chats.find((x) => x.id === id);
  if (!c) { chatSel = ""; return renderPage(); }
  const o = convOther(c);
  $("#chatp").innerHTML = `<div class="chat-top"><button class="ghost-ic back-m" id="cback3">${I.back()}</button>
      ${c.kind === "group" ? `<span class="av sm grp">${I.team()}</span>` : avatar(convName(c), o ? presenceOf(o).cls : "", "sm")}
      <span class="grow"><strong>${esc(convName(c))}</strong><span class="s">${c.kind === "group" ? esc(c.members.map((x) => x === me.user.id ? "vous" : (nameOf(x) || x).split(" ")[0]).join(", ")) : o ? esc(presenceOf(o).label) : ""}</span></span>
      ${o ? `<button class="cbtn" data-call="${esc(o.id)}" title="Appeler">${I.phone()}</button>` : ""}
      ${c.kind === "group" ? '<button class="ghost-ic" id="cren" title="Renommer">✎</button><button class="ghost-ic" id="cleave" title="Quitter le groupe">⎋</button>' : ""}</div>
    <div class="msgs" id="msgs"><div class="empty-st">Chargement…</div></div>
    <form class="composer" id="compose"><textarea id="ctext" rows="1" placeholder="Écrire un message… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"></textarea><button class="btn round sm" title="Envoyer">${I.send()}</button></form>`;
  wireCalls($("#chatp"));
  $("#cback3").onclick = () => { chatSel = ""; renderPage(); };
  $("#cren")?.addEventListener("click", async () => { const n = prompt("Nom du groupe :", c.name || ""); if (n === null) return; await api("PUT", `/api/u/chats/${id}`, { name: n }); loadChats().then(() => renderPage()); });
  $("#cleave")?.addEventListener("click", async () => { if (!confirm("Quitter ce groupe ?")) return; await api("DELETE", `/api/u/chats/${id}/me`); chatSel = ""; loadChats().then(() => renderPage()); });
  const ta = $("#ctext");
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#compose").requestSubmit(); } };
  $("#compose").onsubmit = async (e) => {
    e.preventDefault();
    const body = ta.value.trim(); if (!body) return;
    ta.value = ""; ta.oninput();
    try { await api("POST", `/api/u/chats/${id}/messages`, { body }); } catch (err) { toast(err.message, "bad"); ta.value = body; }
  };
  try { const r = await api("GET", `/api/u/chats/${id}/messages`); chatMsgs = r.messages; chatReads = r.reads; } catch (e) { $("#msgs").innerHTML = `<div class="empty-st">${esc(e.message)}</div>`; return; }
  if (chatSel !== id) return;
  drawMsgs(true);
  ta.focus();
  const last = chatMsgs.at(-1);
  if (last && c.unread) { c.unread = 0; badges(); drawChatList(); api("POST", `/api/u/chats/${id}/read`, { last: last.id }).catch(() => {}); }
}
function drawMsgs(scroll) {
  const box = $("#msgs"); if (!box) return;
  const c = chats.find((x) => x.id === chatSel);
  const others = (c?.members || []).filter((x) => x !== me.user.id);
  let lastDay = "", html = "";
  const myLast = [...chatMsgs].reverse().find((m) => m.sender === me.user.id);
  const seen = myLast && others.length && others.every((x) => Number(chatReads[x] || 0) >= Number(myLast.id));
  chatMsgs.forEach((m, i) => {
    const d = new Date(m.at); const day = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay) { html += `<div class="dsep"><span>${esc(day)}</span></div>`; lastDay = day; }
    const mine = m.sender === me.user.id, prev = chatMsgs[i - 1];
    const showName = !mine && c?.kind === "group" && (!prev || prev.sender !== m.sender);
    html += `<div class="msg ${mine ? "me" : ""}">${showName ? `<span class="mn">${esc(nameOf(m.sender) || m.sender)}</span>` : ""}<div class="bub">${esc(m.body).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>
      <span class="mt">${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}${mine && m === myLast && seen ? " · Vu" : ""}</span></div>`;
  });
  box.innerHTML = html || '<div class="empty-st">Aucun message : dis bonjour 👋</div>';
  if (scroll) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ Contacts (collègues + annuaire de l'entreprise)
let ctab = "all", csel = "";
const PT = { work: "Bureau", mobile: "Mobile", home: "Domicile", other: "Autre" };
let dirAt = Date.now();
function pageContacts(el) {
  // Annuaire relu à l'ouverture de la page (contacts ajoutés depuis la console)
  if (Date.now() - dirAt > 10_000) { dirAt = Date.now(); loadDirectory().then(() => { if (page === "contacts") renderPage(); }); }
  el.innerHTML = `<div class="split ${csel ? "has-sel" : ""}">
    <section class="panel listp">
      <div class="pad-s" style="padding-top:12px"><label class="search">${I.search()}<input id="cq" type="search" placeholder="Nom, société ou numéro" autocomplete="off"></label></div>
      <div class="ltabs">${[["all", "Tous"], ["team", "Collègues"], ["company", "Annuaire"]].map(([k, l]) => `<button class="${ctab === k ? "on" : ""}" data-ct="${k}">${l}</button>`).join("")}</div>
      <ul class="rows" id="clist"></ul>
    </section>
    <section class="panel detp" id="cdetail"></section></div>`;
  $$("[data-ct]", el).forEach((b) => b.onclick = () => { ctab = b.dataset.ct; pageContacts(el); });
  const draw = () => {
    const q = ($("#cq").value || "").toLowerCase().trim(), qd = q.replace(/[\s.]/g, "");
    const team = ctab === "company" ? [] : contacts.filter((c) => !q || `${c.id} ${c.name}`.toLowerCase().includes(q)).map((c) => ({ key: `u:${c.id}`, name: c.name, sub: `Poste ${c.id}`, team: c }));
    const comp = ctab === "team" ? [] : directory.filter((c) => !q || `${c.name} ${c.company} ${c.email}`.toLowerCase().includes(q) || (qd.length > 1 && c.phones.some((p) => p.number.includes(qd))))
      .map((c) => ({ key: `c:${c.id}`, name: c.name, sub: c.company || fmtNum(c.phones[0]?.number), dir: c }));
    const list = [...team, ...comp].sort((a, b) => a.name.localeCompare(b.name, "fr"));
    $("#clist").innerHTML = list.map((x) => `<li data-ck="${esc(x.key)}" class="${csel === x.key ? "sel" : ""}" style="cursor:pointer">${avatar(x.name, x.team ? presenceOf(x.team).cls : "", "sm")}
      <span class="grow"><strong>${esc(x.name)}</strong><span class="s">${esc(x.sub || "")}</span></span>${x.team ? '<span class="tagc">Collègue</span>' : ""}</li>`).join("") || `<li class="empty-st">${directory.length || ctab !== "company" ? "Aucun résultat." : "L'annuaire de l'entreprise est vide (géré par l'administrateur)."}</li>`;
    $$("[data-ck]", $("#clist")).forEach((li) => li.onclick = () => { csel = li.dataset.ck; pageContacts(el); });
  };
  $("#cq").oninput = draw; draw();
  const d = $("#cdetail");
  const [kind, id] = csel.split(":");
  const t = kind === "u" ? contacts.find((c) => c.id === id) : null, c = kind === "c" ? directory.find((x) => x.id === id) : null;
  if (!t && !c) { d.innerHTML = '<div class="empty-st">Sélectionne un contact.</div>'; return; }
  const name = t ? t.name : c.name;
  const nums = t ? [{ type: "Poste", number: t.id }] : c.phones.map((p) => ({ type: PT[p.type] || p.type, number: p.number }));
  d.innerHTML = `<button class="ghost-ic back-m" id="cback">${I.back()} Retour</button>
    <div class="det-head">${avatar(name, t ? presenceOf(t).cls : "", "xl")}<div class="tname">${esc(name)}</div>
      <div class="s">${t ? `Poste ${esc(t.id)} · ${presenceOf(t).label}` : esc(c.company || "")}</div>
      ${!t && c.email ? `<div class="s"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}</div>
    <ul class="rows plain">${nums.map((n) => `<li><span class="grow"><span class="s">${esc(n.type)}</span><strong>${esc(fmtNum(n.number))}</strong></span><button class="cbtn" data-call="${esc(n.number)}" title="Appeler">${I.phone()}</button></li>`).join("")}</ul>`;
  wireCalls(d);
  $("#cback").onclick = () => { csel = ""; pageContacts(el); };
}

// ------------------------------------------------------------------ Messagerie vocale
let vmSel = "";
function pageVoicemail(el) {
  if (!vmEnabled) { el.innerHTML = `<div class="panel pad empty-st">La messagerie vocale n'est pas activée pour ton poste. Demande à ton administrateur de l'activer.</div>`; return; }
  const nv = vmList.filter((m) => m.folder === "new").length;
  el.innerHTML = `<section class="panel listp vm">
    <div class="vm-head"><div><strong>${vmList.length} message${vmList.length > 1 ? "s" : ""}</strong>${nv ? ` · <span class="red">${nv} nouveau${nv > 1 ? "x" : ""}</span>` : ""}</div>
      <div class="row-c"><button class="btn ghost sm" data-call="*97" title="Consulter par téléphone">${I.phone(16)} Appeler la messagerie</button><button class="btn ghost sm" id="vmref">Actualiser</button></div></div>
    <ul class="rows">${vmList.map((m) => `<li class="vmrow ${m.folder} ${vmSel === m.msg_id ? "open" : ""}" data-vm="${esc(m.id)}" data-mid="${esc(m.msg_id)}">
        <button class="playb" data-play title="Écouter">${I.play()}</button>
        <span class="grow"><strong>${esc(m.caller_name || fmtNum(m.caller_number) || "Numéro masqué")}</strong><span class="s">${m.caller_name && m.caller_number ? esc(fmtNum(m.caller_number)) + " · " : ""}${fmtDur(m.duration)}</span></span>
        <span class="when">${esc(fmtWhen(m.at))}</span>
        ${m.caller_number ? `<button class="cbtn sm" data-call="${esc(m.caller_number)}" title="Rappeler">${I.phone(16)}</button>` : ""}
        <button class="ghost-ic" data-del title="Supprimer">${I.trash()}</button>
        <div class="player"></div>
      </li>`).join("") || '<li class="empty-st">Aucun message.</li>'}</ul>
  </section>`;
  wireCalls(el);
  $("#vmref").onclick = refreshVoicemail;
  $$(".vmrow", el).forEach((li) => {
    $("[data-play]", li).onclick = () => playVm(li);
    $("[data-del]", li).onclick = async () => {
      if (!confirm("Supprimer ce message ?")) return;
      try { await api("DELETE", `/api/u/voicemail/${li.dataset.vm}`); toast("Message supprimé"); } catch (e) { toast(e.message, "bad"); }
      refreshVoicemail();
    };
  });
}
async function playVm(li) {
  let id = li.dataset.vm;
  const m = vmList.find((x) => x.id === id);
  if (m?.folder === "new") {
    try { id = (await api("POST", `/api/u/voicemail/${id}/read`)).id; } catch (e) { return toast(e.message, "bad"); }
    // Les numéros des messages changent : on recharge la liste sans couper la lecture
    api("GET", "/api/u/voicemail").then((r) => {
      vmList = r.messages; badges(); li.classList.remove("new"); li.classList.add("old");
      const nv = vmList.filter((x) => x.folder === "new").length, h = $(".vm-head .red");
      if (h) h.textContent = nv ? `${nv} nouveau${nv > 1 ? "x" : ""}` : ""; 
    }).catch(() => {});
  }
  vmSel = li.dataset.mid;
  $$(".vmrow.open").forEach((x) => { if (x !== li) { x.classList.remove("open"); $(".player", x).innerHTML = ""; } });
  li.classList.add("open");
  $(".player", li).innerHTML = `<audio controls autoplay src="/api/u/voicemail/${esc(id)}/audio"></audio>`;
  const a = $("audio", li);
  if (a.setSinkId && audioPrefs().spk) a.setSinkId(audioPrefs().spk).catch(() => {});
}

// ------------------------------------------------------------------ Réglages
function pageSettings(el) {
  const tab = ["general", "transfert", "audio"].includes(sub) ? sub : "general";
  el.innerHTML = `<nav class="stabs">${[["general", "Général"], ["transfert", "Transfert d'appels"], ["audio", "Audio"]].map(([k, l]) => `<a href="#/reglages/${k}" class="${tab === k ? "on" : ""}">${l}</a>`).join("")}</nav><div id="stab"></div>`;
  ({ general: setGeneral, transfert: setForward, audio: setAudio })[tab]($("#stab"));
}

function setGeneral(el) {
  const u = me.user;
  const theme = store.get("callikoe_theme", "auto");
  el.innerHTML = `<div class="sgrid">
    <section class="panel pad prof">
      ${avatar(u.name, myPresence().cls, "xl")}
      <div><div class="tname">${esc(u.name)}</div><div class="s">Poste ${esc(u.id)}${u.email ? " · " + esc(u.email) : ""}</div>
      <dl class="kv">${u.dids?.length ? `<div><dt>Numéro${u.dids.length > 1 ? "s" : ""} direct${u.dids.length > 1 ? "s" : ""}</dt><dd>${u.dids.map((d) => esc(fmtNum(d))).join("<br>")}</dd></div>` : ""}
      ${u.outbound_cid ? `<div><dt>Numéro présenté</dt><dd>${esc(fmtNum(u.outbound_cid))}</dd></div>` : ""}</dl></div>
    </section>
    <section class="panel pad">
      <h2>Mobile</h2>
      <form id="fmob" class="stack" novalidate>
        <label>Numéro de mobile<input name="mobile" inputmode="tel" value="${esc(fmtNum(u.mobile))}" placeholder="06 12 34 56 78"></label>
        <label class="ck"><input type="checkbox" name="ring_mobile" ${u.ring_mobile ? "checked" : ""}> Faire sonner aussi mon mobile quand on m'appelle</label>
        <div><button class="btn" type="submit">Enregistrer</button></div>
      </form>
    </section>
    <section class="panel pad">
      <h2>Messagerie vocale</h2>
      ${u.voicemail.enabled ? `<p class="hint">Depuis ton poste, compose <strong>*97</strong> pour écouter tes messages.</p>
      <form id="fpin" class="stack" novalidate>
        <label>Code PIN (4 à 8 chiffres)<input name="pin" type="password" inputmode="numeric" autocomplete="new-password" value="${esc(u.voicemail.pin)}"></label>
        <div><button class="btn" type="submit">Enregistrer</button></div>
      </form>` : `<p class="hint">Non activée pour ton poste.</p>`}
    </section>
    <section class="panel pad">
      <h2>Application mobile</h2>
      <p class="hint">Scanne le QR code avec l'appli Callikoe pour configurer ton poste sur ton smartphone. Il reste valable 48 h.</p>
      <div id="qrbox"></div>
    </section>
    <section class="panel pad">
      <h2>Affichage et notifications</h2>
      <div class="stack">
        <label>Thème<select id="theme">${[["auto", "Automatique (comme le système)"], ["light", "Clair"], ["dark", "Sombre"]].map(([k, l]) => `<option value="${k}" ${theme === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <div id="notif"></div>
      </div>
    </section>
  </div>`;
  addEyes();
  $("#fmob").onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); saveSettings({ mobile: f.get("mobile"), ring_mobile: f.get("ring_mobile") === "on" }); };
  $("#fpin")?.addEventListener("submit", (e) => { e.preventDefault(); saveSettings({ voicemail: { pin: new FormData(e.target).get("pin") } }); });
  $("#theme").onchange = (e) => { store.set("callikoe_theme", e.target.value); applyTheme(); };
  drawNotif(); drawQr();
}
function drawNotif() {
  const n = $("#notif"); if (!n) return;
  if (!("Notification" in window)) { n.innerHTML = '<p class="hint">Notifications non disponibles sur ce navigateur.</p>'; return; }
  const p = Notification.permission;
  n.innerHTML = p === "granted" ? '<p class="hint ok-t">✓ Notifications activées : un appel entrant s\'affiche même si l\'onglet est en arrière-plan.</p>'
    : p === "denied" ? '<p class="hint">Notifications bloquées dans les réglages du navigateur pour ce site.</p>'
    : '<button class="btn ghost" id="notifbtn">Activer les notifications d\'appel</button>';
  $("#notifbtn")?.addEventListener("click", async () => { await Notification.requestPermission(); drawNotif(); });
}
async function drawQr() {
  const box = $("#qrbox"); if (!box) return;
  let st = null; try { st = (await api("GET", "/api/u/app-token")).active; } catch { /* */ }
  box.innerHTML = `${st ? `<p class="hint">Un QR code est actif jusqu'au ${esc(new Date(st.expires_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))}.</p>` : ""}
    <button class="btn ghost" id="qrgen">${st ? "Générer un nouveau QR code" : "Afficher mon QR code"}</button>`;
  $("#qrgen").onclick = async () => {
    try {
      const t = await api("POST", "/api/u/app-token");
      box.innerHTML = `<div class="qr"><div class="qrimg">${t.qr_svg}</div><div><p class="hint">Valable jusqu'au ${esc(new Date(t.expires_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))}.</p>
        <button class="btn ghost sm" id="qrrev">Révoquer</button></div></div>`;
      $("#qrrev").onclick = async () => { await api("DELETE", "/api/u/app-token"); drawQr(); };
    } catch (e) { toast(e.message, "bad"); }
  };
}
async function saveSettings(body) {
  try { const r = await api("PUT", "/api/u/settings", body); me.user = r.user; toast("Enregistré"); renderPage(); refreshPresence(); return true; }
  catch (e) { toast(e.message, "bad"); return false; }
}

const DESTS = [["voicemail", "Messagerie vocale"], ["extension", "Un collègue"], ["external", "Un numéro externe"], ["hangup", "Raccrocher"]];
let fwTab = "";
function setForward(el) {
  const u = me.user, fw = u.forwarding;
  fwTab ||= u.status;
  const destRow = (rule, label) => {
    const d = fw[rule];
    return `<div class="fwrule" data-rule="${rule}"><div class="fwl">${label}</div>
      <div class="fwd"><select data-type>${DESTS.filter(([k]) => k !== "voicemail" || u.voicemail.enabled).map(([k, l]) => `<option value="${k}" ${d.type === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select data-ext ${d.type === "extension" ? "" : "hidden"}><option value="">— Choisir —</option>${contacts.map((c) => `<option value="${esc(c.id)}" ${d.type === "extension" && d.target === c.id ? "selected" : ""}>${esc(c.id)} · ${esc(c.name)}</option>`).join("")}</select>
      <input data-num inputmode="tel" placeholder="06 12 34 56 78" value="${d.type === "external" ? esc(fmtNum(d.target)) : ""}" ${d.type === "external" ? "" : "hidden"}></div></div>`;
  };
  const body = {
    available: `<p class="hint">Quand tu es <strong>Disponible</strong>, ton poste, ton softphone${u.ring_mobile ? " et ton mobile" : ""} sonnent. Si personne ne décroche :</p>
      <div class="fwrule"><div class="fwl">Délai avant renvoi</div><div class="fwd"><select id="fwt">${[10, 15, 20, 25, 30, 40, 60].concat(fw.timeout).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((t) => `<option value="${t}" ${fw.timeout === t ? "selected" : ""}>${t} secondes</option>`).join("")}</select></div></div>
      ${destRow("no_answer", "Si je ne réponds pas")}${destRow("busy", "Si je suis en ligne ou non connecté")}`,
    away: `<p class="hint">Quand tu es <strong>Absent</strong>, tes appels ne sonnent pas : ils vont directement vers…</p>${destRow("away", "Tous les appels")}`,
    dnd: `<p class="hint">En <strong>Ne pas déranger</strong>, tes appels ne sonnent pas : ils vont directement vers…</p>${destRow("dnd", "Tous les appels")}`,
  };
  el.innerHTML = `<section class="panel">
    <div class="ltabs fwtabs">${Object.entries(STATUS).map(([k, l]) => `<button class="${fwTab === k ? "on" : ""}" data-fw="${k}"><i class="pres ${k}"></i>${l}${u.status === k ? ' <span class="cur">actuel</span>' : ""}</button>`).join("")}</div>
    <form id="ffw" class="pad" novalidate>
      ${body[fwTab]}
      <div class="row-c" style="margin-top:18px"><button class="btn" type="submit">Enregistrer</button>
      ${u.status !== fwTab ? `<button class="btn ghost" type="button" id="fwact">Passer en « ${STATUS[fwTab]} »</button>` : ""}</div>
    </form></section>`;
  $$("[data-fw]", el).forEach((b) => b.onclick = () => { fwTab = b.dataset.fw; setForward(el); });
  $$(".fwrule[data-rule]", el).forEach((r) => {
    const t = $("[data-type]", r);
    t.onchange = () => { $("[data-ext]", r).hidden = t.value !== "extension"; $("[data-num]", r).hidden = t.value !== "external"; };
  });
  $("#fwact")?.addEventListener("click", () => setStatus(fwTab));
  $("#ffw").onsubmit = (e) => {
    e.preventDefault();
    const out = {};
    for (const r of $$(".fwrule[data-rule]", el)) {
      const type = $("[data-type]", r).value;
      out[r.dataset.rule] = { type, target: type === "extension" ? $("[data-ext]", r).value : type === "external" ? $("[data-num]", r).value : "" };
    }
    if ($("#fwt")) out.timeout = Number($("#fwt").value);
    saveSettings({ forwarding: out });
  };
}

let meterStop = null;
async function setAudio(el) {
  meterStop?.();
  const p = audioPrefs();
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* */ }
  const labelled = devs.some((d) => d.label);
  const opts = (kind, cur) => {
    const list = devs.filter((d) => d.kind === kind);
    return `<option value="">Par défaut du système</option>${list.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => `<option value="${esc(d.deviceId)}" ${cur === d.deviceId ? "selected" : ""}>${esc(d.label || `${kind === "audioinput" ? "Micro" : "Sortie"} ${i + 1}`)}</option>`).join("")}`;
  };
  const sinks = "setSinkId" in HTMLMediaElement.prototype;
  el.innerHTML = `<section class="panel pad">
    ${!labelled ? '<div class="flash">Autorise l\'accès au micro pour voir le nom de tes périphériques. <button class="btn sm" id="allow">Autoriser</button></div>' : ""}
    <div class="stack aud">
      <label>Sonnerie (appels entrants)<span class="row-c"><select id="a-ring" ${sinks ? "" : "disabled"}>${opts("audiooutput", p.ring)}</select><button class="btn ghost sm" id="t-ring" type="button">Tester</button></span></label>
      <label>Haut-parleur / casque<span class="row-c"><select id="a-spk" ${sinks ? "" : "disabled"}>${opts("audiooutput", p.spk)}</select><button class="btn ghost sm" id="t-spk" type="button">Tester</button></span></label>
      <label>Microphone<span class="row-c"><select id="a-mic">${opts("audioinput", p.mic)}</select></span></label>
      <div class="meter"><i id="lvl"></i></div>
      ${sinks ? "" : '<p class="hint">Ce navigateur ne permet pas de choisir la sortie audio (Firefox / Safari) : le son sort sur le périphérique par défaut du système.</p>'}
      <p class="hint">Réglages mémorisés sur cet ordinateur.</p>
    </div></section>`;
  $("#allow")?.addEventListener("click", async () => { try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch (e) { toast(`Micro refusé : ${e.message}`, "bad"); } setAudio(el); });
  const save = () => { store.set("callikoe_audio", { ring: $("#a-ring").value, spk: $("#a-spk").value, mic: $("#a-mic").value }); applySinks(); };
  $("#a-ring").onchange = save; $("#a-spk").onchange = save;
  $("#a-mic").onchange = () => { save(); startMeter(); };
  const test = (pattern, out, btn) => {
    if (stopTone && !session) { stopTone(); stopTone = null; }
    const s = tone(pattern, out); btn.disabled = true; setTimeout(() => { s(); btn.disabled = false; }, 2300);
  };
  $("#t-ring").onclick = (e) => test(RINGTONE, "ringer", e.target);
  $("#t-spk").onclick = (e) => test([[440, 880], 700, 300], "tones", e.target);
  if (labelled) startMeter();
}
async function startMeter() {
  meterStop?.();
  if (session || !navigator.mediaDevices?.getUserMedia || !audioReady()) return;
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraint() }); } catch { return; }
  const src = audioCtx.createMediaStreamSource(stream), an = audioCtx.createAnalyser(); an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize); let raf = 0;
  const draw = () => {
    const bar = $("#lvl"); if (!bar) { meterStop(); return; }
    an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    bar.style.width = `${Math.min(100, peak / 64 * 100)}%`; raf = requestAnimationFrame(draw);
  };
  meterStop = () => { cancelAnimationFrame(raf); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); meterStop = null; };
  draw();
}
window.addEventListener("hashchange", () => { if (!location.hash.includes("reglages/audio")) meterStop?.(); });

// ------------------------------------------------------------------ Panneau d'appel (clavier / appel en cours)
const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

const TOUCH = IN_APP || (window.matchMedia?.("(pointer: coarse)").matches ?? false);
function openDrawer(open) {
  drawerOpen = open;
  $("#drawer").classList.toggle("open", open); $("#drawer").setAttribute("aria-hidden", String(!open));
  $("#scrim").classList.toggle("on", open);
  renderCallbar();
  // Sur mobile, pas de clavier du téléphone par-dessus le pavé : il s'ouvre avec le bouton ⌨ (recherche par nom)
  if (open && !session && !TOUCH) setTimeout(() => $("#num")?.focus(), 60);
}

function renderDrawer() {
  const d = $("#drawer"); if (!d) return;
  if (!session) return renderDialer(d);
  renderInCall(d);
}

function renderDialer(d) {
  const ready = regState === "on";
  d.innerHTML = `<div class="dr-head"><strong>Appeler</strong><button class="ghost-ic" id="drclose" title="Fermer">${I.x()}</button></div>
    <div class="dr-body">
      <div class="sp-display">${TOUCH ? `<button class="bk" id="kbd" title="Clavier du téléphone (chercher un nom)" aria-label="Clavier">${svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 12.5h.01M9.5 12.5h.01M13 12.5h.01M16.5 12.5h.01M8 15.5h8"/>', 20)}</button>` : ""}<input id="num" placeholder="${TOUCH ? "Numéro ou nom" : "Saisissez un nom ou un numéro"}" autocomplete="off" ${TOUCH ? 'inputmode="none"' : ""}><button class="bk" id="bk" title="Effacer">⌫</button></div>
      <ul class="sugg strip" id="sugg"></ul>
      <div class="pad-grid">${KEYS.map(([k, l]) => `<button class="key" data-k="${k}"><b>${k}</b><span>${l}</span></button>`).join("")}</div>
      <div class="sp-actions"><button class="btn round call" id="dial" ${ready ? "" : "disabled"} title="Appeler">${I.phone(26)}</button></div>
      <p class="hint center" id="dhint">${ready ? "Appeler avec : <strong>ce navigateur</strong>" : regState === "fail" ? "Connexion refusée par le PBX." : "Connexion au PBX…"}</p>
    </div>`;
  const num = $("#num");
  const sugg = () => {
    const q = num.value.trim().toLowerCase();
    const list = q ? contacts.filter((c) => `${c.id} ${c.name}`.toLowerCase().includes(q)).slice(0, 5) : [];
    const qd = q.replace(/[\s.]/g, "");
    const dir = q ? directory.filter((c) => `${c.name} ${c.company}`.toLowerCase().includes(q) || (qd.length > 2 && c.phones.some((p) => p.number.includes(qd)))).slice(0, 5) : [];
    $("#sugg").innerHTML = list.map((c) => { const p = presenceOf(c); return `<li data-call="${esc(c.id)}">${avatar(c.name, p.cls, "sm")}<span class="grow"><strong>${esc(c.name)}</strong><span class="s">${esc(c.id)} · ${p.label}</span></span>${I.phone(16)}</li>`; }).join("")
      + dir.flatMap((c) => c.phones.slice(0, 2).map((ph) => `<li data-call="${esc(ph.number)}">${avatar(c.name, "", "sm")}<span class="grow"><strong>${esc(c.name)}</strong><span class="s">${esc(c.company ? c.company + " · " : "")}${esc(fmtNum(ph.number))}</span></span>${I.phone(16)}</li>`)).join("");
    wireCalls($("#sugg"));
  };
  const keep = () => { if (!TOUCH) num.focus(); };
  $$("[data-k]", d).forEach((b) => b.onclick = () => { num.value += b.dataset.k; keep(); sugg(); if (session) dtmf(b.dataset.k); });
  $("#bk").onclick = () => { num.value = num.value.slice(0, -1); keep(); sugg(); };
  $("#kbd")?.addEventListener("click", () => {
    const on = num.getAttribute("inputmode") === "none";
    num.setAttribute("inputmode", on ? "text" : "none");
    num.blur(); if (on) setTimeout(() => num.focus(), 30);
    $("#kbd").classList.toggle("on", on);
  });
  num.oninput = sugg;
  const go = () => { const v = num.value.trim(); if (!v) return; if (isDialable(v)) call(v); else { const c = contacts.find((x) => `${x.id} ${x.name}`.toLowerCase().includes(v.toLowerCase())); if (c) call(c.id); } };
  num.onkeydown = (e) => { if (e.key === "Enter") go(); };
  $("#dial").onclick = go;
  $("#drclose").onclick = () => openDrawer(false);
}

function callState() {
  if (!session) return "";
  if (session.isEstablished()) return session.isOnHold().local ? "En attente" : `En communication · <span id="dur">${fmtDur(Math.floor((Date.now() - startedAt) / 1000))}</span>`;
  return callInfo.direction === "in" ? "Appel entrant…" : callInfo.ringing ? "Ça sonne…" : "Appel en cours…";
}

function renderInCall(d) {
  const est = session.isEstablished(), held = session.isOnHold().local, muted = session.isMuted().audio;
  const label = callInfo.name || fmtNum(callInfo.number);
  const vid = !!(callInfo.video || remoteVideo.size), camOff = session.isMuted().video;
  $("#drawer").classList.toggle("wide", vid);
  d.innerHTML = `<div class="dr-head"><strong>${vid ? "Appel vidéo" : "Appel"}</strong><button class="ghost-ic" id="drclose" title="Réduire">${I.x()}</button></div>
    <div class="dr-body">
      ${vid ? `<div class="vstage" id="vstage"><div class="vgrid empty" id="vgrid"></div><video id="vlocal" autoplay playsinline muted></video>
        <div class="vcap"><strong>${esc(label)}</strong> · <span class="cstate">${callState()}</span></div></div>` : `<div class="sp-call">${avatar(callInfo.name || callInfo.number, "", "xl")}
        <div class="cname">${esc(label)}</div>${callInfo.name ? `<div class="s">${esc(fmtNum(callInfo.number))}</div>` : ""}
        <div class="cstate">${callState()}</div></div>`}
      <div class="sp-incall ${vid ? "v" : ""}">
        ${vid ? `<button class="opt ${camOff ? "on" : ""}" id="cam" ${est ? "" : "disabled"}>${camOff ? I.videooff() : I.video()}<span>${camOff ? "Caméra coupée" : "Caméra"}</span></button>
        <button class="opt" id="fs">${I.full()}<span>Plein écran</span></button>` : ""}
        <button class="opt ${muted ? "on" : ""}" id="mute">${muted ? I.micoff() : I.mic()}<span>${muted ? "Micro coupé" : "Muet"}</span></button>
        <button class="opt ${held ? "on" : ""}" id="hold" ${est ? "" : "disabled"}>${I.pause()}<span>${held ? "Reprendre" : "Attente"}</span></button>
        <button class="opt" id="kp" ${est ? "" : "disabled"}>${I.keypad()}<span>Clavier</span></button>
        <button class="opt" id="xfer" ${est ? "" : "disabled"}>${I.xfer()}<span>Transférer</span></button>
      </div>
      <div id="dtmf" hidden class="pad-grid small">${KEYS.map(([k]) => `<button class="key" data-d="${k}"><b>${k}</b></button>`).join("")}</div>
      <div id="xferbox" hidden>
        <div class="sp-xfer"><input id="xnum" placeholder="Transférer vers (nom, poste ou numéro)" autocomplete="off"><button class="btn sm" id="xgo">Transférer</button></div>
        <ul class="sugg" id="xsugg"></ul>
      </div>
      <div class="sp-actions"><button class="btn round hang" id="hang" title="Raccrocher">${I.phone(26)}</button></div>
    </div>`;
  $("#drclose").onclick = () => openDrawer(false);
  $("#hang").onclick = hangup;
  $("#cam")?.addEventListener("click", () => { camOff ? session.unmute({ video: true }) : session.mute({ video: true }); renderDrawer(); });
  $("#fs")?.addEventListener("click", () => { const v = $("#vstage"); document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.().catch(() => {}); });
  if (vid) drawVideos();
  $("#mute").onclick = () => { muted ? session.unmute({ audio: true }) : session.mute({ audio: true }); renderDrawer(); renderCallbar(); };
  $("#hold").onclick = () => { held ? session.unhold() : session.hold(); setTimeout(() => { renderDrawer(); renderCallbar(); }, 300); };
  $("#kp").onclick = () => { $("#dtmf").hidden = !$("#dtmf").hidden; $("#xferbox").hidden = true; };
  $("#xfer").onclick = () => { $("#xferbox").hidden = !$("#xferbox").hidden; $("#dtmf").hidden = true; $("#xnum").focus(); };
  $$("[data-d]", d).forEach((b) => b.onclick = () => dtmf(b.dataset.d));
  const x = $("#xnum");
  x.oninput = () => {
    const q = x.value.trim().toLowerCase();
    const list = q ? contacts.filter((c) => `${c.id} ${c.name}`.toLowerCase().includes(q)).slice(0, 5) : [];
    $("#xsugg").innerHTML = list.map((c) => { const p = presenceOf(c); return `<li data-x="${esc(c.id)}">${avatar(c.name, p.cls, "sm")}<span class="grow"><strong>${esc(c.name)}</strong><span class="s">${esc(c.id)} · ${p.label}</span></span>${I.xfer()}</li>`; }).join("");
    $$("[data-x]", $("#xsugg")).forEach((li) => li.onclick = () => transfer(li.dataset.x));
  };
  x.onkeydown = (e) => { if (e.key === "Enter") $("#xgo").click(); };
  $("#xgo").onclick = () => {
    const v = x.value.trim(); if (!v) return;
    if (isDialable(v)) return transfer(clean(v));
    const c = contacts.find((k) => `${k.id} ${k.name}`.toLowerCase().includes(v.toLowerCase())); if (c) transfer(c.id);
  };
}
function dtmf(k) { if (!session?.isEstablished()) return; try { session.sendDTMF(k, { transportType: "RFC2833" }); } catch { try { session.sendDTMF(k); } catch { /* */ } } }
function transfer(t) {
  try { session.refer(`sip:${t}@${me.sip.domain}`); callInfo.transferred = t; toast(`Transfert vers ${nameOf(t) || fmtNum(t)}…`); }
  catch (e) { toast(`Transfert impossible : ${e.message}`, "bad"); }
}
function hangup() { try { session.terminate(); } catch { /* déjà fini */ } }

function renderCallbar() {
  const b = $("#callbar"); if (!b) return;
  if (!session || drawerOpen || (callInfo.direction === "in" && !session.isEstablished())) { b.innerHTML = ""; return; }
  b.innerHTML = `<div class="callbar">${avatar(callInfo.name || callInfo.number, "", "sm")}
    <span class="grow"><strong>${esc(callInfo.name || fmtNum(callInfo.number))}</strong><span class="s">${callState()}</span></span>
    <button class="btn ghost sm" id="cbopen">Ouvrir</button><button class="btn round hang sm" id="cbhang" title="Raccrocher">${I.phone(18)}</button></div>`;
  $("#cbopen").onclick = () => openDrawer(true);
  $("#cbhang").onclick = hangup;
}

// ------------------------------------------------------------------ SIP
function setReg(s) {
  regState = s;
  const r = $("#reg"); if (r) { r.className = `reg ${s}`; r.textContent = regLabel(); }
  refreshPresence();
  if (!session) renderDrawer();
}

function connect() {
  if (!window.JsSIP || !me.sip.secure) { setReg("off"); return; }
  JsSIP.debug.disable("JsSIP:*");
  const socket = new JsSIP.WebSocketInterface(me.sip.ws_url);
  ua = new JsSIP.UA({
    sockets: [socket], uri: `sip:${me.sip.user}@${me.sip.domain}`, authorization_user: me.sip.auth_user, password: me.sip.password,
    display_name: me.sip.display_name, register: true, register_expires: 300, session_timers: false, user_agent: IN_APP ? "Callikoe-App/0.1 (web)" : "Callikoe-Web/1.0",
  });
  ua.on("connecting", () => setReg("wait"));
  ua.on("registered", () => setReg("on"));
  ua.on("unregistered", () => setReg("off"));
  ua.on("disconnected", () => setReg("wait"));
  ua.on("registrationFailed", () => setReg("fail"));
  ua.on("newRTCSession", ({ session: s, originator }) => {
    if (session) { if (originator === "remote") s.terminate({ status_code: 486 }); return; }
    meterStop?.();
    session = s;
    const remote = s.remote_identity;
    callInfo = originator === "remote"
      ? { direction: "in", number: remote.uri.user, name: remote.display_name || nameOf(remote.uri.user) }
      : { direction: "out", number: callInfo?.number || remote.uri.user, name: nameOf(callInfo?.number || remote.uri.user) || roomName(callInfo?.number), video: !!callInfo?.video };
    if (originator === "remote") callInfo.offerVideo = /\bm=video [1-9]/.test(String(s._request?.body || ""));
    s.on("peerconnection", (e) => hookAudio(e.peerconnection));
    s.on("icecandidate", (e) => { if (e.candidate.type === "srflx" || e.candidate.type === "relay") e.ready(); });
    s.on("progress", () => { if (callInfo.direction === "out") { callInfo.ringing = true; stopTone?.(); stopTone = tone(RINGBACK, "tones"); renderDrawer(); renderCallbar(); } });
    s.on("accepted", () => { stopTone?.(); stopTone = null; startedAt = Date.now(); hideIncoming(); openDrawer(true); renderDrawer(); tick(); });
    s.on("confirmed", () => { renderDrawer(); renderCallbar(); });
    s.on("hold", () => renderDrawer()); s.on("unhold", () => renderDrawer());
    s.on("ended", () => finish("answered"));
    s.on("failed", (e) => finish(callInfo.direction === "in" && !startedAt ? "missed" : "failed", e.cause));
    // Interphone (groupe « annonce sans décrocher ») : décroché automatique
    const ci = originator === "remote" ? String(s._request?.getHeader?.("Call-Info") || "") : "";
    if (/answer-after=0/i.test(ci)) {
      callInfo.intercom = true;
      try { s.answer({ mediaConstraints: { audio: micConstraint(), video: false }, pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] } }); toast(`Annonce de ${callInfo.name || fmtNum(callInfo.number)}`); }
      catch { showIncoming(); }
      return;
    }
    if (originator === "remote") showIncoming(); else { renderDrawer(); openDrawer(true); }
  });
  ua.start();
}

function roomName(num) { const r = (me?.rooms || []).find((x) => x.number === num); return r ? `Réunion ${r.name}` : ""; }
function nameOf(num) { return contacts.find((c) => c.id === num)?.name || (num === me.user.id ? me.user.name : "") || dirByNumber(num)?.name || ""; }

// Médias distants : l'audio va dans <audio id=remote>, chaque flux vidéo (1 en appel, plusieurs en réunion) dans une vignette
let remoteAudio = null;
const remoteVideo = new Map();
function hookAudio(pc) {
  if (pc._callikoe) return; pc._callikoe = true;
  pc.addEventListener("track", (ev) => {
    if (ev.track.kind === "audio") {
      remoteAudio ||= new MediaStream();
      if (!remoteAudio.getTracks().includes(ev.track)) remoteAudio.addTrack(ev.track);
      const a = $("#remote"); a.srcObject = remoteAudio; a.play().catch(() => {});
      return;
    }
    const st = ev.streams[0] || new MediaStream([ev.track]);
    const drop = () => { if (!st.getVideoTracks().some((t) => t.readyState === "live" && !t.muted)) { remoteVideo.delete(st.id); drawVideos(); } };
    remoteVideo.set(st.id, st);
    ev.track.addEventListener("ended", drop); ev.track.addEventListener("mute", drop);
    ev.track.addEventListener("unmute", () => { remoteVideo.set(st.id, st); drawVideos(); });
    st.addEventListener("removetrack", drop);
    if (callInfo) callInfo.video = true;
    if (session) { renderDrawer(); }
  });
}
function localVideoStream() {
  const t = session?.connection?.getSenders().map((x) => x.track).find((x) => x?.kind === "video");
  return t ? new MediaStream([t]) : null;
}
function drawVideos() {
  const g = $("#vgrid"); if (!g) return;
  const live = [...remoteVideo.values()].filter((s) => s.getVideoTracks().some((t) => t.readyState === "live"));
  g.dataset.n = String(Math.min(live.length, 9));
  const have = new Set([...g.querySelectorAll("video")].map((v) => v.dataset.sid));
  for (const v of g.querySelectorAll("video")) if (!live.some((s) => s.id === v.dataset.sid)) v.remove();
  for (const s of live) if (!have.has(s.id)) { const v = document.createElement("video"); v.autoplay = true; v.playsInline = true; v.muted = true; v.dataset.sid = s.id; v.srcObject = s; g.append(v); v.play().catch(() => {}); }
  g.classList.toggle("empty", !live.length);
  const lv = $("#vlocal"); const ls = localVideoStream();
  if (lv && ls && lv.srcObject?.getVideoTracks()[0] !== ls.getVideoTracks()[0]) { lv.srcObject = ls; lv.play().catch(() => {}); }
  if (lv) lv.hidden = !ls || session?.isMuted().video;
}
const videoConstraint = () => ({ width: { ideal: 1280 }, height: { ideal: 720 } });

function call(raw, { video = false } = {}) {
  const num = clean(raw);
  if (!num) return;
  if (session) return toast("Un appel est déjà en cours.", "bad");
  if (!ua || regState !== "on") return toast("Le softphone n'est pas connecté au PBX.", "bad");
  audioReady();
  callInfo = { direction: "out", number: num, name: nameOf(num) || roomName(num), video };
  try {
    const s = ua.call(`sip:${num}@${me.sip.domain}`, {
      mediaConstraints: { audio: micConstraint(), video: video ? videoConstraint() : false },
      pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], bundlePolicy: "max-bundle" },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: video },
    });
    if (s.connection) hookAudio(s.connection);
  } catch (e) { toast(`Appel impossible : ${e.message}`, "bad"); callInfo = null; }
}

function tick() {
  clearInterval(timer);
  timer = setInterval(() => { for (const d of $$("#dur")) d.textContent = fmtDur(Math.floor((Date.now() - startedAt) / 1000)); renderCallbarTime(); }, 1000);
}
function renderCallbarTime() { const s = $("#callbar .s"); if (s && session) s.innerHTML = callState(); }

function finish(status, cause) {
  stopTone?.(); stopTone = null; clearInterval(timer); hideIncoming();
  if (callInfo) addHistory({ direction: callInfo.direction, number: callInfo.number, name: callInfo.name, status, at: new Date().toISOString(), duration: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0 });
  const msg = status === "failed" && cause && !["Canceled", "Terminated"].includes(cause) ? ({ Busy: "Occupé", Rejected: "Refusé", Unavailable: "Indisponible", "Not Found": "Numéro inconnu", "User Denied Media Access": "Accès au micro refusé" }[cause] || cause) : "";
  const wasIncomingMissed = status === "missed";
  session = null; callInfo = null; startedAt = 0; remoteVideo.clear(); remoteAudio = null;
  $("#drawer")?.classList.remove("wide");
  renderDrawer(); renderCallbar();
  if (msg) { toast(`Appel terminé : ${msg}`, "bad"); const h = $("#dhint"); if (h) { h.textContent = `Appel terminé : ${msg}`; h.classList.add("err"); } }
  if (!msg && !wasIncomingMissed && drawerOpen) setTimeout(() => { if (!session) openDrawer(false); }, 1200);
  if (page === "appels") renderPage();
  badges();
  setTimeout(refreshCalls, 2500); // le PBX écrit le journal à la fin de l'appel
}

let blink = null, notif = null;
function showIncoming() {
  stopTone?.(); stopTone = tone(RINGTONE, "ringer");
  const label = callInfo.name || fmtNum(callInfo.number);
  const t = document.title; blink = setInterval(() => { document.title = document.title === t ? `📞 ${label}` : t; }, 900);
  if (document.hidden && window.Notification?.permission === "granted") {
    try { notif = new Notification("Appel entrant", { body: `${label}${callInfo.name ? ` (${fmtNum(callInfo.number)})` : ""}`, tag: "callikoe-call", requireInteraction: true }); notif.onclick = () => { window.focus(); notif.close(); }; } catch { /* */ }
  }
  $("#incoming").innerHTML = `<div class="sp-incoming panel">${avatar(callInfo.name || callInfo.number, "", "")}
    <div class="grow"><div class="s">${callInfo.offerVideo ? "Appel vidéo entrant" : "Appel entrant"}</div><div class="cname">${esc(label)}</div>${callInfo.name ? `<div class="s">${esc(fmtNum(callInfo.number))}</div>` : ""}</div>
    <div class="row"><button class="btn round hang" id="decline" title="Refuser">${I.phone(22)}</button>${callInfo.offerVideo ? `<button class="btn round call" id="answerv" title="Répondre en vidéo">${I.video(22)}</button>` : ""}<button class="btn round call" id="answer" title="Répondre">${I.phone(22)}</button></div></div>`;
  const answer = (video) => {
    callInfo.video = video;
    try { session.answer({ mediaConstraints: { audio: micConstraint(), video: video ? videoConstraint() : false }, pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], bundlePolicy: "max-bundle" } }); }
    catch (e) { toast(`Impossible de répondre : ${e.message}`, "bad"); }
  };
  $("#answer").onclick = () => answer(false);
  $("#answerv")?.addEventListener("click", () => answer(true));
  $("#decline").onclick = () => { try { session.terminate({ status_code: 486 }); } catch { /* */ } };
  renderCallbar();
}
function hideIncoming() { clearInterval(blink); blink = null; notif?.close(); notif = null; if (me) setTitle(); const i = $("#incoming"); if (i) i.innerHTML = ""; }

// ------------------------------------------------------------------ Œil sur les mots de passe
function addEyes() {
  for (const input of document.querySelectorAll('input[type="password"]:not([data-eye])')) {
    input.dataset.eye = "1";
    const wrap = document.createElement("span"); wrap.className = "pw-wrap"; input.replaceWith(wrap);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "pw-eye"; btn.textContent = "👁"; btn.title = "Afficher";
    btn.onclick = () => { input.type = input.type === "password" ? "text" : "password"; input.focus(); };
    wrap.append(input, btn);
  }
}

window.addEventListener("beforeunload", (e) => { if (session) { e.preventDefault(); e.returnValue = ""; } });
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !me || !$("#page")) return;
  refreshTeam();
  if (page === "chat" && chatSel) { const c = chats.find((x) => x.id === chatSel); const last = chatMsgs.at(-1); if (c?.unread && last) { c.unread = 0; badges(); drawChatList(); api("POST", `/api/u/chats/${chatSel}/read`, { last: last.id }).catch(() => {}); } }
});
const welcomeToken = new URLSearchParams(location.search).get("bienvenue");
if (welcomeToken) renderWelcome(welcomeToken); else start();
