// Softphone web Callikoe — WebRTC via JsSIP, connecté au PBX par https://<fqdn>/ws
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtNum = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const fmtDur = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const STATUS = { available: "Disponible", away: "Absent", dnd: "Ne pas déranger" };

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  let data = null; try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

// ------------------------------------------------------------------ Sons (WebAudio, sans fichier)
let audioCtx = null;
function tone(pattern) { // pattern : [[fréquences], durée ms, silence ms]
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { return () => {}; }
  let stopped = false, nodes = [];
  const play = () => {
    if (stopped) return;
    const [freqs, on, off] = pattern;
    const gain = audioCtx.createGain(); gain.gain.value = 0.06; gain.connect(audioCtx.destination);
    nodes = freqs.map((f) => { const o = audioCtx.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); return o; });
    setTimeout(() => { nodes.forEach((o) => o.stop()); gain.disconnect(); setTimeout(play, off); }, on);
  };
  play();
  return () => { stopped = true; nodes.forEach((o) => { try { o.stop(); } catch { /* déjà arrêté */ } }); };
}
const RINGBACK = [[440], 1500, 3500];          // tonalité de retour d'appel (France : 440 Hz)
const RINGTONE = [[523, 659], 900, 1400];      // sonnerie d'appel entrant

// ------------------------------------------------------------------ État
let me = null, ua = null, session = null, regState = "off", timer = null, startedAt = 0, stopTone = null;
let callInfo = null; // { direction, number, name }
const histKey = () => `callikoe_hist_${me?.user.id}`;
function history() { try { return JSON.parse(localStorage.getItem(histKey()) || "[]"); } catch { return []; } }
function addHistory(h) { try { localStorage.setItem(histKey(), JSON.stringify([h, ...history()].slice(0, 40))); } catch { /* stockage indisponible */ } }

// ------------------------------------------------------------------ Connexion
function renderLogin(msg) {
  $("#head").innerHTML = ""; $("#banner").innerHTML = "";
  app.innerHTML = `<div class="sp-login panel">
    <h1>Espace utilisateur</h1>
    <p class="sub">Connecte-toi avec ton numéro de poste (ou ton e-mail) et le mot de passe fourni par ton administrateur.</p>
    ${msg ? `<div class="flash bad">${esc(msg)}</div>` : ""}
    <form id="lf" class="stack" method="post" novalidate>
      <label>Numéro de poste ou e-mail<input name="login" autocomplete="username" autofocus required></label>
      <label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Se connecter</button>
    </form></div>`;
  addEyes();
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api("POST", "/api/u/login", fd); start(); } catch (err) { renderLogin(err.message); }
  };
}

async function start() {
  try { me = await api("GET", "/api/u/me"); } catch (e) { if (e.status === 401) return renderLogin(); app.innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; return; }
  document.title = `${me.user.id} · ${me.user.name} · Softphone`;
  $("#pbx-name").textContent = me.pbx.name || "Softphone";
  renderHead();
  renderBanner();
  renderMain();
  connect();
}

function renderHead() {
  $("#head").innerHTML = `<span class="reg ${regState}" id="reg" title="État de la connexion">${{ on: "En ligne", wait: "Connexion…", off: "Hors ligne", fail: "Refusé" }[regState]}</span>
    <select id="presence" aria-label="Statut">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${me.user.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <span class="who"><strong>${esc(me.user.name)}</strong> · ${esc(me.user.id)}</span>
    <button class="btn ghost sm" id="logout">${me.impersonated_by ? "Quitter" : "Déconnexion"}</button>`;
  $("#presence").onchange = async (e) => {
    try { const r = await api("PUT", "/api/u/status", { status: e.target.value }); me.user.status = r.status; }
    catch (err) { alert(err.message); e.target.value = me.user.status; }
  };
  $("#logout").onclick = async () => { try { ua?.stop(); } catch { /* */ } await api("POST", "/api/u/logout"); me.impersonated_by ? window.close() : renderLogin(); };
}

function renderBanner() {
  const b = [];
  if (me.impersonated_by) b.push(`<div class="sp-banner imp">Mode incarnation : tu es connecté en tant que <strong>${esc(me.user.id)} · ${esc(me.user.name)}</strong> (ouvert par ${esc(me.impersonated_by)}).</div>`);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) b.push(`<div class="sp-banner warn">Le softphone a besoin d'une connexion <strong>HTTPS</strong> pour utiliser le micro. Il fonctionnera dès que l'adresse du PBX aura son certificat (console › Système).</div>`);
  $("#banner").innerHTML = b.join("");
}

// ------------------------------------------------------------------ Interface
function renderMain() {
  app.innerHTML = `<div class="sp-grid">
    <section class="panel sp-phone" id="phone"></section>
    <section class="panel sp-side">
      <nav class="tabs sp-tabs"><a href="#" data-tab="contacts" class="on">Collègues</a><a href="#" data-tab="hist">Historique</a></nav>
      <div id="side"></div>
    </section></div>
    <div id="incoming"></div>`;
  app.querySelectorAll("[data-tab]").forEach((a) => a.onclick = (e) => {
    e.preventDefault(); app.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === a)); renderSide(a.dataset.tab);
  });
  renderPhone();
  renderSide("contacts");
}

function renderSide(tab) {
  const side = $("#side");
  if (tab === "contacts") {
    side.innerHTML = `<div class="pad" style="padding-bottom:6px"><input id="cq" type="search" placeholder="Rechercher un collègue…"></div><ul class="sp-list" id="clist"></ul>`;
    const draw = () => {
      const q = $("#cq").value.toLowerCase();
      $("#clist").innerHTML = me.contacts.filter((c) => !q || `${c.id} ${c.name}`.toLowerCase().includes(q)).map((c) => `<li>
        <span class="dot ${c.registered ? c.status : "off"}" title="${c.registered ? STATUS[c.status] : "Non connecté"}"></span>
        <span class="grow"><strong>${esc(c.name)}</strong><span class="s">${esc(c.id)}</span></span>
        <button class="btn sm callbtn" data-call="${esc(c.id)}" title="Appeler">${ICON_CALL}</button></li>`).join("") || '<li class="s">Aucun collègue.</li>';
      wireCallButtons(side);
    };
    $("#cq").oninput = draw; draw();
  } else {
    const h = history();
    side.innerHTML = `<ul class="sp-list">${h.map((x) => `<li>
      <span class="hdir ${x.status}">${x.direction === "in" ? "↙" : "↗"}</span>
      <span class="grow"><strong>${esc(x.name || fmtNum(x.number))}</strong><span class="s">${esc(new Date(x.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))} · ${x.status === "missed" ? "manqué" : x.status === "failed" ? "échec" : fmtDur(x.duration || 0)}</span></span>
      <button class="btn sm callbtn" data-call="${esc(x.number)}" title="Rappeler">${ICON_CALL}</button></li>`).join("") || '<li class="s">Aucun appel pour l\'instant.</li>'}</ul>`;
    wireCallButtons(side);
  }
}
function wireCallButtons(root) { root.querySelectorAll("[data-call]").forEach((b) => b.onclick = () => call(b.dataset.call)); }

const ICON_CALL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';
const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

function renderPhone() {
  const p = $("#phone");
  const ready = regState === "on";
  if (!session) {
    p.innerHTML = `<div class="sp-display"><input id="num" inputmode="tel" placeholder="Numéro ou poste" autocomplete="off"><button class="bk" id="bk" title="Effacer">⌫</button></div>
      <div class="pad-grid">${KEYS.map(([k, l]) => `<button class="key" data-k="${k}"><b>${k}</b><span>${l}</span></button>`).join("")}</div>
      <div class="sp-actions"><button class="btn round call" id="dial" ${ready ? "" : "disabled"} title="Appeler">${ICON_CALL}</button></div>
      <p class="hint center">${ready ? "Tape un numéro (national, poste à 3 chiffres, *97 pour la messagerie)." : regState === "fail" ? "Connexion refusée par le PBX." : "Connexion au PBX…"}</p>`;
    const num = $("#num");
    p.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { num.value += b.dataset.k; num.focus(); });
    $("#bk").onclick = () => { num.value = num.value.slice(0, -1); num.focus(); };
    num.onkeydown = (e) => { if (e.key === "Enter") call(num.value); };
    $("#dial").onclick = () => call(num.value);
    return;
  }
  const st = session.isEstablished() ? `En communication · <span id="dur">${fmtDur(Math.floor((Date.now() - startedAt) / 1000))}</span>`
    : callInfo.direction === "in" ? "Appel entrant…" : callInfo.ringing ? "Ça sonne…" : "Appel en cours…";
  const held = session.isOnHold().local, muted = session.isMuted().audio;
  p.innerHTML = `<div class="sp-call">
      <div class="avatar">${esc((callInfo.name || callInfo.number || "?").trim().charAt(0).toUpperCase())}</div>
      <div class="cname">${esc(callInfo.name || fmtNum(callInfo.number))}</div>
      ${callInfo.name ? `<div class="s">${esc(fmtNum(callInfo.number))}</div>` : ""}
      <div class="cstate">${held ? "En attente" : st}</div>
    </div>
    <div class="sp-incall">
      <button class="opt ${muted ? "on" : ""}" id="mute">${muted ? "Réactiver le micro" : "Muet"}</button>
      <button class="opt ${held ? "on" : ""}" id="hold" ${session.isEstablished() ? "" : "disabled"}>${held ? "Reprendre" : "Attente"}</button>
      <button class="opt" id="kp" ${session.isEstablished() ? "" : "disabled"}>Clavier</button>
      <button class="opt" id="xfer" ${session.isEstablished() ? "" : "disabled"}>Transférer</button>
    </div>
    <div id="dtmf" hidden class="pad-grid small">${KEYS.map(([k]) => `<button class="key" data-d="${k}"><b>${k}</b></button>`).join("")}</div>
    <div id="xferbox" hidden class="sp-xfer"><input id="xnum" inputmode="tel" placeholder="Transférer vers (poste ou numéro)"><button class="btn sm" id="xgo">Transférer</button></div>
    <div class="sp-actions"><button class="btn round hang" id="hang" title="Raccrocher">${ICON_CALL}</button></div>`;
  $("#hang").onclick = () => { try { session.terminate(); } catch { /* déjà fini */ } };
  $("#mute").onclick = () => { muted ? session.unmute({ audio: true }) : session.mute({ audio: true }); renderPhone(); };
  $("#hold").onclick = () => { held ? session.unhold() : session.hold(); setTimeout(renderPhone, 300); };
  $("#kp").onclick = () => { $("#dtmf").hidden = !$("#dtmf").hidden; };
  $("#xfer").onclick = () => { $("#xferbox").hidden = !$("#xferbox").hidden; $("#xnum").focus(); };
  p.querySelectorAll("[data-d]").forEach((b) => b.onclick = () => { try { session.sendDTMF(b.dataset.d, { transportType: "RFC2833" }); } catch { session.sendDTMF(b.dataset.d); } });
  $("#xgo").onclick = () => {
    const t = clean($("#xnum").value);
    if (!t) return;
    try { session.refer(`sip:${t}@${me.sip.domain}`); callInfo.transferred = t; } catch (e) { alert(`Transfert impossible : ${e.message}`); }
  };
}

const clean = (n) => String(n || "").replace(/[\s.\-()]/g, "").replace(/^\+33/, "0").replace(/^0033/, "0");

// ------------------------------------------------------------------ SIP
function setReg(s) { regState = s; const r = $("#reg"); if (r) { r.className = `reg ${s}`; r.textContent = { on: "En ligne", wait: "Connexion…", off: "Hors ligne", fail: "Refusé" }[s]; } if (!session && $("#phone")) renderPhone(); }

function connect() {
  if (!window.JsSIP) { setReg("off"); return; }
  if (!me.sip.secure) { setReg("off"); return; }
  JsSIP.debug.disable("JsSIP:*");
  const socket = new JsSIP.WebSocketInterface(me.sip.ws_url);
  ua = new JsSIP.UA({
    sockets: [socket], uri: `sip:${me.sip.user}@${me.sip.domain}`, authorization_user: me.sip.auth_user, password: me.sip.password,
    display_name: me.sip.display_name, register: true, register_expires: 300, session_timers: false, user_agent: "Callikoe-Web/1.0",
  });
  ua.on("connecting", () => setReg("wait"));
  ua.on("registered", () => setReg("on"));
  ua.on("unregistered", () => setReg("off"));
  ua.on("disconnected", () => setReg("wait"));
  ua.on("registrationFailed", () => setReg("fail"));
  ua.on("newRTCSession", ({ session: s, originator }) => {
    if (session) { if (originator === "remote") s.terminate({ status_code: 486 }); return; }
    session = s;
    const remote = s.remote_identity;
    callInfo = originator === "remote"
      ? { direction: "in", number: remote.uri.user, name: remote.display_name || nameOf(remote.uri.user) }
      : { direction: "out", number: callInfo?.number || remote.uri.user, name: nameOf(remote.uri.user) };
    s.on("peerconnection", (e) => hookAudio(e.peerconnection));
    s.on("icecandidate", (e) => { if (e.candidate.type === "srflx" || e.candidate.type === "relay") e.ready(); });
    s.on("progress", () => { if (callInfo.direction === "out") { callInfo.ringing = true; stopTone?.(); stopTone = tone(RINGBACK); renderPhone(); } });
    s.on("accepted", () => { stopTone?.(); stopTone = null; startedAt = Date.now(); hideIncoming(); renderPhone(); tick(); });
    s.on("confirmed", () => renderPhone());
    s.on("hold", () => renderPhone()); s.on("unhold", () => renderPhone());
    s.on("ended", () => finish("answered"));
    s.on("failed", (e) => finish(callInfo.direction === "in" && !startedAt ? "missed" : "failed", e.cause));
    if (originator === "remote") showIncoming(); else renderPhone();
  });
  ua.start();
}

function nameOf(num) { return me.contacts.find((c) => c.id === num)?.name || (num === me.user.id ? me.user.name : ""); }

function hookAudio(pc) {
  pc.addEventListener("track", (ev) => { const a = $("#remote"); a.srcObject = ev.streams[0]; a.play().catch(() => {}); });
}

function call(raw) {
  const num = clean(raw);
  if (!num || !ua || regState !== "on" || session) return;
  callInfo = { direction: "out", number: num, name: nameOf(num) };
  try {
    const s = ua.call(`sip:${num}@${me.sip.domain}`, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });
    if (s.connection) hookAudio(s.connection);
  } catch (e) { alert(`Appel impossible : ${e.message}`); callInfo = null; }
}

function tick() {
  clearInterval(timer);
  timer = setInterval(() => { const d = $("#dur"); if (d) d.textContent = fmtDur(Math.floor((Date.now() - startedAt) / 1000)); }, 1000);
}

function finish(status, cause) {
  stopTone?.(); stopTone = null; clearInterval(timer); hideIncoming();
  if (callInfo) addHistory({ ...callInfo, ringing: undefined, status, at: new Date().toISOString(), duration: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0 });
  const msg = status === "failed" && cause && !["Canceled", "Terminated"].includes(cause) ? ({ Busy: "Occupé", Rejected: "Refusé", "Unavailable": "Indisponible", "Not Found": "Numéro inconnu", "User Denied Media Access": "Accès au micro refusé" }[cause] || cause) : "";
  session = null; callInfo = null; startedAt = 0;
  renderPhone();
  if (msg) { const h = $("#phone .hint"); if (h) { h.textContent = `Appel terminé : ${msg}`; h.classList.add("err"); } }
  if ($("[data-tab=hist].on")) renderSide("hist");
}

let blink = null;
function showIncoming() {
  stopTone?.(); stopTone = tone(RINGTONE);
  const t = document.title; blink = setInterval(() => { document.title = document.title === t ? `📞 ${callInfo.name || callInfo.number}` : t; }, 900);
  $("#incoming").innerHTML = `<div class="sp-incoming panel"><div class="avatar">${esc((callInfo.name || callInfo.number || "?").charAt(0).toUpperCase())}</div>
    <div><div class="s">Appel entrant</div><div class="cname">${esc(callInfo.name || fmtNum(callInfo.number))}</div>${callInfo.name ? `<div class="s">${esc(fmtNum(callInfo.number))}</div>` : ""}</div>
    <div class="row"><button class="btn round hang" id="decline" title="Refuser">${ICON_CALL}</button><button class="btn round call" id="answer" title="Répondre">${ICON_CALL}</button></div></div>`;
  $("#answer").onclick = () => {
    try { session.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] } }); }
    catch (e) { alert(`Impossible de répondre : ${e.message}`); }
  };
  $("#decline").onclick = () => { try { session.terminate({ status_code: 486 }); } catch { /* */ } };
  renderPhone();
}
function hideIncoming() { clearInterval(blink); blink = null; document.title = me ? `${me.user.id} · ${me.user.name} · Softphone` : document.title; const i = $("#incoming"); if (i) i.innerHTML = ""; }

// ------------------------------------------------------------------ Œil sur le mot de passe
function addEyes() {
  for (const input of document.querySelectorAll('input[type="password"]:not([data-eye])')) {
    input.dataset.eye = "1";
    const wrap = document.createElement("span"); wrap.className = "pw-wrap"; input.replaceWith(wrap);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "pw-eye"; btn.textContent = "👁"; btn.title = "Afficher le mot de passe";
    btn.onclick = () => { input.type = input.type === "password" ? "text" : "password"; input.focus(); };
    wrap.append(input, btn);
  }
}

window.addEventListener("beforeunload", (e) => { if (session) { e.preventDefault(); e.returnValue = ""; } });
start();
