/**
 * Téléphones des autres marques (Fanvil, Snom, Grandstream), passerelles analogiques (ATA) et bases DECT.
 * Chaque port d'une passerelle ou combiné DECT est rattaché à un utilisateur : il utilise le compte SIP de cet utilisateur.
 * Les fichiers de provisioning marqués « à valider » n'ont pas encore été testés sur le matériel.
 * Fonctions pures, testées dans console/test/devices.test.mjs.
 */
import { UserError } from "./users.mjs";
/** Serveur SIP « hôte » ou « hôte:port » quand le PBX n'écoute pas sur 5060 (Snom, Grandstream). */
const hostPort = (server) => server.port && Number(server.port) !== 5060 ? `${server.host}:${server.port}` : server.host;
const normalizeMac = (input) => {
  if (!String(input ?? "").trim()) return "";
  const s = String(input).trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  return /^[0-9a-f]{12}$/.test(s) ? s : null;
};

// ------------------------------------------------------------------ Téléphones (liste compatible 3CX)
const ph = (brand, list, extra = {}) => list.map(([id, label, keys = 0, more = {}]) => ({ id: `${brand.toLowerCase()}-${id}`, brand, label: `${brand} ${label}`, keys, ...extra, ...more }));
export const OTHER_PHONES = [
  ...ph("Fanvil", [["x1sg", "X1S / X1SG", 0], ["x3sg", "X3SG / X3U", 2], ["x3u-pro", "X3U Pro", 6], ["x4u", "X4U / X4SG", 12], ["x5u", "X5U", 30],
    ["x6u", "X6U", 60], ["x7", "X7 / X7C", 40], ["x7a", "X7A", 40], ["x210", "X210 / X210i", 106], ["x301", "X301 / X301G", 2], ["x303", "X303 / X303G", 4],
    ["v61", "V61 / V61G", 2], ["v62", "V62 / V62 Pro", 6], ["v63", "V63", 6], ["v64", "V64", 12], ["v65", "V65", 30], ["v66", "V66", 24], ["v67", "V67", 30],
    ["h2u", "H2U / H3W / H5W", 0], ["x2p", "X2P", 0]], { format: "fanvil", status: "beta" }),
  ...ph("Snom", [["d712", "D712", 4], ["d713", "D713", 4], ["d715", "D715", 5], ["d717", "D717", 3], ["d735", "D735", 32], ["d785", "D785", 24],
    ["d812", "D812", 6], ["d815", "D815", 6], ["d862", "D862", 36], ["d865", "D865", 36]], { format: "snom", status: "beta" }),
  ...ph("Grandstream", [["grp2601", "GRP2601 / GRP2601P", 0], ["grp2602", "GRP2602 / GRP2602W", 4], ["grp2603", "GRP2603", 6], ["grp2604", "GRP2604", 10],
    ["grp2612", "GRP2612 / GRP2612W", 16], ["grp2613", "GRP2613", 24], ["grp2614", "GRP2614", 16], ["grp2615", "GRP2615", 40], ["grp2616", "GRP2616", 40],
    ["grp2624", "GRP2624", 48], ["grp2634", "GRP2634", 48], ["grp2636", "GRP2636", 48], ["grp2650", "GRP2650", 48], ["grp2670", "GRP2670", 48]], { format: "grandstream", status: "beta" }),
];

// ------------------------------------------------------------------ Passerelles et DECT
/**
 * ports : nombre de ports FXS (ATA) ou de combinés (DECT)
 * prov  : format du fichier généré, ou "manual" (configuration guidée dans la console)
 */
export const GATEWAY_MODELS = [
  { id: "gs-ht801", type: "ata", brand: "Grandstream", label: "Grandstream HT801", ports: 1, prov: "gs-ht", status: "beta" },
  { id: "gs-ht802", type: "ata", brand: "Grandstream", label: "Grandstream HT802", ports: 2, prov: "gs-ht", status: "beta" },
  { id: "gs-ht812", type: "ata", brand: "Grandstream", label: "Grandstream HT812", ports: 2, prov: "gs-ht", status: "beta" },
  { id: "gs-ht814", type: "ata", brand: "Grandstream", label: "Grandstream HT814", ports: 4, prov: "gs-ht", status: "beta" },
  { id: "gs-ht818", type: "ata", brand: "Grandstream", label: "Grandstream HT818", ports: 8, prov: "gs-ht", status: "beta" },
  { id: "gs-gxw4216", type: "ata", brand: "Grandstream", label: "Grandstream GXW4216", ports: 16, prov: "manual" },
  { id: "gs-gxw4224", type: "ata", brand: "Grandstream", label: "Grandstream GXW4224", ports: 24, prov: "manual" },
  { id: "gs-gxw4232", type: "ata", brand: "Grandstream", label: "Grandstream GXW4232", ports: 32, prov: "manual" },
  { id: "gs-gxw4248", type: "ata", brand: "Grandstream", label: "Grandstream GXW4248", ports: 48, prov: "manual" },
  { id: "patton-sn200-2", type: "ata", brand: "Patton", label: "Patton SmartNode SN200 (2 ports)", ports: 2, prov: "manual" },
  { id: "patton-sn200-4", type: "ata", brand: "Patton", label: "Patton SmartNode SN200 (4 ports)", ports: 4, prov: "manual" },
  { id: "patton-sn4141", type: "ata", brand: "Patton", label: "Patton Trinity SN4141", ports: 4, prov: "manual" },
  { id: "yl-w60b", type: "dect", brand: "Yealink", label: "Yealink W60B", ports: 8, prov: "yealink-dect" },
  { id: "yl-w70b", type: "dect", brand: "Yealink", label: "Yealink W70B", ports: 10, prov: "yealink-dect" },
  { id: "yl-w75dm", type: "dect", brand: "Yealink", label: "Yealink W75DM (multicellulaire)", ports: 100, prov: "yealink-dect" },
  { id: "yl-w80dm", type: "dect", brand: "Yealink", label: "Yealink W80DM (multicellulaire)", ports: 100, prov: "yealink-dect" },
  { id: "yl-w90dm", type: "dect", brand: "Yealink", label: "Yealink W90DM (multicellulaire)", ports: 250, prov: "yealink-dect" },
  { id: "snom-m300", type: "dect", brand: "Snom", label: "Snom M300", ports: 20, prov: "snom-dect", status: "beta" },
  { id: "snom-m400", type: "dect", brand: "Snom", label: "Snom M400", ports: 100, prov: "snom-dect", status: "beta" },
  { id: "snom-m500", type: "dect", brand: "Snom", label: "Snom M500", ports: 20, prov: "snom-dect", status: "beta" },
  { id: "snom-m900", type: "dect", brand: "Snom", label: "Snom M900 (multicellulaire)", ports: 200, prov: "snom-dect", status: "beta" },
  { id: "gig-n610", type: "dect", brand: "Gigaset", label: "Gigaset N610 IP PRO", ports: 20, prov: "manual" },
  { id: "gig-n670", type: "dect", brand: "Gigaset", label: "Gigaset N670 IP PRO", ports: 20, prov: "manual" },
  { id: "gig-n870", type: "dect", brand: "Gigaset", label: "Gigaset N870 IP PRO (multicellulaire)", ports: 250, prov: "manual" },
  { id: "gig-n870e", type: "dect", brand: "Gigaset", label: "Gigaset N870E IP PRO (multicellulaire)", ports: 250, prov: "manual" },
  { id: "fanvil-w710d", type: "dect", brand: "Fanvil", label: "Fanvil W710D", ports: 10, prov: "manual" },
];
export const GATEWAY_TYPES = { ata: "Passerelle analogique (fax, téléphones analogiques)", dect: "Base DECT (téléphones sans fil)" };
const gwModel = (id) => GATEWAY_MODELS.find((m) => m.id === id);

const clean = (s, max = 40) => String(s ?? "").replace(/[\r\n<>"&]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Valide une passerelle / base DECT.
 * ctx : { users: Set(id), macOwners: Map(mac → libellé), selfId, usedPorts: Map(user → libellé) }
 */
export function validateGateway(input, ctx) {
  const m = gwModel(input.model);
  if (!m) throw new UserError("Choisis le modèle.", "model");
  const g = { model: m.id, type: m.type, name: clean(input.name) || m.label, mac: "", ports: [] };
  const mac = normalizeMac(input.mac);
  if (mac === null) throw new UserError("Adresse MAC invalide (12 caractères hexadécimaux, ex. 00:0B:82:12:34:56).", "mac");
  if (mac && ctx.macOwners?.has(mac) && ctx.macOwners.get(mac) !== ctx.selfId) throw new UserError(`Cette adresse MAC est déjà utilisée (${ctx.macOwners.get(mac)}).`, "mac");
  g.mac = mac;
  const seen = new Set();
  for (const [i, p] of (Array.isArray(input.ports) ? input.ports : []).entries()) {
    const user = String(p?.user ?? "").trim();
    if (!user) continue;
    const port = Number(p?.port ?? i + 1);
    if (!Number.isInteger(port) || port < 1 || port > m.ports) throw new UserError(`${m.type === "dect" ? "Combiné" : "Port"} ${port} : n'existe pas sur ce modèle (${m.ports} au maximum).`, `ports.${i}`);
    if (!ctx.users.has(user)) throw new UserError(`${m.type === "dect" ? "Combiné" : "Port"} ${port} : utilisateur ${user} inconnu.`, `ports.${i}`);
    if (seen.has(user)) throw new UserError(`L'utilisateur ${user} est attribué deux fois.`, `ports.${i}`);
    const elsewhere = ctx.usedPorts?.get(user);
    if (elsewhere) throw new UserError(`L'utilisateur ${user} est déjà attribué (${elsewhere}).`, `ports.${i}`);
    seen.add(user);
    g.ports.push({ port, user, label: clean(p.label, 24) });
  }
  g.ports.sort((a, b) => a.port - b.port);
  return g;
}

// ------------------------------------------------------------------ Fichiers de provisioning
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Comptes : [{ index, user, name, auth_id, password }] ; server : { host, port, prov_url, tz, lang, admin_password }
 */
export function buildFanvilCfg(accounts, server) {
  const L = ["<<VOIP CONFIG FILE>>Version:2.0002", "", "<GLOBAL CONFIG MODULE>", `Time Zone Name      :${server.tz || "Europe/Paris"}`,
    "SNTP Server         :pool.ntp.org", "Enable SNTP         :1", "", "<SIP CONFIG MODULE>", "--SIP Line List--  :"];
  for (const a of accounts) {
    const p = `SIP${a.index}`;
    L.push(`${p} Phone Number       :${a.user}`, `${p} Display Name       :${clean(a.name)}`, `${p} Sip Name           :${clean(a.name)}`,
      `${p} Register Addr      :${server.host}`, `${p} Register Port      :${server.port || 5060}`, `${p} Register User      :${a.auth_id}`,
      `${p} Register Pswd      :${a.password}`, `${p} Register TTL       :600`, `${p} Enable Reg         :1`, `${p} NAT Keep Alive     :1`, `${p} Voice Mail Number  :*97`);
  }
  L.push("", "<AUTOUPDATE CONFIG MODULE>", `Download Server IP  :${server.prov_url}`, "Auto Update         :1", "Auto Update Interval:1440",
    "", "<WEB CONFIG MODULE>", `Web Server Type     :0`, ...(server.admin_password ? [`--Web User List--  :`, `User1 Name          :admin`, `User1 Password      :${server.admin_password}`, `User1 Level         :10`] : []),
    "", "<<END OF FILE>>", "");
  return L.join("\n");
}

export function buildSnomXml(accounts, server) {
  const L = ['<?xml version="1.0" encoding="utf-8"?>', "<settings>", ' <phone-settings e="2">',
    ` <language perm="">${server.lang === "en" ? "English" : "Français"}</language>`, ` <timezone perm="">FRA+1</timezone>`, ` <ntp_server perm="">pool.ntp.org</ntp_server>`,
    ` <setting_server perm="RW">${xml(server.prov_url)}{mac}.xml</setting_server>`, ` <update_policy perm="">auto_update</update_policy>`,
    ...(server.admin_password ? [` <admin_mode_password perm="">${xml(server.admin_password)}</admin_mode_password>`, ` <http_user perm="">admin</http_user>`, ` <http_pass perm="">${xml(server.admin_password)}</http_pass>`] : [])];
  for (const a of accounts) {
    const i = a.index;
    L.push(` <user_active idx="${i}" perm="">on</user_active>`, ` <user_realname idx="${i}" perm="">${xml(a.name)}</user_realname>`,
      ` <user_name idx="${i}" perm="">${xml(a.user)}</user_name>`, ` <user_pname idx="${i}" perm="">${xml(a.auth_id)}</user_pname>`,
      ` <user_pass idx="${i}" perm="">${xml(a.password)}</user_pass>`, ` <user_host idx="${i}" perm="">${xml(hostPort(server))}</user_host>`,
      ` <user_mailbox idx="${i}" perm="">*97</user_mailbox>`, ` <user_expiry idx="${i}" perm="">600</user_expiry>`);
  }
  L.push(" </phone-settings>", "</settings>", "");
  return L.join("\n");
}

/** Grandstream (téléphones GRP et passerelles HT) : paramètres P. Profils / ports 1 et 2 au format HT80x. */
const GS_ACCOUNT_P = [
  { enable: 271, server: 47, user: 35, auth: 36, pass: 34, name: 3 },
  { enable: 401, server: 747, user: 735, auth: 736, pass: 734, name: 703 },
  { enable: 501, server: 502, user: 504, auth: 505, pass: 506, name: 507 },
  { enable: 601, server: 602, user: 604, auth: 605, pass: 606, name: 607 },
];
export function buildGrandstreamXml(mac, accounts, server, { maxAccounts = 4 } = {}) {
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<gs_provision version="1">', `  <mac>${mac}</mac>`, "  <config version=\"1\">",
    "    <P30>pool.ntp.org</P30>", "    <P64>CET-1CEST-2,M3.5.0/02:00:00,M10.5.0/03:00:00</P64>", `    <P237>${xml(server.prov_url.replace(/^https?:\/\//, ""))}</P237>`,
    `    <P212>${server.prov_url.startsWith("https") ? 2 : 1}</P212>`, "    <P194>1</P194>", "    <P193>1440</P193>",
    ...(server.admin_password ? [`    <P2>${xml(server.admin_password)}</P2>`] : [])];
  for (const a of accounts) {
    const p = GS_ACCOUNT_P[a.index - 1];
    if (!p || a.index > maxAccounts) continue;
    L.push(`    <P${p.enable}>1</P${p.enable}>`, `    <P${p.server}>${xml(hostPort(server))}</P${p.server}>`, `    <P${p.user}>${xml(a.user)}</P${p.user}>`,
      `    <P${p.auth}>${xml(a.auth_id)}</P${p.auth}>`, `    <P${p.pass}>${xml(a.password)}</P${p.pass}>`, `    <P${p.name}>${xml(a.name)}</P${p.name}>`);
  }
  L.push("  </config>", "</gs_provision>", "");
  return L.join("\n");
}

/** Bases DECT Yealink (W60B, W70B, W80DM…) : même format que les téléphones Yealink, un compte par combiné. */
export function buildYealinkDectCfg(accounts, server) {
  const v = (k, val) => `${k} = ${String(val ?? "").replace(/[\r\n]/g, " ")}`;
  const L = ["#!version:1.0.0.1", `## Callikoe — base DECT — généré le ${new Date().toISOString()}`, "",
    v("lang.gui", server.lang === "en" ? "English" : "French"), v("lang.wui", server.lang === "en" ? "English" : "French"),
    v("local_time.time_zone", "+1"), v("local_time.time_zone_name", "France(Paris)"), v("local_time.ntp_server1", "pool.ntp.org"),
    v("static.auto_provision.server.url", server.prov_url), v("static.auto_provision.repeat.enable", 1), v("static.auto_provision.repeat.minutes", 1440),
    ...(server.admin_password ? [v("static.security.user_password", `admin:${server.admin_password}`)] : []), ""];
  for (const a of accounts) {
    const p = `account.${a.index}`;
    L.push(v(`${p}.enable`, 1), v(`${p}.label`, `${a.user} ${a.name}`.slice(0, 24)), v(`${p}.display_name`, a.name), v(`${p}.user_name`, a.user),
      v(`${p}.auth_name`, a.auth_id), v(`${p}.password`, a.password), v(`${p}.sip_server.1.address`, server.host), v(`${p}.sip_server.1.port`, server.port || 5060),
      v(`${p}.sip_server.1.expires`, 600), v(`${p}.nat.udp_update_enable`, 1), v(`handset.${a.index}.name`, a.name.slice(0, 12)),
      v(`handset.${a.index}.incoming_lines`, a.index), v(`handset.${a.index}.dial_out_default_line`, a.index), v(`voice_mail.number.${a.index}`, "*97"), "");
  }
  return L.join("\n");
}

/** Fichier attendu par chaque format : nom de fichier → { format, mac } ou null */
export function provRequest(file) {
  let m;
  if ((m = /^([0-9a-f]{12})\.cfg$/i.exec(file))) return { kind: "cfg", mac: m[1].toLowerCase() };
  if ((m = /^cfg([0-9a-f]{12})(?:\.xml)?$/i.exec(file))) return { kind: "gs", mac: m[1].toLowerCase() };
  if ((m = /^(?:snom\w*-)?([0-9a-f]{12})\.(?:xml|htm)$/i.exec(file))) return { kind: "snom", mac: m[1].toLowerCase() };
  return null;
}

/** Contenu pour une passerelle : accounts déjà résolus (identifiants SIP des utilisateurs). */
export function buildGatewayFile(g, accounts, server) {
  const m = gwModel(g.model);
  switch (m?.prov) {
    case "gs-ht": return buildGrandstreamXml(g.mac, accounts, server, { maxAccounts: Math.min(m.ports, 4) });
    case "yealink-dect": return buildYealinkDectCfg(accounts, server);
    case "snom-dect": return buildSnomXml(accounts, server);
    default: return null;
  }
}

/** Étapes de configuration manuelle (Gigaset, Patton, GXW…). */
export function manualGuide(g, server) {
  const m = gwModel(g.model);
  const brand = m?.brand;
  const common = [`Serveur SIP / registrar : ${server.host}, port ${server.port || 5060} (UDP)`, "Codecs : G.722, G.711 A-law (PCMA), G.711 µ-law", "Enregistrement toutes les 600 secondes"];
  if (brand === "Gigaset") return ["Ouvre l'interface web de la base (adresse IP affichée sur un combiné : Menu › Réglages › Système › Réseau local).",
    "Paramètres › Fournisseur / PBX : ajoute un profil « Autre fournisseur »", ...common, "Pour chaque combiné inscrit : Paramètres › Combinés › Ajouter, puis saisis l'identifiant et le mot de passe affichés ci-dessous."];
  if (brand === "Patton") return ["Ouvre l'interface web du SmartNode (Patton Configuration Wizard).", "Choisis « SIP Gateway » et le mode « FXS vers PBX ».", ...common, "Pour chaque port FXS : saisis l'identifiant et le mot de passe affichés ci-dessous."];
  return ["Ouvre l'interface web de l'appareil.", ...common, `Pour chaque ${m?.type === "dect" ? "combiné" : "port"} : saisis l'identifiant et le mot de passe affichés ci-dessous.`];
}
