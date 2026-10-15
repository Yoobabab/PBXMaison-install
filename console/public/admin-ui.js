// Console Callikoe — pages d'administration : règles sortantes, sécurité, enregistrements, codes raccourcis,
// sauvegardes, mises à jour, alertes, licence, passerelles et DECT.
let H; // helpers fournis par app.js
const ic = (d, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  play: '<path d="M7 5v14l12-7z"/>', dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 5 5 9-10"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 3.5 5.8 3.5 9s-1 6.2-3.5 9c-2.5-2.8-3.5-5.8-3.5-9s1-6.2 3.5-9z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>', phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  disk: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  up2: '<path d="M12 20V8M7 13l5-5 5 5M5 4h14"/>', wifi: '<path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  plug: '<rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 12.5h.01M11 12.5h.01M8 8V5M16 8V4"/>', key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>', drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
};
const pill = (cls, t) => `<span class="pill ${cls}">${H.esc(t)}</span>`;
const sw = (name, on, label, hint = "") => `<label class="switch cx-sw"><input type="checkbox" name="${name}" ${on ? "checked" : ""}><span></span><b>${label}${hint ? `<small>${hint}</small>` : ""}</b></label>`;
const fmtBytes = (n) => n > 1e9 ? `${(n / 1e9).toFixed(1)} Go` : n > 1e6 ? `${(n / 1e6).toFixed(1)} Mo` : n > 1e3 ? `${Math.round(n / 1e3)} Ko` : `${n} o`;
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const head = (title, sub, actions = "") => `${H.takeFlash()}<div class="bar"><div class="grow"><h1>${title}</h1><p class="sub" style="margin:0">${sub}</p></div>${actions}</div>`;
const tabs = (base, cur, list) => `<nav class="tabs cx-tabs">${list.map(([k, l]) => `<a href="${base}/${k}" class="${k === cur ? "on" : ""}">${l}</a>`).join("")}</nav>`;
const kpi = (icon, k, v, s = "", cls = "") => `<div class="kpi ${cls}"><span class="kpi-ic">${ic(I[icon], 20)}</span><div><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div></div>`;
function onSubmit(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = form.querySelector("button[type=submit], button:not([type])");
    if (b) b.disabled = true;
    try { await fn(H.formData(form)); } catch (err) { H.showFormError(form, err); } finally { if (b) b.disabled = false; }
  });
}
const ok = (text) => H.setFlash({ text });

// ================================================================ Règles sortantes
async function pageOutbound(sub) {
  H.setNav("out");
  const d = await H.api("GET", "/api/outbound");
  const editing = sub === "nouvelle" ? {} : d.rules.find((r) => r.id === sub);
  const trunkOpt = (sel) => `<option value="">— Aucune —</option>${d.trunks.map((t) => `<option value="${H.esc(t.id)}" ${sel === t.id ? "selected" : ""}>${H.esc(t.id)} · ${H.esc(t.operator)} · ${t.status.code === "Registered" ? "● enregistré" : "○ " + H.esc(t.status.label.toLowerCase())}</option>`).join("")}`;
  let body;
  if (editing) {
    const r = { name: "", prefixes_text: "", extensions_text: "", lengths_text: "", routes: [], ...editing };
    const routes = [0, 1, 2, 3, 4].map((i) => r.routes[i] || { trunk: "", strip: 0, prepend: "", cid_mode: "user", cid: "" });
    body = `<div class="panel"><div class="ph"><h2>${editing.id ? "Modifier la règle" : "Nouvelle règle sortante"}</h2></div>
      <form id="of" novalidate class="pad stack"><div class="form-msg"></div>
        <label>Nom de la règle<input name="name" value="${H.esc(r.name)}" placeholder="ex. Mobiles, International, Agence de Lyon"></label>
        <div class="cx-sec"><h3>Appliquer la règle aux appels…</h3><div class="cx-g3">
          <label>vers les numéros commençant par<input name="prefixes" value="${H.esc(r.prefixes_text)}" placeholder="06,07 (vide = tous)"><span class="hint">Séparés par des virgules. Plage : 1-3.</span></label>
          <label>passés par les postes<input name="extensions" value="${H.esc(r.extensions_text)}" placeholder="200-299,301 (vide = tous)"><span class="hint">Postes ou plages de postes.</span></label>
          <label>de longueur<input name="lengths" value="${H.esc(r.lengths_text)}" placeholder="10 (vide = toutes)"><span class="hint">Nombre de chiffres composés : 10, 4-6…</span></label>
        </div></div>
        <div class="cx-sec"><h3>Faire passer l'appel par…</h3><p class="hint" style="margin:0 0 10px">La route 1 est essayée en premier ; si le trunk est indisponible ou saturé, la suivante prend le relais.</p>
          <div class="cx-routes">${routes.map((rt, i) => `<div class="cx-route" data-i="${i}"><span class="cx-rn">${i + 1}</span>
            <label>Trunk<select name="routes.${i}.trunk">${trunkOpt(rt.trunk)}</select></label>
            <label>Retirer<input name="routes.${i}.strip" type="number" min="0" max="10" value="${rt.strip || 0}"><span class="hint">chiffres au début</span></label>
            <label>Ajouter<input name="routes.${i}.prepend" value="${H.esc(rt.prepend || "")}" placeholder="—"><span class="hint">devant le numéro</span></label>
            <label>Numéro présenté<select name="routes.${i}.cid_mode" class="cidm">${Object.entries(d.cid_modes).map(([k, l]) => `<option value="${k}" ${rt.cid_mode === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label class="cidc" ${rt.cid_mode === "custom" ? "" : "hidden"}>Numéro<input name="routes.${i}.cid" value="${H.esc(rt.cid || "")}" placeholder="04 12 34 56 78"></label>
          </div>`).join("")}</div></div>
        <div class="actions">${editing.id ? '<button type="button" class="btn ghost" id="odel">Supprimer</button>' : ""}<a class="btn ghost" href="#/sortants">Annuler</a><button class="btn">Enregistrer</button></div>
      </form></div>`;
  } else {
    const catchAll = d.rules.some((r) => !r.prefixes.length && !r.extensions.length && !r.lengths.length);
    const dt = d.trunks.find((t) => t.id === d.default_trunk);
    body = `${!d.default_trunk && !catchAll ? `<div class="flash bad">Aucun trunk par défaut : les appels qui ne correspondent à aucune règle ne peuvent pas sortir. Choisis-en un ci-dessous.</div>` : ""}
      ${dt && dt.status.code !== "Registered" ? `<div class="flash warn">Le trunk par défaut « ${H.esc(dt.id)} » n'est pas enregistré chez l'opérateur (${H.esc(dt.status.label)}) : vérifie ses identifiants dans Trunks.</div>` : ""}
      <form id="dtf" class="panel cx-inline pad" style="margin-bottom:16px;border-bottom:1px solid var(--line)"><label class="grow">Trunk par défaut (appels qui ne correspondent à aucune règle)<select name="trunk">${trunkOpt(d.default_trunk)}</select></label><button class="btn">Enregistrer</button></form>
      ${d.rules.length ? `<div class="panel"><div class="cx-list" id="olist">${d.rules.map((r, i) => `<div class="cx-row" draggable="true" data-id="${r.id}">
        <span class="cx-drag" title="Glisser pour changer l'ordre">${ic(I.drag)}</span><span class="cx-num">${i + 1}</span>
        <div class="grow"><a href="#/sortants/${r.id}" class="cx-title">${H.esc(r.name)}</a><div class="s">${H.esc(r.summary)}</div></div>
        <div class="cx-chain">${r.routes.map((rt, k) => `<span class="cx-chip ${d.trunks.find((t) => t.id === rt.trunk)?.status.code === "Registered" ? "ok" : "bad"}" title="Route ${k + 1}">${H.esc(rt.trunk)}</span>`).join('<span class="cx-arrow">→</span>')}</div>
        <span class="cx-acts"><button class="ghost-ic" data-mv="-1" title="Monter">${ic(I.up)}</button><button class="ghost-ic" data-mv="1" title="Descendre">${ic(I.down)}</button><a class="ghost-ic" href="#/sortants/${r.id}" title="Modifier">${ic(I.edit)}</a></span>
      </div>`).join("")}</div></div>` : `<div class="panel"><div class="empty">${ic(I.up2, 34)}<p><strong>Aucune règle sortante.</strong></p><p>Tous les appels sortent par le trunk par défaut${d.default_trunk ? ` (<b>${H.esc(d.default_trunk)}</b>)` : ""}. Ajoute une règle pour choisir un trunk selon le numéro ou le poste, avec des routes de secours.</p></div></div>`}
      <div class="note" style="margin-top:16px">Les règles sont testées dans l'ordre : la première qui correspond est utilisée. Sans règle correspondante, l'appel part par le trunk par défaut choisi ci-dessus. Les numéros d'urgence passent toujours, sans règle.</div>`;
  }
  H.app.innerHTML = head("Règles sortantes", "Choisis par quel trunk partent les appels et quel numéro est présenté.", editing ? "" : `<a class="btn" href="#/sortants/nouvelle">${ic(I.plus, 16)} Nouvelle règle</a>`) + body;
  if (editing) {
    const f = H.$("#of");
    f.querySelectorAll(".cidm").forEach((s) => s.addEventListener("change", () => { s.closest(".cx-route").querySelector(".cidc").hidden = s.value !== "custom"; }));
    onSubmit(f, async (v) => {
      v.routes = Object.keys(v.routes || {}).sort().map((k) => v.routes[k]);
      await H.api(editing.id ? "PUT" : "POST", editing.id ? `/api/outbound/${editing.id}` : "/api/outbound", v);
      ok("Règle enregistrée."); location.hash = "#/sortants";
    });
    H.$("#odel")?.addEventListener("click", async (e) => {
      if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Confirmer la suppression"; e.target.classList.add("danger"); return; }
      await H.api("DELETE", `/api/outbound/${editing.id}`); ok("Règle supprimée."); location.hash = "#/sortants";
    });
  } else {
    onSubmit(H.$("#dtf"), async (v) => { await H.api("PUT", "/api/routes", { inbound: d.inbound || [], outbound_trunk: v.trunk }); ok("Trunk par défaut enregistré."); pageOutbound(); });
  }
  if (!editing && d.rules.length) {
    const list = H.$("#olist");
    const save = async () => { await H.api("PUT", "/api/outbound-order", { ids: [...list.children].map((x) => x.dataset.id) }); pageOutbound(); };
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mv]"); if (!b) return;
      const row = b.closest(".cx-row"), dir = Number(b.dataset.mv);
      const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sib) return;
      dir < 0 ? sib.before(row) : sib.after(row); save();
    });
    let dragged = null;
    list.addEventListener("dragstart", (e) => { dragged = e.target.closest(".cx-row"); dragged.classList.add("dragging"); });
    list.addEventListener("dragend", () => { dragged?.classList.remove("dragging"); dragged = null; save(); });
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const over = e.target.closest(".cx-row"); if (!over || over === dragged) return;
      const r = over.getBoundingClientRect();
      e.clientY > r.top + r.height / 2 ? over.after(dragged) : over.before(dragged);
    });
  }
}

// ================================================================ Sécurité
async function pageSecurity(sub = "apercu") {
  H.setNav("sec");
  const { settings: s, f2b, countries } = await H.api("GET", "/api/security");
  const T = [["apercu", "Vue d'ensemble"], ["ip", "Adresses IP"], ["numeros", "Numéros bloqués"], ["pays", "International"], ["regles", "Règles d'appel"], ["console", "Accès à la console"]];
  const banned = [...(f2b.manual || []).map((ip) => ({ ip, manual: true })), ...(f2b.auto || []).map((ip) => ({ ip, manual: false }))];
  let body = "";
  if (sub === "apercu") {
    const score = [s.block_premium, s.intl.length < 10, s.max_user_calls > 0, s.max_duration > 0, f2b.active, s.console_allow.length > 0].filter(Boolean).length;
    body = `<div class="kpis">
      ${kpi("shield", "Niveau de protection", `${score}<small>/6</small>`, score >= 5 ? "Très bon" : score >= 3 ? "Correct" : "À renforcer", score >= 5 ? "good" : score >= 3 ? "" : "warn")}
      ${kpi("ban", "Adresses bloquées", banned.length, f2b.ok ? (f2b.active ? "Protection anti-intrusion active" : "Protection arrêtée !") : "Protection injoignable", f2b.ok && f2b.active ? "" : "warn")}
      ${kpi("phone", "Numéros bloqués", s.in_block.length + s.out_block.length, `${s.in_block.length} entrants · ${s.out_block.length} sortants`)}
      ${kpi("globe", "Pays autorisés", s.intl.length, s.intl.length ? s.intl.slice(0, 4).map((c) => "+" + c).join(" ") + (s.intl.length > 4 ? "…" : "") : "International bloqué")}
    </div>
    <div class="panel"><div class="ph"><h2>Points de contrôle</h2></div><div class="cx-checks">
      ${[[f2b.active, "Protection anti-intrusion (fail2ban)", `${s.f2b.maxretry} échecs en ${s.f2b.findtime} min → blocage ${s.f2b.bantime} min`, "ip"],
        [s.block_premium, "Numéros surtaxés bloqués (089x, 118xxx)", "Évite les appels coûteux et la fraude", "regles"],
        [s.intl.length < 10, "International limité aux pays choisis", s.intl.length ? `${s.intl.length} pays autorisés` : "Aucun pays : tout l'international est bloqué", "pays"],
        [s.max_user_calls > 0, "Appels externes simultanés limités par utilisateur", s.max_user_calls ? `${s.max_user_calls} au maximum` : "Pas de limite", "regles"],
        [s.max_duration > 0, "Durée maximale d'un appel externe", s.max_duration ? `${s.max_duration} minutes` : "Pas de limite", "regles"],
        [s.console_allow.length > 0, "Accès à la console limité par adresse IP", s.console_allow.length ? s.console_allow.join(", ") : "Accessible depuis n'importe quelle adresse (avec mot de passe)", "console"],
        [true, "Mots de passe SIP forts et générés", "20 caractères, identifiant d'authentification aléatoire", ""],
        [true, "Pare-feu : seuls SIP, audio et web sont ouverts", "Le reste est bloqué", ""],
      ].map(([on, t, d, link]) => `<div class="cx-check ${on ? "on" : ""}"><span class="cx-dot">${ic(on ? I.check : I.ban, 15)}</span><div class="grow"><b>${t}</b><div class="s">${H.esc(d)}</div></div>${link ? `<a class="btn ghost sm" href="#/securite/${link}">Régler</a>` : ""}</div>`).join("")}
    </div></div>`;
  } else if (sub === "ip") {
    body = `<div class="grid2">
      <div class="panel"><div class="ph"><h2>Adresses bloquées</h2><span class="s">${banned.length}</span></div>
        <form id="banf" class="pad cx-inline" novalidate><label class="grow">Bloquer une adresse<input name="ip" placeholder="203.0.113.7 ou 203.0.113.0/24"></label><button class="btn">Bloquer</button></form>
        ${banned.length ? `<div class="cx-list">${banned.map((b) => `<div class="cx-row"><span class="mono grow">${H.esc(b.ip)}</span>${b.manual ? pill("bad", "Bloquée à la main (permanent)") : pill("wait", "Bloquée automatiquement")}<button class="btn ghost sm" data-unban="${H.esc(b.ip)}">Débloquer</button></div>`).join("")}</div>` : `<div class="empty">Aucune adresse bloquée.</div>`}
        ${f2b.ok ? "" : `<div class="pad"><div class="flash warn" style="margin:0">${H.esc(f2b.error || "Protection anti-intrusion injoignable.")}</div></div>`}
      </div>
      <div class="panel"><div class="ph"><h2>Protection automatique</h2></div>
        <form id="f2bf" class="pad stack" novalidate><div class="form-msg"></div>
          <div class="cx-g3"><label>Échecs autorisés<input type="number" name="f2b.maxretry" min="2" max="50" value="${s.f2b.maxretry}"></label>
          <label>Sur une fenêtre de (min)<input type="number" name="f2b.findtime" min="1" max="1440" value="${s.f2b.findtime}"></label>
          <label>Blocage pendant (min)<input type="number" name="f2b.bantime" min="1" max="525600" value="${s.f2b.bantime}"></label></div>
          <label>Adresses jamais bloquées (liste blanche)<textarea name="whitelist" rows="3" placeholder="Une adresse ou un réseau par ligne : IP fixe de l'entreprise, opérateur…">${H.esc(s.whitelist.join("\n"))}</textarea><span class="hint">Mets l'IP de tes bureaux et celle de ton opérateur SIP pour ne jamais les bloquer par erreur.</span></label>
          <div class="actions"><button class="btn">Enregistrer</button></div></form></div></div>`;
  } else if (sub === "numeros") {
    const rows = (list) => list.map((e) => `${e.number}${e.prefix ? "*" : ""}${e.label ? ` ; ${e.label}` : ""}`).join("\n");
    body = `<form id="numf" novalidate><div class="form-msg"></div><div class="grid2">
      <div class="panel"><div class="ph"><h2>Appels entrants bloqués</h2><span class="s">${s.in_block.length}</span></div><div class="pad stack">
        <label>Numéros qui ne peuvent pas appeler le standard<textarea name="in_block" rows="10" class="mono" placeholder="0612345678 ; Démarcheur&#10;0162*  (tous les numéros commençant par 0162)">${H.esc(rows(s.in_block))}</textarea></label>
        <span class="hint">Un numéro par ligne, « * » à la fin pour tout un préfixe, « ; » puis une note facultative. L'appelant entend que la ligne est indisponible.</span>
        ${sw("block_anonymous", s.block_anonymous, "Refuser les appels masqués", "Les appelants sans numéro sont rejetés")}</div></div>
      <div class="panel"><div class="ph"><h2>Appels sortants bloqués</h2><span class="s">${s.out_block.length}</span></div><div class="pad stack">
        <label>Numéros que les postes ne peuvent pas appeler<textarea name="out_block" rows="10" class="mono" placeholder="0899*&#10;3617*">${H.esc(rows(s.out_block))}</textarea></label>
        <span class="hint">S'applique aussi aux renvois vers l'extérieur.</span></div></div>
      </div><div class="actions" style="margin-top:16px"><button class="btn">Enregistrer</button></div></form>`;
  } else if (sub === "pays") {
    const sel = new Set(s.intl);
    body = `<form id="intf" novalidate><div class="panel"><div class="ph"><h2>Pays autorisés en sortie</h2><span class="s"><span id="ncount">${sel.size}</span> sélectionné(s)</span></div>
      <div class="pad"><p class="hint" style="margin-top:0">Les appels vers l'international (00 + indicatif) sont bloqués, sauf vers les pays cochés. C'est la première protection contre la fraude téléphonique (appels piratés vers des numéros surtaxés à l'étranger).</p>
        <input type="search" id="cq" placeholder="Rechercher un pays…" style="margin-bottom:12px">
        <div class="cx-countries">${countries.map(([cc, n]) => `<label class="cx-cty" data-n="${H.esc(n.toLowerCase())}"><input type="checkbox" value="${cc}" ${sel.has(cc) ? "checked" : ""}><span>${H.esc(n)}</span><small>+${cc}</small></label>`).join("")}</div>
        <label style="margin-top:14px">Autres indicatifs<input name="extra" value="${H.esc(s.intl.filter((c) => !countries.some(([x]) => x === c)).join(", "))}" placeholder="ex. 262, 590"></label>
      </div></div><div class="actions" style="margin-top:16px"><button type="button" class="btn ghost" id="call">Tout décocher</button><button class="btn">Enregistrer</button></div></form>`;
  } else if (sub === "regles") {
    body = `<form id="rgf" novalidate class="panel"><div class="ph"><h2>Règles d'appel</h2></div><div class="pad stack"><div class="form-msg"></div>
      ${sw("block_premium", s.block_premium, "Bloquer les numéros surtaxés", "089x et renseignements 118xxx")}
      <div class="cx-g3"><label>Appels externes simultanés par utilisateur<input type="number" name="max_user_calls" min="0" max="50" value="${s.max_user_calls}"><span class="hint">0 = pas de limite. 2 laisse faire un transfert supervisé.</span></label>
      <label>Durée maximale d'un appel externe (min)<input type="number" name="max_duration" min="0" max="1440" value="${s.max_duration}"><span class="hint">0 = pas de limite. Coupe les appels oubliés ou frauduleux.</span></label></div>
      <div class="note">Rappel : la licence limite aussi le nombre total d'appels externes simultanés. Les numéros d'urgence ne sont jamais bloqués ni limités.</div>
      <div class="actions"><button class="btn">Enregistrer</button></div></div></form>`;
  } else if (sub === "console") {
    body = `<form id="ccf" novalidate class="panel"><div class="ph"><h2>Accès à la console d'administration</h2></div><div class="pad stack"><div class="form-msg"></div>
      <label>Adresses autorisées<textarea name="console_allow" rows="5" class="mono" placeholder="Vide = accessible de partout (avec mot de passe)&#10;192.168.1.0/24&#10;203.0.113.5">${H.esc(s.console_allow.join("\n"))}</textarea></label>
      <span class="hint">Le softphone web, l'application mobile et le provisioning des téléphones restent accessibles depuis partout. Ton adresse doit faire partie de la liste, sinon l'enregistrement est refusé pour ne pas te bloquer.</span>
      <div class="actions"><button class="btn">Enregistrer</button></div></div></form>`;
  }
  H.app.innerHTML = head("Sécurité", "Protège le standard contre les intrusions, la fraude et les appels indésirables.") + tabs("#/securite", sub, T) + `<div class="cx-body">${body}</div>`;
  const save = async (v, msg = "Réglages de sécurité enregistrés.") => {
    const r = await H.api("PUT", "/api/security", v);
    H.setFlash(r.warning ? { cls: "warn", text: r.warning } : { text: msg }); pageSecurity(sub);
  };
  const lines = (t) => String(t || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const parseNums = (t) => lines(t).map((l) => { const [n, ...lab] = l.split(";"); return { number: n.trim(), label: lab.join(";").trim() }; });
  H.$("#banf") && onSubmit(H.$("#banf"), async (v) => { await H.api("POST", "/api/security/ban", { ip: v.ip }); ok(`Adresse ${v.ip} bloquée.`); pageSecurity(sub); });
  H.app.querySelectorAll("[data-unban]").forEach((b) => b.addEventListener("click", async () => { await H.api("POST", "/api/security/unban", { ip: b.dataset.unban }); ok("Adresse débloquée."); pageSecurity(sub); }));
  H.$("#f2bf") && onSubmit(H.$("#f2bf"), (v) => save({ f2b: v.f2b, whitelist: lines(v.whitelist) }));
  H.$("#numf") && onSubmit(H.$("#numf"), (v) => save({ in_block: parseNums(v.in_block), out_block: parseNums(v.out_block), block_anonymous: v.block_anonymous }));
  H.$("#rgf") && onSubmit(H.$("#rgf"), (v) => save(v));
  H.$("#ccf") && onSubmit(H.$("#ccf"), (v) => save({ console_allow: lines(v.console_allow) }));
  const intf = H.$("#intf");
  if (intf) {
    const count = () => { H.$("#ncount").textContent = intf.querySelectorAll(".cx-cty input:checked").length; };
    intf.addEventListener("change", count);
    H.$("#cq").addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); intf.querySelectorAll(".cx-cty").forEach((l) => { l.hidden = q && !l.dataset.n.includes(q) && !l.textContent.includes(q); }); });
    H.$("#call").addEventListener("click", () => { intf.querySelectorAll(".cx-cty input").forEach((c) => (c.checked = false)); count(); });
    onSubmit(intf, (v) => save({ intl: [...[...intf.querySelectorAll(".cx-cty input:checked")].map((c) => c.value), ...String(v.extra || "").split(/[\s,;]+/).filter(Boolean)] }));
  }
}

// ================================================================ Enregistrements
async function pageRecordings(sub) {
  H.setNav("rec");
  const q = JSON.parse(sessionStorage.getItem("pbxm_rec_q") || "{}");
  const [cfg, list] = await Promise.all([H.api("GET", "/api/recording"), H.api("GET", `/api/recordings?days=${q.days || 30}&q=${encodeURIComponent(q.q || "")}&direction=${q.direction || ""}`)]);
  const s = cfg.settings;
  const DIR = { in: "Entrant", out: "Sortant", internal: "Interne" };
  const showCfg = sub === "reglages";
  H.app.innerHTML = head("Enregistrements", "Écoute et télécharge les appels enregistrés.",
    `<a class="btn ${showCfg ? "" : "ghost"}" href="${showCfg ? "#/enregistrements" : "#/enregistrements/reglages"}">${showCfg ? "Retour à la liste" : "Réglages"}</a>`) +
    `<div class="kpis">${kpi("rec" in I ? "rec" : "play", "Enregistrement", s.enabled ? "Actif" : "Arrêté", s.enabled ? [s.in && "entrants", s.out && "sortants"].filter(Boolean).join(" et ") : "Aucun appel n'est enregistré", s.enabled ? "good" : "warn")}
      ${kpi("disk", "Espace utilisé", fmtBytes(cfg.usage.bytes), `${cfg.usage.files} fichier(s)`)}
      ${kpi("clock", "Conservation", s.retention_days ? `${s.retention_days} j` : "Illimitée", "Puis suppression automatique")}</div>` +
    (showCfg ? `<form id="recf" class="panel" novalidate><div class="ph"><h2>Réglages</h2></div><div class="pad stack"><div class="form-msg"></div>
        ${sw("enabled", s.enabled, "Enregistrer les appels")}
        <div class="cx-g3">${sw("in", s.in, "Appels entrants")}${sw("out", s.out, "Appels sortants")}</div>
        <label>Annonce jouée à l'appelant avant l'appel<select name="announce"><option value="">— Aucune annonce —</option>${cfg.prompts.map((p) => `<option value="${H.esc(p.id)}" ${s.announce === p.id ? "selected" : ""}>${H.esc(p.name)}</option>`).join("")}</select>
          <span class="hint">L'appelant doit être informé de l'enregistrement (RGPD). Crée l'annonce dans <a href="#/gestion/annonces">Gestion d'appels › Annonces</a>, par ex. « Cet appel peut être enregistré afin d'améliorer la qualité de nos services ».</span></label>
        <label>Conserver les enregistrements pendant (jours)<input type="number" name="retention_days" min="0" max="3650" value="${s.retention_days}"><span class="hint">0 = sans limite. La CNIL recommande 6 mois au maximum pour les enregistrements de formation.</span></label>
        <div class="actions"><button class="btn">Enregistrer</button></div></div></form>`
    : `<div class="panel"><div class="filters"><input type="search" id="rq" placeholder="Numéro, nom, poste…" value="${H.esc(q.q || "")}">
        <select id="rdir"><option value="">Tous les sens</option><option value="in" ${q.direction === "in" ? "selected" : ""}>Entrants</option><option value="out" ${q.direction === "out" ? "selected" : ""}>Sortants</option></select>
        <select id="rdays">${[[1, "Aujourd'hui"], [7, "7 jours"], [30, "30 jours"], [90, "90 jours"], [366, "1 an"]].map(([v, l]) => `<option value="${v}" ${Number(q.days || 30) === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="s">${list.total} enregistrement(s)</span></div>
      ${list.recordings.length ? `<div class="cx-list">${list.recordings.map((c) => `<div class="cx-row cx-rec">
          <span class="cx-dir ${c.direction}" title="${DIR[c.direction] || ""}">${ic(c.direction === "in" ? I.down : I.up, 15)}</span>
          <div class="grow"><b>${H.esc(c.from.name || H.fmtPhone(c.from.number))}</b> <span class="s">→</span> <b>${H.esc(c.answered_by || H.fmtPhone(c.to.number))}</b>
            <div class="s">${fmtDT(c.start)} · ${Math.floor(c.talk / 60)} min ${String(c.talk % 60).padStart(2, "0")} s${c.did ? ` · SDA ${H.esc(H.fmtPhone(c.did))}` : ""}</div></div>
          ${c.available ? `<audio controls preload="none" src="/api/recordings/file?f=${encodeURIComponent(c.recording)}"></audio>
            <a class="ghost-ic" href="/api/recordings/file?f=${encodeURIComponent(c.recording)}&dl=1" title="Télécharger">${ic(I.dl)}</a>
            <button class="ghost-ic" data-del="${H.esc(c.recording)}" title="Supprimer">${ic(I.trash)}</button>` : `<span class="s">Fichier supprimé</span>`}
        </div>`).join("")}</div>` : `<div class="empty">${s.enabled ? "Aucun appel enregistré sur la période." : "L'enregistrement est arrêté : active-le dans les réglages."}</div>`}</div>`);
  const f = H.$("#recf");
  if (f) onSubmit(f, async (v) => { await H.api("PUT", "/api/recording", { ...v, retention_days: Number(v.retention_days) }); ok("Réglages enregistrés."); location.hash = "#/enregistrements"; });
  const setQ = (k, v) => { sessionStorage.setItem("pbxm_rec_q", JSON.stringify({ ...q, [k]: v })); pageRecordings(); };
  let t; H.$("#rq")?.addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => setQ("q", e.target.value), 400); });
  H.$("#rdir")?.addEventListener("change", (e) => setQ("direction", e.target.value));
  H.$("#rdays")?.addEventListener("change", (e) => setQ("days", e.target.value));
  H.app.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.classList.add("danger"); b.title = "Cliquer à nouveau pour supprimer"; return; }
    await H.api("DELETE", `/api/recordings/file?f=${encodeURIComponent(b.dataset.del)}`); pageRecordings();
  }));
}

// ================================================================ Codes raccourcis
async function pageShortcodes() {
  H.setNav("codes");
  const { codes } = await H.api("GET", "/api/shortcodes");
  const groups = [...new Set(codes.map((c) => c.group))];
  const SUF = { place: "+ place (1-9)", poste: "+ poste", "numéro": "+ numéro" };
  H.app.innerHTML = head("Codes de raccourci", "Codes composés depuis un téléphone ou le softphone. Modifiables pour reprendre ceux d'un ancien standard.") +
    `<form id="scf" novalidate><div class="form-msg"></div><div class="cx-codes">${groups.map((g) => `<div class="panel"><div class="ph"><h2>${H.esc(g)}</h2></div>
      ${codes.filter((c) => c.group === g).map((c) => `<label class="cx-code"><span class="grow">${H.esc(c.label)}${c.code !== c.default ? `<small>par défaut ${H.esc(c.default)}</small>` : ""}</span>
        <span class="cx-kbd"><input name="${c.id}" value="${H.esc(c.code)}" maxlength="5" spellcheck="false">${c.suffix ? `<em>${SUF[c.suffix] || ""}</em>` : ""}</span></label>`).join("")}</div>`).join("")}</div>
      <div class="note" style="margin-top:16px"><b>Exemples</b> : transférer un appel vers <code>${H.esc(codes.find((c) => c.id === "park").code)}</code> le met en attente sur une place de parcage (annoncée), n'importe quel collègue le reprend avec <code>${H.esc(codes.find((c) => c.id === "unpark").code)}1</code>. <code>${H.esc(codes.find((c) => c.id === "pickup").code)}201</code> intercepte un appel qui sonne sur le poste 201.</div>
      <div class="actions" style="margin-top:16px"><button type="button" class="btn ghost" id="scr">Rétablir les codes par défaut</button><button class="btn">Enregistrer</button></div></form>`;
  const f = H.$("#scf");
  onSubmit(f, async (v) => { await H.api("PUT", "/api/shortcodes", v); ok("Codes enregistrés : ils fonctionnent tout de suite."); pageShortcodes(); });
  H.$("#scr").addEventListener("click", () => { codes.forEach((c) => (f.elements[c.id].value = c.default)); });
}

// ================================================================ Sauvegardes
async function pageBackups() {
  H.setNav("backup");
  const d = await H.api("GET", "/api/backups");
  const s = d.settings, r = s.remote;
  H.app.innerHTML = head("Sauvegardes", "Configuration, utilisateurs, messages vocaux et enregistrements : tout ce qu'il faut pour remonter le standard.",
    `<button class="btn" id="bkrun" ${d.running ? "disabled" : ""}>${ic(I.disk, 16)} Sauvegarder maintenant</button>`) +
    `<div class="kpis">${kpi("clock", "Dernière sauvegarde", d.last ? fmtDT(d.last.at) : "Jamais", d.last ? (d.last.ok ? "Réussie" : H.esc(d.last.error)) : "Lance une première sauvegarde", d.last && !d.last.ok ? "warn" : d.last ? "good" : "warn")}
      ${kpi("disk", "Sauvegardes sur le serveur", d.backups.length, d.backups.length ? fmtBytes(d.backups.reduce((a, b) => a + b.size, 0)) : "")}
      ${kpi("globe", "Copie distante", r.enabled ? H.esc(r.host) : "Non configurée", r.enabled ? d.protocols[r.protocol] : "Recommandée : un disque qui lâche emporte tout", r.enabled ? "good" : "")}</div>
    <div id="bkjob"></div>
    <div class="grid2">
      <form id="bkf" class="panel" novalidate><div class="ph"><h2>Programmation</h2></div><div class="pad stack"><div class="form-msg"></div>
        <div class="cx-g3"><label>Fréquence<select name="schedule">${Object.entries(d.schedules).map(([k, l]) => `<option value="${k}" ${s.schedule === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>À<select name="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.hour === h ? "selected" : ""}>${String(h).padStart(2, "0")} h 00</option>`).join("")}</select></label>
        <label>Garder les<input type="number" name="keep" min="1" max="60" value="${s.keep}"><span class="hint">dernières sauvegardes</span></label></div>
        ${sw("voicemail", s.voicemail, "Inclure les messages vocaux")}${sw("recordings", s.recordings, "Inclure les enregistrements d'appels", "Peut être volumineux")}
        <h3 class="cx-h3">Copie sur un serveur distant</h3>
        ${sw("remote.enabled", r.enabled, "Envoyer une copie après chaque sauvegarde")}
        <div class="cx-g3"><label>Protocole<select name="remote.protocol">${Object.entries(d.protocols).map(([k, l]) => `<option value="${k}" ${r.protocol === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Serveur<input name="remote.host" value="${H.esc(r.host)}" placeholder="nas.exemple.fr"></label><label>Port<input name="remote.port" type="number" value="${r.port}"></label></div>
        <div class="cx-g3"><label>Identifiant<input name="remote.user" value="${H.esc(r.user)}" autocomplete="off"></label>
          <label>Mot de passe<input name="remote.password" type="password" placeholder="${r.has_password ? "•••••••• (inchangé)" : ""}" autocomplete="new-password"></label>
          <label>Dossier<input name="remote.path" value="${H.esc(r.path)}" placeholder="/sauvegardes/callikoe/"></label></div>
        <div class="actions"><button type="button" class="btn ghost" id="bktest">Tester la connexion</button><button class="btn">Enregistrer</button></div></div></form>
      <div class="panel"><div class="ph"><h2>Sauvegardes disponibles</h2><label class="btn ghost sm" style="cursor:pointer">Restaurer un fichier…<input type="file" id="bkup" accept=".gz,.tar.gz,application/gzip" hidden></label></div>
        ${d.backups.length ? `<div class="cx-list">${d.backups.map((b) => `<div class="cx-row"><div class="grow"><b>${fmtDT(b.at)}</b><div class="s mono">${H.esc(b.file)} · ${fmtBytes(b.size)}</div></div>
          <a class="ghost-ic" href="/api/backups/file/${encodeURIComponent(b.file)}" title="Télécharger">${ic(I.dl)}</a><button class="btn ghost sm" data-restore="${H.esc(b.file)}">Restaurer</button></div>`).join("")}</div>`
        : `<div class="empty">Aucune sauvegarde pour l'instant.</div>`}</div></div>`;
  const f = H.$("#bkf");
  onSubmit(f, async (v) => { v.hour = Number(v.hour); v.keep = Number(v.keep); await H.api("PUT", "/api/backups", v); ok("Réglages enregistrés."); pageBackups(); });
  H.$("#bktest").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Connexion…";
    try { const r2 = await H.api("POST", "/api/backups/test-remote", H.formData(f).remote); e.target.textContent = `Connexion réussie ✓${r2.listing?.length ? ` (${r2.listing.length} fichier(s))` : ""}`; }
    catch (err) { H.showFormError(f, err); e.target.textContent = "Tester la connexion"; }
    e.target.disabled = false;
  });
  const job = (url, done) => H.poll(async () => {
    const j = url === "backup" ? (await H.api("GET", "/api/backups")).job : await H.api("GET", "/api/backups/restore");
    if (!j) return true;
    H.$("#bkjob").innerHTML = `<div class="panel pad" style="margin-bottom:16px">${(j.steps || []).map((x) => `<div class="cx-step ${x.status}">${H.esc(x.message)}</div>`).join("") || '<div class="cx-step run">Démarrage…</div>'}${!j.running && j.error ? `<div class="flash bad" style="margin:8px 0 0">${H.esc(j.error)}</div>` : ""}</div>`;
    if (!j.running) { done(j); return true; }
  }, 1500);
  H.$("#bkrun").addEventListener("click", async (e) => { e.target.disabled = true; await H.api("POST", "/api/backups/run", {}); job("backup", (j) => { if (j.ok) { ok("Sauvegarde terminée."); pageBackups(); } else e.target.disabled = false; }); });
  const restore = async (file) => {
    await H.api("POST", "/api/backups/restore", { file });
    job("restore", (j) => { if (j.ok) { H.$("#bkjob").insertAdjacentHTML("beforeend", '<div class="flash">Restauration terminée : la console redémarre, la page va se recharger.</div>'); setTimeout(() => location.reload(), 6000); } });
  };
  H.app.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.classList.add("danger"); b.textContent = "Tout remplacer ?"; return; }
    restore(b.dataset.restore);
  }));
  H.$("#bkup").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm(`Restaurer « ${file.name} » ? La configuration actuelle sera remplacée.`)) return;
    H.$("#bkjob").innerHTML = '<div class="panel pad" style="margin-bottom:16px"><div class="cx-step run">Envoi du fichier…</div></div>';
    const res = await fetch("/api/backups/upload", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file, credentials: "same-origin" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { H.$("#bkjob").innerHTML = `<div class="flash bad">${H.esc(j.error || "Envoi impossible.")}</div>`; return; }
    restore(j.file);
  });
}

// ================================================================ Mises à jour
const md = (t) => H.esc(t).split("\n").map((l) => l.startsWith("## ") ? `<h3>${l.slice(3)}</h3>` : l.startsWith("- ") ? `<li>${l.slice(2)}</li>` : l.startsWith("# ") ? "" : l ? `<p>${l}</p>` : "").join("").replace(/(<li>.*?<\/li>)+/gs, (m) => `<ul>${m}</ul>`);
async function pageUpdates(check = false) {
  H.setNav("updates");
  const d = await H.api("GET", `/api/updates${check ? "?check=1" : ""}`);
  const c = d.current, a = d.available;
  const newer = a?.commit && d.up_to_date === false;
  H.app.innerHTML = head("Mises à jour", "Callikoe se met à jour sans perdre sa configuration.", `<button class="btn ghost" id="upchk">Rechercher une mise à jour</button>`) +
    `<div class="cx-hero ${newer ? "new" : d.up_to_date ? "ok" : ""}"><span class="cx-hero-ic">${ic(newer ? I.up2 : I.check, 30)}</span>
      <div class="grow"><h2>${newer ? `Nouvelle version disponible : ${H.esc(a.version)}` : d.up_to_date ? "Callikoe est à jour" : "Version installée"}</h2>
      <p>Installée : <b>${H.esc(c.version)}</b>${c.commit ? ` <span class="mono">(${H.esc(c.commit.slice(0, 7))})</span>` : ""}${c.installed_at ? ` le ${fmtDT(c.installed_at)}` : ""}
      ${a?.checked_at ? ` · vérifié ${fmtDT(a.checked_at)}` : ""}${a?.error ? ` · <span class="err">${H.esc(a.error)}</span>` : ""}</p>
      ${newer && a.message ? `<p class="s">Dernière modification : ${H.esc(a.message)} (${fmtDT(a.date)})</p>` : ""}</div>
      ${newer ? `<button class="btn" id="upgo">Mettre à jour maintenant</button>` : ""}</div>
    <div id="uplog"></div>
    <div class="grid2"><div class="panel"><div class="ph"><h2>Nouveautés${newer ? ` de la version ${H.esc(a.version)}` : ""}</h2></div><div class="pad cx-md">${md((newer ? a.changelog : c.changelog) || "Aucune note de version.")}</div></div>
      <div class="panel"><div class="ph"><h2>Pendant la mise à jour</h2></div><div class="pad cx-md"><ul><li>Durée : 2 à 5 minutes.</li><li>Les appels en cours peuvent être coupés quand le moteur téléphonique redémarre : choisis un moment calme.</li>
        <li>Configuration, utilisateurs, messages et enregistrements sont conservés.</li><li>Conseil : lance une <a href="#/sauvegardes">sauvegarde</a> juste avant.</li></ul></div></div></div>`;
  H.$("#upchk").addEventListener("click", () => pageUpdates(true));
  const follow = () => H.poll(async () => {
    let st; try { st = await H.api("GET", "/api/updates/status"); } catch { H.$("#uplog").innerHTML = '<div class="flash warn">La console redémarre…</div>'; return false; }
    H.$("#uplog").innerHTML = `<div class="panel" style="margin-bottom:16px"><div class="ph"><h2>${st.running ? "Mise à jour en cours…" : st.ok ? "Mise à jour terminée" : st.done ? "La mise à jour a échoué" : "Mise à jour"}</h2></div><pre class="cx-log">${H.esc((st.log || []).join("\n"))}</pre></div>`;
    if (st.done && !st.running) { if (st.ok) { ok("Mise à jour terminée."); setTimeout(() => location.reload(), 2500); } return true; }
  }, 2500);
  H.$("#upgo")?.addEventListener("click", async (e) => {
    if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Confirmer (les appels peuvent être coupés)"; return; }
    e.target.disabled = true; await H.api("POST", "/api/updates/start", {}); follow();
  });
}

// ================================================================ Alertes
async function pageAlerts() {
  H.setNav("alerts");
  const d = await H.api("GET", "/api/alerts");
  const s = d.settings;
  const SEV = { critical: "bad", warning: "wait", info: "off" };
  H.app.innerHTML = head("Alertes", "Le standard prévient quand quelque chose d'important se passe.", `<button class="btn ghost" id="alchk">Vérifier maintenant</button>`) +
    `<div class="note" style="margin-bottom:16px">${ic(I.mail, 16)} <b>Envoi des e-mails en préparation.</b> Les alertes sont déjà détectées et notées dans le journal ci-dessous ; l'envoi par e-mail sera activé dans une prochaine mise à jour avec les réglages enregistrés ici.</div>
    <div class="grid2"><form id="alf" class="panel" novalidate><div class="ph"><h2>Que surveiller ?</h2></div><div class="pad stack"><div class="form-msg"></div>
      ${Object.entries(d.events).map(([k, [t, sev, desc]]) => `<label class="switch cx-sw"><input type="checkbox" name="events.${k}" ${s.events[k] ? "checked" : ""}><span></span><b>${H.esc(t)} ${pill(SEV[sev], d.severity[sev])}<small>${H.esc(desc)}</small></b></label>`).join("")}
      <label>Seuil d'alerte du disque (%)<input type="number" name="disk_threshold" min="50" max="99" value="${s.disk_threshold}"></label>
      <h3 class="cx-h3">Destinataires et serveur d'envoi</h3>
      <label>Adresses e-mail<textarea name="recipients" rows="2" placeholder="technicien@irt-network.fr, gerant@client.fr">${H.esc(s.recipients.join(", "))}</textarea></label>
      <div class="cx-g3"><label>Serveur SMTP<input name="smtp.host" value="${H.esc(s.smtp.host)}" placeholder="smtp.exemple.fr"></label><label>Port<input name="smtp.port" type="number" value="${s.smtp.port}"></label>
        <label>Sécurité<select name="smtp.security">${[["starttls", "STARTTLS (587)"], ["tls", "TLS (465)"], ["none", "Aucune (25)"]].map(([k, l]) => `<option value="${k}" ${s.smtp.security === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <div class="cx-g3"><label>Identifiant<input name="smtp.user" value="${H.esc(s.smtp.user)}" autocomplete="off"></label><label>Mot de passe<input type="password" name="smtp.password" placeholder="${s.smtp.has_password ? "•••••••• (inchangé)" : ""}" autocomplete="new-password"></label>
        <label>Expéditeur<input name="smtp.from" value="${H.esc(s.smtp.from)}" placeholder="standard@client.fr"></label></div>
      <div class="actions"><button class="btn">Enregistrer</button></div></div></form>
      <div class="panel"><div class="ph"><h2>Journal des alertes</h2>${d.log.length ? '<button class="btn ghost sm" id="alclr">Vider</button>' : ""}</div>
        ${d.log.length ? `<div class="cx-list">${d.log.map((l) => `<div class="cx-row cx-al ${l.severity}"><span class="cx-sev"></span><div class="grow"><b>${H.esc(l.title)}</b><div class="s">${H.esc(l.text)}</div></div><div class="s cx-r">${fmtDT(l.at)}<br>${l.email === "pending" ? "e-mail en attente" : l.email === "no_recipient" ? "sans destinataire" : H.esc(l.email)}</div></div>`).join("")}</div>` : `<div class="empty">${ic(I.check, 30)}<p>Aucune alerte. Tout va bien.</p></div>`}</div></div>`;
  onSubmit(H.$("#alf"), async (v) => { v.disk_threshold = Number(v.disk_threshold); v.smtp.port = Number(v.smtp.port); await H.api("PUT", "/api/alerts", v); ok("Réglages des alertes enregistrés."); pageAlerts(); });
  H.$("#alclr")?.addEventListener("click", async () => { await H.api("DELETE", "/api/alerts/log"); pageAlerts(); });
  H.$("#alchk").addEventListener("click", async () => { await H.api("POST", "/api/alerts/check", {}); pageAlerts(); });
}

// ================================================================ Licence
async function pageLicense() {
  H.setNav("licence");
  const l = await H.api("GET", "/api/license");
  const pct = l.max_calls ? Math.min(100, Math.round(100 * l.usage.calls / l.max_calls)) : 0;
  const EDITIONS = { start: "Start", pro: "Pro", enterprise: "Entreprise" };
  H.app.innerHTML = head("Licence", "Informations de licence et d'utilisation du standard.") +
    `<div class="cx-lic"><div class="cx-lic-card"><span class="cx-lic-ed">Callikoe ${H.esc(EDITIONS[l.edition] || l.edition || "")}</span>
      <div class="cx-lic-key mono">${H.esc(l.key || "—")}</div>
      <div class="cx-lic-meta"><span>${H.esc(l.pbx.company || l.pbx.name)}</span><span>${l.expires_at ? `Valable jusqu'au ${new Date(l.expires_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}` : "Sans date d'expiration"}</span></div></div>
      <div class="kpis" style="margin:0">
        ${kpi("phone", "Appels simultanés", `${l.usage.calls}<small>/${l.max_calls}</small>`, `<span class="cx-bar"><i style="width:${pct}%"></i></span>`)}
        ${kpi("clock", "Jours restants", l.days_left ?? "∞", l.days_left != null && l.days_left <= 30 ? "Pense à renouveler" : "", l.days_left != null && l.days_left <= 30 ? "warn" : "good")}
        ${kpi("user", "Utilisateurs", l.usage.users, "Sans limite de postes")}
        ${kpi("plug", "Trunks", l.usage.trunks)}</div></div>
    <div class="panel" style="margin-top:18px"><div class="ph"><h2>Détails</h2></div><div class="cx-kv">
      ${[["Nom du PBX", l.pbx.name], ["Société", l.pbx.company], ["Adresse", l.pbx.fqdn], ["Administrateur", l.pbx.admin_email], ["Identifiant du PBX", l.pbx.id], ["Version", `${l.system.version}${l.system.commit ? ` (${l.system.commit})` : ""}`], ["Système", l.system.os], ["Installé le", l.system.installed_at ? fmtDT(l.system.installed_at) : "—"]]
        .map(([k, v]) => `<div><span>${k}</span><b class="${k.startsWith("Identifiant") ? "mono" : ""}">${H.esc(v || "—")}</b></div>`).join("")}</div></div>
    <p class="hint" style="margin-top:14px">Pour changer d'édition ou ajouter des appels simultanés, contacte IRT NETWORK : la nouvelle licence s'applique en rechargeant le fichier de configuration (<a href="#/systeme">Système</a>).</p>`;
}

// ================================================================ Passerelles et DECT
async function pageGateways(sub) {
  H.setNav("gw");
  const d = await H.api("GET", "/api/gateways");
  const byType = (t) => d.models.filter((m) => m.type === t);
  if (sub && sub !== "nouvelle" && sub.endsWith("/config")) return gatewaySetup(sub.split("/")[0]);
  const editing = sub === "nouvelle" ? { ports: [] } : d.gateways.find((g) => g.id === sub);
  let body;
  if (editing) {
    const g = { name: "", model: "", mac: "", ...editing };
    body = `<form id="gwf" class="panel" novalidate><div class="ph"><h2>${editing.id ? H.esc(g.name) : "Nouvel appareil"}</h2></div><div class="pad stack"><div class="form-msg"></div>
      <div class="cx-g3"><label>Modèle<select name="model" id="gwm"><option value="">— Choisir —</option>${Object.entries(d.types).map(([t, l]) => `<optgroup label="${H.esc(l)}">${byType(t).map((m) => `<option value="${m.id}" ${g.model === m.id ? "selected" : ""}>${H.esc(m.label)}${m.prov === "manual" ? " (configuration guidée)" : m.status === "beta" ? " (à valider)" : ""}</option>`).join("")}</optgroup>`).join("")}</select></label>
        <label>Nom<input name="name" value="${H.esc(g.name)}" placeholder="ex. Base DECT atelier, Fax accueil"></label>
        <label>Adresse MAC<input name="mac" value="${H.esc(g.mac)}" placeholder="00:0B:82:12:34:56"><span class="hint">Sur l'étiquette : permet le provisioning automatique.</span></label></div>
      <div id="gwports"></div>
      <div class="actions">${editing.id ? '<button type="button" class="btn ghost" id="gwdel">Supprimer</button>' : ""}<a class="btn ghost" href="#/passerelles">Annuler</a><button class="btn">Enregistrer</button></div></div></form>`;
  } else {
    body = d.gateways.length ? `<div class="cx-gws">${d.gateways.map((g) => `<a class="cx-gw" href="#/passerelles/${g.id}/config">
        <span class="cx-gw-ic ${g.type}">${ic(g.type === "dect" ? I.wifi : I.plug, 24)}</span>
        <div class="grow"><b>${H.esc(g.name)}</b><div class="s">${H.esc(g.model_label)}${g.mac ? ` · <span class="mono">${H.esc(g.mac.toUpperCase().replace(/(..)(?=.)/g, "$1:"))}</span>` : ""}</div>
          <div class="cx-ports">${g.ports.map((p) => `<span class="cx-port ${p.online ? "on" : ""}" title="${H.esc(p.name)} — ${p.online ? "connecté" : "déconnecté"}">${g.type === "dect" ? "C" : "P"}${p.port} · ${H.esc(p.user)}</span>`).join("") || '<span class="s">Aucun port attribué</span>'}</div></div>
        ${g.ports.length ? pill(g.online ? "ok" : "bad", g.online ? "Connecté" : "Déconnecté") : pill("off", "À configurer")}</a>`).join("")}</div>`
      : `<div class="panel"><div class="empty">${ic(I.plug, 34)}<p><strong>Aucune passerelle ni base DECT.</strong></p><p>Ajoute une passerelle analogique (fax, ancien téléphone, portier) ou une base DECT (téléphones sans fil) : chaque port ou combiné devient un utilisateur du standard.</p></div></div>`;
  }
  H.app.innerHTML = head("Passerelles et DECT", "Passerelles analogiques (Grandstream HT, GXW, Patton) et bases DECT (Yealink, Snom, Gigaset, Fanvil).",
    editing ? "" : `<a class="btn" href="#/passerelles/nouvelle">${ic(I.plus, 16)} Ajouter un appareil</a>`) + body;
  if (!editing) return;
  const f = H.$("#gwf");
  const ports = new Map((editing.ports || []).map((p) => [p.port, p]));
  const drawPorts = () => {
    const m = d.models.find((x) => x.id === f.elements.model.value);
    if (!m) { H.$("#gwports").innerHTML = ""; return; }
    const n = Math.min(m.ports, m.type === "dect" ? Math.max(10, ...[...ports.keys()]) : m.ports);
    H.$("#gwports").innerHTML = `<div class="cx-sec"><h3>${m.type === "dect" ? "Combinés" : "Ports FXS"} : à quel utilisateur ?</h3>
      <p class="hint" style="margin:0 0 10px">${m.type === "dect" ? `Jusqu'à ${m.ports} combinés. ` : ""}Chaque ${m.type === "dect" ? "combiné" : "port"} utilise le compte SIP de l'utilisateur choisi (son numéro, ses renvois, sa messagerie).</p>
      <div class="cx-pgrid">${Array.from({ length: n }, (_, i) => i + 1).map((i) => `<label class="cx-pmap"><span>${m.type === "dect" ? "Combiné" : "Port"} ${i}</span><select data-port="${i}"><option value="">—</option>${d.users.map((u) => `<option value="${u.id}" ${ports.get(i)?.user === u.id ? "selected" : ""}>${u.id} · ${H.esc(u.name)}</option>`).join("")}</select></label>`).join("")}</div>
      ${m.type === "dect" && n < m.ports ? '<button type="button" class="btn ghost sm" id="gwmore" style="margin-top:10px">+ 10 combinés</button>' : ""}</div>`;
    H.$("#gwmore")?.addEventListener("click", () => { collect(); ports.set(n + 10, ports.get(n + 10) || { port: n + 10, user: "" }); drawPorts(); });
  };
  const collect = () => f.querySelectorAll("[data-port]").forEach((s) => { const p = Number(s.dataset.port); if (s.value) ports.set(p, { port: p, user: s.value }); else ports.delete(p); });
  f.elements.model.addEventListener("change", () => { collect(); drawPorts(); });
  drawPorts();
  onSubmit(f, async (v) => {
    collect();
    const r = await H.api(editing.id ? "PUT" : "POST", editing.id ? `/api/gateways/${editing.id}` : "/api/gateways", { ...v, ports: [...ports.values()].filter((p) => p.user) });
    const id = editing.id || r.gateways.at(-1).id;
    ok("Appareil enregistré."); location.hash = `#/passerelles/${id}/config`;
  });
  H.$("#gwdel")?.addEventListener("click", async (e) => {
    if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Confirmer la suppression"; e.target.classList.add("danger"); return; }
    await H.api("DELETE", `/api/gateways/${editing.id}`); ok("Appareil supprimé."); location.hash = "#/passerelles";
  });
}
async function gatewaySetup(id) {
  const s = await H.api("GET", `/api/gateways/${id}/setup`);
  H.app.innerHTML = head(H.esc(s.gateway.name), `${H.esc(s.gateway.model)} — mise en service`, `<a class="btn ghost" href="#/passerelles/${id}">Modifier</a><a class="btn ghost" href="#/passerelles">Retour</a>`) +
    `<div class="grid2">${s.provisioning ? `<div class="panel"><div class="ph"><h2>${ic(I.check, 18)} Provisioning automatique</h2>${s.provisioning.beta ? pill("wait", "À valider sur le matériel") : pill("ok", "Pris en charge")}</div><div class="pad stack">
        <p style="margin:0">Dans l'interface web de l'appareil, renseigne l'adresse de provisioning (ou l'option DHCP 66 du réseau) :</p>
        <div class="cx-copy"><code>${H.esc(s.provisioning.url)}</code><button class="btn ghost sm" data-copy="${H.esc(s.provisioning.url)}">Copier</button></div>
        <p class="hint" style="margin:0">L'appareil télécharge <span class="mono">${H.esc(s.provisioning.file)}</span>${s.gateway.mac ? "" : " — renseigne l'adresse MAC pour l'activer"}. Il se configure seul et se resynchronise chaque jour.</p>
        <p class="hint" style="margin:0">Mot de passe administrateur posé sur l'appareil : <span class="mono">${H.esc(s.admin_password || "—")}</span></p></div></div>` : ""}
      <div class="panel"><div class="ph"><h2>${s.provisioning ? "Ou configuration manuelle" : "Configuration guidée"}</h2></div><div class="pad"><ol class="cx-guide">${s.guide.map((g) => `<li>${H.esc(g)}</li>`).join("")}</ol></div></div></div>
    <div class="panel" style="margin-top:18px"><div class="ph"><h2>Comptes SIP</h2></div>
      ${s.accounts.length ? `<div class="table-wrap"><table><thead><tr><th>Port / combiné</th><th>Utilisateur</th><th>Identifiant (numéro)</th><th>Identifiant d'authentification</th><th>Mot de passe</th></tr></thead><tbody>
        ${s.accounts.map((a) => `<tr><td>${a.port}</td><td>${H.esc(a.name)}</td><td class="mono">${H.esc(a.user)}</td><td class="mono">${H.esc(a.auth_id)} <button class="btn link" data-copy="${H.esc(a.auth_id)}">Copier</button></td>
          <td class="mono"><span class="cx-secret" data-v="${H.esc(a.password)}">••••••••••</span> <button class="btn link" data-show>Afficher</button> <button class="btn link" data-copy="${H.esc(a.password)}">Copier</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">Aucun port attribué : <a href="#/passerelles/${id}">choisis les utilisateurs</a>.</div>`}
      <div class="pad hint">Serveur : <span class="mono">${H.esc(s.server)}</span>, port 5060 (UDP). Ces identifiants sont ceux des utilisateurs : ne les communique pas.</div></div>`;
  H.copyButtons(H.app);
  H.app.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => { const x = b.previousElementSibling; x.textContent = x.textContent.startsWith("•") ? x.dataset.v : "••••••••••"; }));
}

/** Point d'entrée : page = sortants | securite | enregistrements | codes | sauvegardes | mises-a-jour | alertes | licence | passerelles */
export async function renderAdmin(helpers, page, sub) {
  H = helpers;
  switch (page) {
    case "sortants": return pageOutbound(sub);
    case "securite": return pageSecurity(sub || "apercu");
    case "enregistrements": return pageRecordings(sub);
    case "codes": return pageShortcodes();
    case "sauvegardes": return pageBackups();
    case "mises-a-jour": return pageUpdates();
    case "alertes": return pageAlerts();
    case "licence": return pageLicense();
    case "passerelles": return pageGateways(sub);
  }
}
