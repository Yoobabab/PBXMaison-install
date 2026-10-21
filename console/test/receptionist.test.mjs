import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFrames, audioFrame, uuidOf, up3, down3, instructionsFor, toolsFor, validateReceptionist, createReceptionist } from "../lib/receptionist.mjs";

test("standardiste IA : trames AudioSocket et rééchantillonnage", () => {
  const f = audioFrame(Buffer.alloc(320, 1));
  const { frames, rest } = readFrames(Buffer.concat([f, Buffer.from([0x10, 0x01])]));
  assert.equal(frames.length, 1); assert.equal(frames[0].payload.length, 320); assert.equal(rest.length, 2);
  assert.equal(uuidOf(Buffer.from("0123456789abcdef0123456789abcdef", "hex")), "01234567-89ab-cdef-0123-456789abcdef");
  const s8 = Buffer.alloc(320); for (let i = 0; i < 160; i++) s8.writeInt16LE(i * 10, i * 2);
  const s24 = up3(s8); assert.equal(s24.length, 960); assert.equal(s24.readInt16LE(6), 10);
  assert.equal(down3(s24).length, 320); assert.ok(Math.abs(down3(s24).readInt16LE(20) - 100) <= 4);
});

test("standardiste IA : consignes, outils, réglages", () => {
  const cfg = validateReceptionist({ company: "Boulangerie Martin", info: "Ouvert de 7 h à 19 h.", transfers: [{ label: "Commandes", description: "gâteaux, traiteur", dest: { type: "group", target: "g1" } }], message_to: "patron@martin.fr" });
  const ins = instructionsFor(cfg, { caller: "0612345678", now: new Date("2026-10-21T08:00:00Z") });
  assert.match(ins, /standardiste téléphonique de Boulangerie Martin/); assert.match(ins, /1\. Commandes — gâteaux, traiteur/); assert.match(ins, /Ouvert de 7 h à 19 h/);
  assert.deepEqual(toolsFor(cfg).map((t) => t.name), ["transfer", "take_message", "end_call"]);
  assert.deepEqual(toolsFor(cfg, "msg").map((t) => t.name), ["take_message", "end_call"]);
  assert.match(instructionsFor(cfg, { mode: "msg" }), /tu ne peux transférer vers personne/);
  assert.throws(() => validateReceptionist({ transfers: [{ label: "", dest: { type: "group", target: "g1" } }] }), /donne-lui un nom/);
  assert.throws(() => validateReceptionist({ message_to: "pas-une-adresse" }), /Adresse invalide/);
});

test("standardiste IA : conversation de bout en bout (moteur simulé, OpenAI simulé)", async () => {
  const store = new Map([["ai", { enabled: true }], ["receptionist", { company: "Test", transfers: [{ label: "Accueil", dest: { type: "group", target: "g1" } }], message_to: ["a@b.fr"] }]]);
  const rows = [];
  const db = { getSetting: async (k, d) => (store.has(k) ? store.get(k) : d), query: async (sql, p) => { if (/INSERT INTO pbxmaison_ai_messages/.test(sql)) rows.push(p); return { rows: [] }; } };
  const amiCalls = [], mails = [];
  const ami = { connect: async () => {}, action: async (a) => amiCalls.push(a) };
  const sent = []; let sock = null;
  class FakeWs { constructor(url) { this.url = url; this.readyState = 1; sock = this; setTimeout(() => this.onopen?.(), 5); } send(t) { sent.push(JSON.parse(t)); } close() { this.readyState = 3; } }
  const ai = { settings: async () => ({ enabled: true }), realtimeUrl: async () => "wss://relais.test/v1/ai/realtime?t=x" };
  const r = createReceptionist({ db, ami, ai, sendMail: async (to, m) => mails.push({ to, m }), WebSocketImpl: FakeWs, log: {} });
  const id = await r.register({ from: "0612345678", chan: "PJSIP/dstny-0001", mode: "full" });
  const server = r.listen(0); await new Promise((ok) => server.on("listening", ok));
  const c = net.connect(server.address().port, "127.0.0.1");
  const got = [];
  c.on("data", (d) => got.push(d));
  await new Promise((ok) => c.on("connect", ok));
  const h = Buffer.alloc(3); h[0] = 0x01; h.writeUInt16BE(16, 1);
  c.write(Buffer.concat([h, Buffer.from(id.replace(/-/g, ""), "hex")]));
  await new Promise((ok) => setTimeout(ok, 60));
  assert.equal(sent[0].type, "session.update"); assert.match(sent[0].session.instructions, /standardiste téléphonique de Test/); assert.equal(sent[1].type, "response.create");
  for (let i = 0; i < 5; i++) c.write(audioFrame(Buffer.alloc(320)));
  await new Promise((ok) => setTimeout(ok, 30));
  assert.ok(sent.some((x) => x.type === "input_audio_buffer.append"));
  // L'IA parle (60 ms de son à 24 kHz) puis prend un message
  sock.onmessage({ data: JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(2880).toString("base64") }) });
  await sock.onmessage({ data: JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "take_message", call_id: "c1", arguments: JSON.stringify({ caller_name: "Paul", message: "Rappeler pour le devis", urgent: true }) }] } }) });
  await new Promise((ok) => setTimeout(ok, 120));
  assert.equal(rows[0][3], "Rappeler pour le devis"); assert.equal(rows[0][2], "0612345678"); assert.match(mails[0].m.subject, /\[Urgent\] Message pris par le standardiste IA : Paul/);
  assert.ok(sent.some((x) => x.type === "conversation.item.create" && x.item.call_id === "c1"));
  assert.ok(Buffer.concat(got).length >= 3 + 320);   // la voix de l'IA est arrivée au moteur en trames de 20 ms
  // Transfert vers « Accueil »
  await sock.onmessage({ data: JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "transfer", call_id: "c2", arguments: '{"destination":1}' }] } }) });
  await new Promise((ok) => setTimeout(ok, 300));
  assert.deepEqual(amiCalls[0], { Action: "Redirect", Channel: "PJSIP/dstny-0001", Context: "cx-ai-out", Exten: "1", Priority: "1" });
  c.destroy(); r.close();
});
