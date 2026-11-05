// Traitement audio des annonces : lecture WAV, rééchantillonnage de qualité (sinc fenêtré), niveau homogène.
// Les annonces sont gardées en 16 kHz (téléphones HD en G.722, softphone, appli) et en 8 kHz (opérateurs en G.711) :
// Asterisk choisit tout seul le fichier qui demande le moins de conversion pour chaque appel.

/** WAV PCM 16 bits (toute fréquence, mono ou stéréo) → { rate, samples (Float32, -1…1) } */
export function decodeWav(buf) {
  const b = Buffer.from(buf);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Audio illisible (WAV attendu).");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") { data = b.subarray(off + 8, Math.min(b.length, off + 8 + len)); break; }   // taille parfois 0xFFFFFFFF (flux)
    off += 8 + len + (len % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) throw new Error("Audio dans un format inattendu (WAV PCM 16 bits attendu).");
  const ch = fmt.channels, n = Math.floor(data.length / (2 * ch)), s = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < ch; c++) v += data.readInt16LE((i * ch + c) * 2); s[i] = v / ch / 32768; }
  return { rate: fmt.rate, samples: s };
}

/** Float32 (-1…1) → WAV PCM 16 bits mono */
export function encodeWav(samples, rate) {
  const n = samples.length, b = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const bessel0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; } return s; };

/**
 * Rééchantillonnage par sinc fenêtré (fenêtre de Kaiser, β = 8,6 : ~ -80 dB de repliement), coupure à 92 % de la nouvelle
 * demi-fréquence. Bien meilleur qu'une simple moyenne : pas de sifflement ni de son « métallique » sur les consonnes.
 */
export function resample(x, from, to, { zeros = 24, beta = 8.6 } = {}) {
  if (from === to) return Float32Array.from(x);
  const ratio = to / from, fc = Math.min(1, ratio) * 0.92;   // coupure, en fraction de la demi-fréquence d'entrée
  const half = Math.ceil(zeros / fc), n = Math.floor(x.length * ratio), y = new Float32Array(n);
  const i0b = bessel0(beta);
  // Table de la fonction filtre (sinc × Kaiser), interpolée linéairement
  const TBL = 512, len = half * TBL, tab = new Float32Array(len + 2);
  for (let i = 0; i <= len + 1; i++) {
    const t = i / TBL, r = t / half;
    const w = r >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0b;
    const a = Math.PI * fc * t;
    tab[i] = w * fc * (t === 0 ? 1 : Math.sin(a) / a);
  }
  const k = (d) => { const p = Math.abs(d) * TBL, j = p | 0; return j >= len ? 0 : tab[j] + (tab[j + 1] - tab[j]) * (p - j); };
  for (let i = 0; i < n; i++) {
    const t = i / ratio, c = Math.floor(t);
    let s = 0;
    for (let j = c - half + 1; j <= c + half; j++) if (j >= 0 && j < x.length) s += x[j] * k(t - j);
    y[i] = s;
  }
  return y;
}

/**
 * Niveau homogène pour la voix : RMS des passages parlés ramené à `target` dBFS, crêtes limitées à `ceiling` dBFS
 * (limiteur doux, sans saturation), filtre passe-haut à 80 Hz (souffles, bruit de fond grave).
 */
export function levelVoice(x, rate, { target = -18, ceiling = -1.5 } = {}) {
  const y = Float32Array.from(x);
  // Passe-haut du 2e ordre (Butterworth) à 80 Hz
  const w = Math.tan(Math.PI * 80 / rate), q = Math.SQRT1_2, n0 = 1 / (1 + w / q + w * w);
  const b0 = n0, b1 = -2 * n0, b2 = n0, a1 = 2 * (w * w - 1) * n0, a2 = (1 - w / q + w * w) * n0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < y.length; i++) { const v = y[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
  // RMS des fenêtres de 20 ms où l'on parle (au-dessus de -45 dBFS)
  const win = Math.max(1, Math.round(rate * 0.02));
  let e = 0, c = 0;
  for (let i = 0; i + win <= y.length; i += win) {
    let s = 0; for (let j = i; j < i + win; j++) s += y[j] * y[j];
    const r = Math.sqrt(s / win); if (r > 10 ** (-45 / 20)) { e += r * r; c++; }
  }
  if (!c) return y;
  const g = 10 ** (target / 20) / Math.sqrt(e / c), lim = 10 ** (ceiling / 20);
  for (let i = 0; i < y.length; i++) {
    const v = y[i] * g, a = Math.abs(v);
    // au-delà de 70 % du plafond : compression douce (tanh) jusqu'au plafond
    const knee = lim * 0.7;
    y[i] = a <= knee ? v : Math.sign(v) * (knee + (lim - knee) * Math.tanh((a - knee) / (lim - knee)));
  }
  return y;
}

/** Annonce prête pour le PBX à partir d'un WAV quelconque : { wav8, wav16 (si la source le permet), seconds } */
export function promptVersions(buf, { level = false } = {}) {
  const { rate, samples } = decodeWav(buf);
  const hd = rate >= 16000;
  let s16 = hd ? resample(samples, rate, 16000) : null;
  if (s16 && level) s16 = levelVoice(s16, 16000);
  let s8 = s16 ? resample(s16, 16000, 8000) : resample(samples, rate, 8000);
  if (!s16 && level) s8 = levelVoice(s8, 8000);
  return { wav8: encodeWav(s8, 8000), wav16: s16 ? encodeWav(s16, 16000) : null, seconds: s8.length / 8000 };
}
