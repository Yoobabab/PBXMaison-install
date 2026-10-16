/**
 * Surveillance (console du serveur › Surveillance) : appels vers l'étranger ou surtaxés,
 * changements d'adresse IP des téléphones, softphones et applis. Fonctions pures, testées.
 */

/** Numéro composé → "intl" (étranger), "premium" (surtaxé) ou null. cc = indicatif du PBX (33 = France). */
export function numberRisk(raw, cc = "33") {
  let n = String(raw || "").replace(/[\s.()-]/g, "");
  if (!n || !/^\+?\d{3,}$/.test(n)) return null;
  if (n.startsWith("+")) n = `00${n.slice(1)}`;
  if (n.startsWith("00")) {
    if (n.startsWith(`00${cc}`)) n = `0${n.slice(2 + cc.length)}`;
    else return "intl";
  }
  if (cc === "33") {
    if (/^08[129]\d{7}$/.test(n)) return "premium";   // 081x / 082x (coût partagé), 089x (surtaxé)
    if (/^118\d{3}$/.test(n)) return "premium";       // renseignements
    if (/^3\d{3}$/.test(n)) return "premium";         // numéros courts de services (3xxx)
  }
  return null;
}

/** Type d'appareil pour la surveillance : "phone" | "softphone" | "app". */
export function deviceCategory(kind) {
  if (kind === "phone") return "phone";
  if (kind === "mobile") return "app";
  return "softphone";
}
export const CATEGORY_LABELS = { phone: "Téléphone", softphone: "Softphone", app: "Appli mobile" };
