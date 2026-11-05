/**
 * IA du PBX (option, désactivée par défaut) : messagerie vocale transcrite et résumée, annonces en voix IA, diagnostic.
 * Le PBX ne détient jamais la clé OpenAI : il passe par le relais IA du portail pro (https://portail.callikoe.fr/v1/ai/*),
 * où il s'inscrit avec son fichier pbx-config.json signé. Le portail compte la consommation de chaque PBX et applique son plafond.
 * Fonctions pures (résumé, conversion audio) testées dans console/test/ai.test.mjs.
 */
import { decodeWav, encodeWav, resample, levelVoice } from "./audio.mjs";
import fs from "node:fs";
import path from "node:path";
import { listServerMusic, serverMusicFile, MUSIC_DIR } from "./music.mjs";

export const DEFAULT_AI = { enabled: false, voicemail: true, calls: false, relay: "" };
/** Appels enregistrés : morceaux de 10 min envoyés à la transcription, 60 min au plus par appel */
export const CALL_CHUNK_S = 600, CALL_MAX_S = 3600, CALL_MIN_S = 10;
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

/** Réponse JSON du résumé d'un appel enregistré → objet propre */
export function parseCallSummary(text) {
  let o = null;
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (m) { try { o = JSON.parse(m[0]); } catch { o = null; } }
  const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => clean(x, max)).filter(Boolean).slice(0, n);
  if (!o) return { summary: clean(text, 300), todo: [], topics: [] };
  return { summary: clean(o.summary, 300), todo: list(o.todo, 5, 140), topics: list(o.topics, 4, 30) };
}

/** WAV d'un appel → morceaux WAV 8 kHz mono d'au plus `chunkS` secondes (le relais refuse au-delà de 15 min) */
export function splitWav(buf, chunkS = CALL_CHUNK_S) {
  const w = toPbxWav(buf), data = w.subarray(44), per = chunkS * 8000 * 2, out = [];
  for (let off = 0; off < data.length; off += per) {
    const part = data.subarray(off, Math.min(data.length, off + per));
    if (part.length < 8000 * 2) break;   // reste de moins d'une seconde : ignoré
    const h = Buffer.from(w.subarray(0, 44)); h.writeUInt32LE(36 + part.length, 4); h.writeUInt32LE(part.length, 40);
    out.push(Buffer.concat([h, part]));
  }
  return out;
}

/** Recherche dans les enregistrements : numéros, noms, et ce qui a été dit (sans tenir compte des accents ni des majuscules) */
export function callMatches(c, ins, q) {
  const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const digits = (x) => String(x || "").replace(/\D/g, "");
  const hay = norm([c.from?.name, c.from?.number, c.to?.name, c.to?.number, c.answered_by, c.did, ins?.summary, ins?.text, ...(ins?.todo || []), ...(ins?.topics || [])].join(" "));
  const nums = [c.from?.number, c.to?.number, c.did].map(digits).join(" ");
  return words.every((w) => hay.includes(w) || (/^\d{3,}$/.test(w) && nums.includes(w.replace(/^0/, ""))));
}

/** WAV PCM 16 bits (n'importe quelle fréquence, mono ou stéréo) → WAV mono à `rate` (8 kHz par défaut), rééchantillonné proprement */
export function toPbxWav(buf, rate = 8000) {
  let d;
  try { d = decodeWav(buf); } catch { throw new Error("Audio reçu illisible ou dans un format inattendu (WAV PCM attendu)."); }
  return encodeWav(resample(d.samples, d.rate, rate), rate);
}

/** Échantillons d'un WAV à `rate` (mono, -1…1) */
const samplesOf = (wav, rate) => { const d = decodeWav(wav); return resample(d.samples, d.rate, rate); };
const rmsOf = (s) => { let e = 0, n = 0; for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > 0.01) { e += s[i] * s[i]; n++; } return n ? Math.sqrt(e / n) : 0; };   // sans les silences

/**
 * Annonce sur fond musical : la musique démarre seule, la voix arrive après `lead` secondes,
 * la musique est baissée de `duckDb` sous la voix, puis s'éteint en fondu `tail` secondes après la fin de la voix.
 * Musique trop courte : rejouée en boucle avec un fondu enchaîné d'1 s. Mélange et sortie en 16 kHz (HD), WAV mono.
 */
export function mixMusic(voiceWav, musicWav, { lead = 1.5, tail = 2, duckDb = 15, introDb = 6, rate = 16000 } = {}) {
  const R = rate, v = samplesOf(voiceWav, R), m0 = samplesOf(musicWav, R);
  if (!m0.length) return encodeWav(v, R);
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
  const vr = rmsOf(v) || 0.1, mr = rmsOf(m) || 1;
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
  const k = peak > 0.97 ? 0.97 / peak : 1;   // jamais de saturation
  for (let i = 0; i < n; i++) out[i] *= k;
  return encodeWav(out, R);
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
  // + ceux du serveur multi-tenant (dossier partagé, ajoutés dans sa console › IA)
  const musicDir = env.CX_MUSIC_DIR || MUSIC_DIR;
  async function portalMusics() {
    if (musicList?.items.length && Date.now() - musicList.at < 10 * 60_000) return musicList.items;   // liste vide : on redemande à chaque fois
    const r = await call("/v1/ai/music", undefined);
    musicList = { at: Date.now(), items: (r.music || []).map((x) => ({ id: String(x.id), name: String(x.name || ""), seconds: Number(x.seconds) || 0 })) };
    return musicList.items;
  }
  async function musics() {
    const local = listServerMusic(musicDir).map((m) => ({ id: m.id, name: m.name, seconds: m.seconds }));
    try { return [...await portalMusics(), ...local]; } catch (e) { if (local.length) return local; throw e; }
  }
  async function music(id) {
    id = String(id || "");
    if (id.startsWith("srv-")) { const f = serverMusicFile(id, musicDir); if (!f) throw new AiError("Fond musical inconnu (retiré ?).", 404); return toPbxWav(fs.readFileSync(f), 16000); }
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new AiError("Fond musical inconnu.", 404);
    if (!musicCache.has(id)) {
      const wav = toPbxWav(Buffer.from((await call(`/v1/ai/music/${id}`, undefined)).audio, "base64"), 16000);
      if (musicCache.size >= 20) musicCache.delete(musicCache.keys().next().value);
      musicCache.set(id, wav);
    }
    return musicCache.get(id);
  }
  const speech = async (t, voice, musicId) => {
    // Voix gardée en 16 kHz (HD) avec un niveau homogène ; la version 8 kHz est faite à l'enregistrement de l'annonce
    const d = decodeWav(Buffer.from((await call("/v1/ai/speech", { text: t, voice })).audio, "base64"));
    const v = encodeWav(levelVoice(resample(d.samples, d.rate, 16000), 16000), 16000);
    return musicId ? mixMusic(v, await music(musicId)) : v;
  };

  /** Message vocal → transcription + résumé (gardés en base : une seule fois par message) */
  const inFlight = new Map();   // une seule transcription à la fois par message (deux tâches peuvent la demander en même temps)
  function voicemailInsight(box, msgKey, file, meta = {}) {
    if (!inFlight.has(msgKey)) inFlight.set(msgKey, insightOnce(box, msgKey, file, meta).finally(() => inFlight.delete(msgKey)));
    return inFlight.get(msgKey);
  }
  async function insightOnce(box, msgKey, file, meta = {}) {
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
  /** Appel enregistré → transcription (par morceaux) + résumé, gardés en base : une seule fois par enregistrement */
  function callInsight(rel, file, meta = {}) {
    const k = `call:${rel}`;
    if (!inFlight.has(k)) inFlight.set(k, callOnce(rel, file, meta).finally(() => inFlight.delete(k)));
    return inFlight.get(k);
  }
  async function callOnce(rel, file, meta) {
    const old = (await db.query("SELECT rec, status, text, summary, todo, topics FROM pbxmaison_call_ai WHERE rec = $1", [rel])).rows[0];
    if (old && old.status === "ok") return old;
    const save = async (status, t = "", sum = { summary: "", todo: [], topics: [] }) => {
      await db.query(`INSERT INTO pbxmaison_call_ai (rec, status, text, summary, todo, topics, call_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (rec) DO UPDATE SET status = $2, text = $3, summary = $4, todo = $5, topics = $6, at = now()`,
        [rel, status, t, sum.summary, JSON.stringify(sum.todo), JSON.stringify(sum.topics), String(meta.start || "")]);
      return { rec: rel, status, text: t, ...sum };
    };
    const parts = splitWav(fs.readFileSync(file));
    if (parts.length * CALL_CHUNK_S > CALL_MAX_S + CALL_CHUNK_S) return save("long", "", { summary: "Appel trop long pour être résumé (plus d'une heure).", todo: [], topics: [] });
    const texts = [];
    for (const p of parts) texts.push((await call("/v1/ai/transcribe", { audio: p.toString("base64") })).text || "");
    const t = texts.join(" ").replace(/\s+/g, " ").trim();
    if (!t) return save("ok", "", { summary: "Appel sans parole reconnue (silence ou bruit).", todo: [], topics: [] });
    const input = JSON.stringify({ sens: meta.direction === "out" ? "appel sortant" : "appel entrant", appelant: meta.from || "", appele: meta.to || "", duree_s: meta.talk || 0, transcription: t });
    return save("ok", t, parseCallSummary(await text("call", input)));
  }
  async function callInsights(rels) {
    if (!rels.length) return new Map();
    const r = await db.query("SELECT rec, status, text, summary, todo, topics FROM pbxmaison_call_ai WHERE rec = ANY($1)", [rels]);
    return new Map(r.rows.map((x) => [x.rec, x]));
  }
  const forgetCall = (rel) => db.query("DELETE FROM pbxmaison_call_ai WHERE rec = $1", [rel]);
  async function saveSettings(input) {
    const s = await settings();
    const next = { ...s };
    if (input.enabled !== undefined) next.enabled = !!input.enabled;
    if (input.voicemail !== undefined) next.voicemail = !!input.voicemail;
    if (input.calls !== undefined) {
      next.calls = !!input.calls;
      // Activé à partir de maintenant : les appels enregistrés avant ne sont pas résumés d'office (bouton « Résumer » sur chacun)
      if (next.calls && !s.calls) next.calls_since = new Date().toISOString();
    }
    await db.setSetting("ai", next);
    if (next.enabled && !s.enabled) { try { await register(next); } catch { /* le statut affichera l'erreur */ } }
    return status();
  }
  // Relais du portail pour autre chose que l'IA (autorisations de notification de l'appli) : marche même si l'IA est désactivée
  const relay = (p, body) => call(p, body, { force: true });
  return { settings, saveSettings, status, transcribe, text, speech, musics, music, voicemailInsight, insights, callInsight, callInsights, forgetCall, realtimeUrl, relay, AiError };
}
