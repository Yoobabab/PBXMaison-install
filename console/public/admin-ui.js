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
  const { settings: s, f2b, countries, tenant } = await H.api("GET", "/api/security");
  // Serveur multi-tenant : adresses bloquées, protection automatique et liste blanche sont communes à tout le serveur
  const SERVER_MANAGED = `<div class="note">Géré par la console du serveur (Paramètres › Protection anti-intrusion) : les adresses bloquées, la protection automatique et la liste blanche sont communes à tous les PBX du serveur.</div>`;
  if (tenant && sub === "ip") sub = "apercu";
  const T = [["apercu", "Vue d'ensemble"], ...(tenant ? [] : [["ip", "Adresses IP"]]), ["numeros", "Numéros bloqués"], ["pays", "Appel Pays autorisés"], ["regles", "Anti-fraude"], ["console", "Accès console et postes"], ["journal", "Connexions et journal"]];
  const banned = [...(f2b.manual || []).map((ip) => ({ ip, manual: true })), ...(f2b.auto || []).map((ip) => ({ ip, manual: false }))];
  let body = "";
  if (sub === "apercu") {
    const score = [s.block_premium, s.intl.length < 10, s.max_user_calls > 0, s.max_duration > 0, f2b.active, s.console_allow.length > 0, s.max_per_hour > 0, s.max_intl_day > 0].filter(Boolean).length;
    body = `<div class="kpis">
      ${kpi("shield", "Niveau de protection", `${score}<small>/8</small>`, score >= 7 ? "Très bon" : score >= 5 ? "Correct" : "À renforcer", score >= 7 ? "good" : score >= 5 ? "" : "warn")}
      ${tenant ? kpi("ban", "Anti-intrusion", "Serveur", "géré par la console du serveur") : kpi("ban", "Adresses bloquées", banned.length, f2b.ok ? (f2b.active ? "Protection anti-intrusion active" : "Protection arrêtée !") : "Protection injoignable", f2b.ok && f2b.active ? "" : "warn")}
      ${kpi("phone", "Numéros bloqués", s.in_block.length + s.out_block.length, `${s.in_block.length} entrants · ${s.out_block.length} sortants`)}
      ${kpi("globe", "Appel Pays autorisés", s.intl.length, s.intl.length ? s.intl.slice(0, 4).map((c) => "+" + c).join(" ") + (s.intl.length > 4 ? "…" : "") : "International bloqué")}
    </div>
    ${tenant ? SERVER_MANAGED : ""}
    <div class="panel"><div class="ph"><h2>Points de contrôle</h2></div><div class="cx-checks">
      ${[tenant ? [true, "Protection anti-intrusion", "Gérée pour tout le serveur par la console du serveur", ""] : [f2b.active, "Protection anti-intrusion (fail2ban)", `${s.f2b.maxretry} échecs en ${s.f2b.findtime} min → blocage ${s.f2b.bantime} min`, "ip"],
        [s.block_premium, "Numéros surtaxés bloqués (089x, 118xxx)", "Évite les appels coûteux et la fraude", "regles"],
        [s.intl.length < 10, "International limité aux pays choisis", s.intl.length ? `${s.intl.length} pays autorisés` : "Aucun pays : tout l'international est bloqué", "pays"],
        [s.max_per_hour > 0, "Plafond anti-fraude : appels externes par heure", s.max_per_hour ? `${s.max_per_hour} par heure pour tout le standard, au-delà tout est refusé et une alerte est créée` : "Pas de plafond", "regles"],
        [s.max_intl_day > 0, "Plafond d'appels internationaux par jour", s.max_intl_day ? `${s.max_intl_day} par jour` : "Pas de plafond", "regles"],
        [true, "Renvois vers l'extérieur limités aux numéros nationaux", "Jamais vers l'international, un surtaxé ou un numéro court, même par un compte piraté", ""],
        [(s.sip_allow || []).length > 0, "Postes SIP limités à certains réseaux", (s.sip_allow || []).length ? s.sip_allow.join(", ") : "Les téléphones peuvent se connecter depuis Internet (mot de passe fort)", "console"],
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
        <form id="banf" class="pad cx-inline" novalidate><label class="grow">Bloquer une adresse<input name="ip" placeholder="203.0.113.7 ou 203.0.113.0/24"></label><button class="btn">Bloquer</button>
          <label class="btn ghost" style="cursor:pointer" title="Fichier JSON, CSV ou texte : toutes les adresses IP trouvées sont bloquées définitivement (500 au plus)">Importer une liste…<input type="file" id="banfile" accept=".json,.csv,.txt,.log,text/*,application/json" hidden></label></form>
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
    body = `<form id="intf" novalidate><div class="panel"><div class="ph"><h2>Appel Pays autorisés</h2><span class="s"><span id="ncount">${sel.size}</span> sélectionné(s)</span></div>
      <div class="pad"><p class="hint" style="margin-top:0">Les appels vers l'international (00 + indicatif) sont bloqués, sauf vers les pays cochés. C'est la première protection contre la fraude téléphonique (appels piratés vers des numéros surtaxés à l'étranger).</p>
        <input type="search" id="cq" placeholder="Rechercher un pays…" style="margin-bottom:12px">
        <div class="cx-countries">${countries.map(([cc, n]) => `<label class="cx-cty" data-n="${H.esc(n.toLowerCase())}"><input type="checkbox" value="${cc}" ${sel.has(cc) ? "checked" : ""}><span>${H.esc(n)}</span><small>+${cc}</small></label>`).join("")}</div>
        <label style="margin-top:14px">Autres indicatifs<input name="extra" value="${H.esc(s.intl.filter((c) => !countries.some(([x]) => x === c)).join(", "))}" placeholder="ex. 262, 590"></label>
      </div></div><div class="actions" style="margin-top:16px"><button type="button" class="btn ghost" id="call">Tout décocher</button><button class="btn">Enregistrer</button></div></form>`;
  } else if (sub === "regles") {
    body = `<form id="rgf" novalidate class="panel"><div class="ph"><h2>Règles d'appel</h2></div><div class="pad stack"><div class="form-msg"></div>
      ${sw("block_premium", s.block_premium, "Bloquer les numéros surtaxés", "089x et renseignements 118xxx")}
      <div class="cx-g3"><label>Plafond : appels externes par heure (tout le standard)<input type="number" name="max_per_hour" min="0" max="10000" value="${s.max_per_hour ?? 100}"><span class="hint">Au-delà, tout appel externe est refusé jusqu'à l'heure suivante et une alerte est créée. 0 = pas de plafond.</span></label>
      <label>Plafond : appels internationaux par jour<input type="number" name="max_intl_day" min="0" max="10000" value="${s.max_intl_day ?? 20}"><span class="hint">La fraude passe presque toujours par l'international. 0 = pas de plafond.</span></label></div>
      <div class="cx-g3"><label>Appels externes simultanés par utilisateur<input type="number" name="max_user_calls" min="0" max="50" value="${s.max_user_calls}"><span class="hint">0 = pas de limite. 2 laisse faire un transfert supervisé.</span></label>
      <label>Durée maximale d'un appel externe (min)<input type="number" name="max_duration" min="0" max="1440" value="${s.max_duration}"><span class="hint">0 = pas de limite. Coupe les appels oubliés ou frauduleux.</span></label></div>
      <div class="note">Rappel : la licence limite aussi le nombre total d'appels externes simultanés. Les numéros d'urgence ne sont jamais bloqués ni limités.</div>
      <div class="actions"><button class="btn">Enregistrer</button></div></div></form>`;
  } else if (sub === "console") {
    const ca = s.console_allow.length > 0, sa = (s.sip_allow || []).length > 0;
    body = `<form id="ccf" novalidate class="stack"><div class="form-msg"></div>
      <div class="panel"><div class="ph"><h2>Console d'administration</h2></div><div class="pad stack">
        <label class="check"><input type="radio" name="ca_mode" value="all" ${ca ? "" : "checked"}> Accessible depuis partout (identifiant + mot de passe)</label>
        <label class="check"><input type="radio" name="ca_mode" value="list" ${ca ? "checked" : ""}> Seulement depuis ces adresses IP</label>
        <label data-for="ca">Adresses autorisées<textarea name="console_allow" rows="4" class="mono" placeholder="203.0.113.5&#10;192.168.1.0/24">${H.esc(s.console_allow.join("\n"))}</textarea>
          <span class="hint">IP fixe des bureaux, du technicien… Une par ligne. Ton adresse actuelle doit y être, sinon l'enregistrement est refusé pour ne pas te bloquer. Le softphone web, l'appli mobile et le provisioning des téléphones restent accessibles.</span></label>
      </div></div>
      <div class="panel"><div class="ph"><h2>Téléphones et applis SIP</h2></div><div class="pad stack">
        <label class="check"><input type="radio" name="sa_mode" value="all" ${sa ? "" : "checked"}> Peuvent se connecter depuis partout (télétravail, mobiles)</label>
        <label class="check"><input type="radio" name="sa_mode" value="list" ${sa ? "checked" : ""}> Seulement depuis ces réseaux (le plus sûr)</label>
        <label data-for="sa">Réseaux autorisés<textarea name="sip_allow" rows="4" class="mono" placeholder="IP publique des bureaux, ex. 203.0.113.5&#10;192.168.1.0/24">${H.esc((s.sip_allow || []).join("\n"))}</textarea>
          <span class="hint">Un téléphone, une base DECT ou une appli qui se connecte d'ailleurs est refusé, même avec le bon mot de passe. Mets l'IP publique de chaque site (et le réseau local si le PBX est sur place). Le softphone web et l'appli Callikoe ne sont pas concernés ; une appli SIP (Zoiper…) hors de ces réseaux ne fonctionnera plus.</span></label>
      </div></div>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`;
  }
  if (sub === "journal") {
    const [{ entries }, me] = await Promise.all([H.api("GET", "/api/audit"), H.api("GET", "/api/me")]);
    body = `<div class="kpis">${kpi("lock", "Double authentification", me.totp ? "Activée" : "Désactivée", me.totp ? `${me.recovery_left} code(s) de secours restant(s)` : "", me.totp ? "good" : "warn")}
      ${kpi("user", "Connexions refusées (200 dernières actions)", entries.filter((e) => !e.ok).length, "mauvais mot de passe ou mauvais code")}</div>
      <div class="panel" style="margin-bottom:16px"><div class="ph"><h2>Double authentification</h2><button class="btn ghost sm" id="totpnew">Changer d'appareil / nouveaux codes de secours</button></div><div class="pad" id="totparea"><p class="hint" style="margin:0">Chaque connexion demande le mot de passe puis le code à 6 chiffres de Psono. Les actions sensibles (sécurité, trunks, règles sortantes, restauration, mise à jour) redemandent le code s'il date de plus de 15 minutes.</p></div></div>
      <div class="panel"><div class="ph"><h2>Journal : connexions et modifications</h2></div>
      ${entries.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Compte</th><th>Adresse IP</th><th>Action</th></tr></thead><tbody>
        ${entries.map((e) => `<tr><td>${fmtDT(e.at)}</td><td>${H.esc(e.email)}</td><td class="mono">${H.esc(e.ip)}</td><td>${e.ok ? "" : pill("bad", "Refusé")} ${H.esc(e.action)}${e.detail ? `<div class="s mono">${H.esc(e.detail)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Rien pour l\'instant.</div>'}</div>`;
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
  // Import d'une liste d'adresses à bloquer (JSON, CSV, texte)
  H.$("#banfile")?.addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 900_000) { H.setFlash({ cls: "bad", text: "Fichier trop gros (900 Ko au plus)." }); return pageSecurity(sub); }
    const text = await f.text();
    if (!confirm(`Bloquer définitivement les adresses IP trouvées dans « ${f.name} » ?\nTon adresse actuelle est toujours exclue.`)) return;
    try {
      const r = await H.api("POST", "/api/security/ban-list", { text });
      H.setFlash({ cls: r.failed.length ? "warn" : "", text: `${r.banned} adresse${r.banned > 1 ? "s" : ""} bloquée${r.banned > 1 ? "s" : ""}.${r.truncated ? ` Fichier coupé à 500 adresses (sur ${r.total}).` : ""}${r.skipped.length ? ` Ignorée : ${r.skipped.join(", ")} (ton adresse ou le serveur).` : ""}${r.failed.length ? ` Échec : ${r.failed.slice(0, 5).join(", ")}` : ""}${r.invalid.length ? ` Refusées (invalides) : ${r.invalid.slice(0, 5).join(", ")}` : ""}` });
    } catch (err) { H.setFlash({ cls: "bad", text: err.message }); }
    pageSecurity(sub);
  });
  H.$("#f2bf") && onSubmit(H.$("#f2bf"), (v) => save({ f2b: v.f2b, whitelist: lines(v.whitelist) }));
  H.$("#numf") && onSubmit(H.$("#numf"), (v) => save({ in_block: parseNums(v.in_block), out_block: parseNums(v.out_block), block_anonymous: v.block_anonymous }));
  H.$("#rgf") && onSubmit(H.$("#rgf"), (v) => save({ ...v, max_per_hour: Number(v.max_per_hour), max_intl_day: Number(v.max_intl_day), max_user_calls: Number(v.max_user_calls), max_duration: Number(v.max_duration) }));
  H.$("#totpnew")?.addEventListener("click", async () => {
    const area = H.$("#totparea");
    try {
      const t = await H.api("POST", "/api/totp/setup");
      area.innerHTML = `<div class="totp"><div class="totp-qr">${t.qr}</div><div class="totp-steps"><p style="margin-top:0">Scanne ce nouveau QR code dans Psono (l'ancien code cessera de fonctionner), puis tape le code affiché.</p>
        <label>Code<input id="ntc" inputmode="numeric" maxlength="6" placeholder="123456"></label><div class="err" id="nte"></div><button class="btn" id="ntok" style="margin-top:10px">Valider</button></div></div>`;
      H.$("#ntok").onclick = async () => {
        try { const r = await H.api("POST", "/api/totp/confirm", { code: H.$("#ntc").value }); area.innerHTML = `<div class="note"><strong>Nouveaux codes de secours</strong> (les anciens ne marchent plus) :<pre class="code">${r.recovery_codes.map(H.esc).join("\n")}</pre></div>`; }
        catch (e) { H.$("#nte").textContent = e.message; }
      };
    } catch (e) { area.innerHTML = `<div class="flash bad">${H.esc(e.message)}</div>`; }
  });
  const ccf = H.$("#ccf");
  if (ccf) {
    const sync = () => { ccf.querySelector('[data-for="ca"]').hidden = ccf.elements.ca_mode.value !== "list"; ccf.querySelector('[data-for="sa"]').hidden = ccf.elements.sa_mode.value !== "list"; };
    ccf.addEventListener("change", sync); sync();
    onSubmit(ccf, (v) => save({ console_allow: v.ca_mode === "list" ? lines(v.console_allow) : [], sip_allow: v.sa_mode === "list" ? lines(v.sip_allow) : [] }));
  }
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
  const pg = H.paginate("rec", list.recordings);
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
      ${list.recordings.length ? `${pg.html}<div class="cx-list">${pg.rows.map((c) => `<div class="cx-row cx-rec">
          <span class="cx-dir ${c.direction}" title="${DIR[c.direction] || ""}">${ic(c.direction === "in" ? I.down : I.up, 15)}</span>
          <div class="grow"><b>${H.esc(c.from.name || H.fmtPhone(c.from.number))}</b> <span class="s">→</span> <b>${H.esc(c.answered_by || H.fmtPhone(c.to.number))}</b>
            <div class="s">${fmtDT(c.start)} · ${Math.floor(c.talk / 60)} min ${String(c.talk % 60).padStart(2, "0")} s${c.did ? ` · SDA ${H.esc(H.fmtPhone(c.did))}` : ""}</div></div>
          ${c.available ? `<audio controls preload="none" src="/api/recordings/file?f=${encodeURIComponent(c.recording)}"></audio>
            <a class="ghost-ic" href="/api/recordings/file?f=${encodeURIComponent(c.recording)}&dl=1" title="Télécharger">${ic(I.dl)}</a>
            <button class="ghost-ic" data-del="${H.esc(c.recording)}" title="Supprimer">${ic(I.trash)}</button>` : `<span class="s">Fichier supprimé</span>`}
        </div>`).join("")}</div>${pg.html}` : `<div class="empty">${s.enabled ? "Aucun appel enregistré sur la période." : "L'enregistrement est arrêté : active-le dans les réglages."}</div>`}</div>`);
  const f = H.$("#recf");
  H.$("#tmgo")?.addEventListener("click", async (e) => {
    const b = e.target; b.disabled = true; const t = b.textContent; b.textContent = "Envoi…";
    try { await H.api("POST", "/api/alerts/test-mail", { to: H.$("#tmto").value }); ok("E-mail de test envoyé : vérifie la boîte de réception (et les indésirables)."); }
    catch (err) { H.setFlash({ cls: "bad", text: err.message }); }
    pageAlerts("reglages"); b.textContent = t;
  });
  if (f) onSubmit(f, async (v) => { await H.api("PUT", "/api/recording", { ...v, retention_days: Number(v.retention_days) }); ok("Réglages enregistrés."); location.hash = "#/enregistrements"; });
  H.wirePager(H.app, () => pageRecordings(sub));
  const setQ = (k, v) => { sessionStorage.setItem("pbxm_rec_q", JSON.stringify({ ...q, [k]: v })); H.resetPage("rec"); pageRecordings(); };
  let t; const h0 = location.hash;
  H.$("#rq")?.addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { if (location.hash === h0) setQ("q", e.target.value); }, 400); });
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
  const EX = { place: "1", poste: "201", "numéro": "0612345678" };
  const example = (c) => `${c.code}${c.suffix ? EX[c.suffix] || "" : ""}`;
  H.app.innerHTML = head("Codes de raccourci", "Composés depuis un téléphone, le softphone ou l'appli. Tu peux les changer pour reprendre ceux d'un ancien standard.") +
    `<form id="scf" novalidate><div class="form-msg"></div><div class="panel"><div class="table-wrap"><table class="sctable">
      <thead><tr><th>Code</th><th>Ce que ça fait</th><th class="hide-sm">Exemple</th></tr></thead>
      ${groups.map((g) => `<tbody><tr class="scg"><td colspan="3">${H.esc(g)}</td></tr>
        ${codes.filter((c) => c.group === g).map((c) => `<tr>
          <td class="nw"><span class="sc-in"><input name="${c.id}" value="${H.esc(c.code)}" maxlength="5" spellcheck="false" aria-label="${H.esc(c.label)}" data-sfx="${H.esc(c.suffix || "")}">${c.suffix ? `<em>+ ${H.esc(c.suffix === "place" ? "place" : c.suffix)}</em>` : ""}</span></td>
          <td>${H.esc(c.label)}${c.code !== c.default ? ` <span class="s">(par défaut ${H.esc(c.default)})</span>` : ""}</td>
          <td class="hide-sm"><code data-ex="${c.id}">${H.esc(example(c))}</code></td></tr>`).join("")}</tbody>`).join("")}
    </table></div></div>
      <div class="actions" style="margin-top:16px"><button type="button" class="btn ghost" id="scr">Rétablir les codes par défaut</button><button class="btn">Enregistrer</button></div></form>`;
  H.app.querySelectorAll(".sc-in input").forEach((i) => i.addEventListener("input", () => { const x = H.app.querySelector(`[data-ex="${i.name}"]`); if (x) x.textContent = `${i.value}${i.dataset.sfx ? EX[i.dataset.sfx] || "" : ""}`; }));
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
  // Serveur multi-tenant : tous les PBX sont mis à jour ensemble, depuis la console du serveur
  if (d.tenant) {
    H.app.innerHTML = head("Mises à jour", "Ce PBX est mis à jour avec tout le serveur.") +
      `<div class="cx-hero ok"><span class="cx-hero-ic">${ic(I.check, 30)}</span><div class="grow"><h2>Version installée : ${H.esc(d.current.version)}</h2>
        <p>Le serveur cherche une nouvelle version chaque matin. Pour l'installer : <b>console du serveur › Mises à jour</b> (une pastille noire apparaît dans son menu quand il y en a une).</p></div></div>`;
    return;
  }
  const c = d.current, a = d.available;
  const newer = a?.commit && d.up_to_date === false;
  if (H.state) { H.state.update_available = !!newer; H.renderNav?.(); }
  H.app.innerHTML = head("Mises à jour", "Le PBX cherche une nouvelle version chaque matin. Rien ne s'installe sans toi.", `<button class="btn ghost" id="upchk">Rechercher une mise à jour</button>`) +
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
async function pageAlerts(sub) {
  H.setNav("alerts");
  const d = await H.api("GET", "/api/alerts");
  const s = d.settings;
  const SEV = { critical: "bad", warning: "wait", info: "off" };
  const showCfg = sub === "reglages";
  const week = Date.now() - 7 * 86400_000;
  const recent = d.log.filter((l) => Date.parse(l.at) > week);
  // Alertes identiques regroupées : une ligne, le nombre et la dernière fois
  const groups = [];
  for (const l of d.log) {
    const g = groups.find((x) => x.title === l.title && x.text === l.text);
    if (g) { g.count++; g.first = l.at; } else groups.push({ ...l, count: 1, first: l.at, last: l.at });
  }
  const lvl = sessionStorage.getItem("pbxm_al_lvl") || "";
  const shown = groups.filter((g) => !lvl || g.severity === lvl);
  const tabs = `<nav class="subtabs" style="margin:0 0 14px">${[["", "Journal"], ["reglages", "Réglages"]].map(([k, l]) => `<a href="#/alertes${k ? "/" + k : ""}" class="${(sub || "") === k ? "on" : ""}">${l}</a>`).join("")}</nav>`;
  H.app.innerHTML = head("Alertes", "Le PBX prévient quand quelque chose d'important se passe : trunk décroché, tentative d'intrusion, disque plein…", `<button class="btn ghost" id="alchk">Vérifier maintenant</button>`) + tabs +
    (showCfg ? `<form id="alf" novalidate><div class="form-msg"></div>
      <div class="panel" style="margin-bottom:16px"><div class="ph"><h2>Que surveiller ?</h2></div><div class="table-wrap"><table class="altable"><thead><tr><th></th><th>Alerte</th><th class="nw" title="Urgent : à traiter tout de suite (appels coupés, disque plein…). À surveiller : à regarder, rien ne presse.">Importance ⓘ</th></tr></thead><tbody>
        ${Object.entries(d.events).map(([k, [t, sev, desc]]) => `<tr><td class="nw"><label class="switch"><input type="checkbox" name="events.${k}" ${s.events[k] ? "checked" : ""} aria-label="${H.esc(t)}"><span></span></label></td>
          <td><b>${H.esc(t)}</b><div class="s">${H.esc(desc)}</div>${k === "disk" || /disk|disque/i.test(k) ? `<label class="al-inline">Seuil<input type="number" name="disk_threshold" min="50" max="99" value="${s.disk_threshold}"> %</label>` : ""}</td>
          <td class="nw">${pill(SEV[sev], d.severity[sev])}</td></tr>`).join("")}
      </tbody></table></div></div>
      ${Object.keys(d.events).some((k) => k === "disk" || /disk|disque/i.test(k)) ? "" : `<input type="hidden" name="disk_threshold" value="${s.disk_threshold}">`}
      <div class="panel"><div class="ph"><h2>Envoi des e-mails</h2>${d.sending_enabled ? pill("ok", "Prêt") : pill("wait", "À régler")}</div><div class="pad stack">
        <p class="hint" style="margin:0">Le serveur d'envoi sert aux alertes et aux messages vocaux envoyés par e-mail (fiche utilisateur › Messagerie vocale). Celui de l'entreprise convient : OVH, Microsoft 365, Gmail, la messagerie du client…</p>
        <label>Destinataires des alertes<textarea name="recipients" rows="2" placeholder="technicien@irt-network.fr, gerant@client.fr">${H.esc(s.recipients.join(", "))}</textarea></label>
        <div class="cx-g3"><label>Serveur SMTP<input name="smtp.host" value="${H.esc(s.smtp.host)}" placeholder="ssl0.ovh.net"></label><label>Port<input name="smtp.port" type="number" value="${s.smtp.port}"></label>
          <label>Sécurité<select name="smtp.security">${[["starttls", "STARTTLS (587)"], ["tls", "TLS (465)"], ["none", "Aucune (25)"]].map(([k, l]) => `<option value="${k}" ${s.smtp.security === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
        <div class="cx-g3"><label>Identifiant<input name="smtp.user" value="${H.esc(s.smtp.user)}" autocomplete="off" placeholder="standard@client.fr"></label><label>Mot de passe<input type="password" name="smtp.password" placeholder="${s.smtp.has_password ? "•••••••• (inchangé)" : ""}" autocomplete="new-password"></label>
          <label>Expéditeur<input name="smtp.from" value="${H.esc(s.smtp.from)}" placeholder="standard@client.fr"></label></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><input id="tmto" type="email" placeholder="Adresse pour le test" style="max-width:260px" value="${H.esc(s.recipients[0] || "")}"><button type="button" class="btn ghost" id="tmgo">Envoyer un e-mail de test</button><span class="hint">Enregistre d'abord les réglages.</span></div>
      </div></div>
      <div class="actions" style="margin-top:16px"><button class="btn">Enregistrer</button></div></form>`
    : `<div class="kpis">${kpi("alerts" in I ? "alerts" : "clock", "7 derniers jours", recent.length, recent.length ? `${recent.filter((l) => l.severity === "critical").length} urgente(s)` : "Rien à signaler", recent.some((l) => l.severity === "critical") ? "warn" : "good")}
        ${kpi("clock", "Dernière alerte", d.log[0] ? fmtDT(d.log[0].at) : "Aucune", d.log[0] ? H.esc(d.log[0].title) : "")}
        ${kpi("check", "Surveillances actives", Object.values(s.events).filter(Boolean).length, `sur ${Object.keys(d.events).length}`)}</div>
      <div class="panel"><div class="filters"><div class="seg" id="allvl">${[["", "Toutes"], ["critical", "Urgentes"], ["warning", "À surveiller"]].map(([k, l]) => `<label class="${lvl === k ? "on" : ""}"><input type="radio" name="allvl" value="${k}" ${lvl === k ? "checked" : ""}>${l}</label>`).join("")}</div>
        <span class="grow"></span>${d.log.length ? '<button class="btn ghost sm" id="alclr">Vider le journal</button>' : ""}</div>
        ${shown.length ? `<div class="table-wrap"><table><thead><tr><th>Importance</th><th>Alerte</th><th class="hide-sm">Dernière fois</th><th>Nombre</th></tr></thead><tbody>
          ${shown.map((g) => `<tr><td class="nw">${pill(SEV[g.severity] || "off", d.severity[g.severity] || g.severity)}</td>
            <td><b>${H.esc(g.title)}</b><div class="s">${H.esc(g.text)}</div></td>
            <td class="hide-sm nw">${fmtDT(g.last)}${g.count > 1 ? `<div class="s">depuis le ${fmtDT(g.first)}</div>` : ""}</td>
            <td class="nw">${g.count > 1 ? `<span class="pill off">×${g.count}</span>` : "1"}</td></tr>`).join("")}</tbody></table></div>`
          : `<div class="empty">${ic(I.check, 30)}<p>${d.log.length ? "Aucune alerte de ce niveau." : "Aucune alerte. Tout va bien."}</p></div>`}</div>`);
  const f = H.$("#alf");
  H.$("#tmgo")?.addEventListener("click", async (e) => {
    const b = e.target; b.disabled = true; const t = b.textContent; b.textContent = "Envoi…";
    try { await H.api("POST", "/api/alerts/test-mail", { to: H.$("#tmto").value }); ok("E-mail de test envoyé : vérifie la boîte de réception (et les indésirables)."); }
    catch (err) { H.setFlash({ cls: "bad", text: err.message }); }
    pageAlerts("reglages"); b.textContent = t;
  });
  if (f) onSubmit(f, async (v) => { v.disk_threshold = Number(v.disk_threshold); v.smtp.port = Number(v.smtp.port); await H.api("PUT", "/api/alerts", v); ok("Réglages des alertes enregistrés."); pageAlerts("reglages"); });
  H.app.querySelectorAll("[name=allvl]").forEach((r) => r.onchange = () => { sessionStorage.setItem("pbxm_al_lvl", r.value); pageAlerts(sub); });
  H.$("#alclr")?.addEventListener("click", async () => { if (!confirm("Vider tout le journal des alertes ?")) return; await H.api("DELETE", "/api/alerts/log"); pageAlerts(sub); });
  H.$("#alchk").addEventListener("click", async () => { await H.api("POST", "/api/alerts/check", {}); pageAlerts(sub); });
}

// ================================================================ Licence
async function pageLicense() {
  H.setNav("sys");
  const l = await H.api("GET", "/api/license");
  const pct = l.max_calls ? Math.min(100, Math.round(100 * l.usage.calls / l.max_calls)) : 0;
  const EDITIONS = { basic: "Basic", start: "Start", pro: "Essentiel", enterprise: "Intégral" };
  H.app.innerHTML = `<p style="margin:0 0 6px"><a href="#/systeme">← Système</a></p>` + head("Licence", "Informations de licence et d'utilisation du standard.") +
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
    <form class="panel" id="licf" style="margin-top:18px" novalidate><div class="ph"><h2>Changer de licence</h2></div><div class="pad stack">
      <p class="hint" style="margin:0">Changement d'édition (ex. Pro → Entreprise), d'appels simultanés (ex. 4 → 8) ou renouvellement : génère la nouvelle clé dans le portail Callikoe (fiche du PBX › Changer la licence), puis colle-la ici. Elle s'applique tout de suite, sans couper les appels en cours.</p>
      <label>Nouvelle clé de licence<textarea name="token" rows="3" class="mono" placeholder="CLK1.…" spellcheck="false" autocomplete="off"></textarea></label>
      <div class="form-msg"></div>
      <div class="row"><button class="btn">Appliquer la nouvelle licence</button></div></div></form>`;
  H.$("#licf").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button"); btn.disabled = true;
    try {
      const r = await H.api("POST", "/api/license", { token: e.target.token.value });
      H.setFlash({ text: `Licence appliquée : Callikoe ${EDITIONS[r.edition] || r.edition}, ${r.max_calls} appels simultanés.` }); pageLicense();
    } catch (err) { H.showFormError(e.target, err); btn.disabled = false; }
  };
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
    `<div class="panel"><div class="ph"><h2>Mise en service</h2>${s.provisioning ? (s.provisioning.beta ? pill("wait", "Provisioning à valider sur le matériel") : pill("ok", "Provisioning automatique")) : pill("off", "Configuration à la main")}</div>
      <div class="pad"><div class="cx-setup">
        ${s.provisioning ? `<div><span class="dl">Lien de provisioning</span><button class="btn ghost sm" data-copy="${H.esc(s.provisioning.url)}" title="${H.esc(s.provisioning.url)}">🔗 Copier le lien</button>
          <div class="hint" style="margin:6px 0 0">Interface web de l'appareil ou option DHCP 66${s.gateway.mac ? "" : " · <b>adresse MAC à renseigner</b>"}</div></div>` : ""}
        <div><span class="dl">Mot de passe de l'appareil</span>${s.admin_password ? `<span class="mono cx-secret" data-v="${H.esc(s.admin_password)}">••••••••••</span> <button class="btn link" data-show>Afficher</button> <button class="btn link" data-copy="${H.esc(s.admin_password)}">Copier</button>
          <div class="hint" style="margin:6px 0 0">${s.provisioning ? "Remplace l'ancien mot de passe dès que l'appareil est provisionné" : "À poser dans l'interface web de l'appareil"}</div>` : '<span class="s">—</span>'}</div>
        <div><span class="dl">Serveur SIP</span><span class="mono">${H.esc(s.server)}</span> <span class="hint">port 5060 (UDP)</span></div>
      </div>${s.provisioning ? "" : `<details style="margin-top:14px"><summary>Réglages à faire dans l'appareil</summary><ol class="cx-guide">${s.guide.map((g) => `<li>${H.esc(g)}</li>`).join("")}</ol></details>`}</div></div>
    <div class="panel" style="margin-top:18px"><div class="ph"><h2>Comptes SIP</h2></div>
      ${s.accounts.length ? `<div class="table-wrap"><table><thead><tr><th>Port / combiné</th><th>Utilisateur</th><th>État</th><th>Identifiant (numéro)</th><th>Identifiant d'authentification</th><th>Mot de passe</th></tr></thead><tbody>
        ${s.accounts.map((a) => `<tr><td>${a.port}</td><td><a href="#/utilisateurs/${H.esc(a.user)}">${H.esc(a.name)}</a></td><td>${a.online ? pill("ok", "Connecté") : pill("off", "Non connecté")}</td><td class="mono">${H.esc(a.user)}</td><td class="mono">${H.esc(a.auth_id)} <button class="btn link" data-copy="${H.esc(a.auth_id)}">Copier</button></td>
          <td class="mono"><span class="cx-secret" data-v="${H.esc(a.password)}">••••••••••</span> <button class="btn link" data-show>Afficher</button> <button class="btn link" data-copy="${H.esc(a.password)}">Copier</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">Aucun port attribué : <a href="#/passerelles/${id}">choisis les utilisateurs</a>.</div>`}</div>`;
  H.copyButtons(H.app);
  H.app.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => { const x = b.previousElementSibling; x.textContent = x.textContent.startsWith("•") ? x.dataset.v : "••••••••••"; }));
}

// ================================================================ Comptes de la console
async function pageAccounts() {
  H.setNav("accounts");
  const d = await H.api("GET", "/api/accounts");
  const admin = d.role === "admin";
  H.app.innerHTML = head("Comptes", "Un compte par personne : chacun se connecte avec son adresse, son mot de passe et sa double authentification, et le journal indique qui a fait quoi.") +
    `${admin ? `<form id="acf" class="panel" novalidate style="margin-bottom:16px"><div class="ph"><h2>Inviter un collègue</h2></div><div class="pad stack"><div class="form-msg"></div>
      <div class="cx-g3"><label>E-mail<input name="email" type="email" placeholder="prenom.nom@irt-network.fr"></label><label>Nom<input name="name" placeholder="Prénom Nom"></label>
      <label>Rôle<select name="role">${Object.entries(d.roles).map(([k, l]) => `<option value="${k}" ${k === "tech" ? "selected" : ""}>${H.esc(l)}</option>`).join("")}</select></label></div>
      <p class="hint" style="margin:0"><b>Administrateur</b> : tout, y compris les comptes. <b>Technicien</b> : tout sauf la gestion des comptes. <b>Lecture seule</b> : consulter sans rien modifier.</p>
      <div id="aclink"></div><div class="actions"><button class="btn">Créer le lien d'invitation</button></div></div></form>` : ""}
    <div class="panel"><div class="ph"><h2>Comptes</h2><span class="s">${d.accounts.length}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Compte</th><th>Rôle</th><th>Double authentification</th><th>Dernière connexion</th><th></th></tr></thead><tbody>
      ${d.accounts.map((a) => `<tr><td><b>${H.esc(a.name || a.email)}</b>${a.name ? `<div class="s">${H.esc(a.email)}</div>` : ""}${a.invited_by ? `<div class="s">invité par ${H.esc(a.invited_by)}</div>` : ""}</td>
        <td>${admin && a.email !== d.me ? `<select data-role="${H.esc(a.email)}">${Object.entries(d.roles).map(([k, l]) => `<option value="${k}" ${k === a.role ? "selected" : ""}>${H.esc(l)}</option>`).join("")}</select>` : H.esc(d.roles[a.role] || a.role)}</td>
        <td>${a.totp ? pill("ok", "Activée") : pill("wait", "À activer")}</td><td>${fmtDT(a.last_login_at)}</td>
        <td class="acts">${admin && a.email !== d.me ? `<button class="btn ghost sm" data-del="${H.esc(a.email)}">Supprimer</button>` : a.email === d.me ? '<span class="s">toi</span>' : ""}</td></tr>`).join("")}
      ${d.invites.map((i) => `<tr><td><b>${H.esc(i.name || i.email)}</b><div class="s">${H.esc(i.email)}</div></td><td>${H.esc(d.roles[i.role])}</td><td colspan="2">${pill("off", "Invitation en attente")} <span class="s">expire ${fmtDT(i.expires_at)}</span></td><td></td></tr>`).join("")}
      </tbody></table></div></div>`;
  const f = H.$("#acf");
  H.$("#tmgo")?.addEventListener("click", async (e) => {
    const b = e.target; b.disabled = true; const t = b.textContent; b.textContent = "Envoi…";
    try { await H.api("POST", "/api/alerts/test-mail", { to: H.$("#tmto").value }); ok("E-mail de test envoyé : vérifie la boîte de réception (et les indésirables)."); }
    catch (err) { H.setFlash({ cls: "bad", text: err.message }); }
    pageAlerts("reglages"); b.textContent = t;
  });
  if (f) onSubmit(f, async (v) => {
    const r = await H.api("POST", "/api/accounts", v);
    H.$("#aclink").innerHTML = `<div class="note">Envoie ce lien à ${H.esc(v.email)} (valable ${r.expires_in_hours} h, une seule fois) :<div class="cx-copy" style="margin-top:8px"><code>${H.esc(r.link)}</code><button type="button" class="btn ghost sm" data-copy="${H.esc(r.link)}">Copier</button></div></div>`;
    H.copyButtons(H.app);
  });
  H.app.querySelectorAll("[data-role]").forEach((sel) => sel.onchange = async () => { try { await H.api("PUT", `/api/accounts/${encodeURIComponent(sel.dataset.role)}`, { role: sel.value }); ok("Rôle modifié."); } catch (e) { H.setFlash({ cls: "bad", text: e.message }); } pageAccounts(); });
  H.app.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.classList.add("danger"); b.textContent = "Confirmer"; return; }
    try { await H.api("DELETE", `/api/accounts/${encodeURIComponent(b.dataset.del)}`); ok("Compte supprimé : l'accès est coupé immédiatement."); } catch (e) { H.setFlash({ cls: "bad", text: e.message }); }
    pageAccounts();
  });
}

/** Point d'entrée : page = sortants | securite | enregistrements | codes | sauvegardes | mises-a-jour | alertes | licence | passerelles */
// ================================================================ Capture réseau (pcap pour Wireshark)
async function pageCapture() {
  H.setNav("cap");
  const size = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1e3))} Ko`;
  const d = await H.api("GET", "/api/capture");
  H.app.innerHTML = head("Capture réseau", "Enregistre le trafic des appels (comme Wireshark) pour analyser un problème : appel refusé, pas de son, son coupé, touches non reconnues.") +
    `<form class="panel" id="capf" novalidate><div class="ph"><h2>${d.running ? `${pill("wait", "Capture en cours…")}` : "Nouvelle capture"}</h2></div><div class="pad stack"><div class="form-msg"></div>
      <div class="grid3"><label>Contenu<select name="mode"><option value="sip">Signalisation SIP seulement (léger)</option><option value="all">SIP + audio RTP (pour « pas de son »)</option></select></label>
        <label>Durée<select name="seconds">${[[30, "30 secondes"], [60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"], [600, "10 minutes"]].map(([v, l]) => `<option value="${v}" ${v === 120 ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <p class="hint" style="margin:0">Lance la capture, reproduis l'appel qui pose problème, puis télécharge le fichier <code>.pcap</code> et ouvre-le dans Wireshark (Téléphonie › Appels VoIP pour voir l'échange et réécouter l'audio). Les postes en SIP TLS (port 5061) apparaissent chiffrés. Le fichier contient les numéros et, avec l'audio, les conversations : à garder pour soi et à supprimer après analyse. 20 captures gardées au plus.</p>
      <div class="row">${d.running ? '<button type="button" class="btn" id="capstop">Arrêter la capture</button>' : '<button class="btn">Démarrer la capture</button>'}</div></div></form>
    <div class="panel" style="margin-top:18px"><div class="ph"><h2>Captures</h2></div>
      ${d.files.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Contenu</th><th>Taille</th><th></th></tr></thead><tbody>${d.files.map((f) => `<tr><td>${fmtDT(f.at)}</td><td>${f.mode === "all" ? "SIP + audio" : "SIP"}</td><td>${f.ready ? size(f.size) : pill("wait", "en cours")}</td>
        <td class="acts">${f.ready ? `<a class="btn ghost sm" href="/api/capture/file/${encodeURIComponent(f.name)}" download>Tout télécharger</a> <button class="btn ghost sm" data-capdel="${H.esc(f.name)}">Supprimer</button>` : ""}</td></tr>
        ${f.ready ? `<tr class="capcalls"><td colspan="4">${f.calls?.length ? `<div class="s" style="margin-bottom:6px">${f.calls.length} appel${f.calls.length > 1 ? "s" : ""} dans cette capture : un fichier par appel (sa signalisation${f.mode === "all" ? " et son audio" : ""}).</div>
          ${f.calls.map((c, i) => `<div class="capcall"><span class="grow"><strong>Appel ${i + 1}</strong> · ${H.esc(c.from_name ? `${c.from_name} (${c.from})` : c.from || "?")} → ${H.esc(c.to || "?")}
            <span class="s">· ${fmtDT(c.start)} · ${c.duration} s · ${c.answered ? "décroché" : c.status ? `refusé (${H.esc(c.status)})` : "sans réponse"}${f.mode === "all" ? ` · ${c.audio_packets ? `audio ${c.audio_packets} paquets` : "pas d'audio"}` : ""}</span></span>
            <a class="btn ghost sm" href="/api/capture/file/${encodeURIComponent(f.name)}/${encodeURIComponent(c.file)}" download>Télécharger</a></div>`).join("")}`
          : '<span class="s">Aucun appel dans cette capture (seulement des enregistrements ou tests de présence).</span>'}</td></tr>` : ""}`).join("")}</tbody></table></div>` : '<div class="empty">Aucune capture.</div>'}</div>`;
  H.$("#capf").onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await H.api("POST", "/api/capture/start", H.formData(e.target)); H.setFlash({ text: `Capture démarrée pour ${r.seconds} s : reproduis l'appel maintenant.` }); pageCapture(); }
    catch (err) { H.showFormError(e.target, err); }
  };
  H.$("#capstop")?.addEventListener("click", async () => { await H.api("POST", "/api/capture/stop"); pageCapture(); });
  H.app.querySelectorAll("[data-capdel]").forEach((b) => b.onclick = async () => { await H.api("DELETE", `/api/capture/file/${encodeURIComponent(b.dataset.capdel)}`); pageCapture(); });
  if (d.running || d.files.some((f) => !f.ready)) H.poll(async () => { const x = await H.api("GET", "/api/capture"); if (!x.running && x.files.every((f) => f.ready)) { if (location.hash === "#/capture") pageCapture(); return true; } return false; }, 4000);
}

// ================================================================ IA
/** Destinations proposées au standardiste IA : collègues, groupes, files, SVI, messageries */
function rcDests(rc, cur, fallback = false) {
  const v = cur?.type ? `${cur.type}:${cur.target || ""}` : "";
  const opt = (val, l) => `<option value="${H.esc(val)}" ${val === v ? "selected" : ""}>${H.esc(l)}</option>`;
  const K = { group: "Groupe", queue: "File", ivr: "SVI", groupvm: "Messagerie de groupe" };
  return (fallback ? opt("hangup:", "Raccrocher") : opt("", "— Choisir —"))
    + `<optgroup label="Collègues">${rc.users.map((u) => opt(`user:${u.id}`, `${u.id} · ${u.name}`)).join("")}</optgroup>`
    + `<optgroup label="Groupes, files, SVI">${rc.objects.filter((o) => o.kind !== "groupvm").map((o) => opt(`${o.kind}:${o.id}`, `${K[o.kind]} ${o.number || ""} · ${o.name}`)).join("")}</optgroup>`
    + `<optgroup label="Messageries">${rc.users.filter((u) => u.vm).map((u) => opt(`user_vm:${u.id}`, `Messagerie de ${u.name}`)).join("")}${rc.objects.filter((o) => o.kind === "groupvm").map((o) => opt(`groupvm:${o.id}`, `Messagerie de groupe ${o.name}`)).join("")}</optgroup>`;
}
async function pageAi() {
  H.setNav("ai");
  const d = await H.api("GET", "/api/ai-settings");
  const r = d.relay, on = d.settings.enabled;
  const euro = (n) => `${(n || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const OPS = { transcriptions: "messages transcrits", voicemail: "résumés", annonces: "annonces en voix IA", diagnose: "diagnostics", announce: "textes d'annonce", report: "bilans et rapports", flow: "routages écrits en français", ivr: "choix du SVI parlé", standardiste: "appels du standardiste IA", standardiste_min: "minutes de standardiste IA" };
  const state = !on ? ["off", "Désactivée"] : d.error ? ["bad", "Problème"] : r?.fake ? ["wait", "Mode test"] : r?.ready ? ["ok", "Active"] : ["wait", "En attente de la clé IRT"];
  H.app.innerHTML = head("IA", "Fonctions d'intelligence artificielle du PBX. La clé OpenAI d'IRT reste dans le portail pro : le PBX n'y a jamais accès.") + `
    <div class="cards">
      ${kpi("check", "État", `<span class="pill ${state[0]}">${state[1]}</span>`, on && d.error ? H.esc(d.error) : on && r && !r.ready ? "Le relais du portail attend la clé OpenAI d'IRT." : on && r?.fake ? "Réponses de démonstration, rien n'est consommé." : "")}
      ${kpi("clock", "Ce mois-ci", r ? euro(r.used_eur) : "—", r ? `plafond ${euro(r.cap_eur)} / mois` : "")}
      ${kpi("mail", "Utilisations du mois", r ? String(Object.values(r.ops || {}).reduce((a, n) => a + n, 0)) : "—", r ? Object.entries(r.ops || {}).map(([k, n]) => `${n} ${OPS[k] || k}`).join(" · ") : "")}
    </div>
    <div class="panel"><div class="ph"><h2>Réglages</h2></div><form id="aif" class="pad stack">
      ${sw("enabled", on, "Activer l'IA sur ce PBX", "Annonces en voix IA, diagnostic dans Gestion d'appels › Dépannage, et les options ci-dessous.")}
      ${sw("voicemail", d.settings.voicemail, "Transcrire et résumer les messages vocaux", "Chaque nouveau message est écrit en texte avec un résumé d'une phrase : dans l'e-mail, le softphone et l'appli. Environ 0,3 centime la minute.")}
      <div class="note">À prévoir côté client (RGPD) : informer les appelants que les messages sont transcrits automatiquement, par exemple dans l'annonce du répondeur. Les messages passent par le relais Callikoe puis OpenAI, sans y être conservés au-delà du traitement.</div>
      <div class="actions"><button class="btn">Enregistrer</button></div></form></div>
    <div class="panel"><div class="ph"><h2>Ailleurs dans la console</h2></div><div class="pad stack">
      <p style="margin:0"><a href="#/gestion/standardiste"><b>Standardiste IA</b></a> : dans Gestion d'appels, avec les routages.</p>
      <p style="margin:0"><a href="#/rapports"><b>Rapport mensuel au client</b></a> : dans Activité › Rapports.</p></div></div>
    <div class="panel"><div class="ph"><h2>Essayer</h2></div><div class="pad stack">
      <div class="row"><input id="aitry" class="grow" value="On est fermés lundi pour inventaire" maxlength="300"><button type="button" class="btn ghost" id="aitryb" ${on ? "" : "disabled"}>Rédiger une annonce</button></div>
      <p class="hint" style="margin:0">Pour créer une vraie annonce lue par une voix IA, avec ou sans fond musical : <a href="#/gestion/annonces/nouveau">Gestion d'appels › Annonces › Ajouter</a>.</p>
      <div id="aitryr"></div></div></div>`;
  onSubmit(H.$("#aif"), async (f) => { await H.api("PUT", "/api/ai-settings", { enabled: f.enabled, voicemail: f.voicemail }); ok(f.enabled ? "IA activée." : "IA désactivée."); pageAi(); });
  H.$("#aitry").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); H.$("#aitryb").click(); } };
  H.$("#aitryb").onclick = async (e) => {
    e.target.disabled = true; H.$("#aitryr").innerHTML = '<span class="spin"></span>';
    try { const x = await H.api("POST", "/api/ai/announce-text", { idea: H.$("#aitry").value }); H.$("#aitryr").innerHTML = `<div class="note">« ${H.esc(x.text)} »</div>`; }
    catch (err) { H.$("#aitryr").innerHTML = `<div class="flash bad">${H.esc(err.message)}</div>`; }
    e.target.disabled = false;
  };
}


/** Gestion d'appels › Standardiste IA (top = en-tête et onglets de Gestion d'appels) */
async function pageReceptionist(top) {
  const [d, rc] = await Promise.all([H.api("GET", "/api/ai-settings"), H.api("GET", "/api/ai-settings/receptionist")]);
  const on = d.settings.enabled;
  H.app.innerHTML = `${top}${on ? "" : `<div class="flash warn">L'IA est désactivée sur ce PBX : active-la dans <a href="#/ia">Administration › IA</a> pour que le standardiste réponde.</div>`}
    <div class="panel"><div class="ph"><h2><span class="ai-badge">IA</span> Standardiste IA</h2></div><form id="rcf" class="pad stack" novalidate><div class="form-msg"></div>
      <p class="hint" style="margin:0">Une voix IA répond au téléphone : elle renseigne l'appelant, le transfère vers le bon service ou prend un message. Pour l'utiliser, choisis la destination <b>« Standardiste IA »</b> dans un routage, une règle entrante ou un SVI. Environ 5 à 10 centimes la minute d'appel.</p>
      <div class="grid2"><label>Nom de l'entreprise<input name="company" value="${H.esc(rc.settings.company)}" maxlength="80" placeholder="Boulangerie Martin"></label>
        <label>Voix<select name="voice">${Object.entries(rc.voices).map(([k, l]) => `<option value="${k}" ${rc.settings.voice === k ? "selected" : ""}>${H.esc(l)}</option>`).join("")}</select></label></div>
      <label>Phrase d'accueil (facultatif)<input name="greeting" value="${H.esc(rc.settings.greeting)}" maxlength="200" placeholder="Boulangerie Martin, bonjour ! Que puis-je pour vous ?"></label>
      <label>Ce que l'IA peut répondre<textarea name="info" rows="5" maxlength="3000" placeholder="Horaires : du mardi au samedi, 7 h – 19 h 30, dimanche 7 h – 13 h.\nAdresse : 12 rue de la Gare, Rennes. Parking devant.\nCommandes de gâteaux : 48 h à l'avance.">${H.esc(rc.settings.info)}</textarea><span class="hint">Horaires, adresse, réponses aux questions fréquentes. L'IA n'invente rien d'autre.</span></label>
      <div><span class="dl">Transferts possibles</span><div id="rctr" class="rc-trs"></div><button type="button" class="btn ghost sm" id="rcadd">+ Ajouter un transfert</button></div>
      <div class="grid2"><label>Messages envoyés à<input name="message_to" value="${H.esc(rc.settings.message_to.join(", "))}" placeholder="accueil@client.fr"><span class="hint">Chaque message pris par l'IA arrive par e-mail et dans « À rappeler » du softphone.</span></label>
        <label>Si l'IA est indisponible<select name="fallback">${rcDests(rc, rc.settings.fallback, true)}</select></label></div>
      <div class="actions"><button class="btn">Enregistrer</button></div></form></div>`;
  // Standardiste IA : transferts (nom, description, destination)
  let trs = rc.settings.transfers.map((t) => ({ ...t }));
  const drawTr = () => {
    H.$("#rctr").innerHTML = trs.map((t, i) => `<div class="rc-tr" data-i="${i}"><span class="rc-n">${i + 1}</span>
      <input data-f="label" value="${H.esc(t.label)}" placeholder="Nom (ex. Commandes)" maxlength="60">
      <input data-f="description" value="${H.esc(t.description || "")}" placeholder="Quand ? (ex. gâteaux, traiteur, livraisons)" maxlength="200">
      <select data-f="dest">${rcDests(rc, t.dest)}</select><button type="button" class="ic" data-rm title="Retirer">✕</button></div>`).join("") || '<p class="s" style="margin:0 0 8px">Aucun transfert : l\'IA ne fera que renseigner et prendre des messages.</p>';
    H.$("#rctr").querySelectorAll(".rc-tr").forEach((row) => {
      const t = trs[Number(row.dataset.i)];
      row.querySelectorAll("[data-f]").forEach((el) => el.oninput = el.onchange = () => { if (el.dataset.f === "dest") { const [type, target] = el.value.split(":"); t.dest = { type, target }; } else t[el.dataset.f] = el.value; });
      row.querySelector("[data-rm]").onclick = () => { trs.splice(Number(row.dataset.i), 1); drawTr(); };
    });
  };
  drawTr();
  H.$("#rcadd").onclick = () => { trs.push({ label: "", description: "", dest: { type: "", target: "" } }); drawTr(); };
  onSubmit(H.$("#rcf"), async (f) => {
    const [ft, fg] = String(f.fallback || "hangup:").split(":");
    await H.api("PUT", "/api/ai-settings/receptionist", { company: f.company, voice: f.voice, greeting: f.greeting, info: f.info, message_to: f.message_to, transfers: trs, fallback: { type: ft, target: fg || "" } });
    ok("Standardiste IA enregistré."); pageReceptionist(top);
  });
}

/** Activité › Rapports : rapport mensuel envoyé au client */
async function pageReports() {
  H.setNav("reports");
  const [d, rep, sc] = await Promise.all([H.api("GET", "/api/ai-settings"), H.api("GET", "/api/ai-settings/report"), H.api("GET", "/api/reports/schedules")]);
  const on = d.settings.enabled;
  const editing = sessionStorage.getItem("pbxm_rs_edit");
  const cur = editing === "new" ? { name: "", frequency: "week", hour: 8, recipients: [], sections: Object.fromEntries(Object.keys(sc.sections).map((k) => [k, true])), csv: true, enabled: true }
    : sc.schedules.find((x) => x.id === editing);
  const schForm = cur ? `<form id="rsf" class="pad stack" novalidate style="border-top:1px solid var(--line)"><div class="form-msg"></div>
      <div class="grid2"><label>Nom<input name="name" value="${H.esc(cur.name)}" maxlength="60" placeholder="Rapport de la semaine"></label>
        <label>Destinataires<input name="recipients" value="${H.esc(cur.recipients.join(", "))}" placeholder="gerant@client.fr, compta@client.fr"></label></div>
      <div class="grid2"><label>Fréquence<select name="frequency">${Object.entries(sc.frequencies).map(([k, l]) => `<option value="${k}" ${cur.frequency === k ? "selected" : ""}>${H.esc(l)}</option>`).join("")}</select></label>
        <label>Heure d'envoi<select name="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${cur.hour === h ? "selected" : ""}>${h} h</option>`).join("")}</select></label></div>
      <div><span class="dl">Contenu</span><div class="row" style="flex-wrap:wrap;gap:6px 18px">${Object.entries(sc.sections).map(([k, l]) => `<label class="check"><input type="checkbox" name="sec_${k}" ${cur.sections[k] ? "checked" : ""}> ${H.esc(l)}</label>`).join("")}
        <label class="check"><input type="checkbox" name="csv" ${cur.csv ? "checked" : ""}> Tous les appels en fichier Excel (CSV)</label></div></div>
      ${sw("enabled", cur.enabled, "Actif")}
      <div class="actions">${cur.id ? '<button type="button" class="btn ghost" id="rsdel">Supprimer</button>' : ""}<button type="button" class="btn ghost" id="rscancel">Annuler</button><button class="btn">Enregistrer</button></div></form>` : "";
  H.app.innerHTML = head("Rapports", "Bilans d'appels envoyés par e-mail au client.") + `
    <div class="panel" style="margin-bottom:16px"><div class="ph"><h2>Rapports détaillés planifiés</h2>${cur ? "" : '<button class="btn sm" id="rsnew">+ Nouveau rapport</button>'}</div>
      ${sc.smtp ? "" : '<div class="pad"><div class="flash warn" style="margin:0">Le serveur d\'envoi des e-mails n\'est pas réglé : <a href="#/alertes/reglages">Alertes › Réglages</a>.</div></div>'}
      ${sc.schedules.length ? `<div class="table-wrap"><table><thead><tr><th>Rapport</th><th>Quand</th><th>Destinataires</th><th>Dernier envoi</th><th></th></tr></thead><tbody>
        ${sc.schedules.map((x) => `<tr><td><b>${H.esc(x.name)}</b>${x.enabled ? "" : ` ${pill("off", "En pause")}`}<div class="s">${Object.entries(sc.sections).filter(([k]) => x.sections[k]).map(([, l]) => H.esc(l)).join(" · ")}${x.csv ? " · fichier Excel" : ""}</div></td>
          <td>${H.esc(sc.frequencies[x.frequency].split(" (")[0])}<div class="s">à ${x.hour} h</div></td><td class="s">${H.esc(x.recipients.join(", "))}</td>
          <td class="s">${x.last ? `${H.esc(x.last.label)}<br>${fmtDT(x.last.at)}` : "—"}</td>
          <td class="acts"><a class="btn ghost sm" href="/api/reports/schedules/${H.esc(x.id)}/preview" target="_blank" rel="noopener">Aperçu</a> <button class="btn ghost sm" data-rstest="${H.esc(x.id)}">Essai</button> <button class="btn ghost sm" data-rsedit="${H.esc(x.id)}">Modifier</button></td></tr>`).join("")}</tbody></table></div>`
        : cur ? "" : '<div class="empty">Aucun rapport planifié : chaque jour, semaine ou mois, le client reçoit les chiffres détaillés (par utilisateur, par numéro, appels manqués) et tous les appels en fichier Excel.</div>'}
      ${schForm}</div>
    <div class="panel"><div class="ph"><h2>Rapport mensuel au client</h2></div><form id="rpf" class="pad stack" novalidate><div class="form-msg"></div>
      <p class="hint" style="margin:0">Le 1er de chaque mois, le client reçoit par e-mail le bilan du mois écoulé : appels reçus, pris, manqués, attente, jours et heures chargés, appels par personne${on ? ", avec l'analyse et les conseils de l'IA" : ""}. Aux couleurs et au logo du serveur (option Marque blanche), sinon aux couleurs Callikoe.</p>
      ${sw("enabled", rep.enabled, "Envoyer le rapport chaque mois")}
      <div class="grid2"><label>Destinataires<input name="recipients" value="${H.esc(rep.recipients.join(", "))}" placeholder="gerant@client.fr, compta@client.fr"><span class="hint">Séparés par des virgules (10 au plus).</span></label>
        <label>Signé par<input name="signature" value="${H.esc(rep.signature)}" maxlength="80" placeholder="Ex. Télécom Ouest — votre installateur"></label></div>
      ${sw("ai", rep.ai, "Ajouter l'analyse et les conseils de l'IA", on ? "Environ 1 centime par rapport." : "L'IA doit être activée ci-dessus.")}
      <p class="s" style="margin:0">${rep.last ? `Dernier envoi : ${H.esc(rep.last.label)}, le ${fmtDT(rep.last.at)} à ${H.esc(rep.last.to.join(", "))}.` : "Pas encore envoyé."}</p>
      <div class="actions"><a class="btn ghost" href="/api/ai-settings/report/preview" target="_blank" rel="noopener">Aperçu du mois dernier</a><button type="button" class="btn ghost" id="rptest">M'envoyer un essai</button><button class="btn">Enregistrer</button></div></form></div>`;
  onSubmit(H.$("#rpf"), async (f) => { await H.api("PUT", "/api/ai-settings/report", { enabled: f.enabled, ai: f.ai, recipients: f.recipients, signature: f.signature }); ok("Rapport mensuel enregistré."); pageReports(); });
  // Rapports planifiés
  const setEdit = (v) => { try { v ? sessionStorage.setItem("pbxm_rs_edit", v) : sessionStorage.removeItem("pbxm_rs_edit"); } catch { /* */ } pageReports(); };
  H.$("#rsnew")?.addEventListener("click", () => setEdit("new"));
  H.$("#rscancel")?.addEventListener("click", () => setEdit(null));
  H.app.querySelectorAll("[data-rsedit]").forEach((b) => b.onclick = () => setEdit(b.dataset.rsedit));
  H.$("#rsdel")?.addEventListener("click", async () => { if (!confirm("Supprimer ce rapport planifié ?")) return; await H.api("DELETE", `/api/reports/schedules/${cur.id}`); ok("Rapport supprimé."); setEdit(null); });
  H.app.querySelectorAll("[data-rstest]").forEach((b) => b.onclick = async () => {
    const to = prompt("Envoyer un essai de ce rapport (dernière période) à :", H.state?.email || "");
    if (!to) return;
    b.disabled = true;
    try { const x = await H.api("POST", `/api/reports/schedules/${b.dataset.rstest}/test`, { to }); alert(`Rapport (${x.label}) envoyé à ${x.to.join(", ")}.`); } catch (err) { alert(err.message); }
    b.disabled = false;
  });
  if (H.$("#rsf")) onSubmit(H.$("#rsf"), async (f) => {
    const body = { name: f.name, recipients: f.recipients, frequency: f.frequency, hour: Number(f.hour), csv: f.csv, enabled: f.enabled,
      sections: Object.fromEntries(Object.keys(sc.sections).map((k) => [k, !!f[`sec_${k}`]])) };
    await H.api(cur.id ? "PUT" : "POST", `/api/reports/schedules${cur.id ? "/" + cur.id : ""}`, body);
    ok("Rapport planifié enregistré."); setEdit(null);
  });
  H.$("#rptest").onclick = async (e) => {
    const to = prompt("Envoyer un essai du rapport (mois dernier) à :", H.state?.email || "");
    if (!to) return;
    e.target.disabled = true;
    try { const x = await H.api("POST", "/api/ai-settings/report/test", { to }); alert(`Rapport de ${x.label} envoyé à ${x.to.join(", ")}.`); } catch (err) { alert(err.message); }
    e.target.disabled = false;
  };
}

// ================================================================ Import / export
const TX_ICON = {
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14c2.6 0 4.4 1.6 5 4.5"/>',
  contacts: '<rect x="4" y="3" width="15" height="18" rx="2"/><circle cx="11.5" cy="10" r="2.6"/><path d="M7.5 17c.6-2.2 2.1-3.3 4-3.3s3.4 1.1 4 3.3M19 7h2M19 12h2"/>',
  trunks: '<path d="M4 12h16M4 6h16M4 18h16"/><circle cx="8" cy="6" r="1.4" fill="currentColor"/><circle cx="14" cy="12" r="1.4" fill="currentColor"/><circle cx="10" cy="18" r="1.4" fill="currentColor"/>',
  inbound: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6"/><path d="M4 4v4M4 12v8h8"/>',
  outbound: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const TX_HINT = {
  users: "Fiches, rôles, SDA, messagerie, téléphone (modèle et MAC).",
  contacts: "Contacts de l'entreprise et leurs numéros.",
  trunks: "Lignes opérateur. Les mots de passe ne sont jamais exportés.",
  inbound: "SDA, horaires et destinations (ouvert, fermé, pause, fériés).",
  outbound: "Préfixes, postes, trunks et numéro présenté.",
};
const TX_ACTION = { create: ["ok", "À créer"], update: ["wait", "À mettre à jour"], error: ["bad", "Erreur"] };
/** Fichier CSV → texte (UTF-8, sinon Windows-1252 : CSV enregistré par Excel en français) */
async function fileText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function pageTransfer() {
  H.setNav("transfer");
  const { kinds } = await H.api("GET", "/api/transfer");
  const lists = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k.id, (await H.api("GET", `/api/transfer/${k.id}`)).items])));
  const fmt = {};
  const sel = Object.fromEntries(kinds.map((k) => [k.id, new Set()]));
  H.app.innerHTML = `${head("Import / export", "Récupère tes réglages dans un fichier (s'ouvre dans Excel) ou importe-les d'un autre PBX. Les fichiers exportés par 3CX sont reconnus tout seuls.")}
    <section class="panel tx-full"><div class="tx-fullin pad"><span class="tx-ic">${ic(I.up2, 22)}</span><div class="grow"><h2>Reprendre tout un PBX 3CX</h2>
        <p>La sauvegarde 3CX (.zip) : utilisateurs, renvois et téléphones, trunks avec leurs mots de passe, annonces, horaires, groupes, files d'attente, SVI, règles entrantes et sortantes, annuaire. Aperçu avant import.</p></div>
        <label class="btn tx-file">${ic(I.up2, 16)} Choisir la sauvegarde 3CX…<input type="file" id="tx3cx" accept=".zip,application/zip" hidden></label></div></section>
    <p class="hint tx-tip">Partie par partie : importe dans l'ordre utilisateurs, trunks, puis les règles. Chaque import montre d'abord un aperçu.</p>
    <div class="tx-grid">${kinds.map((k) => `<section class="tx-card" data-k="${k.id}">
      <div class="tx-top"><span class="tx-ic">${ic(TX_ICON[k.id], 22)}</span><div class="grow"><h2>${H.esc(k.label)}</h2><p>${TX_HINT[k.id]}</p></div><span class="tx-n">${lists[k.id].length}</span></div>
      <div class="tx-fmt"><span>Format</span><div class="seg sm">${k.formats.map((f, i) => `<label class="${i ? "" : "on"}"><input type="radio" name="f-${k.id}" value="${f}" ${i ? "" : "checked"}>${f === "3cx" ? "3CX" : "Callikoe (Excel)"}</label>`).join("")}</div>
        ${k.formats.includes("3cx") ? "" : `<small>${k.import3cx ? "3CX : import accepté" : "3CX n'a pas d'export pour cette partie"}</small>`}</div>
      <div class="tx-btns"><button type="button" class="btn sm" data-all ${lists[k.id].length ? "" : "disabled"}>${ic(I.dl, 16)} Tout exporter</button>
        <button type="button" class="btn ghost sm" data-pick ${lists[k.id].length ? "" : "disabled"}>Choisir…</button>
        <label class="btn ghost sm tx-file">${ic(I.up2, 16)} Importer<input type="file" accept=".csv,text/csv,text/plain" hidden></label></div>
      <div class="tx-pick" hidden><input type="search" placeholder="Rechercher…"><div class="tx-list">${lists[k.id].map((x) => `<label class="tx-it"><input type="checkbox" value="${H.esc(x.id)}"><span><b>${H.esc(x.label)}</b>${x.sub ? `<small>${H.esc(x.sub)}</small>` : ""}</span></label>`).join("")}</div>
        <div class="tx-pa"><button type="button" class="btn link" data-tog>Tout cocher</button><span class="grow"></span><button type="button" class="btn sm" data-sel disabled>Exporter la sélection</button></div></div>
    </section>`).join("")}</div>
    <div id="txprev"></div>`;
  H.$("#tx3cx").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const box = H.app.querySelector("#txprev");
    box.innerHTML = '<div class="panel pad"><span class="spin"></span> Lecture de la sauvegarde…</div>';
    box.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const zip = await openZip(f);
      const xmlName = zip.names.find((n) => /(^|\/)\d*Db\.xml$/i.test(n));
      if (!xmlName) throw new Error("Ce .zip ne contient pas de fichier …Db.xml : est-ce bien une sauvegarde 3CX ?");
      const xml = await zip.text(xmlName);
      const files = zip.names.filter((n) => /^httpprompts\/[^/]+\.wav$/i.test(n)).map((n) => n.slice(12));
      show3cx(box, f.name, { xml, files, zip, trunks: false }, await H.api("POST", "/api/transfer-3cx", { xml, files, trunks: false }));
    } catch (err) { box.innerHTML = `<div class="panel pad"><div class="form-msg err" style="display:block">${H.esc(err.message)}</div></div>`; }
  };
  H.app.querySelectorAll(".tx-card").forEach((card) => {
    const k = card.dataset.k;
    fmt[k] = card.querySelector(".seg input:checked").value;
    card.querySelectorAll(".seg input").forEach((r) => r.onchange = () => { fmt[k] = r.value; card.querySelectorAll(".seg label").forEach((l) => l.classList.toggle("on", l.contains(r))); });
    const doExport = async (ids) => {
      const r = await H.api("POST", `/api/transfer/${k}/export`, { format: fmt[k], ids });
      download(r.filename, r.text);
    };
    card.querySelector("[data-all]").onclick = () => doExport([]).catch((e) => alert(e.message));
    const pick = card.querySelector(".tx-pick");
    const selBtn = card.querySelector("[data-sel]");
    const upd = () => { selBtn.disabled = !sel[k].size; selBtn.textContent = sel[k].size ? `Exporter la sélection (${sel[k].size})` : "Exporter la sélection"; };
    card.querySelector("[data-pick]").onclick = () => { pick.hidden = !pick.hidden; if (!pick.hidden) pick.querySelector("input[type=search]").focus(); };
    pick.querySelector("input[type=search]").oninput = (e) => {
      const q = e.target.value.toLowerCase().trim();
      pick.querySelectorAll(".tx-it").forEach((it) => { it.hidden = !!q && !it.textContent.toLowerCase().includes(q); });
    };
    pick.querySelectorAll(".tx-it input").forEach((c) => c.onchange = () => { c.checked ? sel[k].add(c.value) : sel[k].delete(c.value); c.closest(".tx-it").classList.toggle("on", c.checked); upd(); });
    pick.querySelector("[data-tog]").onclick = () => {
      const vis = [...pick.querySelectorAll(".tx-it:not([hidden]) input")];
      const on = !vis.every((c) => c.checked);
      vis.forEach((c) => { c.checked = on; on ? sel[k].add(c.value) : sel[k].delete(c.value); c.closest(".tx-it").classList.toggle("on", on); });
      upd();
    };
    selBtn.onclick = () => doExport([...sel[k]]).catch((e) => alert(e.message));
    const fileIn = card.querySelector("input[type=file]");
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; fileIn.value = "";
      if (!f) return;
      const text = await fileText(f);
      const box = H.app.querySelector("#txprev");
      box.innerHTML = '<div class="panel pad"><span class="spin"></span> Lecture du fichier…</div>';
      box.scrollIntoView({ behavior: "smooth", block: "start" });
      try { showPreview(box, kinds.find((x) => x.id === k), f.name, text, await H.api("POST", `/api/transfer/${k}/import`, { text })); }
      catch (e) { box.innerHTML = `<div class="panel pad"><div class="form-msg err" style="display:block">${H.esc(e.message)}</div></div>`; }
    };
  });
}
/** Lecture d'un .zip dans le navigateur : liste des fichiers et contenu d'un fichier (seuls les fichiers utiles sont envoyés à la console) */
async function openZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Fichier .zip illisible.");
  let p = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true), entries = new Map();
  for (let k = 0; k < n && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    entries.set(new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl)), { method, csize, off });
    p += 46 + nl + xl + cl;
  }
  const bytes = async (name) => {
    const e = entries.get(name); if (!e) return null;
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error("Compression du .zip non prise en charge.");
    return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  };
  return { names: [...entries.keys()], bytes, text: async (name) => new TextDecoder().decode(await bytes(name)) };
}
const b64of = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
/** Aperçu / résultat de l'import d'une sauvegarde 3CX : une partie par bloc */
function show3cx(box, name, src, r) {
  const ready = r.sections.reduce((a, s) => a + s.counts.create + s.counts.update, 0);
  const sec = (s) => {
    const done = s.lines.filter((l) => l.done).length;
    const rows = s.lines.map((l) => {
      const [cls, t] = r.applied ? (l.done ? ["ok", l.action === "update" ? "Mis à jour" : "Créé"] : ["bad", "Non importé"]) : TX_ACTION[l.action];
      return `<tr class="${l.action === "error" || (r.applied && !l.done) ? "tx-err" : ""}"><td><b>${H.esc(l.label)}</b></td><td><span class="pill ${cls}">${t}</span></td>
        <td>${l.error ? `<div class="tx-e">${H.esc(l.error)}</div>` : ""}${l.warnings.map((w) => `<div class="tx-w">${H.esc(w)}</div>`).join("")}${!l.error && !l.warnings.length ? '<span class="s">—</span>' : ""}</td></tr>`;
    }).join("");
    return `<details class="tx-sec" ${s.counts.error ? "open" : ""}><summary><b>${H.esc(s.label)}</b> <span class="tx-sum">${r.applied
      ? `<span class="pill ok">${done} importé${done > 1 ? "s" : ""}</span>${s.lines.length - done ? `<span class="pill bad">${s.lines.length - done} non importé${s.lines.length - done > 1 ? "s" : ""}</span>` : ""}`
      : `${s.counts.create ? `<span class="pill ok">${s.counts.create} à créer</span>` : ""}${s.counts.update ? `<span class="pill wait">${s.counts.update} à mettre à jour</span>` : ""}${s.counts.error ? `<span class="pill bad">${s.counts.error} en erreur</span>` : ""}`}</span></summary>
      <div class="table-wrap"><table><thead><tr><th>Élément</th><th>Action</th><th>Détails</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  };
  box.innerHTML = `<div class="panel tx-prev"><div class="ph"><h2>${r.applied ? "Import terminé" : "Aperçu avant import"} · sauvegarde 3CX</h2><span class="s">${H.esc(name)}${r.version ? ` · 3CX ${H.esc(r.version)}` : ""}</span></div>
    <div class="pad stack">${r.applied ? "" : '<p class="hint" style="margin:0">Rien n\'est encore enregistré. Les lignes en erreur sont ignorées, les autres sont importées.</p>'}
      ${!r.applied && r.trunks_available ? `<label class="check tx-trk"><input type="checkbox" id="tx3trk" ${src.trunks ? "checked" : ""}> <span><b>Importer aussi les ${r.trunks_available} trunk${r.trunks_available > 1 ? "s" : ""} et les règles sortantes</b><br><span class="s">Ils s'enregistrent tout de suite chez l'opérateur avec les identifiants de 3CX : les appels entrants arriveraient sur Callikoe au lieu de 3CX. À cocher seulement le jour de la bascule.</span></span></label>` : ""}
      ${r.sections.map(sec).join("") || '<p class="s">Rien à importer dans cette sauvegarde.</p>'}
      ${r.notes.length ? `<div class="note"><b>À faire à la main</b><ul style="margin:6px 0 0">${r.notes.map((x) => `<li>${H.esc(x)}</li>`).join("")}</ul></div>` : ""}</div>
    <div class="actions pad">${r.applied ? '<button type="button" class="btn" data-close>Fermer</button>'
      : `<button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn" data-go ${ready ? "" : "disabled"}>Tout importer</button>`}</div></div>`;
  box.querySelector("[data-close]").onclick = () => (r.applied ? pageTransfer() : (box.innerHTML = ""));
  box.querySelector("#tx3trk")?.addEventListener("change", async (e) => {
    src.trunks = e.target.checked;
    box.style.opacity = ".6";
    try { show3cx(box, name, src, await H.api("POST", "/api/transfer-3cx", { xml: src.xml, files: src.files, trunks: src.trunks })); } catch (err) { alert(err.message); }
    box.style.opacity = "";
  });
  const go = box.querySelector("[data-go]");
  if (go) go.onclick = async () => {
    if (!confirm("Importer la sauvegarde 3CX dans ce PBX ?\nLes fiches qui existent déjà (même numéro de poste, même nom de trunk ou de règle) sont mises à jour.")) return;
    go.disabled = true; go.innerHTML = '<span class="spin"></span> Import en cours…';
    try {
      const wavs = {};
      for (const p of r.prompts || []) { const b = await src.zip.bytes(`httpprompts/${p}`); if (b) wavs[p] = b64of(b); }
      show3cx(box, name, src, await H.api("POST", "/api/transfer-3cx", { xml: src.xml, files: src.files, wavs, trunks: src.trunks, apply: true }));
    }
    catch (e) { go.disabled = false; go.textContent = "Réessayer"; alert(e.message); }
  };
}
function showPreview(box, kind, name, text, r) {
  const ready = r.counts.create + r.counts.update;
  const rows = r.lines.map((l) => {
    const [cls, txt] = r.applied ? (l.done ? ["ok", l.action === "update" ? "Mis à jour" : "Créé"] : ["bad", "Non importé"]) : TX_ACTION[l.action];
    return `<tr class="${l.action === "error" || (r.applied && !l.done) ? "tx-err" : ""}"><td class="s">${l.line}</td><td><b>${H.esc(l.label)}</b></td><td><span class="pill ${cls}">${txt}</span></td>
      <td>${l.error ? `<div class="tx-e">${H.esc(l.error)}</div>` : ""}${l.warnings.map((w) => `<div class="tx-w">${H.esc(w)}</div>`).join("")}${!l.error && !l.warnings.length ? '<span class="s">—</span>' : ""}</td></tr>`;
  }).join("");
  const done = r.lines.filter((l) => l.done).length;
  box.innerHTML = `<div class="panel tx-prev"><div class="ph"><h2>${r.applied ? "Import terminé" : "Aperçu avant import"} · ${H.esc(kind.label)}</h2>
      <span class="s">${H.esc(name)}${r.format === "3cx" ? ' · <span class="pill off">Fichier 3CX reconnu</span>' : ""}</span></div>
    <div class="pad"><div class="tx-sum">${r.applied
      ? `<span class="pill ok">${done} importé${done > 1 ? "s" : ""}</span>${r.lines.length - done ? `<span class="pill bad">${r.lines.length - done} non importé${r.lines.length - done > 1 ? "s" : ""}</span>` : ""}`
      : `<span class="pill ok">${r.counts.create} à créer</span><span class="pill wait">${r.counts.update} à mettre à jour</span>${r.counts.error ? `<span class="pill bad">${r.counts.error} en erreur (ignoré${r.counts.error > 1 ? "s" : ""})</span>` : ""}`}</div>
      ${r.applied ? "" : '<p class="hint" style="margin:8px 0 0">Rien n\'est encore enregistré. Les colonnes absentes du fichier ne changent pas les fiches existantes.</p>'}</div>
    <div class="table-wrap"><table><thead><tr><th>Ligne</th><th>Élément</th><th>Action</th><th>Détails</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="s">Aucune ligne.</td></tr>'}</tbody></table></div>
    <div class="actions pad">${r.applied ? '<button type="button" class="btn" data-close>Fermer</button>'
      : `<button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn" data-go ${ready ? "" : "disabled"}>Importer ${ready} ligne${ready > 1 ? "s" : ""}</button>`}</div></div>`;
  box.querySelector("[data-close]").onclick = () => (r.applied ? pageTransfer() : (box.innerHTML = ""));
  const go = box.querySelector("[data-go]");
  if (go) go.onclick = async () => {
    go.disabled = true; go.innerHTML = '<span class="spin"></span> Import en cours…';
    try { showPreview(box, kind, name, text, await H.api("POST", `/api/transfer/${kind.id}/import`, { text, apply: true })); }
    catch (e) { go.disabled = false; go.textContent = "Réessayer"; alert(e.message); }
  };
}

export async function renderAdmin(helpers, page, sub) {
  H = helpers;
  switch (page) {
    case "sortants": return pageOutbound(sub);
    case "securite": return pageSecurity(sub || "apercu");
    case "enregistrements": return pageRecordings(sub);
    case "codes": return pageShortcodes();
    case "sauvegardes": return pageBackups();
    case "mises-a-jour": return pageUpdates();
    case "alertes": return pageAlerts(sub);
    case "licence": return pageLicense();
    case "passerelles": return pageGateways(sub);
    case "comptes": return pageAccounts();
    case "capture": return pageCapture();
    case "import-export": return pageTransfer();
    case "ia": return pageAi();
    case "standardiste": return pageReceptionist(sub);
    case "rapports": return pageReports();
  }
}
