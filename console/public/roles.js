/**
 * Rôles des utilisateurs du PBX : ce que chacun peut faire (fenêtre « i » de la console).
 * En escalier : chaque rôle a tous les droits du rôle précédent.
 */
export const ROLES = [
  { id: "user", name: "Utilisateur", short: "Téléphone, softphone et appli", color: "#64748b" },
  { id: "standard", name: "Pilote", short: "Ouvre et ferme tout le PBX", color: "#16a34a" },
  { id: "manager", name: "Superviseur", short: "Plannings et suivi de l'équipe", color: "#2563eb" },
  { id: "console", name: "Gestionnaire", short: "Console du PBX, accès limité", color: "#9333ea" },
  { id: "admin", name: "Administrateur", short: "Console du PBX, tout", color: "#dc2626" },
];
/** [droit, rôle minimum] */
export const RIGHTS = [
  ["Appeler, chat, messagerie vocale, contacts, statut", "user"],
  ["Renvoyer ses propres appels (menu Renvoi, touche, codes)", "user"],
  ["Ouvrir / fermer tout le PBX en choisissant où vont les appels (bouton, touche, codes)", "standard"],
  ["Renvoyer les appels d'un collègue absent", "standard"],
  ["Enregistrer ou remplacer les annonces au micro (ex. « fermé exceptionnellement »)", "standard"],
  ["Modifier les plannings d'appels qui lui sont confiés", "manager"],
  ["Voir les appels en cours et le journal d'appels de l'équipe", "manager"],
  ["Écouter les enregistrements d'appels", "manager"],
  ["Suivre les files d'attente (appels en attente, perdus, temps d'attente)", "manager"],
  ["Se connecter à la console du PBX : utilisateurs, téléphones, gestion d'appels, annuaire, journal", "console"],
  ["Console complète : lignes opérateur (trunks), règles sortantes, sécurité, sauvegardes, mises à jour, capture réseau…", "admin"],
];
const RANK = Object.fromEntries(ROLES.map((r, i) => [r.id, i]));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Fenêtre « Que peut faire chaque rôle ? » (role = rôle à mettre en avant) */
export function openRolesInfo(role = "") {
  document.querySelector(".roles-modal")?.remove();
  const box = document.createElement("div");
  box.className = "roles-modal";
  box.innerHTML = `<div class="rm-scrim"></div><div class="rm-card" role="dialog" aria-label="Rôles des utilisateurs">
    <div class="rm-head"><div><h2>Que peut faire chaque rôle ?</h2><p>Chaque rôle a tous les droits du rôle précédent, plus les siens.</p></div><button type="button" class="rm-x" aria-label="Fermer">✕</button></div>
    <div class="rm-roles">${ROLES.map((r, i) => `<div class="rm-role ${r.id === role ? "on" : ""}" style="--rc:${r.color}"><span class="rm-n">${i + 1}</span><b>${esc(r.name)}</b><small>${esc(r.short)}</small></div>`).join("")}</div>
    <div class="rm-scroll"><table class="rm-table"><thead><tr><th></th>${ROLES.map((r) => `<th class="${r.id === role ? "on" : ""}" style="--rc:${r.color}">${esc(r.name)}</th>`).join("")}</tr></thead>
      <tbody>${RIGHTS.map(([t, min]) => `<tr><td>${esc(t)}</td>${ROLES.map((r) => `<td class="${r.id === role ? "on" : ""}">${RANK[r.id] >= RANK[min] ? `<span class="rm-y" style="--rc:${r.color}">✓</span>` : '<span class="rm-n0">—</span>'}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="rm-foot">Gestionnaire et Administrateur se connectent à la console de ce PBX avec l'e-mail de leur fiche et leur mot de passe du softphone. La gestion des comptes de connexion à la console reste réservée à l'installateur.</p>
  </div>`;
  document.body.append(box);
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  box.querySelector(".rm-scrim").onclick = close;
  box.querySelector(".rm-x").onclick = close;
  document.addEventListener("keydown", onKey);
}
