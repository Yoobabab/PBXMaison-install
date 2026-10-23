import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoicemailSummary, toPbxWav, diagnosisInput, createAi, mixMusic } from "../lib/ai.mjs";
import { voicemailMail } from "../lib/mail.mjs";

const wav = (rate, ch, n) => {
  const b = Buffer.alloc(44 + n * 2 * ch);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2 * ch, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * ch, 28); b.writeUInt16LE(2 * ch, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(0xffffffff, 40);
  for (let i = 0; i < n * ch; i++) b.writeInt16LE(1000, 44 + i * 2);
  return b;
};

test("IA : résumé d'un message vocal lu proprement", () => {
  assert.deepEqual(parseVoicemailSummary('Voici : {"summary":"Paul rappelle pour le devis.","caller_name":"Paul","callback":"06 12 34 56 78","urgent":true}'),
    { summary: "Paul rappelle pour le devis.", caller_name: "Paul", callback: "0612345678", urgent: true });
  assert.equal(parseVoicemailSummary("pas du JSON").summary, "pas du JSON");
});

test("IA : voix reçue (24 kHz, taille de flux) convertie au format des annonces (8 kHz mono)", () => {
  const out = toPbxWav(wav(24000, 1, 24000));
  assert.equal(out.readUInt32LE(24), 8000); assert.equal(out.readUInt16LE(22), 1); assert.equal(out.readUInt32LE(40), 16000);
  assert.equal(out.readInt16LE(44), 1000);
  assert.equal(toPbxWav(wav(16000, 2, 1600)).readUInt32LE(40), 1600);
  assert.throws(() => toPbxWav(Buffer.from("pas un wav")), /illisible/);
});

test("IA : le diagnostic n'envoie jamais de mot de passe ni de code", () => {
  const t = diagnosisInput("le 203 ne sonne pas", { Postes: [{ poste: "203", password: "secret1", pin: "1234", nom: "Karim" }], Rien: null });
  assert.match(t, /Karim/); assert.doesNotMatch(t, /secret1|1234/); assert.doesNotMatch(t, /Rien/);
});

test("IA : e-mail du message vocal avec le résumé", () => {
  const m = voicemailMail({ box: "201", boxName: "Marie", caller: "0612345678", callerName: "", at: null, duration: 30, insight: { summary: "Rappeler pour le devis du four.", callback: "0612345678", text: "Bonjour…", urgent: true } });
  assert.match(m.subject, /^\[Urgent\] Message vocal .*: Rappeler pour le devis/); assert.match(m.html, /Transcription automatique/); assert.match(m.text, /À rappeler : 06 12 34 56 78/);
});

test("IA : inscription auprès du relais puis nouvelle inscription si le jeton est refusé", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-")); fs.writeFileSync(path.join(dir, "pbx-config.json"), JSON.stringify({ version: 1, pbx: { id: "x" }, signature: "s" }));
  const store = new Map([["ai", { enabled: true }]]);
  const db = { getSetting: async (k, d) => (store.has(k) ? store.get(k) : d), setSetting: async (k, v) => store.set(k, v), query: async () => ({ rows: [] }) };
  let n = 0; const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url.replace("https://r.test", ""));
    if (url.endsWith("/register")) return new Response(JSON.stringify({ token: `AI1.x.tok${++n}` }));
    if (init.headers.authorization === "Bearer AI1.x.tok1") return new Response(JSON.stringify({ error: "jeton" }), { status: 401 });
    return new Response(JSON.stringify({ text: "ok" }));
  };
  const ai = createAi({ db, etcDir: dir, env: { PBXM_AI_URL: "https://r.test" }, fetchImpl });
  assert.equal(await ai.text("diagnose", "aide"), "ok");
  assert.deepEqual(calls, ["/v1/ai/register", "/v1/ai/text", "/v1/ai/register", "/v1/ai/text"]);
  store.set("ai", { enabled: false });
  await assert.rejects(ai.text("diagnose", "aide"), /désactivée/);
});

test("fond musical : musique seule au début, voix 1,5 s après, musique baissée, fondu de fin, boucle", () => {
  const R = 8000;
  const wavOf = (s) => { const b = Buffer.alloc(44 + s.length * 2); s.forEach((x, i) => b.writeInt16LE(Math.round(x), 44 + i * 2));
    b.write("RIFF", 0); b.writeUInt32LE(36 + s.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(R, 24); b.writeUInt32LE(R * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(s.length * 2, 40); return b; };
  const sine = (n, f, a) => Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / R));
  const voice = wavOf(sine(3 * R, 440, 8000));           // 3 s de « voix »
  const music = wavOf(sine(2 * R, 200, 20000));          // 2 s de musique forte : doit boucler
  const out = mixMusic(voice, music);
  const n = (out.length - 44) / 2;
  assert.equal(n, Math.round(1.5 * R) + 3 * R + 2 * R);  // 1,5 s + voix + 2 s
  const rms = (a, z) => { let e = 0; for (let i = a; i < z; i++) e += out.readInt16LE(44 + i * 2) ** 2; return Math.sqrt(e / (z - a)); };
  const intro = rms(0.3 * R, 0.9 * R), bed = rms(4.6 * R, 4.95 * R), end = rms(n - 400, n);
  const vr = 8000 / Math.SQRT2;
  assert.ok(Math.abs(20 * Math.log10(intro / vr) + 6) < 1.5, `intro ${intro}`);   // musique seule : 6 dB sous la voix
  assert.ok(Math.abs(20 * Math.log10(bed / vr) + 15) < 1.5, `après la voix ${bed}`); // 15 dB sous la voix
  assert.ok(end < bed / 4, "fondu de fin");
  assert.ok(rms(2 * R, 4 * R) > 0.9 * vr, "la voix reste entendue");
  assert.ok(rms(3.4 * R, 3.6 * R) > 0, "la musique a bouclé");
});
