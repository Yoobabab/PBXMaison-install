import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createAppPush, incomingCallEvent, fcmMessage } from "../lib/apppush.mjs";

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
function fakeDb(rows) {
  return { async query(sql, p) {
    if (sql.startsWith("UPDATE pbxmaison_app_devices SET last_used_at")) { const r = rows.find((x) => x.token_hash === p[0]); return { rows: r ? [{ extension: r.extension }] : [] }; }
    if (sql.includes("SET push_token = NULL, push_type = NULL WHERE push_token")) { for (const r of rows) if (r.push_token === p[0] && r.token_hash !== p[1]) r.push_token = null; return { rows: [] }; }
    if (sql.includes("SET push_token = $2")) { const r = rows.find((x) => x.token_hash === p[0]); Object.assign(r, { push_token: p[1], push_type: p[2], apns_env: p[3] }); return { rows: [] }; }
    if (sql.includes("SET push_token = NULL, push_type = NULL WHERE token_hash")) { const r = rows.find((x) => x.token_hash === p[0]); r.push_token = null; return { rows: [] }; }
    if (sql.startsWith("SELECT token_hash, push_token")) return { rows: rows.filter((x) => x.extension === p[0] && x.push_token) };
    if (sql.startsWith("SELECT DISTINCT extension")) return { rows: [...new Set(rows.filter((x) => x.push_token).map((x) => x.extension))].map((extension) => ({ extension })) };
    throw new Error(sql);
  } };
}
/** Faux serveur Apple (HTTP/2) : répond le code demandé */
function fakeApns(status, seen) {
  return (host) => {
    const s = new EventEmitter(); s.close = () => {};
    s.request = (h) => {
      const req = new EventEmitter();
      req.setTimeout = () => {}; req.close = () => {};
      req.end = (body) => { seen.push({ host, h, body: JSON.parse(body) }); setImmediate(() => { req.emit("response", { ":status": status }); if (status !== 200) req.emit("data", '{"reason":"BadDeviceToken"}'); req.emit("close"); }); };
      return req;
    };
    return s;
  };
}

test("appli : notification d'appel (format CallKit / Android), appli au premier plan, réveil puis « prête », fin d'appel", async () => {
  const ev = incomingCallEvent({ call: "1730.42", num: "+33612345678", name: "Boulangerie\nMartin", ext: "201", pbx: "Standard" });
  assert.equal(ev.serverCallId, "1730.42"); assert.equal(ev.caller.phoneNumber, "+33612345678"); assert.equal(ev.caller.displayName, "Boulangerie Martin");
  assert.equal(JSON.parse(fcmMessage("tok", ev).message.data.incomingCall).serverCallId, "1730.42");

  const rows = [{ token_hash: hash("d".repeat(40)), extension: "201" }, { token_hash: hash("e".repeat(40)), extension: "201" }];
  const seen = [], fcm = [];
  let t = 1_000_000;
  const push = createAppPush({ db: fakeDb(rows), relay: async () => ({ apns: { jwt: "J", topic: "fr.irtnetwork.callikoe.voip" }, fcm: { access_token: "A", project_id: "callikoe" }, ttl: 1800 }),
    connect: fakeApns(200, seen), fetchImpl: async (url, o) => { fcm.push({ url, body: JSON.parse(o.body) }); return new Response("{}", { status: 200 }); }, now: () => t, log: {} });
  // sans téléphone inscrit : rien
  assert.equal(await push.startCall({ ext: "201", call: "c0", num: "0612", name: "" }), "");
  await assert.rejects(push.setPushToken("d".repeat(40), { token: "court", type: "APNS_VOIP" }), /invalide/);
  assert.equal(await push.setPushToken("d".repeat(40), { token: "a".repeat(64), type: "APNS_VOIP", env: "development" }), "201");
  assert.equal(await push.setPushToken("e".repeat(40), { token: "fcm:" + "b".repeat(40), type: "FCM" }), "201");
  assert.equal(await push.setPushToken("x".repeat(40), { token: "a".repeat(64), type: "APNS_VOIP" }), null);   // appareil inconnu
  assert.deepEqual(await push.appExtensions(), ["201"]);
  // appli fermée : notifications (iPhone en bac à sable, Android), puis l'appli se dit prête
  assert.equal(await push.startCall({ ext: "201", call: "c1", num: "0612345678", name: "Paul" }), "wait");
  assert.equal(seen[0].host, "https://api.sandbox.push.apple.com"); assert.equal(seen[0].h["apns-push-type"], "voip"); assert.equal(seen[0].body.incomingCall.serverCallId, "c1");
  assert.match(fcm[0].url, /projects\/callikoe\/messages:send/); assert.equal(fcm[0].body.message.data.messageType, "incomingCall");
  assert.equal(push.poll("c1"), "");
  assert.equal(push.ready("202", "c1"), false);   // un autre poste ne peut pas répondre à sa place
  assert.equal(push.ready("201", "c1"), true); assert.equal(push.poll("c1"), "ready");
  assert.equal(push.callState("201", "c1"), "ringing"); push.endCall("c1"); assert.equal(push.callState("201", "c1"), "ended");
  // appli ouverte (signe de vie récent) : on la fait sonner directement ; passée en arrière-plan : de nouveau par notification
  push.presence("201", "active");
  assert.equal(await push.startCall({ ext: "201", call: "c2" }), "dial");
  t += 80_000;
  assert.equal(await push.startCall({ ext: "201", call: "c3" }), "wait");
  // appli désinstallée (Apple répond 410) : le jeton est oublié
  const gone = createAppPush({ db: fakeDb(rows), relay: async () => ({ apns: { jwt: "J", topic: "x.voip" }, ttl: 1800 }), connect: fakeApns(410, []), now: () => t, log: {} });
  rows[1].push_token = null;
  assert.equal(await gone.startCall({ ext: "201", call: "c4" }), "");
  assert.equal(rows[0].push_token, null);
});
