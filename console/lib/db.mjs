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
      ALTER TABLE pbxmaison_users ADD COLUMN IF NOT EXISTS totp_secret text;
      ALTER TABLE pbxmaison_users ADD COLUMN IF NOT EXISTS totp_last_step bigint NOT NULL DEFAULT 0;
      ALTER TABLE pbxmaison_users ADD COLUMN IF NOT EXISTS recovery jsonb NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS pbxmaison_audit (
        id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), email text NOT NULL DEFAULT '', ip text NOT NULL DEFAULT '',
        action text NOT NULL, ok boolean NOT NULL DEFAULT true, detail text NOT NULL DEFAULT ''
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
      CREATE TABLE IF NOT EXISTS pbxmaison_objects (
        kind text NOT NULL,
        id text NOT NULL,
        number text,
        name text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text NOT NULL DEFAULT '',
        PRIMARY KEY (kind, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pbxmaison_objects_number ON pbxmaison_objects (number) WHERE number IS NOT NULL;
      CREATE TABLE IF NOT EXISTS cdr (
        id bigserial PRIMARY KEY,
        calldate timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
        answerdate timestamp, enddate timestamp,
        clid varchar(160) NOT NULL DEFAULT '', src varchar(80) NOT NULL DEFAULT '', dst varchar(80) NOT NULL DEFAULT '',
        dcontext varchar(80) NOT NULL DEFAULT '', channel varchar(160) NOT NULL DEFAULT '', dstchannel varchar(160) NOT NULL DEFAULT '',
        lastapp varchar(80) NOT NULL DEFAULT '', lastdata varchar(255) NOT NULL DEFAULT '',
        duration integer NOT NULL DEFAULT 0, billsec integer NOT NULL DEFAULT 0, disposition varchar(45) NOT NULL DEFAULT '',
        amaflags integer NOT NULL DEFAULT 0, accountcode varchar(40) NOT NULL DEFAULT '', uniqueid varchar(150) NOT NULL DEFAULT '',
        userfield varchar(255) NOT NULL DEFAULT '', linkedid varchar(150) NOT NULL DEFAULT '', peeraccount varchar(40) NOT NULL DEFAULT '',
        sequence integer NOT NULL DEFAULT 0,
        did varchar(40) NOT NULL DEFAULT '', direction varchar(12) NOT NULL DEFAULT '', dest_kind varchar(20) NOT NULL DEFAULT '', rule varchar(80) NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS cdr_calldate ON cdr (calldate);
      CREATE INDEX IF NOT EXISTS cdr_linkedid ON cdr (linkedid);
      CREATE TABLE IF NOT EXISTS pbxmaison_contacts (
        id bigserial PRIMARY KEY,
        first_name text NOT NULL DEFAULT '', last_name text NOT NULL DEFAULT '', company text NOT NULL DEFAULT '',
        email text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', phones jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL DEFAULT ''
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
