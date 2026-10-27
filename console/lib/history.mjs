/**
 * Historique du standard (« machine à remonter le temps ») : après chaque modification de la configuration des appels,
 * une photo du routage est gardée (objets de Gestion d'appels, règles sortantes, standardiste IA, codes, standard, SDA des
 * utilisateurs). On peut revenir à une photo en un clic ; la version du moment est d'abord gardée, donc tout se défait.
 * Ce qui change tous les jours (statuts, renvois des utilisateurs, ouvert/fermé du standard) n'en fait pas partie.
 * Fonctions pures (photo comparée, résumé des changements) testées dans console/test/history.test.mjs.
 */
import crypto from "node:crypto";

export const HISTORY_KEEP = 300;          // versions gardées au plus
export const HISTORY_DAYS = 180;          // et pas plus vieilles que
export const HISTORY_MERGE_S = 120;       // deux changements de la même personne à moins de 2 min = une seule version
export const SNAPSHOT_SETTINGS = ["routes", "outbound_rules", "receptionist", "shortcodes"];

const KIND_LABEL = { flow: "Routage", rule: "Règle entrante", schedule: "Horaires", group: "Groupe", queue: "File d'attente", ivr: "SVI", prompt: "Annonce", groupvm: "Messagerie de groupe", planning: "Planning" };
const SETTING_ENDING = { routes: "modifiés", outbound_rules: "modifiées", receptionist: "modifiée", shortcodes: "modifiés" };
const FEMININE = new Set(["rule", "queue", "prompt", "groupvm"]);
const SETTING_LABEL = { routes: "Lignes et trunk sortant", outbound_rules: "Règles sortantes", receptionist: "Standardiste IA", shortcodes: "Codes de raccourci", standard: "Standard (destination quand c'est fermé)" };

/** Ordre stable des clés : deux photos identiques donnent la même empreinte */
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
export const hashOf = (snap) => crypto.createHash("sha256").update(JSON.stringify(stable(snap))).digest("hex").slice(0, 16);

/** Photo à partir de l'état de la base (sans dates ni auteurs, qui changent sans changer le routage) */
export function buildSnapshot({ objects, settings, standard, users }) {
  return {
    objects: objects.map((o) => ({ kind: o.kind, id: o.id, number: o.number ?? null, name: o.name, data: o.data }))
      .sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`)),
    settings: Object.fromEntries(SNAPSHOT_SETTINGS.filter((k) => settings[k] !== undefined && settings[k] !== null).map((k) => [k, settings[k]])),
    standard: { closed_dest: standard?.closed_dest ?? null, skip_dids: standard?.skip_dids ?? [] },
    users: Object.fromEntries(users.map((u) => [u.id, { name: u.name, dids: [...(u.dids || [])].sort() }]).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

/** Ce qui a changé entre deux photos, en phrases courtes (« Groupe « Accueil » modifié ») */
export function describeChanges(before, after) {
  if (!before) return ["Première version gardée"];
  const out = [];
  const key = (o) => `${o.kind}/${o.id}`;
  const b = new Map(before.objects.map((o) => [key(o), o])), a = new Map(after.objects.map((o) => [key(o), o]));
  const said = (o, verb) => `${KIND_LABEL[o.kind] || o.kind} « ${o.name} » ${verb}${FEMININE.has(o.kind) ? "e" : ""}${o.kind === "schedule" ? "s" : ""}`;
  for (const [k, o] of a) {
    if (!b.has(k)) out.push(said(o, "ajouté"));
    else if (hashOf(b.get(k)) !== hashOf(o)) out.push(said(o, "modifié"));
  }
  for (const [k, o] of b) if (!a.has(k)) out.push(said(o, "supprimé"));
  for (const s of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    if (hashOf(before.settings[s] ?? null) !== hashOf(after.settings[s] ?? null)) out.push(`${SETTING_LABEL[s] || s} ${SETTING_ENDING[s] || "modifié"}`);
  }
  if (hashOf(before.standard) !== hashOf(after.standard)) out.push(SETTING_LABEL.standard + " modifié");
  for (const [id, u] of Object.entries(after.users)) {
    const old = before.users[id];
    if (old && hashOf(old.dids) !== hashOf(u.dids)) out.push(`SDA de ${u.name || id} (${id}) modifiées`);
  }
  return out.length ? out : ["Réglages du routage modifiés"];
}

export function createHistory({ db, pbx }) {
  async function migrate() {
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_history (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), by_who text NOT NULL DEFAULT '',
      hash text NOT NULL, changes jsonb NOT NULL DEFAULT '[]', snap jsonb NOT NULL, note text NOT NULL DEFAULT '')`);
  }
  async function current() {
    const [objects, users, standard] = await Promise.all([pbx.loadObjects(), pbx.loadUsers(), db.getSetting("standard", null)]);
    const settings = {};
    for (const k of SNAPSHOT_SETTINGS) settings[k] = await db.getSetting(k, null);
    return buildSnapshot({ objects, settings, standard, users });
  }
  /** Qui vient de modifier : la dernière action du journal d'audit (moins d'une minute) */
  async function lastActor() {
    const r = await db.query("SELECT email FROM pbxmaison_audit WHERE at > now() - interval '1 minute' AND ok ORDER BY id DESC LIMIT 1").catch(() => ({ rows: [] }));
    if (r.rows[0]?.email) return r.rows[0].email;
    // Sinon (Superviseur dans le softphone…) : l'auteur du dernier objet modifié
    const o = await db.query("SELECT updated_by FROM pbxmaison_objects WHERE updated_at > now() - interval '1 minute' ORDER BY updated_at DESC LIMIT 1").catch(() => ({ rows: [] }));
    return o.rows[0]?.updated_by || "";
  }
  let chain = Promise.resolve(), restoring = false;
  /** Appelée après chaque mise à jour du plan de numérotation : garde une version si le routage a changé */
  function record({ by = null, note = "" } = {}) {
    if (restoring) return chain;
    chain = chain.then(() => recordNow(by, note)).catch((e) => console.error("Historique :", e.message));
    return chain;
  }
  async function recordNow(by, note) {
    const snap = await current();
    const hash = hashOf(snap);
    const last = (await db.query("SELECT id, at, by_who, hash, snap FROM pbxmaison_history ORDER BY id DESC LIMIT 1")).rows[0];
    if (last?.hash === hash) return null;
    const who = by ?? await lastActor();
    const prev = last ? (await db.query("SELECT snap FROM pbxmaison_history WHERE id < $1 ORDER BY id DESC LIMIT 1", [last.id])).rows[0] : null;
    // Plusieurs petits changements d'affilée par la même personne : une seule version (sauf un retour en arrière)
    if (last && !note && last.by_who === who && Date.now() - new Date(last.at).getTime() < HISTORY_MERGE_S * 1000
      && !(await db.query("SELECT note FROM pbxmaison_history WHERE id = $1", [last.id])).rows[0]?.note) {
      await db.query("UPDATE pbxmaison_history SET at = now(), hash = $2, snap = $3, changes = $4 WHERE id = $1",
        [last.id, hash, JSON.stringify(snap), JSON.stringify(describeChanges(prev?.snap || null, snap))]);
      return last.id;
    }
    const r = await db.query("INSERT INTO pbxmaison_history (by_who, hash, changes, snap, note) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [who, hash, JSON.stringify(describeChanges(last?.snap || null, snap)), JSON.stringify(snap), note]);
    await db.query(`DELETE FROM pbxmaison_history WHERE id NOT IN (SELECT id FROM pbxmaison_history ORDER BY id DESC LIMIT ${HISTORY_KEEP})
      OR (at < now() - interval '${HISTORY_DAYS} days' AND id <> (SELECT max(id) FROM pbxmaison_history))`);
    return r.rows[0].id;
  }
  async function list() {
    await chain;
    const r = await db.query("SELECT id, at, by_who, changes, note FROM pbxmaison_history ORDER BY id DESC LIMIT $1", [HISTORY_KEEP]);
    return { versions: r.rows.map((x, i) => ({ id: Number(x.id), at: x.at, by: x.by_who, changes: x.changes, note: x.note, current: i === 0 })) };
  }
  /** Revenir à une version : le routage du moment est d'abord gardé, puis remplacé par la photo */
  async function restore(id, by = "") {
    await chain;
    const row = (await db.query("SELECT id, at, snap FROM pbxmaison_history WHERE id = $1", [Number(id)])).rows[0];
    if (!row) throw Object.assign(new Error("Version introuvable (trop ancienne ?)."), { status: 404 });
    await recordNow(by, "");
    const snap = row.snap, notes = [];
    restoring = true;
    try {
    const prompts = new Set((await pbx.loadObjects()).filter((o) => o.kind === "prompt").map((o) => o.id));
    const users = new Set((await pbx.loadUsers()).map((u) => u.id));
    await db.tx(async (c) => {
      // Les annonces ne sont pas effacées (leur fichier son n'est pas dans la photo) ; une annonce supprimée depuis ne revient pas
      await c.query("DELETE FROM pbxmaison_objects WHERE kind <> 'prompt'");
      for (const o of snap.objects) {
        if (o.kind === "prompt") { if (!prompts.has(o.id)) notes.push(`Annonce « ${o.name} » supprimée depuis : à recréer.`); continue; }
        await c.query("INSERT INTO pbxmaison_objects (kind, id, number, name, data, updated_by) VALUES ($1, $2, $3, $4, $5, $6)",
          [o.kind, o.id, o.number, o.name, JSON.stringify(o.data), by]);
      }
      for (const [k, v] of Object.entries(snap.settings)) await c.query(`INSERT INTO pbxmaison_settings (key, value) VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [k, JSON.stringify(v)]);
      const std = (await c.query("SELECT value FROM pbxmaison_settings WHERE key = 'standard'")).rows[0]?.value;
      if (std && snap.standard?.closed_dest) await c.query("UPDATE pbxmaison_settings SET value = $1, updated_at = now() WHERE key = 'standard'",
        [JSON.stringify({ ...std, closed_dest: snap.standard.closed_dest, skip_dids: snap.standard.skip_dids || [] })]);
      // SDA : retirées partout puis remises, pour ne jamais avoir la même SDA sur deux postes
      await c.query("UPDATE pbxmaison_extensions SET dids = '{}' WHERE id = ANY($1)", [Object.keys(snap.users).filter((u) => users.has(u))]);
      for (const [uid, u] of Object.entries(snap.users)) {
        if (!users.has(uid)) { if (u.dids.length) notes.push(`Utilisateur ${u.name || uid} (${uid}) supprimé depuis : ses SDA ne sont plus attribuées.`); continue; }
        await c.query("UPDATE pbxmaison_extensions SET dids = $2 WHERE id = $1", [uid, u.dids]);
      }
    });
    await pbx.applyDialplan();
    } finally { restoring = false; }
    const at = new Date(row.at).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });
    await recordNow(by, `Retour à la version du ${at}`);
    return { ok: true, notes };
  }
  async function snapshotOf(id) {
    const r = (await db.query("SELECT snap FROM pbxmaison_history WHERE id = $1", [Number(id)])).rows[0];
    if (!r) throw Object.assign(new Error("Version introuvable (trop ancienne ?)."), { status: 404 });
    return r.snap;
  }
  return { migrate, record, list, restore, current, snapshotOf };
}
