/** Connexion PostgreSQL (base « asterisk ») et tables propres à la console. */
import pg from "pg";

export function createDb(cfg) {
  const pool = new pg.Pool({ ...cfg, max: 5, idleTimeoutMillis: 30_000 });

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pbxmaison_users (
        email text PRIMARY KEY,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS pbxmaison_settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS pbxmaison_trunks (
        id text PRIMARY KEY,
        template text NOT NULL,
        label text,
        host text NOT NULL,
        number text NOT NULL,
        outbound_cid text NOT NULL,
        dial_format text NOT NULL DEFAULT 'national',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE pbxmaison_trunks ADD COLUMN IF NOT EXISTS cid_format text NOT NULL DEFAULT 'national';
      ALTER TABLE pbxmaison_trunks ADD COLUMN IF NOT EXISTS caller_format text NOT NULL DEFAULT 'national';
      ALTER TABLE pbxmaison_trunks ADD COLUMN IF NOT EXISTS did_from text NOT NULL DEFAULT 'request_uri';
      ALTER TABLE pbxmaison_trunks ADD COLUMN IF NOT EXISTS username text;
      CREATE TABLE IF NOT EXISTS pbxmaison_extensions (
        id text PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS first_name text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS last_name text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS mobile text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS outbound_cid text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS dids text[] NOT NULL DEFAULT '{}';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'available';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS forwarding jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS voicemail jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS phone jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_extensions ADD COLUMN IF NOT EXISTS web_password_hash text NOT NULL DEFAULT '';
      ALTER TABLE pbxmaison_trunks ADD COLUMN IF NOT EXISTS dids text[] NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS pbxmaison_app_tokens (
        token_hash text PRIMARY KEY,
        extension text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text NOT NULL DEFAULT '',
        used_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS pbxmaison_devices (
        endpoint text PRIMARY KEY,
        online boolean NOT NULL DEFAULT false,
        since timestamptz NOT NULL DEFAULT now(),
        last_seen timestamptz,
        user_agent text NOT NULL DEFAULT '',
        source_ip text NOT NULL DEFAULT '',
        local_ip text NOT NULL DEFAULT ''
      );
    `);
  }

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await fn(client);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function getSetting(key, fallback = null) {
    const r = await pool.query("SELECT value FROM pbxmaison_settings WHERE key = $1", [key]);
    return r.rows[0]?.value ?? fallback;
  }
  async function setSetting(key, value) {
    await pool.query(
      `INSERT INTO pbxmaison_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  return { pool, query: (...a) => pool.query(...a), migrate, tx, getSetting, setSetting, end: () => pool.end() };
}
