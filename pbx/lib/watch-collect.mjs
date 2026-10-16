#!/usr/bin/env node
/**
 * Surveillance du serveur multi-tenant (console du serveur) : lit le journal de surveillance de chaque PBX client
 * (appels vers l'étranger / surtaxés, changements d'adresse IP des appareils) ou marque un événement comme vérifié.
 * Lancé par callikoe-host (root) :
 *   node watch-collect.mjs <tenants.json> liste <jours>
 *   node watch-collect.mjs <tenants.json> ok <pbx> <id> <compte>
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const [reg, cmd, ...args] = process.argv.slice(2);
const tenants = (() => { try { return JSON.parse(fs.readFileSync(reg, "utf8")).tenants || []; } catch { return []; } })();
const dbOf = (slug) => `cx_${slug.replace(/-/g, "_")}`;
const psql = (db, sql, vars = {}) => execFileSync("runuser", ["-u", "postgres", "--", "psql", "-d", db, "-At", "-v", "ON_ERROR_STOP=1",
  ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim();

if (cmd === "liste") {
  const days = Math.min(90, Math.max(1, Number(args[0]) || 30));
  const events = [];
  for (const t of tenants) {
    try {
      const out = psql(dbOf(t.slug), `SELECT coalesce(json_agg(x), '[]') FROM (SELECT id, at, kind, category, extension, text, reviewed_at, reviewed_by
        FROM pbxmaison_watch WHERE at > now() - make_interval(days => ${days}) ORDER BY at DESC LIMIT 2000) x`);
      for (const e of JSON.parse(out || "[]")) events.push({ ...e, pbx: t.slug, pbx_name: t.name || t.slug });
    } catch { /* PBX sans journal (pas encore mis à jour) ou arrêté */ }
  }
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  process.stdout.write(JSON.stringify({ days, events: events.slice(0, 5000) }) + "\n");
} else if (cmd === "ok") {
  const [slug, id, who] = args;
  if (!tenants.some((t) => t.slug === slug) || !/^\d+$/.test(String(id)) || !/^[^\s'"\;]{3,120}$/.test(String(who))) { console.error("Paramètres invalides."); process.exit(1); }
  const n = psql(dbOf(slug), `UPDATE pbxmaison_watch SET reviewed_at = now(), reviewed_by = '${who}' WHERE id = ${Number(id)} AND reviewed_at IS NULL RETURNING id`);
  process.stdout.write(JSON.stringify({ ok: true, updated: !!n }) + "\n");
} else { console.error("Usage : watch-collect.mjs <tenants.json> liste <jours> | ok <pbx> <id> <compte>"); process.exit(2); }
