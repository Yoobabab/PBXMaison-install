/**
 * Alertes : détection des événements importants et réglages d'envoi par e-mail.
 * L'envoi des e-mails est préparé (réglages SMTP, destinataires, journal) mais pas encore activé :
 * chaque alerte est notée dans le journal avec l'état « e-mail en attente ».
 * Fonctions pures, testées dans console/test/alerts.test.mjs.
 */
import { UserError } from "./users.mjs";

/** id → [libellé, gravité, description] */
export const ALERT_EVENTS = {
  admin_login: ["Connexion à la console depuis une nouvelle adresse", "warning", "Quelqu'un s'est connecté à la console d'administration depuis une adresse IP jamais vue."],
  fraud: ["Plafond anti-fraude atteint", "critical", "Des appels externes ont été refusés parce que le plafond par heure (ou d'appels internationaux par jour) est dépassé : signe possible de piratage."],
  emergency: ["Numéro d'urgence composé", "critical", "Un poste a appelé le 15, 17, 18, 112, 114, 115, 119, 116000, 191, 196 ou 197."],
  trunk_down: ["Trunk désenregistré", "critical", "Un trunk n'est plus enregistré chez l'opérateur depuis plus de 2 minutes : plus d'appels entrants."],
  ip_banned: ["Adresse IP bloquée", "warning", "Une adresse IP a été bloquée après des échecs de connexion répétés (tentative d'intrusion)."],
  disk_full: ["Espace disque presque plein", "critical", "Le disque est rempli au-delà du seuil (enregistrements, messages vocaux, sauvegardes)."],
  gateway_down: ["Passerelle, base DECT ou SBC déconnecté", "warning", "Plus aucun port ou combiné de l'appareil n'est connecté depuis plus de 5 minutes."],
  service_down: ["Service critique arrêté", "critical", "Le moteur téléphonique, la base de données, le serveur web ou la protection anti-intrusion s'est arrêté."],
  license_expiring: ["Licence bientôt expirée", "warning", "La licence expire dans moins de 30 jours."],
  backup_failed: ["Sauvegarde en échec", "warning", "La sauvegarde automatique ou l'envoi vers le serveur FTP a échoué."],
};
export const SEVERITY = { critical: "Critique", warning: "Attention", info: "Information" };

export const CRITICAL_SERVICES = { asterisk: "Moteur téléphonique (Asterisk)", postgresql: "Base de données", nginx: "Serveur web", fail2ban: "Protection anti-intrusion" };

export function defaultAlerts() {
  return {
    recipients: [], events: Object.fromEntries(Object.keys(ALERT_EVENTS).map((k) => [k, true])), disk_threshold: 90,
    smtp: { host: "", port: 587, security: "starttls", user: "", password: "", from: "" },
  };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function validateAlerts(input, current = defaultAlerts()) {
  const a = { ...defaultAlerts(), ...current, events: { ...defaultAlerts().events, ...(current.events || {}) }, smtp: { ...defaultAlerts().smtp, ...(current.smtp || {}) } };
  if (input.recipients !== undefined) {
    const list = (Array.isArray(input.recipients) ? input.recipients : String(input.recipients).split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
    for (const e of list) if (!EMAIL.test(e)) throw new UserError(`Adresse e-mail invalide : ${e}.`, "recipients");
    a.recipients = [...new Set(list)].slice(0, 20);
  }
  if (input.events) for (const k of Object.keys(ALERT_EVENTS)) if (input.events[k] !== undefined) a.events[k] = !!input.events[k];
  if (input.disk_threshold !== undefined) {
    const n = Number(input.disk_threshold);
    if (!Number.isInteger(n) || n < 50 || n > 99) throw new UserError("Seuil d'espace disque : entre 50 et 99 %.", "disk_threshold");
    a.disk_threshold = n;
  }
  if (input.smtp) {
    const s = input.smtp;
    if (s.host !== undefined) {
      const h = String(s.host).trim();
      if (h && !/^[A-Za-z0-9.-]+$/.test(h)) throw new UserError("Serveur SMTP invalide.", "smtp.host");
      a.smtp.host = h;
    }
    if (s.port !== undefined) {
      const p = Number(s.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new UserError("Port SMTP invalide.", "smtp.port");
      a.smtp.port = p;
    }
    if (s.security !== undefined) a.smtp.security = ["starttls", "tls", "none"].includes(s.security) ? s.security : "starttls";
    if (s.user !== undefined) a.smtp.user = String(s.user).trim().slice(0, 120);
    if (s.password) a.smtp.password = String(s.password).slice(0, 200); // vide = inchangé
    if (s.from !== undefined) {
      const f = String(s.from).trim();
      if (f && !EMAIL.test(f)) throw new UserError("Adresse d'expédition invalide.", "smtp.from");
      a.smtp.from = f;
    }
  }
  return a;
}
/** Réglages renvoyés au navigateur : sans le mot de passe SMTP. */
export const publicAlerts = (a) => ({ ...a, smtp: { ...a.smtp, password: "", has_password: !!a.smtp.password } });

/**
 * Compare l'état courant au précédent et renvoie les nouvelles alertes.
 * state : { trunks: [{id, registered}], banned: [ip], disk: {pct}, services: {name: bool}, gateways: [{id, name, online}],
 *           emergencies: [{dst, src, at}], license_days: n|null, backup_error: "" }
 * prev  : état précédent (mêmes champs) + { since: {clé: horodatage} } pour les délais de grâce
 */
export function detectAlerts(state, prev = {}, now = Date.now()) {
  const out = [];
  const since = { ...(prev.since || {}) };
  const add = (event, text, key) => out.push({ event, severity: ALERT_EVENTS[event][1], title: ALERT_EVENTS[event][0], text, key });
  const grace = (key, bad, ms) => {
    if (!bad) { delete since[key]; return false; }
    if (!since[key]) since[key] = now;
    if (since[key] === -1) return false; // déjà signalé
    if (now - since[key] >= ms) { since[key] = -1; return true; }
    return false;
  };
  for (const t of state.trunks || []) if (grace(`trunk:${t.id}`, !t.registered, 120_000)) add("trunk_down", `Le trunk « ${t.id} » n'est plus enregistré chez l'opérateur.`, `trunk:${t.id}`);
  const before = new Set(prev.banned || []);
  for (const ip of state.banned || []) if (prev.banned && !before.has(ip)) add("ip_banned", `L'adresse ${ip} a été bloquée (échecs de connexion répétés).`, `ban:${ip}`);
  if (state.disk && grace("disk", state.disk.pct >= (state.disk_threshold || 90), 0)) add("disk_full", `Disque rempli à ${state.disk.pct} %.`, "disk");
  for (const [name, up] of Object.entries(state.services || {})) if (grace(`svc:${name}`, !up, 30_000)) add("service_down", `Service arrêté : ${CRITICAL_SERVICES[name] || name}.`, `svc:${name}`);
  for (const g of state.gateways || []) if (grace(`gw:${g.id}`, !g.online, 300_000)) add("gateway_down", `« ${g.name} » n'est plus connecté.`, `gw:${g.id}`);
  for (const e of state.emergencies || []) add("emergency", `Le poste ${e.src || "?"} a appelé le ${e.dst} (${e.at}).`, `sos:${e.at}:${e.src}`);
  if (state.license_days != null && grace("license", state.license_days <= 30, 0)) add("license_expiring", `La licence expire dans ${state.license_days} jour(s).`, "license");
  if (state.backup_error && grace("backup", true, 0)) add("backup_failed", state.backup_error, "backup");
  if (!state.backup_error) delete since.backup;
  return { alerts: out, since };
}
