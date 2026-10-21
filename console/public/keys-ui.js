// Éditeur des touches programmables des téléphones IP (Yealink) : console et softphone.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Disposition des touches programmables : touches par côté et par page, écran tactile ou non. */
export function keyLayout(model) {
  const n = model?.keys || 10;
  const touch = /x(480|600)$/.test(model?.screen || "");
  // Grands écrans tactiles (T57W, T48U, T77U…) : 6 touches à gauche, 5 à droite + « Show More » qui déploie 3 colonnes de 6 au centre
  if (touch && n >= 27) return { n, touch, more: true, perSide: 6, sides: 2, perPage: n, pages: 1 };
  const perSide = n >= 24 ? 5 : n >= 12 ? 3 : n >= 4 ? 2 : n;
  const sides = n >= 4 ? 2 : 1;
  return { n, touch, perSide, sides, perPage: perSide * sides, pages: Math.ceil(n / (perSide * sides)) };
}
/**
 * Éditeur de touches (téléphone dessiné, modules, liste) — partagé par la console (fiche utilisateur) et le softphone.
 * root : élément contenant #phv, #phvpanel, #keys, #addkey, #addall ; onChange(keys, mods) à chaque modification.
 */
export function mountKeys(root, { u, users, opts, initial = null, onChange = () => {}, submit = null }) {
  const $ = (s) => root.querySelector(s);
  const o = opts;
  const model = o.models.find((m) => m.id === u.phone.model);
  const L = keyLayout(model);
  const expId = Object.entries(o.expansions || {}).find(([, e]) => e.models.some((m) => (u.phone.model || "").startsWith(m)))?.[0] || "";
  const EXP = expId ? o.expansions[expId] : null;
  let keys = (initial?.keys || u.phone.keys).map((k) => ({ ...k }));
  let mods = (initial?.mods || (u.phone.modules || []).map((m) => m.keys || [])).map((m) => m.map((k) => ({ ...k })));
  const clean = (a) => { const c = a.map((k) => ({ ...k })); while (c.length && c.at(-1).type === "none") c.pop(); return c; };
  const keepKeys = () => onChange(clean(keys), mods.map(clean));
  const others = users.filter((x) => x.id !== u.id);
  const box = $("#keys");
  let page = 0, cur = null, showMore = false; // cur = { m: -1 (téléphone) ou n° de module, i }
  // Écran « Show More » : ordre des touches donné par l'installateur (gauche, droite, puis colonnes 1, 2, 3 du centre)
  const MORE = { left: [0, 1, 2, 3, 4, 5], right: [6, 7, 8, 9, 10], c1: [11, 12, 13, 14, 15, 16], c2: [17, 18, 19, 20, 21, 22], c3: [23, 24, 25, 26, 27, 28] };
  const morePlace = (i) => i < 6 ? "colonne de gauche" : i < 11 ? "colonne de droite" : i < 17 ? "colonne 1 (« Show More »)" : i < 23 ? "colonne 2 (« Show More »)" : "colonne 3 (« Show More »)";
  const modPage = [0, 0, 0];
  const NONE = () => ({ type: "none", value: "", label: "" });
  const arr = (m) => m < 0 ? keys : mods[m];
  const K = (m, i) => arr(m)[i] || NONE();
  const setKey = (m, i, k) => { const a = arr(m); while (a.length <= i) a.push(NONE()); a[i] = k; };
  const trim = (m) => { const a = arr(m); while (a.length && a.at(-1).type === "none") a.pop(); };
  const isCur = (m, i) => cur && cur.m === m && cur.i === i;
  const keyText = (k) => k.type === "none" ? "" : k.type === "line" ? (k.label || `Ligne ${u.id}`) : k.label || (k.type === "blf" ? (others.find((x) => x.id === k.value)?.name || k.value) : k.value);
  const cell = (m, i, max, right = false) => {
    if (i >= max) return `<span class="phv-k off"></span>`;
    const k = K(m, i);
    return `<button type="button" class="phv-k t-${k.type} ${isCur(m, i) ? "sel" : ""} ${right ? "rt" : ""}" data-key="${m}:${i}" title="${m < 0 ? "" : `Module ${m + 1}, `}touche ${i + 1}"><i></i><span>${esc(keyText(k)) || "<em>+</em>"}</span><b>${i + 1}</b></button>`;
  };
  const pagesNav = (n, curPage, attr) => n > 1 ? `<div class="phv-pages">${Array.from({ length: n }, (_, p) => `<button type="button" ${attr}="${p}" class="${p === curPage ? "on" : ""}">Page ${p + 1}</button>`).join("")}</div>` : "";
  // Téléphone dessiné comme sur la notice (haut du poste) + modules d'extension à droite
  const drawVisual = () => {
    const start = page * L.perPage;
    const col = (side) => Array.from({ length: L.perSide }, (_, r) => cell(-1, start + side * L.perSide + r, L.n, side === 1)).join("");
    const mcol = (list, extra = "") => `<div class="phv-col">${list.map((i) => cell(-1, i, L.n)).join("")}${extra}</div>`;
    const phone = L.more
      ? `<div class="phv touch"><div class="phv-head"><span class="phv-brand">${esc(model?.brand || "Téléphone")}</span><span class="phv-model">${esc(model?.label.replace(/^\S+\s/, "") || "")}</span></div>
          <div class="phv-screen big"><div class="phv-bar"><span>${esc(u.id)}</span><span></span></div>
            <div class="phv-tgrid five ${showMore ? "open" : ""}">${mcol(MORE.left)}
              ${showMore ? `${mcol(MORE.c1)}${mcol(MORE.c3)}${mcol(MORE.c2)}` : `<div class="phv-mid"><span class="phv-clock">12:00</span></div>`}
              ${mcol(MORE.right, `<button type="button" class="phv-k phv-more" id="showmore"><span>${showMore ? "Show Less" : "Show More"}</span></button>`)}</div>
            <div class="phv-soft"><span>Historique</span><span>Annuaire</span><span>NPD</span><span>Menu</span></div></div>
          <p class="phv-note">${showMore ? "Colonnes du centre dans l'ordre 1 (à gauche), 2 (à droite), 3 (au milieu)." : "Clique sur « Show More » pour voir et régler les 18 touches du centre."}</p></div>`
      : L.touch
      ? `<div class="phv touch"><div class="phv-head"><span class="phv-brand">${esc(model?.brand || "Téléphone")}</span><span class="phv-model">${esc(model?.label.replace(/^\S+\s/, "") || "")}</span></div>
          <div class="phv-screen big"><div class="phv-bar"><span>${esc(u.id)}</span><span>${L.pages > 1 ? `${page + 1}/${L.pages}` : ""}</span></div>
            <div class="phv-tgrid"><div class="phv-col">${col(0)}</div><div class="phv-col r">${col(1)}</div></div>
            <div class="phv-soft"><span>Historique</span><span>Annuaire</span><span>NPD</span><span>Menu</span></div></div>
          ${pagesNav(L.pages, page, "data-page")}</div>`
      : `<div class="phv"><div class="phv-head"><span class="phv-brand">${esc(model?.brand || "Téléphone")}</span><span class="phv-model">${esc(model?.label.replace(/^\S+\s/, "") || "")}</span></div>
          <div class="phv-top"><div class="phv-col">${col(0)}</div>
            <div class="phv-screen"><div class="phv-bar"><span>${esc(u.id)}</span><span>${L.pages > 1 ? `${page + 1}/${L.pages}` : ""}</span></div>
              <div class="phv-mid">${L.sides === 2 ? `<span class="phv-clock">12:00</span>` : ""}</div>
              <div class="phv-soft"><span>Historique</span><span>Annuaire</span><span>NPD</span><span>Menu</span></div></div>
            ${L.sides === 2 ? `<div class="phv-col r">${col(1)}</div>` : ""}</div>
          ${pagesNav(L.pages, page, "data-page")}</div>`;
    const modules = EXP ? mods.map((_, m) => {
      const half = EXP.perPage / 2, st = modPage[m] * EXP.perPage, max = EXP.perPage * EXP.pages;
      const mc = (side) => Array.from({ length: half }, (_, r) => cell(m, st + side * half + r, max, side === 1)).join("");
      return `<div class="phv phv-exp"><div class="phv-head"><span class="phv-brand">${esc(EXP.label.replace("Yealink ", ""))}</span><span class="phv-model">module ${m + 1}</span></div>
        <div class="phv-screen exp"><div class="phv-tgrid"><div class="phv-col">${mc(0)}</div><div class="phv-col r">${mc(1)}</div></div></div>
        ${pagesNav(EXP.pages, modPage[m], `data-mpage="${m}" data-p`)}</div>`;
    }).join("") : "";
    $("#phv").innerHTML = `${EXP ? `<div class="phv-mods"><span>Modules d'extension ${esc(EXP.label)} (${EXP.perPage} touches × ${EXP.pages} pages)</span>${[0, 1, 2, 3].map((n) => `<button type="button" data-nmods="${n}" class="${mods.length === n ? "on" : ""}">${n === 0 ? "Aucun" : n}</button>`).join("")}</div>` : ""}
      <div class="phv-row">${phone}${modules}</div>
      ${L.touch && !L.more ? `<p class="hint" style="margin:8px 0 0">Écran tactile : les raccourcis s'affichent à l'écran, ${L.perPage} par page.</p>` : ""}`;
    $("#phv").querySelectorAll("[data-key]").forEach((b) => b.onclick = () => { const [m, i] = b.dataset.key.split(":").map(Number); cur = { m, i }; drawVisual(); drawPanel(); });
    $("#phv").querySelectorAll("[data-page]").forEach((b) => b.onclick = () => { page = Number(b.dataset.page); drawVisual(); });
    $("#showmore")?.addEventListener("click", () => { showMore = !showMore; drawVisual(); });
    $("#phv").querySelectorAll("[data-mpage]").forEach((b) => b.onclick = () => { modPage[Number(b.dataset.mpage)] = Number(b.dataset.p); drawVisual(); });
    $("#phv").querySelectorAll("[data-nmods]").forEach((b) => b.onclick = () => {
      const n = Number(b.dataset.nmods);
      while (mods.length < n) mods.push([]);
      mods = mods.slice(0, n);
      if (cur && cur.m >= n) cur = null;
      drawAll();
    });
  };
  const drawPanel = () => {
    const pnl = $("#phvpanel");
    if (!cur) { pnl.innerHTML = `<div class="phv-empty">Clique sur une touche ${EXP ? "du téléphone ou d'un module " : "du téléphone "}pour choisir ce qu'elle fait : <strong>BLF</strong> (supervision d'un collègue), <strong>Statut</strong> (Ne pas déranger), <strong>numérotation rapide</strong> ou <strong>ligne</strong>.</div>`; return; }
    const { m, i } = cur, k = K(m, i);
    const where = m < 0 && L.more ? morePlace(i) : m < 0 ? `${L.pages > 1 ? `page ${Math.floor(i / L.perPage) + 1}, ` : ""}${(i % L.perPage) < L.perSide ? "à gauche" : "à droite"}`
      : `module ${m + 1}, page ${Math.floor(i / EXP.perPage) + 1}, ${(i % EXP.perPage) < EXP.perPage / 2 ? "à gauche" : "à droite"}`;
    pnl.innerHTML = `<div class="phv-ph"><strong>Touche ${i + 1}</strong><span class="s">${where}</span></div>
      <div class="phv-types">${Object.entries(o.key_types).filter(([t]) => m < 0 || t !== "line").map(([t, l]) => `<button type="button" data-t="${t}" class="${k.type === t ? "on" : ""}">${esc(l.split(" (")[0])}</button>`).join("")}</div>
      ${k.type === "blf" ? `<label>Collègue supervisé<select data-pv="value"><option value="">— Choisir —</option>${others.map((x) => `<option value="${esc(x.id)}" ${k.value === x.id ? "selected" : ""}>${esc(x.id)} · ${esc(x.name)}</option>`).join("")}</select></label>` : ""}
      ${k.type === "speed" ? `<label>Numéro<input data-pv="value" value="${esc(k.value)}" inputmode="tel" placeholder="06 12 34 56 78 ou 201"></label>` : ""}
      ${k.type === "none" ? "" : `<label>Libellé à l'écran<input data-pv="label" value="${esc(k.label)}" maxlength="24" placeholder="${k.type === "line" ? "facultatif" : ""}"></label>`}
      <p class="hint" style="margin:0">${{ blf: "S'allume quand le collègue est en ligne, clignote quand il sonne : un appui intercepte l'appel.", status: "Voyant allumé quand tu es Absent ou en Ne pas déranger (même changé depuis la console) ; un appui bascule le statut.", fwd: "Voyant allumé quand un renvoi immédiat est actif ; un appui active le renvoi vers la destination choisie (fiche › Renvois d'appels) ou l'annule.", standard: "Voyant allumé quand c'est fermé ; un appui ferme (vers la dernière destination) ou rouvre tout le PBX. Pour les postes autorisés (fiche › Renvois d'appels › Ouvert / Fermé).", speed: "Un appui compose le numéro.", line: "Affiche la ligne du poste.", none: "Touche libre." }[k.type] || ""}</p>
      <div class="row"><button type="button" class="btn ghost sm" data-clear>Vider la touche</button>
        <button type="button" class="btn ghost sm" data-multi title="Remplir les touches suivantes avec des BLF, à partir de celle-ci">Série de BLF</button></div>
      <div id="blfmulti"></div>`;
    pnl.querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { setKey(m, i, { type: b.dataset.t, value: "", label: ({ status: "Ne pas déranger", fwd: "Renvoi", standard: "Standard" })[b.dataset.t] || "" }); drawAll(); });
    pnl.querySelectorAll("[data-pv]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const k2 = { ...K(m, i), [el.dataset.pv]: el.value };
      if (el.dataset.pv === "value" && k2.type === "blf") k2.label = others.find((x) => x.id === el.value)?.name || "";
      setKey(m, i, k2);
      if (el.tagName === "SELECT") drawAll(); else { drawVisual(); drawList(); keepKeys(); }
    }));
    pnl.querySelector("[data-clear]").onclick = () => { setKey(m, i, NONE()); trim(m); drawAll(); };
    // Plusieurs BLF d'un coup : les utilisateurs cochés remplissent les touches à partir de celle-ci
    pnl.querySelector("[data-multi]").onclick = () => {
      const max = m < 0 ? L.n : EXP.perPage * EXP.pages;
      const box = pnl.querySelector("#blfmulti");
      box.innerHTML = `<div class="blfm"><div class="row" style="justify-content:space-between;align-items:center"><strong>Coche les utilisateurs</strong>
          <span class="row" style="gap:6px"><button type="button" class="btn link sm" data-all>Tous</button><button type="button" class="btn link sm" data-none>Aucun</button></span></div>
        <input type="search" placeholder="Rechercher…" data-q>
        <div class="blfm-list">${others.map((x) => `<label class="check" data-n="${esc(`${x.id} ${x.name}`.toLowerCase())}"><input type="checkbox" value="${esc(x.id)}" ${keys.some((k) => k.type === "blf" && k.value === x.id) ? "" : "checked"}> ${esc(x.id)} · ${esc(x.name)}</label>`).join("")}</div>
        <p class="hint" data-info style="margin:0"></p>
        <div class="row"><button type="button" class="btn sm" data-go>Ajouter</button><button type="button" class="btn ghost sm" data-cancel>Annuler</button></div></div>`;
      const boxes = () => [...box.querySelectorAll(".blfm-list input")];
      const info = () => {
        const n = boxes().filter((b) => b.checked).length, last = Math.min(i + n, max);
        const replaced = Array.from({ length: Math.max(0, last - i) }, (_, j) => K(m, i + j)).filter((k) => k.type !== "none").length;
        box.querySelector("[data-info]").textContent = n ? `Touches ${i + 1} à ${i + n}${i + n > max ? ` — seulement ${max - i} touche(s) libres jusqu'à la fin : les ${i + n - max} dernier(s) ne seront pas ajoutés` : ""}${replaced ? ` · ${replaced} touche(s) déjà réglée(s) seront remplacées` : ""}.` : "Coche au moins un utilisateur.";
      };
      box.querySelector("[data-q]").oninput = (e) => { const q = e.target.value.trim().toLowerCase(); box.querySelectorAll(".blfm-list label").forEach((l) => { l.hidden = !!q && !l.dataset.n.includes(q); }); };
      box.querySelector("[data-all]").onclick = () => { boxes().forEach((b) => { if (!b.closest("label").hidden) b.checked = true; }); info(); };
      box.querySelector("[data-none]").onclick = () => { boxes().forEach((b) => (b.checked = false)); info(); };
      boxes().forEach((b) => (b.onchange = info));
      box.querySelector("[data-cancel]").onclick = () => { box.innerHTML = ""; };
      box.querySelector("[data-go]").onclick = () => {
        const ids = boxes().filter((b) => b.checked).map((b) => b.value);
        ids.slice(0, Math.max(0, max - i)).forEach((id, j) => setKey(m, i + j, { type: "blf", value: id, label: others.find((x) => x.id === id)?.name || id }));
        cur = { m, i: Math.min(i + ids.length, max) - 1 };
        drawAll();
      };
      info();
    };
  };
  const drawAll = () => { drawVisual(); drawPanel(); drawList(); keepKeys(); };
  const draw = drawAll;
  const drawList = () => {
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
        if (el.dataset.f === "label") { drawVisual(); keepKeys(); }
        if (el.dataset.f === "type") { keys[i].value = ""; keys[i].label = ({ status: "Ne pas déranger", fwd: "Renvoi", standard: "Standard" })[keys[i].type] || ""; draw(); }
        if (el.dataset.f === "value" && keys[i].type === "blf") { keys[i].label = others.find((x) => x.id === el.value)?.name || ""; draw(); }
        keepKeys();
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
  if (submit) submit();
}

