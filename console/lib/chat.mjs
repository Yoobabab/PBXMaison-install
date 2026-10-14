/**
 * Chat entre collègues (softphone web) : conversations à deux ou en groupe, messages, lus / non lus,
 * et diffusion en temps réel (Server-Sent Events) aux membres connectés.
 */
import { UserError } from "./users.mjs";

export async function migrateChat(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pbxmaison_chat_conv (
      id bigserial PRIMARY KEY, kind text NOT NULL DEFAULT 'direct', name text NOT NULL DEFAULT '',
      members text[] NOT NULL, created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS pbxmaison_chat_conv_members ON pbxmaison_chat_conv USING gin (members);
    CREATE TABLE IF NOT EXISTS pbxmaison_chat_msg (
      id bigserial PRIMARY KEY, conv_id bigint NOT NULL REFERENCES pbxmaison_chat_conv(id) ON DELETE CASCADE,
      sender text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS pbxmaison_chat_msg_conv ON pbxmaison_chat_msg (conv_id, id);
    CREATE TABLE IF NOT EXISTS pbxmaison_chat_read (
      conv_id bigint NOT NULL REFERENCES pbxmaison_chat_conv(id) ON DELETE CASCADE, ext text NOT NULL, last_read bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (conv_id, ext)
    );`);
}

export function createChat(db, { users }) {
  // ------------------------------------------------------------ Temps réel (SSE)
  const streams = new Map(); // poste → Set(réponses)
  function subscribe(ext, res) {
    if (!streams.has(ext)) streams.set(ext, new Set());
    streams.get(ext).add(res);
    return () => { streams.get(ext)?.delete(res); if (!streams.get(ext)?.size) streams.delete(ext); };
  }
  function push(exts, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const e of exts) for (const res of streams.get(e) || []) { try { res.write(payload); } catch { /* fermé */ } }
  }
  const online = () => new Set(streams.keys());

  // ------------------------------------------------------------ Conversations
  async function conv(id, ext) {
    const r = await db.query("SELECT * FROM pbxmaison_chat_conv WHERE id = $1", [id]);
    if (!r.rowCount || !r.rows[0].members.includes(ext)) throw Object.assign(new UserError("Conversation introuvable."), { status: 404 });
    return r.rows[0];
  }
  async function list(ext) {
    const r = await db.query(`
      SELECT c.id::text, c.kind, c.name, c.members, c.updated_at,
        (SELECT json_build_object('id', m.id::text, 'sender', m.sender, 'body', left(m.body, 200), 'at', m.created_at)
           FROM pbxmaison_chat_msg m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS last,
        (SELECT count(*) FROM pbxmaison_chat_msg m WHERE m.conv_id = c.id AND m.sender <> $1
           AND m.id > COALESCE((SELECT last_read FROM pbxmaison_chat_read r WHERE r.conv_id = c.id AND r.ext = $1), 0))::int AS unread
      FROM pbxmaison_chat_conv c WHERE $1 = ANY(c.members) ORDER BY c.updated_at DESC LIMIT 200`, [ext]);
    return r.rows;
  }
  async function open(ext, members, name = "") {
    const known = new Set((await users()).map((u) => u.id));
    const others = [...new Set((Array.isArray(members) ? members : [members]).map(String))].filter((x) => x !== ext);
    if (!others.length) throw new UserError("Choisis au moins un collègue.", "members");
    for (const x of others) if (!known.has(x)) throw new UserError(`Collègue inconnu : ${x}.`, "members");
    if (others.length === 1) {
      const pair = [ext, others[0]].sort();
      const r = await db.query("SELECT id::text FROM pbxmaison_chat_conv WHERE kind = 'direct' AND members @> $1 AND members <@ $1", [pair]);
      if (r.rowCount) return { id: r.rows[0].id, existing: true };
      const c = await db.query("INSERT INTO pbxmaison_chat_conv (kind, members, created_by) VALUES ('direct', $1, $2) RETURNING id::text", [pair, ext]);
      return { id: c.rows[0].id };
    }
    const clean = String(name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 60);
    const c = await db.query("INSERT INTO pbxmaison_chat_conv (kind, name, members, created_by) VALUES ('group', $1, $2, $3) RETURNING id::text",
      [clean, [ext, ...others].sort(), ext]);
    return { id: c.rows[0].id };
  }
  async function messages(ext, id, before = null, limit = 60) {
    await conv(id, ext);
    const r = await db.query(`SELECT id::text, sender, body, created_at AS at FROM pbxmaison_chat_msg WHERE conv_id = $1 ${before ? "AND id < $3" : ""}
      ORDER BY id DESC LIMIT $2`, before ? [id, Math.min(limit, 200), before] : [id, Math.min(limit, 200)]);
    const reads = await db.query("SELECT ext, last_read::text FROM pbxmaison_chat_read WHERE conv_id = $1", [id]);
    return { messages: r.rows.reverse(), reads: Object.fromEntries(reads.rows.map((x) => [x.ext, x.last_read])) };
  }
  async function send(ext, id, body) {
    const c = await conv(id, ext);
    const text = String(body || "").replace(/\r/g, "").trim();
    if (!text) throw new UserError("Message vide.", "body");
    if (text.length > 4000) throw new UserError("Message trop long (4000 caractères maximum).", "body");
    const r = await db.query("INSERT INTO pbxmaison_chat_msg (conv_id, sender, body) VALUES ($1, $2, $3) RETURNING id::text, sender, body, created_at AS at", [id, ext, text]);
    await db.query("UPDATE pbxmaison_chat_conv SET updated_at = now() WHERE id = $1", [id]);
    await markRead(ext, id, r.rows[0].id, false);
    const msg = { conv: String(id), ...r.rows[0] };
    push(c.members, "message", msg);
    return msg;
  }
  async function markRead(ext, id, lastId, notify = true) {
    const c = await conv(id, ext);
    await db.query(`INSERT INTO pbxmaison_chat_read (conv_id, ext, last_read) VALUES ($1, $2, $3)
      ON CONFLICT (conv_id, ext) DO UPDATE SET last_read = GREATEST(pbxmaison_chat_read.last_read, EXCLUDED.last_read)`, [id, ext, Number(lastId) || 0]);
    if (notify) push(c.members, "read", { conv: String(id), ext, last_read: String(lastId) });
    return { ok: true };
  }
  async function rename(ext, id, name) {
    const c = await conv(id, ext);
    if (c.kind !== "group") throw new UserError("Seules les discussions de groupe ont un nom.");
    const clean = String(name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 60);
    await db.query("UPDATE pbxmaison_chat_conv SET name = $2 WHERE id = $1", [id, clean]);
    push(c.members, "conv", { conv: String(id) });
    return { ok: true };
  }
  async function leave(ext, id) {
    const c = await conv(id, ext);
    if (c.kind !== "group") throw new UserError("On ne quitte pas une discussion à deux.");
    await db.query("UPDATE pbxmaison_chat_conv SET members = array_remove(members, $2) WHERE id = $1", [id, ext]);
    push(c.members, "conv", { conv: String(id) });
    return { ok: true };
  }
  return { subscribe, push, online, list, open, messages, send, markRead, rename, leave };
}
