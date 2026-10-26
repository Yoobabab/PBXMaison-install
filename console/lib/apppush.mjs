/**
 * Appli mobile : sonnerie même quand l'appli est fermée.
 *
 * À chaque appel vers un poste qui a l'appli, le plan de numérotation passe par [cx-app] (une branche de plus dans le Dial) :
 *   1. il demande à la console /internal/app-call : appli au premier plan → on la fait sonner tout de suite ;
 *      sinon la console envoie une notification « appel entrant » (iPhone : VoIP / CallKit, Android : FCM) à chaque téléphone du poste ;
 *   2. le téléphone se réveille, affiche la sonnerie du système, se connecte au PBX (poste <n>-app) et prévient la console (/app/ready) ;
 *   3. le plan de numérotation, qui attendait (20 s au plus), fait alors sonner l'appli.
 * Les clés Apple et Google ne sont jamais sur le PBX : le portail donne des autorisations temporaires (relais, comme l'IA).
 * Fonctions pures testées dans console/test/apppush.test.mjs.
 */
import crypto from "node:crypto";
import http2 from "node:http2";

export const RING_WAIT_S = 20;
const FOREGROUND_MS = 75_000;   // appli « au premier plan » si elle a donné signe de vie depuis moins de 75 s

/** Contenu de la notification d'appel entrant (format attendu par expo-callkit-telecom, iOS et Android) */
export function incomingCallEvent({ call, num, name, ext, pbx, host = "" }) {
  const n = String(num || "").replace(/[^\d+*#]/g, "").slice(0, 32);
  return { eventId: crypto.randomUUID(), serverCallId: String(call), hasVideo: false, startedAt: new Date().toISOString(),
    caller: { id: n || "inconnu", displayName: String(name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || n || "Appel entrant", ...(n.startsWith("+") ? { phoneNumber: n } : {}) },
    metadata: { pbx: String(pbx || ""), ext: String(ext), host: String(host || "") } };   // host + ext : l'appli retrouve le bon compte
}
/** Requête FCM v1 (Android) : message de données prioritaire, lu par l'appli même fermée */
export function fcmMessage(token, event) {
  return { message: { token, android: { priority: "high", ttl: "30s" }, data: { messageType: "incomingCall", incomingCall: JSON.stringify(event) } } };
}

export function createAppPush({ db, relay, log = console, pbxName = () => "", pbxHost = () => "", fetchImpl = globalThis.fetch, connect = http2.connect, now = () => Date.now() }) {
  const seen = new Map();      // poste → dernier signe de vie de l'appli au premier plan
  const calls = new Map();     // appel → { ext, state, ready, at }
  let auth = null;             // autorisations du portail (APNs, FCM) gardées jusqu'à leur expiration

  const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
  async function deviceExt(deviceToken) {
    if (!deviceToken || String(deviceToken).length < 30) return null;
    const r = await db.query("UPDATE pbxmaison_app_devices SET last_used_at = now() WHERE token_hash = $1 RETURNING extension", [hash(deviceToken)]);
    return r.rows[0]?.extension || null;
  }
  async function setPushToken(deviceToken, { token, type, env }) {
    const ext = await deviceExt(deviceToken);
    if (!ext) return null;
    const t = String(token || "").trim();
    if (!["APNS_VOIP", "FCM"].includes(type) || !/^[\w:.\-]{20,400}$/.test(t)) throw Object.assign(new Error("Jeton de notification invalide."), { status: 400 });
    await db.query("UPDATE pbxmaison_app_devices SET push_token = NULL, push_type = NULL WHERE push_token = $1 AND token_hash <> $2", [t, hash(deviceToken)]);   // même téléphone réinscrit
    await db.query("UPDATE pbxmaison_app_devices SET push_token = $2, push_type = $3, apns_env = $4, push_at = now() WHERE token_hash = $1",
      [hash(deviceToken), t, type, env === "development" ? "development" : "production"]);
    return ext;
  }
  const pushTargets = async (ext) => (await db.query("SELECT token_hash, push_token, push_type, apns_env FROM pbxmaison_app_devices WHERE extension = $1 AND push_token IS NOT NULL", [String(ext)])).rows;
  /** Postes qui ont au moins un téléphone joignable par notification (repris dans AstDB : cxapp/<poste>) */
  const appExtensions = async () => (await db.query("SELECT DISTINCT extension FROM pbxmaison_app_devices WHERE push_token IS NOT NULL")).rows.map((r) => r.extension);

  const presence = (ext, state) => { if (state === "background") seen.delete(String(ext)); else seen.set(String(ext), now()); };
  const foreground = (ext) => now() - (seen.get(String(ext)) || 0) < FOREGROUND_MS;

  async function getAuth() {
    if (auth && auth.until > now()) return auth;
    const r = await relay("/v1/push/auth", {});
    auth = { apns: r.apns || null, fcm: r.fcm || null, until: now() + Math.max(60, Number(r.ttl) || 1800) * 1000 };
    return auth;
  }
  function apnsSend(a, dev, event) {
    return new Promise((resolve) => {
      const host = dev.apns_env === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
      let s; try { s = connect(host); } catch (e) { resolve({ ok: false, error: e.message }); return; }
      s.on("error", (e) => resolve({ ok: false, error: e.message }));
      const req = s.request({ ":method": "POST", ":path": `/3/device/${dev.push_token}`, authorization: `bearer ${a.jwt}`, "apns-topic": a.topic,
        "apns-push-type": "voip", "apns-priority": "10", "apns-expiration": "0", "content-type": "application/json" });
      let status = 0, body = "";
      req.setTimeout(8000, () => { req.close(); });
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.on("data", (d) => { body += d; });
      req.on("close", () => { s.close(); resolve({ ok: status === 200, status, gone: status === 410 || /BadDeviceToken|Unregistered/.test(body), error: body.slice(0, 200) }); });
      req.end(JSON.stringify({ incomingCall: event }));
    });
  }
  async function fcmSend(a, dev, event) {
    try {
      const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, { method: "POST", signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${a.access_token}`, "content-type": "application/json" }, body: JSON.stringify(fcmMessage(dev.push_token, event)) });
      const body = await r.text();
      return { ok: r.ok, status: r.status, gone: r.status === 404 || /UNREGISTERED/.test(body), error: body.slice(0, 200) };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  /** Envoie la notification à tous les téléphones du poste ; renvoie le nombre de notifications acceptées */
  async function notify(ext, event) {
    const devs = await pushTargets(ext);
    if (!devs.length) return 0;
    let a; try { a = await getAuth(); } catch (e) { log.warn?.({ err: e.message }, "Appli : autorisation de notification refusée par le portail"); return 0; }
    let sent = 0;
    await Promise.all(devs.map(async (d) => {
      const r = d.push_type === "APNS_VOIP" ? (a.apns ? await apnsSend(a.apns, d, event) : { ok: false, error: "notifications iPhone pas encore activées sur le portail" })
        : a.fcm ? await fcmSend(a.fcm, d, event) : { ok: false, error: "notifications Android pas encore activées sur le portail" };
      if (r.ok) sent++;
      else {
        log.warn?.({ ext, status: r.status, err: r.error }, "Appli : notification d'appel non envoyée");
        if (r.gone) await db.query("UPDATE pbxmaison_app_devices SET push_token = NULL, push_type = NULL WHERE token_hash = $1", [d.token_hash]);   // appli désinstallée
        if (r.status === 403 || r.status === 401) auth = null;   // autorisation expirée : redemandée au prochain appel
      }
    }));
    return sent;
  }

  /** Début d'un appel vers le poste (plan de numérotation) : "dial" (appli déjà prête), "wait" (téléphone réveillé), "" (rien à faire) */
  async function startCall({ ext, call, num, name }) {
    for (const [k, c] of calls) if (now() - c.at > 120_000) calls.delete(k);
    ext = String(ext); call = String(call);
    if (foreground(ext)) { calls.set(call, { ext, state: "ringing", ready: true, at: now() }); return "dial"; }
    calls.set(call, { ext, state: "ringing", ready: false, at: now() });
    const sent = await notify(ext, incomingCallEvent({ call, num, name, ext, pbx: pbxName(), host: pbxHost() }));
    if (!sent) { calls.delete(call); return ""; }
    return "wait";
  }
  const poll = (call) => (calls.get(String(call))?.ready ? "ready" : "");
  const endCall = (call) => { const c = calls.get(String(call)); if (c) { c.state = "ended"; c.at = now(); } };
  /** L'appli réveillée est connectée au PBX : le plan de numérotation peut la faire sonner */
  const ready = (ext, call) => { const c = calls.get(String(call)); if (c && c.ext === String(ext)) { c.ready = true; return true; } return false; };
  /** Pour l'appli : l'appel sonne-t-il encore ? (sinon elle arrête la sonnerie du système) */
  const callState = (ext, call) => { const c = calls.get(String(call)); return c && c.ext === String(ext) ? c.state : "ended"; };

  return { deviceExt, setPushToken, appExtensions, presence, foreground, startCall, poll, endCall, ready, callState, notify, _calls: calls };
}
