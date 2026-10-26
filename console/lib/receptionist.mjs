/**
 * Standardiste IA : répond au téléphone en direct (voix OpenAI Realtime, via le relais du portail pro).
 *
 *   Moteur téléphonique ──AudioSocket (TCP local, slin 8 kHz)──► console ──WebSocket (PCM 24 kHz)──► relais du portail ──► OpenAI
 *
 * L'IA peut : renseigner (horaires, adresse… donnés par l'installateur), transférer vers les destinations réglées
 * (contexte cx-ai-out du dialplan), prendre un message (e-mail + « À rappeler »), raccrocher poliment.
 * Fonctions pures (trames, rééchantillonnage, consignes) testées dans console/test/receptionist.test.mjs.
 */
import net from "node:net";
import crypto from "node:crypto";

export const RT_VOICES = { marin: "Marin (naturelle)", cedar: "Cedar (posée)", coral: "Coral (chaleureuse)", sage: "Sage (calme)", alloy: "Alloy (neutre)", verse: "Verse (dynamique)" };
export const DEFAULT_RECEPTIONIST = { company: "", voice: "marin", greeting: "", info: "", transfers: [], message_to: [], fallback: { type: "hangup", target: "" } };
const TRANSFER_TYPES = ["user", "group", "queue", "ivr", "user_vm", "groupvm", "external"];

// ------------------------------------------------------------------ AudioSocket
/** Lit les trames AudioSocket d'un tampon : [{ type, payload }] + reste non lu */
export function readFrames(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 3) {
    const len = buf.readUInt16BE(off + 1);
    if (buf.length - off < 3 + len) break;
    out.push({ type: buf[off], payload: buf.subarray(off + 3, off + 3 + len) });
    off += 3 + len;
  }
  return { frames: out, rest: buf.subarray(off) };
}
export const audioFrame = (pcm) => { const h = Buffer.alloc(3); h[0] = 0x10; h.writeUInt16BE(pcm.length, 1); return Buffer.concat([h, pcm]); };
export const uuidOf = (b) => { const h = Buffer.from(b).toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };

/** PCM 16 bits 8 kHz → 24 kHz (interpolation linéaire) */
export function up3(pcm8) {
  const n = Math.floor(pcm8.length / 2), out = Buffer.alloc(n * 6);
  for (let i = 0; i < n; i++) {
    const a = pcm8.readInt16LE(i * 2), b = i + 1 < n ? pcm8.readInt16LE((i + 1) * 2) : a;
    out.writeInt16LE(a, i * 6); out.writeInt16LE(Math.round(a + (b - a) / 3), i * 6 + 2); out.writeInt16LE(Math.round(a + (2 * (b - a)) / 3), i * 6 + 4);
  }
  return out;
}
/** PCM 16 bits 24 kHz → 8 kHz (moyenne de 3 échantillons) */
export function down3(pcm24) {
  const n = Math.floor(pcm24.length / 6), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round((pcm24.readInt16LE(i * 6) + pcm24.readInt16LE(i * 6 + 2) + pcm24.readInt16LE(i * 6 + 4)) / 3), i * 2);
  return out;
}

// ------------------------------------------------------------------ Consignes de l'IA
export function instructionsFor(cfg, { mode = "full", caller = "", callerName = "", now = new Date(), tz = "Europe/Paris" } = {}) {
  const when = now.toLocaleString("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const transfers = mode === "full" ? (cfg.transfers || []) : [];
  return [
    `Tu es le standardiste téléphonique de ${cfg.company || "l'entreprise"}. Tu réponds au téléphone en français, avec une voix chaleureuse et professionnelle.`,
    "Phrases courtes (une ou deux à la fois), vouvoiement, pas de jargon. Ne lis jamais de liste : propose au plus deux choix à la fois.",
    `Nous sommes ${when}.${caller ? ` L'appelant appelle depuis le ${caller}${callerName ? ` (${callerName})` : ""}.` : ""}`,
    cfg.greeting ? `Commence par dire : « ${cfg.greeting} »` : `Commence par : « ${cfg.company ? `${cfg.company}, bonjour` : "Bonjour"}, que puis-je pour vous ? »`,
    cfg.info ? `Informations que tu peux donner (et seulement celles-ci, n'invente rien) :\n${cfg.info}` : "Tu n'as pas d'informations sur l'entreprise : n'en invente aucune.",
    transfers.length
      ? `Tu peux transférer l'appel avec l'outil transfer vers :\n${transfers.map((t, i) => `${i + 1}. ${t.label}${t.description ? ` — ${t.description}` : ""}`).join("\n")}\nAvant de transférer, dis « Je vous mets en relation, un instant. » Si personne ne répond après le transfert, l'appel continue ailleurs : ce n'est plus ton rôle.`
      : "Personne n'est disponible pour prendre l'appel en ce moment : tu ne peux transférer vers personne.",
    "Si la demande ne correspond à aucun transfert, ou si l'appelant le souhaite, propose de prendre un message : demande son nom, un numéro pour le rappeler (confirme-le en le répétant chiffre par chiffre) et le motif, puis appelle l'outil take_message. Dis ensuite que le message sera transmis.",
    "Quand la conversation est finie, dis au revoir puis appelle l'outil end_call. Ne donne jamais d'information personnelle sur les employés (numéro de portable, adresse…).",
  ].join("\n\n");
}
export function toolsFor(cfg, mode = "full") {
  const tools = [
    { type: "function", name: "take_message", description: "Enregistre un message pour l'entreprise, à rappeler.",
      parameters: { type: "object", properties: { caller_name: { type: "string", description: "Nom de l'appelant (et sa société)" }, callback: { type: "string", description: "Numéro de téléphone pour rappeler" },
        message: { type: "string", description: "Motif de l'appel, résumé en une ou deux phrases" }, urgent: { type: "boolean", description: "Vrai si l'appelant dit que c'est urgent" } }, required: ["message"] } },
    { type: "function", name: "end_call", description: "Raccroche, une fois l'au revoir dit.", parameters: { type: "object", properties: {} } },
  ];
  if (mode === "full" && (cfg.transfers || []).length) tools.unshift({ type: "function", name: "transfer", description: "Transfère l'appel vers une destination de la liste.",
    parameters: { type: "object", properties: { destination: { type: "integer", description: "Numéro de la destination dans la liste (1, 2…)" } }, required: ["destination"] } });
  return tools;
}

/** Réglages du standardiste IA (console › Administration › IA) */
export function validateReceptionist(input, cur = DEFAULT_RECEPTIONIST) {
  const t = (v, max) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
  const out = { ...DEFAULT_RECEPTIONIST, ...cur };
  if (input.company !== undefined) out.company = t(input.company, 80).replace(/\n/g, " ");
  if (input.voice !== undefined) out.voice = RT_VOICES[input.voice] ? input.voice : "marin";
  if (input.greeting !== undefined) out.greeting = t(input.greeting, 200).replace(/\n/g, " ");
  if (input.info !== undefined) out.info = t(input.info, 3000);
  if (input.transfers !== undefined) {
    out.transfers = (Array.isArray(input.transfers) ? input.transfers : []).slice(0, 12).map((x, i) => {
      const label = t(x?.label, 60).replace(/\n/g, " ");
      if (!label) throw Object.assign(new Error(`Transfert ${i + 1} : donne-lui un nom (ex. « Comptabilité »).`), { field: `transfers.${i}.label` });
      const type = String(x?.dest?.type || "");
      if (!TRANSFER_TYPES.includes(type) || !String(x?.dest?.target || "").trim()) throw Object.assign(new Error(`Transfert « ${label} » : choisis la destination.`), { field: `transfers.${i}.dest` });
      return { label, description: t(x.description, 200).replace(/\n/g, " "), dest: { type, target: String(x.dest.target).trim() } };
    });
  }
  if (input.message_to !== undefined) {
    const list = (Array.isArray(input.message_to) ? input.message_to : String(input.message_to).split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    for (const e of list) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) throw Object.assign(new Error(`Adresse invalide : ${e}`), { field: "message_to" });
    out.message_to = [...new Set(list)].slice(0, 10);
  }
  if (input.fallback !== undefined) out.fallback = input.fallback?.type && input.fallback.type !== "hangup" ? { type: String(input.fallback.type), target: String(input.fallback.target || "") } : { type: "hangup", target: "" };
  return out;
}

// ------------------------------------------------------------------ Service
export function createReceptionist({ db, ami, ai, sendMail, tz = () => "Europe/Paris", log = console, WebSocketImpl = globalThis.WebSocket }) {
  const calls = new Map();   // uuid → { from, name, chan, did, mode, at }
  const settings = async () => ({ ...DEFAULT_RECEPTIONIST, ...((await db.getSetting("receptionist", {})) || {}) });

  /** Appel annoncé par le dialplan juste avant AudioSocket : renvoie l'identifiant à donner à AudioSocket ("" = IA indisponible) */
  async function register({ from = "", name = "", chan = "", did = "", mode = "full" }) {
    const st = await ai.settings();
    if (!st.enabled) return "";
    for (const [k, v] of calls) if (Date.now() - v.at > 30 * 60_000) calls.delete(k);
    const id = crypto.randomUUID();
    calls.set(id, { from: String(from).slice(0, 30), name: String(name).slice(0, 60), chan: String(chan).slice(0, 120), did: String(did).slice(0, 30), mode: mode === "msg" ? "msg" : "full", at: Date.now() });
    return id;
  }

  async function saveMessage(call, args) {
    const msg = { caller: call.from, caller_name: String(args.caller_name || call.name || "").slice(0, 120), callback: String(args.callback || call.from || "").replace(/[^\d+]/g, "").slice(0, 20),
      message: String(args.message || "").slice(0, 1000), urgent: !!args.urgent };
    await db.query(`CREATE TABLE IF NOT EXISTS pbxmaison_ai_messages (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), caller text NOT NULL DEFAULT '', caller_name text NOT NULL DEFAULT '',
      callback text NOT NULL DEFAULT '', message text NOT NULL DEFAULT '', urgent boolean NOT NULL DEFAULT false)`);
    await db.query("INSERT INTO pbxmaison_ai_messages (caller, caller_name, callback, message, urgent) VALUES ($1, $2, $3, $4, $5)", [msg.caller, msg.caller_name, msg.callback, msg.message, msg.urgent]);
    const cfg = await settings();
    if (cfg.message_to.length && sendMail) {
      const who = msg.caller_name || msg.callback || "Numéro masqué";
      const subject = `${msg.urgent ? "[Urgent] " : ""}Message pris par le standardiste IA : ${who}`;
      const text = [`Message pris par le standardiste IA${cfg.company ? ` de ${cfg.company}` : ""}.`, "", `De : ${who}`, msg.callback ? `À rappeler au : ${msg.callback}` : "", "", msg.message].filter((l) => l !== null).join("\n");
      const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;max-width:520px"><p><b>${msg.urgent ? "Urgent · " : ""}Message pris par le standardiste IA</b></p><p>De : <b>${esc(who)}</b>${msg.callback ? `<br>À rappeler au : <b>${esc(msg.callback)}</b>` : ""}</p><p style="padding:12px;background:#f4f5f8;border-radius:8px">${esc(msg.message)}</p></div>`;
      sendMail(cfg.message_to, { subject, text, html }).catch((e) => log.warn?.({ err: e.message }, "Standardiste IA : e-mail du message en échec"));
    }
    return msg;
  }

  /** Une conversation : trames AudioSocket ⇄ OpenAI Realtime (par le relais) */
  async function handle(sock) {
    let buf = Buffer.alloc(0), ws = null, call = null, out = Buffer.alloc(0), inBatch = [], closing = false, timer = null;
    const cfg = await settings();
    const send = (o) => { try { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); } catch { /* fermé */ } };
    const stop = () => {
      if (closing) return; closing = true;
      clearInterval(timer); try { ws?.close(); } catch { /* */ } try { sock.end(); } catch { /* */ }
    };
    const drained = (max = 6000) => new Promise((r) => { const t0 = Date.now(); const i = setInterval(() => { if (out.length < 320 || Date.now() - t0 > max) { clearInterval(i); r(); } }, 100); });
    const amiAct = async (a) => { try { await ami.connect(); await ami.action(a); } catch (e) { log.warn?.({ err: e.message }, "Standardiste IA : action du moteur en échec"); } };
    async function tool(name, args, callId) {
      if (name === "take_message") { await saveMessage(call, args); return { ok: true, info: "Message enregistré et transmis." }; }
      if (name === "transfer") {
        const n = Number(args.destination), t = (cfg.transfers || [])[n - 1];
        if (!t || call.mode !== "full") return { ok: false, info: "Destination inconnue : propose de prendre un message." };
        await drained();
        await amiAct({ Action: "Redirect", Channel: call.chan, Context: "cx-ai-out", Exten: String(n), Priority: "1" });
        setTimeout(stop, 500); return null;
      }
      if (name === "end_call") { await drained(); await amiAct({ Action: "Hangup", Channel: call.chan }); setTimeout(stop, 300); return null; }
      return { ok: false };
      void callId;
    }
    timer = setInterval(() => {   // voix de l'IA vers l'appelant : une trame de 20 ms toutes les 20 ms
      if (out.length >= 320) { const f = out.subarray(0, 320); out = out.subarray(320); try { sock.write(audioFrame(f)); } catch { stop(); } }
    }, 20);
    sock.on("data", (chunk) => onData(chunk).catch((e) => { log.warn?.({ err: e.message }, "Standardiste IA : erreur audio"); stop(); }));
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const r = readFrames(buf); buf = Buffer.from(r.rest);
      for (const f of r.frames) {
        if (f.type === 0x00) return stop();
        if (f.type === 0x01 && !ws) {
          call = calls.get(uuidOf(f.payload));
          if (!call) return stop();
          calls.delete(uuidOf(f.payload));
          let url;
          try { url = await ai.realtimeUrl(); } catch (e) { log.warn?.({ err: e.message }, "Standardiste IA : relais indisponible"); return stop(); }
          ws = new WebSocketImpl(url);
          ws.onopen = () => {
            send({ type: "session.update", session: { type: "realtime", instructions: instructionsFor(cfg, { mode: call.mode, caller: call.from, callerName: call.name, tz: tz() }),
              output_modalities: ["audio"], tools: toolsFor(cfg, call.mode), tool_choice: "auto",
              audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "server_vad", silence_duration_ms: 600 } },
                output: { format: { type: "audio/pcm", rate: 24000 }, voice: cfg.voice || "marin" } } } });
            send({ type: "response.create" });   // l'IA parle la première (accueil)
          };
          ws.onmessage = (ev) => handleMessage(ev).catch((e) => log.warn?.({ err: e.message }, "Standardiste IA : erreur pendant l'appel"));   // jamais d'arrêt de la console
          const handleMessage = async (ev) => {
            let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
            if (m.type === "response.output_audio.delta" || m.type === "response.audio.delta") out = Buffer.concat([out, down3(Buffer.from(m.delta || "", "base64"))]);
            else if (m.type === "input_audio_buffer.speech_started") out = Buffer.alloc(0);   // l'appelant coupe la parole : on se tait
            else if (m.type === "response.done") {
              for (const it of m.response?.output || []) {
                if (it.type !== "function_call") continue;
                let args = {}; try { args = JSON.parse(it.arguments || "{}"); } catch { /* sans arguments */ }
                let res; try { res = await tool(it.name, args, it.call_id); } catch (e) { log.warn?.({ err: e.message }, "Standardiste IA : action impossible"); res = { ok: false, error: "Action impossible pour le moment." }; }
                if (res) { send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: it.call_id, output: JSON.stringify(res) } }); send({ type: "response.create" }); }
              }
            } else if (m.type === "error") log.warn?.({ err: m.error?.message }, "Standardiste IA : erreur OpenAI");
          };
          ws.onclose = () => stop();
          ws.onerror = () => stop();
        } else if (f.type === 0x10 && ws?.readyState === 1) {
          inBatch.push(f.payload);
          if (inBatch.length >= 5) { send({ type: "input_audio_buffer.append", audio: up3(Buffer.concat(inBatch)).toString("base64") }); inBatch = []; }   // 100 ms à la fois
        }
      }
    };
    sock.on("close", stop); sock.on("error", stop);
  }

  let server = null;
  function listen(port) {
    server = net.createServer((s) => handle(s).catch((e) => { log.warn?.({ err: e.message }, "Standardiste IA"); s.destroy(); }));
    server.on("error", (e) => log.warn?.({ err: e.message }, "Standardiste IA : port audio indisponible"));
    server.listen(port, "127.0.0.1");
    return server;
  }
  return { settings, register, listen, handle, saveMessage, close: () => server?.close() };
}
