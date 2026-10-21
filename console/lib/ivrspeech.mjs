/**
 * SVI qui comprend la parole : ce que l'appelant a dit → touche du menu.
 * D'abord une correspondance simple (chiffre dit, nom d'un service, mot-clé), sinon l'IA choisit.
 * Fonctions pures, testées dans console/test/ivrspeech.test.mjs.
 */
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const NUMS = { zero: "0", un: "1", une: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six: "6", sept: "7", huit: "8", neuf: "9", etoile: "*", diese: "#" };

/** Libellé de chaque touche : destination (nom du groupe, de la personne…) + mots-clés donnés par l'installateur */
export function ivrOptions(ivr, { objects = [], users = new Map() } = {}) {
  return Object.entries(ivr.options || {}).map(([key, d]) => {
    let label = "";
    if (d.type === "user" || d.type === "user_vm") { const u = users.get(d.target); label = u ? `${u.first_name || ""} ${u.last_name || ""}`.trim() || `poste ${d.target}` : `poste ${d.target}`; }
    else if (d.type === "external") label = "numéro extérieur";
    else if (d.type === "hangup") label = "fin d'appel";
    else label = objects.find((o) => o.kind === d.type && o.id === d.target)?.name || "";
    return { key, label, keywords: ivr.keywords?.[key] || "" };
  });
}

/** Correspondance sans IA : « le deux », « tapez 3 », « la compta » quand un mot-clé ou le nom du service est dit */
export function localMatch(said, options) {
  const t = ` ${norm(said)} `;
  if (!t.trim()) return "";
  const words = t.trim().split(" ");
  // Un seul chiffre dit (« le deux », « 2 », « touche 2 ») et c'est une touche du menu
  const digits = [...new Set(words.map((w) => NUMS[w] || (/^[0-9]$/.test(w) ? w : "")).filter(Boolean))];
  if (digits.length === 1 && words.length <= 4 && options.some((o) => o.key === digits[0])) return digits[0];
  const hits = options.filter((o) => [o.label, ...o.keywords.split(/[,;/]+/)].map(norm).filter((k) => k.length >= 3).some((k) => t.includes(` ${k} `) || t.includes(` ${k}s `)));
  return hits.length === 1 ? hits[0].key : "";
}
