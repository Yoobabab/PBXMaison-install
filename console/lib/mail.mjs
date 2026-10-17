/**
 * E-mails sortants du PBX : alertes et messages vocaux.
 * Serveur d'envoi réglé dans la console (Administration › Alertes › Réglages) : celui de l'entreprise, d'OVH, de Microsoft 365…
 * Le contenu des e-mails est construit par des fonctions pures, testées dans console/test/mail.test.mjs.
 */
import nodemailer from "nodemailer";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtNum = (n) => /^0\d{9}$/.test(n || "") ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : (n || "");
const fmtDur = (s) => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;

/** Serveur d'envoi prêt à servir ? */
export const smtpReady = (s) => !!(s?.host && s?.from);

/** Transport nodemailer depuis les réglages (STARTTLS 587, TLS 465, aucun chiffrement 25) */
export function transportOf(s) {
  return nodemailer.createTransport({
    host: s.host, port: s.port || 587, secure: s.security === "tls", requireTLS: s.security === "starttls", ignoreTLS: s.security === "none",
    auth: s.user ? { user: s.user, pass: s.password || "" } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

/** Erreur SMTP → phrase simple */
export function smtpError(e) {
  const m = String(e?.message || e || "");
  if (e?.code === "EAUTH" || /auth/i.test(m)) return "Identifiant ou mot de passe refusé par le serveur d'envoi.";
  if (e?.code === "ECONNECTION" || e?.code === "ETIMEDOUT" || /ECONNREFUSED|timeout|ENOTFOUND|EAI_AGAIN/i.test(m)) return "Serveur d'envoi injoignable : vérifie son adresse, le port et la sécurité.";
  if (/certificate|TLS|SSL/i.test(m)) return "Connexion sécurisée refusée : essaie l'autre réglage de sécurité (STARTTLS ou TLS).";
  if (/sender|from|relay/i.test(m)) return "Adresse d'expédition refusée par le serveur d'envoi.";
  return `Envoi refusé : ${m.slice(0, 160)}`;
}

/** E-mail d'un nouveau message vocal */
export function voicemailMail({ box, boxName, caller, callerName, at, duration, pbxName, tz = "Europe/Paris", attach = true }) {
  const who = callerName && caller ? `${callerName} (${fmtNum(caller)})` : callerName || fmtNum(caller) || "Numéro masqué";
  const when = at ? new Date(at).toLocaleString("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
  const subject = `Message vocal de ${who}${duration ? ` (${fmtDur(duration)})` : ""}`;
  const text = [`Nouveau message vocal pour ${boxName} (poste ${box}).`, "", `De : ${who}`, when ? `Le : ${when}` : "", duration ? `Durée : ${fmtDur(duration)}` : "",
    "", attach ? "Le message est en pièce jointe." : "Écoute-le depuis ton téléphone (*97), le softphone ou l'appli.", "", `— ${pbxName || "Callikoe"}`].filter((l) => l !== null).join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b1d24;max-width:520px">
  <p style="margin:0 0 14px">Nouveau message vocal pour <b>${esc(boxName)}</b> (poste ${esc(box)}).</p>
  <table style="border-collapse:collapse;font-size:15px">
    <tr><td style="padding:4px 14px 4px 0;color:#626977">De</td><td style="padding:4px 0"><b>${esc(who)}</b></td></tr>
    ${when ? `<tr><td style="padding:4px 14px 4px 0;color:#626977">Le</td><td style="padding:4px 0">${esc(when)}</td></tr>` : ""}
    ${duration ? `<tr><td style="padding:4px 14px 4px 0;color:#626977">Durée</td><td style="padding:4px 0">${esc(fmtDur(duration))}</td></tr>` : ""}
  </table>
  <p style="margin:16px 0 0">${attach ? "Le message est en pièce jointe." : "Écoute-le depuis ton téléphone (*97), le softphone ou l'appli."}</p>
  <p style="margin:22px 0 0;color:#626977;font-size:13px">${esc(pbxName || "Callikoe")}</p></div>`;
  return { subject, text, html };
}

/** E-mail d'alerte */
export function alertMail({ title, text, severity, at, pbxName, tz = "Europe/Paris" }) {
  const when = new Date(at || Date.now()).toLocaleString("fr-FR", { timeZone: tz, dateStyle: "short", timeStyle: "short" });
  const tag = severity === "critical" ? "[Critique] " : severity === "warning" ? "[Attention] " : "";
  return {
    subject: `${tag}${title} — ${pbxName || "Callikoe"}`,
    text: `${title}\n\n${text}\n\nLe ${when}, sur ${pbxName || "le PBX"}.\nJournal des alertes : console du PBX › Administration › Alertes.`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b1d24;max-width:560px"><p style="margin:0 0 6px;font-size:17px"><b>${esc(title)}</b></p>
      <p style="margin:0 0 14px">${esc(text)}</p><p style="margin:0;color:#626977;font-size:13px">Le ${esc(when)}, sur ${esc(pbxName || "le PBX")}. Journal : console › Administration › Alertes.</p></div>`,
  };
}

/** Messages à envoyer : récents (2 h), pas encore envoyés — on n'envoie jamais tout l'historique d'une boîte d'un coup */
export function messagesToMail(list, mailed, now = Date.now(), windowMs = 2 * 3600_000) {
  return list.filter((m) => m.folder === "new" && m.key && !mailed.has(m.key) && m.at && now - Date.parse(m.at) < windowMs);
}
