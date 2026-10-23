import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addServerMusic, listServerMusic, removeServerMusic, renameServerMusic, serverMusicFile, checkMusicWav } from "../lib/music.mjs";
import { createAi } from "../lib/ai.mjs";

const wav = (secs, rate = 8000) => { const n = secs * rate, b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b; };

test("fonds musicaux du serveur multi-tenant : ajout vérifié, liste, renommage, retrait ; proposés aux PBX avec ceux du portail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxmusic-"));
  assert.throws(() => checkMusicWav(wav(10, 44100)), /8 kHz/);
  assert.throws(() => addServerMusic("Court", wav(2), dir), /5 et 90/);
  const a = addServerMusic("Jazz du magasin", wav(10), dir), b = addServerMusic("Jazz du magasin", wav(6), dir);
  assert.equal(a.id, "srv-jazz-du-magasin"); assert.equal(b.id, "srv-jazz-du-magasin-2");
  assert.deepEqual(listServerMusic(dir).map((m) => m.name), ["Jazz du magasin", "Jazz du magasin"]);
  assert.equal(renameServerMusic(b.id, "Piano", dir).name, "Piano");
  assert.equal(serverMusicFile("../../etc/passwd", dir), null);
  // côté PBX : portail (fourni d'office) + serveur ; la musique du serveur est lue sur place
  const db = { getSetting: async (k, d) => (k === "ai" ? { enabled: true } : k === "ai_token" ? "AI1.x.y" : d), setSetting: async () => {} };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith("/v1/ai/music") ? { music: [{ id: "silk-phello", name: "Silk — Phello", seconds: 60 }] } : {}) });
  const ai = createAi({ db, etcDir: dir, env: { CX_MUSIC_DIR: dir, PBXM_AI_URL: "http://relais" }, fetchImpl });
  assert.deepEqual((await ai.musics()).map((m) => m.id), ["silk-phello", "srv-jazz-du-magasin", "srv-jazz-du-magasin-2"]);
  assert.equal((await ai.music("srv-jazz-du-magasin")).length, 44 + 10 * 16000);
  removeServerMusic(a.id, dir);
  assert.equal(serverMusicFile(a.id, dir), null);
  await assert.rejects(ai.music(a.id), /inconnu/);
  // portail injoignable : on garde au moins celles du serveur
  const ai2 = createAi({ db, etcDir: dir, env: { CX_MUSIC_DIR: dir, PBXM_AI_URL: "http://relais" }, fetchImpl: async () => { throw new Error("hors ligne"); } });
  assert.deepEqual((await ai2.musics()).map((m) => m.name), ["Piano"]);
});
