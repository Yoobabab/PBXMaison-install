/**
 * Absences programmées (« Julie est en congé du 3 au 14, ses appels vont à Marc ») : le renvoi immédiat de l'utilisateur
 * s'active tout seul le premier jour à minuit (heure du PBX) et se défait tout seul le lendemain du dernier jour.
 * Si l'utilisateur a changé son renvoi entre-temps, le sien est gardé à la fin (on ne lui reprend rien).
 * Fonctions pures testées dans console/test/absences.test.mjs.
 */
import { nationalNumber, UserError, displayName } from "./users.mjs";

export const ABS_TYPES = { voicemail: "Sa messagerie vocale", extension: "Un collègue", external: "Un numéro" };
export const ABS_MAX_DAYS = 366;

/** Date du jour (AAAA-MM-JJ) dans le fuseau du PBX */
export const localDate = (now = new Date(), tz = "Europe/Paris") => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/** Contrôle d'une absence saisie : { start, end, dest: { type, target }, note } */
export function validateAbsence(input, { selfId, users, today, cc = "33" }) {
  const start = String(input.start || ""), end = String(input.end || "");
  if (!isDate(start)) throw new UserError("Date de début invalide.", "start");
  if (!isDate(end)) throw new UserError("Date de fin invalide.", "end");
  if (end < start) throw new UserError("La fin est avant le début.", "end");
  if (end < today) throw new UserError("Cette absence est déjà terminée.", "end");
  if (days(start, end) >= ABS_MAX_DAYS) throw new UserError("Un an au maximum.", "end");
  const type = String(input.dest?.type || "");
  if (!ABS_TYPES[type]) throw new UserError("Choisis où vont les appels.", "dest");
  let target = "";
  if (type === "extension") {
    target = String(input.dest?.target || "").trim();
    if (!users.has(target)) throw new UserError("Choisis le collègue qui reçoit les appels.", "dest");
    if (target === selfId) throw new UserError("Un utilisateur ne peut pas se renvoyer vers lui-même.", "dest");
  } else if (type === "external") {
    const n = nationalNumber(input.dest?.target, cc);
    if (!n) throw new UserError("Numéro : numéro national (ex. 06 12 34 56 78).", "dest");
    if (/^08[9]/.test(n) || /^(15|17|18|112|114|115|119)$/.test(n)) throw new UserError("Numéro non autorisé.", "dest");
    target = n;
  }
  return { start, end, dest: { type, target }, note: String(input.note || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 80) };
}

/** Que faire aujourd'hui pour cette absence ? « start », « end » ou null */
export function absenceStep(a, today) {
  if (a.status === "planned" && a.start <= today && a.end >= today) return "start";
  if (a.status === "planned" && a.end < today) return "skip";            // jamais commencée (PBX éteint toute la période)
  if (a.status === "active" && a.end < today) return "end";
  return null;
}

/** Phrase lisible : « du lun. 3 nov. au ven. 14 nov. → Marc Dupont (202) » */
export function absenceLabel(a, names = new Map()) {
  const d = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const to = a.dest.type === "voicemail" ? "messagerie vocale" : a.dest.type === "extension" ? `${names.get(a.dest.target) || "poste"} (${a.dest.target})` : a.dest.target.replace(/(\d{2})(?=\d)/g, "$1 ");
  return `${a.start === a.end ? `le ${d(a.start)}` : `du ${d(a.start)} au ${d(a.end)}`} → ${to}`;
}

const sameDest = (x, y) => (x?.type || "none") === (y?.type || "none") && (x?.target || "") === (y?.target || "");

export function createAbsences({ db, pbx }) {
  async function migrate() {
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_absences (id bigserial PRIMARY KEY, ext text NOT NULL, start_day text NOT NULL, end_day text NOT NULL,
      dest jsonb NOT NULL, note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'planned', prev jsonb, error text NOT NULL DEFAULT '',
      created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`);
  }
  const today = () => localDate(new Date(), pbx.tz());
  const row = (r) => ({ id: Number(r.id), ext: r.ext, start: r.start_day, end: r.end_day, dest: r.dest, note: r.note, status: r.status, error: r.error, created_by: r.created_by });
  async function names() { return new Map((await pbx.loadUsers()).map((u) => [u.id, displayName(u)])); }
  /** Absences à venir ou en cours (d'un utilisateur, ou de tous) */
  async function list(ext = null) {
    const r = await db.query(`SELECT * FROM pbxmaison_absences WHERE status IN ('planned', 'active') ${ext ? "AND ext = $1" : ""} ORDER BY start_day, id`, ext ? [ext] : []);
    const n = await names();
    return { absences: r.rows.map(row).map((a) => ({ ...a, name: n.get(a.ext) || a.ext, label: absenceLabel(a, n) })), today: today() };
  }
  async function create(ext, input, by = "") {
    const users = await names();
    if (!users.has(ext)) throw Object.assign(new UserError("Utilisateur introuvable."), { status: 404 });
    const a = validateAbsence(input, { selfId: ext, users, today: today(), cc: pbx.countryCode() });
    const overlap = await db.query("SELECT 1 FROM pbxmaison_absences WHERE ext = $1 AND status IN ('planned', 'active') AND start_day <= $3 AND end_day >= $2", [ext, a.start, a.end]);
    if (overlap.rowCount) throw new UserError("Une autre absence est déjà prévue sur ces dates.", "start");
    await db.query("INSERT INTO pbxmaison_absences (ext, start_day, end_day, dest, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [ext, a.start, a.end, JSON.stringify(a.dest), a.note, by]);
    await tick();   // commence aujourd'hui : renvoi posé tout de suite
    return list(ext);
  }
  /** Supprimer : une absence en cours est arrêtée tout de suite (le renvoi d'avant revient) */
  async function remove(id, by = "") {
    const r = (await db.query("SELECT * FROM pbxmaison_absences WHERE id = $1", [Number(id)])).rows[0];
    if (!r) throw Object.assign(new UserError("Absence introuvable."), { status: 404 });
    if (r.status === "active") await finish(r, by);
    await db.query("UPDATE pbxmaison_absences SET status = 'cancelled' WHERE id = $1 AND status IN ('planned', 'active')", [r.id]);
    return list(r.ext);
  }
  async function finish(r, by) {
    const u = await pbx.getUser(r.ext).catch(() => null);
    // Renvoi changé par l'utilisateur pendant son absence : on garde le sien
    if (u && sameDest(u.forwarding.always, r.dest)) await pbx.updateUser(r.ext, { forwarding: { always: r.prev || { type: "none", target: "" } } }, by || "absence programmée (fin)");
  }
  /** Chaque minute : début et fin des absences */
  async function tick() {
    const t = today();
    const r = await db.query("SELECT * FROM pbxmaison_absences WHERE status IN ('planned', 'active') ORDER BY start_day");
    for (const x of r.rows) {
      const step = absenceStep(row(x), t);
      try {
        if (step === "start") {
          const u = await pbx.getUser(x.ext);
          await pbx.updateUser(x.ext, { forwarding: { always: x.dest } }, "absence programmée");
          await db.query("UPDATE pbxmaison_absences SET status = 'active', prev = $2, error = '' WHERE id = $1", [x.id, JSON.stringify(u.forwarding.always || { type: "none", target: "" })]);
        } else if (step === "end") {
          await finish(x, "");
          await db.query("UPDATE pbxmaison_absences SET status = 'done' WHERE id = $1", [x.id]);
        } else if (step === "skip") await db.query("UPDATE pbxmaison_absences SET status = 'done' WHERE id = $1", [x.id]);
      } catch (e) {
        // Destination devenue impossible (collègue supprimé…) : notée, on réessaie à la minute suivante
        await db.query("UPDATE pbxmaison_absences SET error = $2 WHERE id = $1", [x.id, String(e.message).slice(0, 200)]);
      }
    }
    await db.query("DELETE FROM pbxmaison_absences WHERE status IN ('done', 'cancelled') AND created_at < now() - interval '1 year'");
  }
  return { migrate, list, create, remove, tick };
}
