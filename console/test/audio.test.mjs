import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeWav, encodeWav, resample, levelVoice, promptVersions } from "../lib/audio.mjs";
import { toPbxWav } from "../lib/ai.mjs";

const tone = (f, rate, sec, a = 0.5) => Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => a * Math.sin(2 * Math.PI * f * i / rate));
const db = (x, f, rate) => { // niveau d'une fréquence (Goertzel), en dB par rapport à une sinusoïde d'amplitude 1
  const k = 2 * Math.cos(2 * Math.PI * f / rate); let s1 = 0, s2 = 0;
  const a = Math.floor(x.length * 0.1), z = Math.floor(x.length * 0.9);
  for (let i = a; i < z; i++) { const s = x[i] + k * s1 - s2; s2 = s1; s1 = s; }
  const p = s1 * s1 + s2 * s2 - k * s1 * s2; return 20 * Math.log10(Math.sqrt(p) / ((z - a) / 2) + 1e-12);
};

test("rééchantillonnage : la voix passe, le repliement est supprimé", () => {
  const x = tone(1000, 24000, 1);
  const y = resample(x, 24000, 8000);
  assert.equal(y.length, 8000);
  assert.ok(Math.abs(db(y, 1000, 8000) - db(x, 1000, 24000)) < 0.2, "1 kHz conservé");
  // 7 kHz n'existe pas à 8 kHz : sans filtre il revient en faux 1 kHz
  const z = resample(tone(7000, 24000, 1), 24000, 8000);
  assert.ok(db(z, 1000, 8000) < -70, `repliement ${db(z, 1000, 8000).toFixed(1)} dB`);
  // 16 kHz : les aigus de la voix (5-7 kHz) restent
  const h = resample(tone(6000, 24000, 1), 24000, 16000);
  assert.ok(Math.abs(db(h, 6000, 16000) - db(tone(6000, 24000, 1), 6000, 24000)) < 0.3);
});

test("niveau de la voix : homogène et sans saturation", () => {
  const quiet = levelVoice(tone(500, 16000, 1, 0.02), 16000), loud = levelVoice(tone(500, 16000, 1, 0.99), 16000);
  const rms = (x) => 20 * Math.log10(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length));
  assert.ok(Math.abs(rms(quiet) - -18) < 1 && Math.abs(rms(loud) - -18) < 1);
  assert.ok(Math.max(...loud.map(Math.abs)) <= 10 ** (-1.5 / 20) + 1e-6);
});

test("annonce : versions 16 kHz et 8 kHz", () => {
  const v = promptVersions(encodeWav(tone(800, 24000, 2), 24000), { level: true });
  assert.equal(decodeWav(v.wav16).rate, 16000); assert.equal(decodeWav(v.wav8).rate, 8000);
  assert.ok(Math.abs(v.seconds - 2) < 0.01);
  const n = promptVersions(encodeWav(tone(800, 8000, 1), 8000));
  assert.equal(n.wav16, null); assert.equal(decodeWav(n.wav8).samples.length, 8000);
});
