/**
 * IA du PBX (option, désactivée par défaut) : messagerie vocale transcrite et résumée, annonces en voix IA, diagnostic.
 * Le PBX ne détient jamais la clé OpenAI : il passe par le relais IA du portail pro (https://portail.callikoe.fr/v1/ai/*),
 * où il s'inscrit avec son fichier pbx-config.json signé. Le portail compte la consommation de chaque PBX et applique son plafond.
 * Fonctions pures (résumé, conversion audio) testées dans console/test/ai.test.mjs.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_AI = { enabled: false, voicemail: true, relay: "" };
export const VOICES = { coral: "Chaleureuse", sage: "Posée", alloy: "Neutre", verse: "Dynamique", ash: "Grave", nova: "Claire" };

/** Réponse JSON du résumé d'un message vocal → objet propre (tolère du texte autour) */
export function parseVoicemailSummary(text) {
  let o = null;
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (m) { try { o = JSON.parse(m[0]); } catch { o = null; } }
  const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  if (!o) return { summary: clean(text, 240), caller_name: "", callback: "", urgent: false };
  return { summary: clean(o.summary, 240), caller_name: clean(o.caller_name, 60), callback: clean(o.callback, 20).replace(/[^\d+]/g, ""), urgent: o.urgent === true };
}

/** WAV PCM 16 bits (n'importe quelle fréquence, mono ou stéréo) → WAV 8 kHz mono, le format des annonces du PBX */
export function toPbxWav(buf) {
  const b = Buffer.from(buf);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Audio reçu illisible (WAV attendu).");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") { data = b.subarray(off + 8, Math.min(b.length, off + 8 + len)); break; }   // taille parfois 0xFFFFFFFF (flux) : jusqu'à la fin
    off += 8 + len + (len % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) throw new Error("Audio reçu dans un format inattendu.");
  const ch = fmt.channels, n = Math.floor(data.length / (2 * ch));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2); mono[i] = s / ch; }
  const ratio = fmt.rate / 8000, outN = Math.floor(n / ratio);
  const out = Buffer.alloc(44 + outN * 2);
  for (let i = 0; i < outN; i++) {
    // moyenne sur la fenêtre (filtre simple contre le repliement) puis échantillon à 8 kHz
    const a = Math.floor(i * ratio), z = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < z && j < n; j++) s += mono[j];
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s / (Math.min(z, n) - a)))), 44 + i * 2);
  }
  out.write("RIFF", 0); out.writeUInt32LE(36 + outN * 2, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24); out.writeUInt32LE(16000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(outN * 2, 40);
  return out;
}

/** Échantillons d'un WAV 8 kHz mono 16 bits (tel que rendu par toPbxWav) */
const samplesOf = (wav) => { const b = toPbxWav(wav); const n = (b.length - 44) >> 1; const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = b.readInt16LE(44 + i * 2); return s; };
const rmsOf = (s) => { let e = 0, n = 0; for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > 300) { e += s[i] * s[i]; n++; } return n ? Math.sqrt(e / n) : 0; };   // sans les silences

/**
 * Annonce sur fond musical : la musique démarre seule, la voix arrive après `lead` secondes,
 * la musique est baissée de `duckDb` sous la voix, puis s'éteint en fondu `tail` secondes après la fin de la voix.
 * Musique trop courte : rejouée en boucle avec un fondu enchaîné d'1 s. Entrées et sortie : WAV (sortie 8 kHz mono).
 */
export function mixMusic(voiceWav, musicWav, { lead = 1.5, tail = 2, duckDb = 15, introDb = 6 } = {}) {
  const R = 8000, v = samplesOf(voiceWav), m0 = samplesOf(musicWav);
  if (!m0.length) return toPbxWav(voiceWav);
  const L = Math.round(lead * R), T = Math.round(tail * R), n = L + v.length + T;
  // musique au moins aussi longue que l'annonce : boucle avec fondu enchaîné
  const X = Math.min(R, m0.length >> 2), m = new Float32Array(n);
  for (let start = 0; start < n; start += m0.length - X) {
    for (let j = 0; j < m0.length && start + j < n; j++) {
      const k = start > 0 && j < X ? j / X : 1;   // la nouvelle copie monte pendant que la précédente s'éteint
      m[start + j] = start > 0 && j < X ? m[start + j] * (1 - k) + m0[j] * k : m0[j];
    }
    if (m0.length <= X) break;
  }
  // niveaux : musique seule 6 dB sous la voix, puis 15 dB sous la voix pendant qu'elle parle
  const vr = rmsOf(v) || 3000, mr = rmsOf(m) || 1;
  const gIntro = (vr / mr) * 10 ** (-introDb / 20), gBed = (vr / mr) * 10 ** (-duckDb / 20);
  const ramp = Math.round(0.5 * R), fadeIn = Math.round(0.2 * R), endV = L + v.length, fadeOut = Math.max(1, T - Math.round(0.5 * R));
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let g;
    if (i < L - ramp) g = gIntro;
    else if (i < L) g = gIntro + (gBed - gIntro) * ((i - (L - ramp)) / ramp);   // la musique baisse juste avant la voix
    else if (i < endV + T - fadeOut) g = gBed;
    else g = gBed * Math.max(0, (n - i) / fadeOut);   // fondu de fin
    if (i < fadeIn) g *= i / fadeIn;
    const s = m[i] * g + (i >= L && i < endV ? v[i - L] : 0);
    out[i] = s; if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  const k = peak > 32000 ? 32000 / peak : 1;   // jamais de saturation
  const b = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(out[i] * k), 44 + i * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(R, 24); b.writeUInt32LE(R * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

/** Texte envoyé au diagnostic : la question + l'état utile du PBX, sans aucun secret */
export function diagnosisInput(question, facts) {
  const strip = (o) => JSON.stringify(o, (k, v) => (/pass|secret|token|pin|hash|key/i.test(k) ? undefined : v));
  return [`Question de l'installateur : ${String(question).slice(0, 1000)}`, "", ...Object.entries(facts).filter(([, v]) => v != null).map(([k, v]) => `## ${k}\n${typeof v === "string" ? v : strip(v)}`)].join("\n").slice(0, 23000);
}

export function createAi({ db, etcDir, env = process.env, fetchImpl = globalThis.fetch }) {
  const settings = async () => ({ ...DEFAULT_AI, ...((await db.getSetting("ai", {})) || {}) });
  const relayUrl = (s) => (env.PBXM_AI_URL || s.relay || "https://portail.callikoe.fr").replace(/\/+$/, "");
  class AiError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

  async function register(s) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(etcDir, "pbx-config.json"), "utf8")); }
    catch { throw new AiError("Fichier de configuration du PBX introuvable : l'IA ne peut pas s'inscrire auprès du portail."); }
    const r = await raw(s, "/v1/ai/register", { config }, "");
    await db.setSetting("ai_token", r.token);
    return r;
  }
  async function raw(s, p, body, token) {
    let res;
    try {
      res = await fetchImpl(`${relayUrl(s)}${p}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(90_000),
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new AiError("Relais IA injoignable (portail.callikoe.fr) : vérifie l'accès Internet du serveur.", 502); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new AiError(data.error || `Relais IA : erreur ${res.status}`, res.status === 401 ? 401 : res.status >= 500 ? 502 : 400), { code: res.status });
    return data;
  }
  /** Appel au relais avec le jeton du PBX (inscription automatique au premier appel ou si le jeton est refusé) */
  async function call(p, body, { force = false } = {}) {
    const s = await settings();
    if (!s.enabled && !force) throw new AiError("IA désactivée : active-la dans Administration › IA.", 403);
    let token = await db.getSetting("ai_token", "");
    if (!token) token = (await register(s)).token;
    try { return await raw(s, p, body, token); }
    catch (e) { if (e.code !== 401) throw e; token = (await register(s)).token; return raw(s, p, body, token); }
  }

  /** Adresse WebSocket de la voix en direct (standardiste IA), jeton du PBX compris */
  async function realtimeUrl() {
    const s = await settings();
    if (!s.enabled) throw new AiError("IA désactivée.", 403);
    let token = await db.getSetting("ai_token", "");
    if (!token) token = (await register(s)).token;
    return `${relayUrl(s).replace(/^http/, "ws")}/v1/ai/realtime?t=${encodeURIComponent(token)}`;
  }
  const status = async () => {
    const s = await settings();
    try { return { settings: s, relay: (await call("/v1/ai/status", undefined, { force: true })).status, error: "" }; }
    catch (e) { return { settings: s, relay: null, error: e.message }; }
  };
  const transcribe = async (file) => (await call("/v1/ai/transcribe", { audio: fs.readFileSync(file).toString("base64") })).text;
  const text = async (task, input) => (await call("/v1/ai/text", { task, input })).text;
  // Fonds musicaux des annonces : gardés sur le portail (licence), récupérés à la demande et gardés en mémoire
  let musicList = null;
  const musicCache = new Map();
  async function musics() {
    if (musicList && Date.now() - musicList.at < 10 * 60_000) return musicList.items;
    const r = await call("/v1/ai/music", undefined);
    musicList = { at: Date.now(), items: (r.music || []).map((x) => ({ id: String(x.id), name: String(x.name || ""), seconds: Number(x.seconds) || 0 })) };
    return musicList.items;
  }
  async function music(id) {
    id = String(id || "");
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new AiError("Fond musical inconnu.", 404);
    if (!musicCache.has(id)) {
      const wav = toPbxWav(Buffer.from((await call(`/v1/ai/music/${id}`, undefined)).audio, "base64"));
      if (musicCache.size >= 20) musicCache.delete(musicCache.keys().next().value);
      musicCache.set(id, wav);
    }
    return musicCache.get(id);
  }
  const speech = async (t, voice, musicId) => {
    const v = toPbxWav(Buffer.from((await call("/v1/ai/speech", { text: t, voice })).audio, "base64"));
    return musicId ? mixMusic(v, await music(musicId)) : v;
  };

  /** Message vocal → transcription + résumé (gardés en base : une seule fois par message) */
  async function voicemailInsight(box, msgKey, file, meta = {}) {
    const old = (await db.query("SELECT text, summary, caller_name, callback, urgent FROM pbxmaison_vm_ai WHERE key = $1", [msgKey])).rows[0];
    if (old) return old;
    const t = await transcribe(file);
    const sum = t.trim() ? parseVoicemailSummary(await text("voicemail", t)) : { summary: "Message sans parole (silence ou bruit).", caller_name: "", callback: "", urgent: false };
    await db.query(`INSERT INTO pbxmaison_vm_ai (key, box, text, summary, caller_name, callback, urgent, caller_number, msg_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (key) DO NOTHING`,
      [msgKey, box, t, sum.summary, sum.caller_name, sum.callback, sum.urgent, String(meta.caller_number || ""), String(meta.at || "")]);
    return { text: t, ...sum };
  }
  async function insights(box) {
    const r = await db.query("SELECT key, text, summary, caller_name, callback, urgent FROM pbxmaison_vm_ai WHERE box = $1", [box]);
    return new Map(r.rows.map((x) => [x.key, x]));
  }
  async function saveSettings(input) {
    const s = await settings();
    const next = { ...s };
    if (input.enabled !== undefined) next.enabled = !!input.enabled;
    if (input.voicemail !== undefined) next.voicemail = !!input.voicemail;
    await db.setSetting("ai", next);
    if (next.enabled && !s.enabled) { try { await register(next); } catch { /* le statut affichera l'erreur */ } }
    return status();
  }
  return { settings, saveSettings, status, transcribe, text, speech, musics, music, voicemailInsight, insights, realtimeUrl, AiError };
}
