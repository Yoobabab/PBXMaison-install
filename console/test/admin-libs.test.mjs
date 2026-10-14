import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateShortcodes, buildShortcodesDialplan, defaultShortcodes } from "../lib/shortcodes.mjs";
import { validateGateway, buildGrandstreamXml, buildYealinkDectCfg, provRequest, buildFanvilCfg, buildSnomXml } from "../lib/devices.mjs";
import { detectAlerts, validateAlerts } from "../lib/alerts.mjs";
import { validateBackup, backupDue, remoteUrl } from "../lib/backup.mjs";
import { validateRecording, recordingGlobals, recordingPath, purgeRecordings } from "../lib/recording.mjs";

test("codes raccourcis", () => {
  const c = validateShortcodes({ park: "*7" });
  assert.equal(c.park, "*7");
  assert.throws(() => validateShortcodes({ park: "*97" }), /deux fois/);
  assert.throws(() => validateShortcodes({ echo: "*12" }), /commence comme/);
  assert.throws(() => validateShortcodes({ echo: "*5" }), /commence comme|deux fois/);
  assert.throws(() => validateShortcodes({ park: "12" }), /commence par/);
  const d = buildShortcodesDialplan(defaultShortcodes());
  assert.match(d, /exten => _\*1\[1-9\],1,ParkedCall\(default,70\$\{EXTEN:2\}\)/);
  assert.match(d, /exten => _\*\*XXX,1,Pickup\(\$\{EXTEN:2\}@PICKUPMARK\)/);
  assert.match(d, /exten => \*31,1,Answer\(\)\n same => n,Set\(DB\(callikoe_status\/\$\{CUT/);
  assert.match(d, /PauseQueueMember\(,Local\/\$\{CUT\(CUT\(CHANNEL\(name\),\/,2\),-,1\)\}@queue-ring\/n\)/);
});

test("passerelles et DECT", () => {
  const ctx = { users: new Set(["201", "202"]), macOwners: new Map(), usedPorts: new Map([["202", "« Base 1 »"]]) };
  const g = validateGateway({ model: "gs-ht802", mac: "00:0B:82:12:34:56", ports: [{ port: 2, user: "201" }] }, ctx);
  assert.equal(g.mac, "000b82123456");
  assert.throws(() => validateGateway({ model: "gs-ht802", ports: [{ port: 3, user: "201" }] }, ctx), /n'existe pas/);
  assert.throws(() => validateGateway({ model: "gs-ht802", ports: [{ port: 1, user: "202" }] }, ctx), /déjà attribué/);
  const acc = [{ index: 1, user: "201", name: "Alice", auth_id: "abc", password: "p<w" }, { index: 2, user: "203", name: "Bob", auth_id: "def", password: "x" }];
  const x = buildGrandstreamXml("000b82123456", acc, { host: "pbx.example.fr", prov_url: "https://pbx.example.fr/prov/t/" });
  assert.match(x, /<P47>pbx.example.fr<\/P47>/); assert.match(x, /<P734>x<\/P734>/); assert.match(x, /<P34>p&lt;w<\/P34>/);
  assert.match(buildYealinkDectCfg(acc, { host: "h", prov_url: "u" }), /account\.2\.user_name = 203/);
  assert.match(buildFanvilCfg(acc, { host: "h", prov_url: "u" }), /SIP2 Register User      :def/);
  assert.match(buildSnomXml(acc, { host: "h", prov_url: "u/" }), /<user_name idx="1" perm="">201<\/user_name>/);
  assert.deepEqual(provRequest("cfg000B82123456.xml"), { kind: "gs", mac: "000b82123456" });
  assert.deepEqual(provRequest("000413aabbcc.xml"), { kind: "snom", mac: "000413aabbcc" });
  assert.deepEqual(provRequest("805ec0aabbcc.cfg"), { kind: "cfg", mac: "805ec0aabbcc" });
});

test("alertes", () => {
  assert.throws(() => validateAlerts({ recipients: "pas-un-mail" }), /invalide/);
  const t0 = 1_000_000;
  let r = detectAlerts({ trunks: [{ id: "op", registered: false }], banned: ["1.2.3.4"] }, {}, t0);
  assert.equal(r.alerts.length, 0);
  r = detectAlerts({ trunks: [{ id: "op", registered: false }], banned: ["1.2.3.4", "5.6.7.8"] }, { banned: ["1.2.3.4"], since: r.since }, t0 + 130_000);
  assert.deepEqual(r.alerts.map((a) => a.event).sort(), ["ip_banned", "trunk_down"]);
  r = detectAlerts({ trunks: [{ id: "op", registered: false }] }, { since: r.since }, t0 + 300_000);
  assert.equal(r.alerts.length, 0); // déjà signalé
  r = detectAlerts({ emergencies: [{ dst: "112", src: "201", at: "x" }], disk: { pct: 95 }, disk_threshold: 90 }, {}, t0);
  assert.deepEqual(r.alerts.map((a) => a.event).sort(), ["disk_full", "emergency"]);
});

test("sauvegardes", () => {
  const b = validateBackup({ hour: 2, remote: { enabled: true, protocol: "ftp", host: "nas.local", port: 21, user: "u", password: "p", path: "callikoe" } });
  assert.equal(remoteUrl(b.remote, "x.tar.gz"), "ftp://nas.local:21/callikoe/x.tar.gz");
  assert.throws(() => validateBackup({ remote: { enabled: true, host: "" } }), /serveur/);
  assert.throws(() => validateBackup({ remote: { path: "../etc" } }), /invalide/);
  assert.equal(backupDue(b, null, new Date(2026, 9, 15, 2, 5)), true);
  assert.equal(backupDue(b, new Date(2026, 9, 15, 2, 1).toISOString(), new Date(2026, 9, 15, 2, 5)), false);
  assert.equal(backupDue({ ...b, schedule: "weekly" }, null, new Date(2026, 9, 15, 2, 5)), false); // jeudi
});

test("enregistrements", () => {
  const r = validateRecording({ out: false, retention_days: 30 });
  assert.deepEqual(recordingGlobals(r), ["REC_ENABLED = 1", "REC_DIRS = in", "REC_ANNOUNCE = "]);
  assert.equal(recordingPath("../../etc/passwd"), null);
  assert.ok(recordingPath("2026/10/15/101500-in-1697.12.wav", "/r").endsWith("/r/2026/10/15/101500-in-1697.12.wav"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  for (const d of ["2026/01/02", "2026/10/14"]) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, "a.wav"), "x"); }
  assert.equal(purgeRecordings(30, dir, new Date("2026-10-15T00:00:00Z")), 1);
  assert.ok(fs.existsSync(path.join(dir, "2026/10/14/a.wav")));
});
