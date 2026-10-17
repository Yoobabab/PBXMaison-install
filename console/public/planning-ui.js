// Gestion d'appels › Routages › Planning de la semaine.
// Écran partagé : console du PBX (administrateur) et softphone / appli (utilisateur « Responsable »).
//
// renderPlanning(root, opts)
//   opts.cf      : { objects, users, timezone, trunk_dids }   (objets du PBX pour choisir les étapes)
//   opts.plan    : objet planning existant { id, name, data } ou null (nouveau)
//   opts.mode    : "admin" | "manager" (le responsable ne change ni le nom, ni les numéros)
//   opts.save(body) → Promise<objet>, opts.remove() → Promise, opts.done(message), opts.top (HTML au-dessus)
//   opts.backHref / opts.backLabel, opts.traceHref(did)
import {
  PLAN_DAYS, PLAN_DAY_LONG, PLAN_COLORS, PLAN_MAX_SCENARIOS, planMin, planTime, ymdOf, weekdayOf, mondayOf,
  isWeekB, planHolidays, dayPlan, resolvePlan, localNow, paintSlots,
} from "./planning-core.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtP = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const DAY_SHORT = { mon: "Lun", tue: "Mar", wed: "Mer", thu: "Jeu", fri: "Ven", sat: "Sam", sun: "Dim" };
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const STEP_LABEL = {
  ring: "Faire sonner", group: "Groupe d'appel", queue: "File d'attente", prompt: "Lire une annonce", ivr: "SVI (menu)",
  user: "Utilisateur (avec ses renvois)", user_vm: "Boîte vocale", groupvm: "Boîte vocale de groupe", conf: "Salle de réunion",
  external: "Numéro externe", hangup: "Raccrocher",
};
const TERMINAL = ["ivr", "user", "user_vm", "groupvm", "conf", "external", "hangup"];
const OBJ_STEPS = ["group", "queue", "prompt", "ivr", "groupvm", "conf"];
const CELL = 11; // hauteur d'un quart d'heure (px)

let S = null; // état de l'écran

const longDate = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return `${PLAN_DAY_LONG[weekdayOf(ymd)]} ${d} ${MONTHS[m - 1]} ${y}`; };
const emptyWeek = () => Object.fromEntries(PLAN_DAYS.map((x) => [x, []]));
const newId = () => { for (;;) { const id = Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, ""); if (id && !S.p.scenarios.some((x) => x.id === id)) return id; } };

export function renderPlanning(root, opts) {
  const today = localNow(new Date(), opts.cf.timezone).ymd;
  const base = opts.plan ? structuredClone(opts.plan.data) : {
    name: "", dids: [], is_default: false, managers: true,
    scenarios: [{ id: "x", name: "En dehors des plages", color: "#94a3b8" }], branches: { x: [{ type: "hangup", target: "" }] }, outside: "x",
    week: emptyWeek(), alternate: false, week_b: emptyWeek(), ref_monday: mondayOf(today), holidays_fr: true, holiday_scenario: "x", days: {}, override: "",
  };
  base.week ||= emptyWeek(); base.week_b ||= emptyWeek(); base.days ||= {}; base.ref_monday ||= mondayOf(today);
  S = { root, opts, p: base, wk: "a", brush: base.scenarios.find((x) => x.id !== base.outside)?.id || base.outside, full: false,
    month: today.slice(0, 7), pick: null, drawer: null, err: null, today, dirty: false };
  root.innerHTML = `${opts.top || ""}<div class="panel tabbed pl" id="pl"></div><div class="fx-drawer pl-drawer" id="pldr" aria-hidden="true"></div><div class="fx-scrim" id="plscrim"></div>`;
  root.querySelector("#plscrim").onclick = closeDrawer;
  draw();
}

// ---------------------------------------------------------------- Rendu principal
const sc = (id) => S.p.scenarios.find((x) => x.id === id);
const scName = (id) => sc(id)?.name || "?";
const scColor = (id) => sc(id)?.color || "#94a3b8";
const dot = (id, big = false) => `<span class="pl-dot${big ? " big" : ""}" style="background:${esc(scColor(id))}"></span>`;
const users = () => S.opts.cf.users;
const objs = (kind) => S.opts.cf.objects.filter((o) => o.kind === kind);
const userName = (id) => users().find((u) => u.id === id)?.name || id;

function describeStep(st) {
  const o = (k, id) => S.opts.cf.objects.find((x) => x.kind === k && x.id === id);
  switch (st.type) {
    case "ring": return st.users?.length ? `Sonne ${st.users.map((u) => `${u} ${userName(u)}`).join(", ")} · ${st.time || 20} s` : "Faire sonner : choisis qui";
    case "group": { const g = o("group", st.target); return g ? `Groupe ${g.number} ${g.name}${st.time ? ` · ${st.time} s` : ""}` : "Groupe : à choisir"; }
    case "external": return st.target ? `Renvoi vers ${fmtP(st.target)}` : "Numéro externe : à saisir";
    case "user": return st.target ? `${st.target} ${userName(st.target)} (ses renvois)` : "Utilisateur : à choisir";
    case "user_vm": return st.target ? `Messagerie de ${st.target} ${userName(st.target)}` : "Boîte vocale : à choisir";
    case "hangup": return "Raccroche";
    default: { const x = o(st.type, st.target); return x ? `${STEP_LABEL[st.type]} ${x.number ? x.number + " " : ""}${x.name}` : `${STEP_LABEL[st.type]} : à choisir`; }
  }
}
const chainText = (id) => (S.p.branches[id] || []).map(describeStep).join(" → ") || "Aucune étape";

function draw() {
  const p = S.p, admin = S.opts.mode === "admin", cur = S.opts.plan;
  const now = localNow(new Date(), S.opts.cf.timezone);
  const res = resolvePlan(p, now.ymd, now.minute);
  const box = S.root.querySelector("#pl");
  box.innerHTML = `
    <div class="fx-top">
      ${S.opts.backHref ? `<a href="${esc(S.opts.backHref)}" class="fx-back">← ${esc(S.opts.backLabel || "Retour")}</a>` : ""}
      ${admin ? `<input id="plname" class="fx-name" maxlength="50" value="${esc(p.name)}" placeholder="Nom du planning (ex. Standard 04 04 04 04 04)" aria-label="Nom du planning">` : `<h2 class="pl-title">${esc(p.name)}</h2>`}
      <div class="fx-actions">${admin && cur ? '<button type="button" class="btn ghost" id="pldel">Supprimer</button>' : ""}${admin && cur?.data.dids?.[0] && S.opts.traceHref ? `<a class="btn ghost" href="${esc(S.opts.traceHref(cur.data.dids[0]))}">Tracer</a>` : ""}<button type="button" class="btn" id="plsave">Valider et appliquer</button></div>
    </div>
    ${admin ? `<div class="fx-entry">
      <div class="fx-box"><span class="fx-bi">☎</span><div class="fx-bc"><span class="fx-bl">Numéros appelés (SDA)</span><div class="fx-chips" id="pldids"></div></div></div>
      <label class="check fx-def"><input type="checkbox" id="pldef" ${p.is_default ? "checked" : ""}> Routage par défaut (SDA sans règle)</label>
      <label class="check fx-def"><input type="checkbox" id="plman" ${p.managers ? "checked" : ""}> Modifiable par les superviseurs (softphone et appli)</label>
    </div>` : `<p class="hint pad" style="margin:0">Numéros : ${p.dids.map(fmtP).map(esc).join(", ") || (p.is_default ? "toutes les SDA sans règle" : "—")}</p>`}

    <div class="pl-now">
      <div class="pl-nowmain">${dot(res.scenario, true)}<div><strong>Maintenant (${esc(PLAN_DAY_LONG[weekdayOf(now.ymd)].toLowerCase())} ${planTime(now.minute)}) : ${esc(scName(res.scenario))}</strong>
        <div class="s">${esc(res.forced ? "Scénario forcé" : res.label)} · ${esc(chainText(res.scenario))}</div></div></div>
      <label class="pl-force">Forcer<select id="plforce"><option value="">Automatique (selon le planning)</option>${p.scenarios.map((x) => `<option value="${esc(x.id)}" ${p.override === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    </div>
    ${p.override ? `<div class="flash warn" style="margin:0 16px">Le planning est forcé sur « ${esc(scName(p.override))} » : les plages ci-dessous sont ignorées jusqu'à ce que tu remettes « Automatique ».</div>` : ""}

    <section class="pl-sec"><div class="pl-h"><h3>1. Scénarios</h3><span class="hint">Ce qui se passe quand on appelle : qui sonne, combien de temps, puis où part l'appel.</span></div>
      <div class="pl-scs">${p.scenarios.map((x) => `<button type="button" class="pl-sc ${S.err?.sc === x.id ? "bad" : ""}" data-sc="${esc(x.id)}">
        <span class="pl-sch">${dot(x.id)}<strong>${esc(x.name)}</strong>${x.id === p.outside ? '<span class="pill off">en dehors des plages</span>' : ""}</span>
        <span class="s">${esc(chainText(x.id))}</span></button>`).join("")}
        ${p.scenarios.length < PLAN_MAX_SCENARIOS ? '<button type="button" class="pl-sc add" id="pladdsc">+ Nouveau scénario</button>' : ""}</div>
      <label class="pl-inline">En dehors des plages peintes<select id="ploutside">${p.scenarios.map((x) => `<option value="${esc(x.id)}" ${p.outside === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    </section>

    <section class="pl-sec"><div class="pl-h"><h3>2. La semaine</h3><span class="hint">Choisis un scénario puis peins les heures : clique-glisse, même sur plusieurs jours d'un coup.</span></div>
      <div class="pl-opts">
        <label class="check"><input type="checkbox" id="plalt" ${p.alternate ? "checked" : ""}> Alterner deux semaines (A / B : semaines paires et impaires)</label>
        ${p.alternate ? `<label class="pl-inline">La semaine A commence le lundi<input type="date" id="plref" value="${esc(p.ref_monday)}"></label>
          <span class="s">Cette semaine (${esc(mondayOf(S.today).split("-").reverse().join("/"))}) est une semaine <strong>${isWeekB(p, S.today) ? "B" : "A"}</strong>.</span>` : ""}
      </div>
      ${p.alternate ? `<nav class="fx-tabs pl-wtabs">${[["a", "Semaine A"], ["b", "Semaine B"]].map(([k, l]) => `<button type="button" class="${S.wk === k ? "on" : ""}" data-wk="${k}">${l}</button>`).join("")}</nav>` : ""}
      ${brushBar()}
      <div class="pl-gridwrap">${weekGrid()}</div>
      <div class="pl-gridfoot"><button type="button" class="btn ghost sm" id="plfull">${S.full ? "Afficher 7 h – 21 h" : "Afficher 0 h – 24 h"}</button>
        <button type="button" class="btn ghost sm" id="plclear">Vider ${p.alternate ? `la semaine ${S.wk.toUpperCase()}` : "la semaine"}</button>
        ${p.alternate ? `<button type="button" class="btn ghost sm" id="plcopyab">Copier la semaine ${S.wk === "a" ? "A vers B" : "B vers A"}</button>` : ""}</div>
    </section>

    <section class="pl-sec"><div class="pl-h"><h3>3. Le mois</h3><span class="hint">Jours fériés, veilles de fête, fermetures, remplacements : un jour modifié ici passe avant la semaine.</span></div>
      <div class="pl-opts"><label class="check"><input type="checkbox" id="plhol" ${p.holidays_fr ? "checked" : ""}> Jours fériés (France, calculés chaque année)</label>
        ${p.holidays_fr ? `<label class="pl-inline">toute la journée<select id="plholsc"><option value="">Comme un jour normal</option>${p.scenarios.map((x) => `<option value="${esc(x.id)}" ${p.holiday_scenario === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}</div>
      ${monthView()}
    </section>

    <section class="pl-sec"><div class="pl-h"><h3>Tester</h3><span class="hint">Où ira un appel tel jour à telle heure ? (avec les modifications pas encore validées)</span></div>
      <div class="pl-test"><input type="date" id="pltd" value="${esc(S.testD || S.today)}"><input type="time" id="pltt" value="${esc(S.testT || "10:00")}" step="300"><div id="pltr" class="pl-testr"></div></div>
    </section>
    <div class="fx-msg" id="plmsg"></div>`;
  wire();
}

function brushBar() {
  return `<div class="pl-brush" role="radiogroup" aria-label="Pinceau">${S.p.scenarios.map((x) => `<button type="button" class="pl-b ${S.brush === x.id ? "on" : ""}" data-brush="${esc(x.id)}" role="radio" aria-checked="${S.brush === x.id}">${dot(x.id)}${esc(x.name)}</button>`).join("")}
    <button type="button" class="pl-b ${S.brush === "" ? "on" : ""}" data-brush="" role="radio" aria-checked="${S.brush === ""}">⌫ Gomme</button></div>`;
}
const range = () => S.full ? [0, 1440] : [420, 1260];

/** Colonnes de jours peintes. cols : [{ key, label, slots, note }] */
function grid(cols, id) {
  const [a, b] = range();
  const rows = (b - a) / 15;
  const hours = []; for (let m = a; m < b; m += 60) hours.push(`<span style="top:${((m - a) / 15) * CELL}px">${planTime(m).slice(0, 2)} h</span>`);
  return `<div class="pl-grid" id="${id}" style="--cols:${cols.length}">
    <div class="pl-gh"></div>${cols.map((c, i) => `<div class="pl-gh" data-colh="${i}">${c.label}</div>`).join("")}
    <div class="pl-hours" style="height:${rows * CELL}px">${hours.join("")}</div>
    ${cols.map((c, i) => `<div class="pl-col" data-col="${i}" style="height:${rows * CELL}px">${c.whole ? `<div class="pl-blk whole" style="top:0;height:100%;background:${esc(scColor(c.whole))}"><span>${esc(scName(c.whole))}<small>${esc(c.note || "")}</small></span></div>` :
      c.slots.filter((x) => planMin(x.to) > a && planMin(x.from) < b).map((x) => {
        const t = (Math.max(planMin(x.from), a) - a) / 15 * CELL, hgt = (Math.min(planMin(x.to), b) - Math.max(planMin(x.from), a)) / 15 * CELL;
        return `<div class="pl-blk" style="top:${t}px;height:${hgt}px;background:${esc(scColor(x.s))}" title="${esc(`${x.from}-${x.to} ${scName(x.s)}`)}"><span>${hgt >= 22 ? `${esc(scName(x.s))}<small>${x.from}-${x.to}</small>` : ""}</span></div>`;
      }).join("")}</div>`).join("")}
    <div class="pl-sel" hidden></div></div>`;
}
function weekGrid() {
  const w = S.wk === "b" ? S.p.week_b : S.p.week;
  return grid(PLAN_DAYS.map((d) => ({ key: d, label: `${DAY_SHORT[d]} <button type="button" class="pl-copy" data-copy="${d}" title="Copier le ${PLAN_DAY_LONG[d].toLowerCase()} vers d'autres jours" aria-label="Copier le ${PLAN_DAY_LONG[d].toLowerCase()}">⧉</button>`, slots: w[d] || [] })), "plweek");
}

function monthView() {
  const [y, m] = S.month.split("-").map(Number);
  const first = `${S.month}-01`;
  const start = Date.parse(`${mondayOf(first)}T00:00:00Z`);
  const cells = [];
  for (let t = start; ; t += 86400_000) {
    const ymd = ymdOf(t);
    if (ymd.slice(0, 7) > S.month && weekdayOf(ymd) === "mon") break;
    cells.push(ymd);
  }
  const hol = planHolidays(y);
  const sel = S.pick || new Set();
  const bar = (ymd) => {
    const dp = dayPlan(S.p, ymd);
    if (dp.whole) return `<span class="pl-mbar"><i style="left:0;width:100%;background:${esc(scColor(dp.whole))}"></i></span>`;
    return `<span class="pl-mbar">${dp.slots.map((x) => `<i style="left:${planMin(x.from) / 14.4}%;width:${(planMin(x.to) - planMin(x.from)) / 14.4}%;background:${esc(scColor(x.s))}"></i>`).join("")}</span>`;
  };
  return `<div class="pl-mtop"><button type="button" class="btn ghost sm" data-mon="-1" aria-label="Mois précédent">‹</button><strong>${MONTHS[m - 1]} ${y}</strong><button type="button" class="btn ghost sm" data-mon="1" aria-label="Mois suivant">›</button>
      <span class="grow"></span>
      <button type="button" class="btn ghost sm ${S.pick ? "on" : ""}" id="plpick">${S.pick ? "Annuler la sélection" : "Sélectionner plusieurs jours"}</button>
      ${S.pick?.size ? `<button type="button" class="btn sm" id="plpickgo">Modifier ${S.pick.size} jour${S.pick.size > 1 ? "s" : ""}</button>` : ""}</div>
    <div class="pl-month">${PLAN_DAYS.map((d) => `<div class="pl-mh">${DAY_SHORT[d]}</div>`).join("")}
      ${cells.map((ymd) => {
        const out = ymd.slice(0, 7) !== S.month, sp = S.p.days[ymd], hl = S.p.holidays_fr && hol.get(ymd), b = isWeekB(S.p, ymd);
        return `<button type="button" class="pl-md ${out ? "out" : ""} ${ymd === S.today ? "today" : ""} ${sp ? "sp" : ""} ${sel.has(ymd) ? "picked" : ""}" data-day="${ymd}" aria-label="${esc(longDate(ymd))}">
          <span class="pl-mn">${Number(ymd.slice(8))}${S.p.alternate ? `<small>${b ? "B" : "A"}</small>` : ""}</span>
          ${bar(ymd)}<span class="pl-mtag">${sp ? `✎ ${esc(sp.label || "Modifié")}` : hl ? esc(hl) : ""}</span></button>`;
      }).join("")}</div>
    <p class="hint" style="margin:6px 0 0">Clique sur un jour pour lui donner des horaires différents. ✎ = journée modifiée.</p>`;
}

// ---------------------------------------------------------------- Événements
function wire() {
  const $ = (q) => S.root.querySelector(q);
  const p = S.p;
  const touch = () => { S.dirty = true; };
  $("#plname")?.addEventListener("input", (e) => { p.name = e.target.value; touch(); });
  $("#pldef")?.addEventListener("change", (e) => { p.is_default = e.target.checked; touch(); drawDids(); });
  $("#plman")?.addEventListener("change", (e) => { p.managers = e.target.checked; touch(); });
  $("#plsave").onclick = save;
  $("#pldel")?.addEventListener("click", del);
  $("#plforce").onchange = (e) => { p.override = e.target.value; touch(); draw(); };
  $("#ploutside").onchange = (e) => { p.outside = e.target.value; touch(); draw(); };
  S.root.querySelectorAll("[data-sc]").forEach((b) => b.onclick = () => scenarioDrawer(b.dataset.sc));
  $("#pladdsc")?.addEventListener("click", () => {
    const id = newId();
    p.scenarios.push({ id, name: "", color: PLAN_COLORS.find((c) => !p.scenarios.some((x) => x.color === c)) || PLAN_COLORS[0] });
    p.branches[id] = [{ type: "ring", users: [], strategy: "all", time: 20 }];
    touch(); scenarioDrawer(id, true);
  });
  $("#plalt").onchange = (e) => { p.alternate = e.target.checked; if (!p.alternate) S.wk = "a"; touch(); draw(); };
  $("#plref")?.addEventListener("change", (e) => { if (e.target.value) { p.ref_monday = mondayOf(e.target.value); touch(); draw(); } });
  S.root.querySelectorAll("[data-wk]").forEach((b) => b.onclick = () => { S.wk = b.dataset.wk; draw(); });
  S.root.querySelectorAll("[data-brush]").forEach((b) => b.onclick = () => { S.brush = b.dataset.brush; S.root.querySelectorAll("[data-brush]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); }); });
  $("#plfull").onclick = () => { S.full = !S.full; draw(); };
  $("#plclear").onclick = () => { if (!confirm("Effacer toutes les plages de cette semaine ?")) return; p[S.wk === "b" ? "week_b" : "week"] = emptyWeek(); touch(); draw(); };
  $("#plcopyab")?.addEventListener("click", () => { const [from, to] = S.wk === "a" ? ["week", "week_b"] : ["week_b", "week"]; p[to] = structuredClone(p[from]); touch(); S.wk = S.wk === "a" ? "b" : "a"; draw(); });
  S.root.querySelectorAll("[data-copy]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); copyDay(b); });
  paintable($("#plweek"), (dayIdx, from, to) => {
    const key = S.wk === "b" ? "week_b" : "week";
    for (const i of dayIdx) p[key][PLAN_DAYS[i]] = paintSlots(p[key][PLAN_DAYS[i]], from, to, S.brush || null);
    touch(); draw();
  });
  $("#plhol").onchange = (e) => { p.holidays_fr = e.target.checked; if (p.holidays_fr && !p.holiday_scenario) p.holiday_scenario = p.outside; touch(); draw(); };
  $("#plholsc")?.addEventListener("change", (e) => { p.holiday_scenario = e.target.value; touch(); draw(); });
  S.root.querySelectorAll("[data-mon]").forEach((b) => b.onclick = () => {
    const [y, m] = S.month.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + Number(b.dataset.mon), 1));
    S.month = ymdOf(t.getTime()).slice(0, 7); draw();
  });
  $("#plpick").onclick = () => { S.pick = S.pick ? null : new Set(); draw(); };
  $("#plpickgo")?.addEventListener("click", () => dayDrawer([...S.pick].sort()));
  S.root.querySelectorAll("[data-day]").forEach((b) => b.onclick = () => {
    const d = b.dataset.day;
    if (S.pick) { S.pick.has(d) ? S.pick.delete(d) : S.pick.add(d); draw(); return; }
    dayDrawer([d]);
  });
  const test = () => {
    S.testD = $("#pltd").value; S.testT = $("#pltt").value;
    if (!S.testD || !S.testT) { $("#pltr").innerHTML = ""; return; }
    const r = resolvePlan(p, S.testD, planMin(S.testT));
    $("#pltr").innerHTML = `${dot(r.scenario)}<span><strong>${esc(longDate(S.testD))} à ${esc(S.testT)} : ${esc(scName(r.scenario))}</strong><span class="s"> (${esc(r.forced ? "forcé" : r.label)})</span><br><span class="s">${esc(chainText(r.scenario))}</span></span>`;
  };
  $("#pltd").onchange = test; $("#pltt").onchange = test; $("#pltt").oninput = test; test();
  if (S.opts.mode === "admin") drawDids();
}

/** Peinture à la souris ou au doigt : rectangle (jours × heures), appliqué au relâchement. */
function paintable(gridEl, apply) {
  if (!gridEl) return;
  const cols = [...gridEl.querySelectorAll("[data-col]")];
  const selBox = gridEl.querySelector(".pl-sel");
  const [a, b] = range();
  let start = null, end = null;
  const at = (e) => {
    let i = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX < r.right; });
    if (i < 0) i = e.clientX < cols[0].getBoundingClientRect().left ? 0 : cols.length - 1;
    const r = cols[0].getBoundingClientRect();
    const q = Math.max(0, Math.min((b - a) / 15 - 1, Math.floor((e.clientY - r.top) / CELL)));
    return { i, m: a + q * 15 };
  };
  const show = () => {
    const i1 = Math.min(start.i, end.i), i2 = Math.max(start.i, end.i), m1 = Math.min(start.m, end.m), m2 = Math.max(start.m, end.m) + 15;
    const g = gridEl.getBoundingClientRect(), c1 = cols[i1].getBoundingClientRect(), c2 = cols[i2].getBoundingClientRect();
    Object.assign(selBox.style, { left: `${c1.left - g.left}px`, width: `${c2.right - c1.left}px`, top: `${c1.top - g.top + ((m1 - a) / 15) * CELL}px`, height: `${((m2 - m1) / 15) * CELL}px`,
      background: S.brush ? `${scColor(S.brush)}66` : "repeating-linear-gradient(45deg,#0002 0 6px,#fff0 6px 12px)", borderColor: S.brush ? scColor(S.brush) : "var(--muted)" });
    selBox.dataset.label = `${planTime(m1)} – ${planTime(m2) === "24:00" ? "24:00" : planTime(m2)}`;
    selBox.hidden = false;
  };
  cols.forEach((c) => c.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    start = end = at(e); show();
  }));
  gridEl.addEventListener("pointermove", (e) => { if (!start) return; end = at(e); show(); });
  const finish = () => {
    if (!start) return;
    const i1 = Math.min(start.i, end.i), i2 = Math.max(start.i, end.i), m1 = Math.min(start.m, end.m), m2 = Math.max(start.m, end.m) + 15;
    start = end = null; selBox.hidden = true;
    apply(Array.from({ length: i2 - i1 + 1 }, (_, k) => i1 + k), m1, m2);
  };
  gridEl.addEventListener("pointerup", finish);
  gridEl.addEventListener("pointercancel", () => { start = end = null; selBox.hidden = true; });
}

function copyDay(btn) {
  const from = btn.dataset.copy;
  S.root.querySelector(".pl-copypop")?.remove();
  const pop = document.createElement("div");
  pop.className = "pl-copypop";
  pop.innerHTML = `<strong>Copier le ${PLAN_DAY_LONG[from].toLowerCase()} vers :</strong>
    <div class="pl-cpd">${PLAN_DAYS.filter((d) => d !== from).map((d) => `<label class="check"><input type="checkbox" value="${d}" ${["mon", "tue", "wed", "thu", "fri"].includes(d) && ["mon", "tue", "wed", "thu", "fri"].includes(from) ? "checked" : ""}> ${PLAN_DAY_LONG[d]}</label>`).join("")}</div>
    <div class="row"><button type="button" class="btn ghost sm" data-x>Annuler</button><button type="button" class="btn sm" data-ok>Copier</button></div>`;
  btn.closest(".pl-gridwrap").append(pop);
  const r = btn.getBoundingClientRect(), w = btn.closest(".pl-gridwrap").getBoundingClientRect();
  pop.style.left = `${Math.max(0, Math.min(r.left - w.left, w.width - 240))}px`; pop.style.top = `${r.bottom - w.top + 4}px`;
  pop.querySelector("[data-x]").onclick = () => pop.remove();
  pop.querySelector("[data-ok]").onclick = () => {
    const key = S.wk === "b" ? "week_b" : "week";
    for (const i of pop.querySelectorAll("input:checked")) S.p[key][i.value] = structuredClone(S.p[key][from]);
    S.dirty = true; draw();
  };
}

// ---------------------------------------------------------------- SDA (console uniquement)
function drawDids() {
  const box = S.root.querySelector("#pldids"); if (!box) return;
  const p = S.p, cf = S.opts.cf, selfId = S.opts.plan?.id;
  const used = new Set(); for (const o of cf.objects) if (o.id !== selfId) for (const d of o.data?.dids || []) used.add(d);
  for (const u of cf.users) for (const d of u.dids || []) used.add(d);
  const free = (cf.trunk_dids || []).filter((d) => !used.has(d.did) && !p.dids.includes(d.did));
  box.innerHTML = `${p.dids.map((d) => `<span class="fx-chip">${esc(fmtP(d))}<button type="button" data-rmdid="${esc(d)}" aria-label="Retirer ${esc(fmtP(d))}">✕</button></span>`).join("")}
    ${p.is_default && !p.dids.length ? '<span class="s">Toutes les SDA sans règle</span>' : ""}
    <select id="pladddid" class="fx-add"><option value="">+ Ajouter</option>${free.map((d) => `<option value="${esc(d.did)}">${esc(fmtP(d.did))}</option>`).join("")}<option value="__autre">Autre numéro…</option></select>
    <input id="plotherdid" class="fx-other" placeholder="04 12 34 56 78" hidden>`;
  box.querySelectorAll("[data-rmdid]").forEach((x) => x.onclick = () => { p.dids = p.dids.filter((d) => d !== x.dataset.rmdid); S.dirty = true; drawDids(); });
  const sel = box.querySelector("#pladddid"), other = box.querySelector("#plotherdid");
  sel.onchange = () => {
    if (sel.value === "__autre") { other.hidden = false; other.focus(); sel.value = ""; return; }
    if (sel.value) { p.dids.push(sel.value); S.dirty = true; drawDids(); }
  };
  other.onkeydown = (e) => { if (e.key !== "Enter") return; e.preventDefault(); const v = other.value.replace(/[\s.]/g, "").replace(/^\+33/, "0"); if (/^0[1-9]\d{8}$/.test(v) && !p.dids.includes(v)) { p.dids.push(v); S.dirty = true; drawDids(); } else other.classList.add("bad"); };
}

// ---------------------------------------------------------------- Tiroirs (scénario, journée)
function openDrawer(html, wide = false) {
  const d = S.root.querySelector("#pldr");
  d.innerHTML = html; d.classList.add("open"); d.classList.toggle("wide", wide); d.setAttribute("aria-hidden", "false");
  S.root.querySelector("#plscrim").classList.add("on");
  return d;
}
function closeDrawer() {
  const d = S.root.querySelector("#pldr");
  if (S.drawer?.cancel) S.drawer.cancel();
  S.drawer = null;
  d.classList.remove("open", "wide"); d.setAttribute("aria-hidden", "true");
  S.root.querySelector("#plscrim").classList.remove("on");
}

function scenarioDrawer(id, isNew = false) {
  const p = S.p, s = sc(id);
  const steps = structuredClone(p.branches[id] || []);
  let name = s.name, color = s.color;
  S.drawer = { cancel: isNew ? () => { p.scenarios = p.scenarios.filter((x) => x.id !== id); delete p.branches[id]; draw(); } : null };
  const d = openDrawer(`<div class="fx-ph">${dot(id)}<strong>${isNew ? "Nouveau scénario" : "Scénario"}</strong><button type="button" class="fx-x" data-close aria-label="Fermer">✕</button></div>
    <div class="fx-pb stack" id="scb"></div>
    <div class="fx-pf">${!isNew && p.scenarios.length > 1 ? '<button type="button" class="btn ghost" data-rm>Supprimer le scénario</button>' : '<button type="button" class="btn ghost" data-close>Annuler</button>'}<button type="button" class="btn" data-ok>${isNew ? "Créer" : "Terminé"}</button></div>`, true);
  const body = d.querySelector("#scb");
  const drawBody = () => {
    const last = steps.at(-1);
    body.innerHTML = `<label>Nom<input data-name maxlength="30" value="${esc(name)}" placeholder="ex. Matin Paul, Après-midi Julie, Fermé"></label>
      <div><span class="dl">Couleur</span><div class="pl-colors">${PLAN_COLORS.map((c) => `<button type="button" class="pl-color ${c === color ? "on" : ""}" data-color="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join("")}</div></div>
      <div><span class="dl">Étapes (dans l'ordre)</span>
        <ol class="pl-steps">${steps.map((st, i) => stepRow(st, i, steps)).join("")}</ol>
        ${!last || !TERMINAL.includes(last.type) ? `<div class="pl-addstep"><select data-addstep><option value="">+ Ajouter une étape…</option>${Object.entries(STEP_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select>${last ? '<span class="s">sinon : raccroche</span>' : ""}</div>` : ""}</div>
      ${S.err?.sc === id ? `<div class="fx-perr">${esc(S.err.msg)}</div>` : ""}<div class="fx-perr" data-perr></div>`;
    body.querySelector("[data-name]").oninput = (e) => { name = e.target.value; };
    body.querySelectorAll("[data-color]").forEach((b) => b.onclick = () => { color = b.dataset.color; body.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("on", x === b)); });
    body.querySelector("[data-addstep]")?.addEventListener("change", (e) => {
      const type = e.target.value; if (!type) return;
      const st = { type, ...(type === "ring" ? { users: [], strategy: "all", time: 20 } : type === "group" ? { target: objs("group")[0]?.id || "", time: null } : type === "hangup" ? { target: "" } : { target: OBJ_STEPS.includes(type) && objs(type).length === 1 ? objs(type)[0].id : "" }) };
      steps.push(st); drawBody();
    });
    body.querySelectorAll("[data-st]").forEach((row) => {
      const i = Number(row.dataset.st), st = steps[i];
      row.querySelector("[data-up]")?.addEventListener("click", () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; drawBody(); });
      row.querySelector("[data-down]")?.addEventListener("click", () => { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; drawBody(); });
      row.querySelector("[data-del]").onclick = () => { steps.splice(i, 1); drawBody(); };
      row.querySelector("[data-type]").onchange = (e) => { const t = e.target.value; steps[i] = t === "ring" ? { type: t, users: [], strategy: "all", time: 20 } : { type: t, target: "", ...(t === "group" ? { time: null } : {}) }; drawBody(); };
      row.querySelector("[data-target]")?.addEventListener("change", (e) => { st.target = st.type === "external" ? e.target.value.replace(/[\s.]/g, "").replace(/^\+33/, "0") : e.target.value; });
      row.querySelector("[data-time]")?.addEventListener("change", (e) => { st.time = e.target.value ? Number(e.target.value) : (st.type === "group" ? null : 20); });
      row.querySelector("[data-strat]")?.addEventListener("change", (e) => { st.strategy = e.target.value; });
      row.querySelector("[data-adduser]")?.addEventListener("change", (e) => { if (e.target.value) { st.users.push(e.target.value); drawBody(); } });
      row.querySelectorAll("[data-rmuser]").forEach((b) => b.onclick = () => { st.users = st.users.filter((u) => u !== b.dataset.rmuser); drawBody(); });
    });
  };
  drawBody();
  d.querySelectorAll("[data-close]").forEach((b) => b.onclick = closeDrawer);
  d.querySelector("[data-rm]")?.addEventListener("click", () => {
    const usedIn = [p.outside === id && "« en dehors des plages »", p.holiday_scenario === id && "les jours fériés", p.override === id && "le forçage"].filter(Boolean);
    if (usedIn.length) { d.querySelector("[data-perr]").textContent = `Ce scénario est utilisé pour ${usedIn.join(", ")} : choisis-en un autre d'abord.`; return; }
    if (!confirm(`Supprimer le scénario « ${s.name} » ? Ses plages deviennent « en dehors des plages ».`)) return;
    p.scenarios = p.scenarios.filter((x) => x.id !== id); delete p.branches[id];
    const strip = (list) => (list || []).filter((x) => x.s !== id);
    for (const k of ["week", "week_b"]) for (const day of PLAN_DAYS) p[k][day] = strip(p[k][day]);
    for (const v of Object.values(p.days)) v.slots = strip(v.slots);
    if (S.brush === id) S.brush = p.outside;
    S.dirty = true; S.drawer = null; closeDrawer(); draw();
  });
  d.querySelector("[data-ok]").onclick = () => {
    const perr = d.querySelector("[data-perr]");
    if (!name.trim()) { perr.textContent = "Donne un nom au scénario."; body.querySelector("[data-name]").focus(); return; }
    if (!steps.length) { perr.textContent = "Ajoute au moins une étape."; return; }
    const bad = steps.findIndex((st) => (st.type === "ring" && !st.users.length) || (st.type === "external" && !/^0[1-9]\d{8}$/.test(st.target || "")) || (!["ring", "hangup", "external"].includes(st.type) && !st.target));
    if (bad >= 0) { perr.textContent = `Étape ${bad + 1} : ${steps[bad].type === "ring" ? "choisis qui doit sonner" : steps[bad].type === "external" ? "numéro à 10 chiffres (ex. 06 12 34 56 78)" : "choisis la destination"}.`; return; }
    s.name = name.trim(); s.color = color; p.branches[id] = steps;
    if (isNew) S.brush = id;
    if (S.err?.sc === id) S.err = null;
    S.dirty = true; S.drawer = null; closeDrawer(); draw();
  };
}
function stepRow(st, i, steps) {
  const opt = (list, v, empty) => `${empty ? `<option value="">${esc(empty)}</option>` : ""}${list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
  const typeSel = `<select data-type aria-label="Type d'étape">${opt(Object.entries(STEP_LABEL), st.type)}</select>`;
  const userOpts = users().map((u) => [u.id, `${u.id} · ${u.name}`]);
  let f = "";
  if (st.type === "ring") {
    f = `<div class="pl-chips">${st.users.map((u) => `<span class="fx-chip">${esc(u)} ${esc(userName(u))}<button type="button" data-rmuser="${esc(u)}" aria-label="Retirer">✕</button></span>`).join("")}
      <select data-adduser class="fx-add"><option value="">+ Qui sonne ?</option>${userOpts.filter(([id]) => !st.users.includes(id)).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select></div>
      <div class="pl-row"><label>Pendant (s)<input type="number" min="5" max="300" data-time value="${esc(st.time || 20)}"></label>
      ${st.users.length > 1 ? `<label>Comment<select data-strat>${opt([["all", "Tous ensemble"], ["hunt", "L'un après l'autre"]], st.strategy || "all")}</select></label>` : ""}</div>`;
  } else if (st.type === "group") {
    f = `<div class="pl-row"><select data-target aria-label="Groupe">${opt(objs("group").map((o) => [o.id, `${o.number} · ${o.name}`]), st.target, objs("group").length ? "— Choisir le groupe —" : "Aucun groupe : crée-le dans Groupes d'appel")}</select>
      <label>Pendant (s)<input type="number" min="5" max="300" data-time value="${esc(st.time || "")}" placeholder="durée du groupe"></label></div>`;
  } else if (OBJ_STEPS.includes(st.type)) {
    f = `<select data-target aria-label="${esc(STEP_LABEL[st.type])}">${opt(objs(st.type).map((o) => [o.id, `${o.number ? o.number + " · " : ""}${o.name}`]), st.target, objs(st.type).length ? "— Choisir —" : "Aucun pour l'instant")}</select>`;
  } else if (st.type === "user" || st.type === "user_vm") {
    f = `<select data-target aria-label="Utilisateur">${opt(userOpts, st.target, "— Choisir l'utilisateur —")}</select>`;
  } else if (st.type === "external") {
    f = `<input data-target inputmode="tel" placeholder="06 12 34 56 78" value="${esc(fmtP(st.target))}" aria-label="Numéro externe">`;
  }
  const prev = steps[i - 1];
  const link = !prev ? "" : `<span class="pl-link">${prev.type === "prompt" ? "puis" : prev.type === "queue" ? "attente dépassée →" : "sans réponse →"}</span>`;
  const after = prev && TERMINAL.includes(prev.type);
  return `<li class="pl-step ${after ? "bad" : ""}" data-st="${i}">${link}<div class="pl-stb"><span class="pl-stn">${i + 1}</span><div class="pl-stf">${typeSel}${f}${after ? '<span class="fx-err">Rien ne peut suivre l\'étape précédente</span>' : ""}</div>
    <div class="pl-sta">${i ? '<button type="button" class="ic" data-up title="Monter" aria-label="Monter">↑</button>' : ""}${i < steps.length - 1 ? '<button type="button" class="ic" data-down title="Descendre" aria-label="Descendre">↓</button>' : ""}<button type="button" class="ic" data-del title="Retirer" aria-label="Retirer l'étape">✕</button></div></div></li>`;
}

function dayDrawer(dates) {
  const p = S.p, one = dates.length === 1;
  const first = dates[0];
  const existing = p.days[first];
  let slots = structuredClone(existing ? existing.slots : dayPlan({ ...p, days: {} }, first).whole ? [] : dayPlan({ ...p, days: {} }, first).slots);
  let label = existing?.label || (p.holidays_fr ? planHolidays(Number(first.slice(0, 4))).get(first) || "" : "");
  const d = openDrawer(`<div class="fx-ph"><strong>${one ? esc(longDate(first)) : `${dates.length} jours sélectionnés`}</strong><button type="button" class="fx-x" data-close aria-label="Fermer">✕</button></div>
    <div class="fx-pb stack">
      ${one ? "" : `<p class="hint" style="margin:0">${dates.map((x) => esc(longDate(x))).join(", ")}</p>`}
      <p class="hint" style="margin:0">${existing ? "Ce jour a des horaires particuliers." : `D'habitude : ${esc(dayPlan({ ...p, days: {} }, first).label.toLowerCase())}. Peins les horaires de ${one ? "ce jour" : "ces jours"} : ils passeront avant la semaine.`}</p>
      <label>Libellé (facultatif)<input data-label maxlength="40" value="${esc(label)}" placeholder="ex. Veille de Noël, Inventaire, Remplacement de Julie"></label>
      <div data-brushhost></div><div class="pl-gridwrap one" data-gridhost></div>
      <div class="row" style="flex-wrap:wrap;gap:6px"><button type="button" class="btn ghost sm" data-fromweek>Repartir de la semaine type</button><button type="button" class="btn ghost sm" data-allout>Toute la journée « ${esc(scName(p.outside))} »</button></div>
    </div>
    <div class="fx-pf">${dates.some((x) => p.days[x]) ? `<button type="button" class="btn ghost" data-reset>Remettre comme d'habitude</button>` : '<button type="button" class="btn ghost" data-close>Annuler</button>'}<button type="button" class="btn" data-ok>Appliquer</button></div>`, true);
  const drawGrid = () => {
    d.querySelector("[data-brushhost]").innerHTML = brushBar();
    d.querySelector("[data-gridhost]").innerHTML = grid([{ key: "d", label: one ? `${DAY_SHORT[weekdayOf(first)]} ${Number(first.slice(8))}` : "Ces jours", slots }], "plday");
    d.querySelectorAll("[data-brush]").forEach((b) => b.onclick = () => { S.brush = b.dataset.brush; drawGrid(); });
    paintable(d.querySelector("#plday"), (_, from, to) => { slots = paintSlots(slots, from, to, S.brush || null); drawGrid(); });
  };
  drawGrid();
  d.querySelector("[data-label]").oninput = (e) => { label = e.target.value; };
  d.querySelector("[data-fromweek]").onclick = () => { const dp = dayPlan({ ...p, days: {}, holidays_fr: false }, first); slots = structuredClone(dp.slots); drawGrid(); };
  d.querySelector("[data-allout]").onclick = () => { slots = []; drawGrid(); };
  d.querySelectorAll("[data-close]").forEach((b) => b.onclick = closeDrawer);
  d.querySelector("[data-reset]")?.addEventListener("click", () => { for (const x of dates) delete p.days[x]; S.pick = null; S.dirty = true; closeDrawer(); draw(); });
  d.querySelector("[data-ok]").onclick = () => {
    for (const x of dates) p.days[x] = { slots: structuredClone(slots), label: label.trim() };
    S.pick = null; S.dirty = true; closeDrawer(); draw();
  };
}

// ---------------------------------------------------------------- Enregistrement
function body() {
  const p = S.p;
  const out = { scenarios: p.scenarios, branches: p.branches, outside: p.outside, week: p.week, week_b: p.week_b, alternate: p.alternate, ref_monday: p.ref_monday,
    holidays_fr: p.holidays_fr, holiday_scenario: p.holiday_scenario, days: p.days, override: p.override };
  if (S.opts.mode === "admin") Object.assign(out, { name: (p.name || "").trim() || (p.dids[0] ? `Planning ${fmtP(p.dids[0])}` : ""), dids: p.dids, is_default: p.is_default, managers: p.managers });
  return out;
}
async function save() {
  const msg = S.root.querySelector("#plmsg"); msg.innerHTML = "";
  const btn = S.root.querySelector("#plsave"); btn.disabled = true;
  try {
    await S.opts.save(body());
    S.dirty = false;
    S.opts.done("Planning validé et appliqué.");
  } catch (e) {
    btn.disabled = false;
    const m = /^(?:branches|scenario)\.(\w+)/.exec(e.field || "");
    if (m && sc(m[1])) { S.err = { sc: m[1], msg: e.message }; draw(); scenarioDrawer(m[1]); }
    S.root.querySelector("#plmsg").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`;
    S.root.querySelector("#plmsg").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
let armed = false;
async function del() {
  const b = S.root.querySelector("#pldel");
  if (!armed) { armed = true; b.textContent = "Confirmer la suppression"; setTimeout(() => { armed = false; if (b.isConnected) b.textContent = "Supprimer"; }, 4000); return; }
  try { await S.opts.remove(); S.opts.done("Planning supprimé."); }
  catch (e) { S.root.querySelector("#plmsg").innerHTML = `<div class="flash bad">${esc(e.message)}</div>`; }
}

/** Résumé d'une ligne pour la liste des routages. */
export function planningSummary(d, cfData) {
  const names = (id) => d.scenarios.find((x) => x.id === id)?.name || "?";
  const now = localNow(new Date(), cfData.timezone);
  const r = resolvePlan(d, now.ymd, now.minute);
  return `${d.scenarios.length} scénario${d.scenarios.length > 1 ? "s" : ""}${d.alternate ? " · semaines A / B" : ""}${Object.keys(d.days || {}).length ? ` · ${Object.keys(d.days).length} jour(s) particulier(s)` : ""} · maintenant : ${names(r.scenario)}${r.forced ? " (forcé)" : ""}`;
}
