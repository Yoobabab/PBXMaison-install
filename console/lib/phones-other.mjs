/**
 * Téléphones de bureau Fanvil, Snom et Grandstream : fichier de provisioning complet (compte, codecs, langue, heure,
 * mot de passe, provisioning quotidien, touches BLF / numérotation rapide), comme pour les Yealink.
 * Noms des réglages repris des modèles de provisioning publiés (Fanvil Auto Provision, Grandstream Provisioning Guide,
 * modèles Wazo et FusionPBX) ; marqués « à valider » tant qu'ils n'ont pas été essayés sur le matériel.
 * Fonctions pures, testées dans console/test/phones-other.test.mjs.
 */
import { TIMEZONES, LANGUAGES, TRANSPORTS } from "./phones.mjs";

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const nameOf = (user) => `${user.first_name || ""} ${user.last_name || ""}`.trim() || `Poste ${user.id}`;
const tzOf = (st) => TIMEZONES[st?.timezone] || TIMEZONES["Europe/Paris"];

/** Touches du poste → liste neutre : { kind: line|blf|speed, value, label, pickup } */
export function keyList(user, phone, names = new Map(), pickup = "**") {
  return (phone.keys || []).map((k) => {
    switch (k.type) {
      case "line": return { kind: "line", value: "", label: k.label || user.id };
      case "blf": return { kind: "blf", value: k.value, label: k.label || names.get(k.value) || k.value, pickup: true };
      case "status": return { kind: "blf", value: `status${user.id}`, label: k.label || "Ne pas déranger" };
      case "fwd": return { kind: "blf", value: `fwd${user.id}`, label: k.label || "Renvoi" };
      case "standard": return { kind: "blf", value: "standard", label: k.label || "Ouvert/Fermé" };
      case "speed": return { kind: "speed", value: k.value, label: k.label || k.value };
      default: return { kind: "none", value: "", label: "" };
    }
  }).map((k) => ({ ...k, pickupCode: pickup }));
}

// ------------------------------------------------------------------ Fanvil (firmware 2.x : XML <sysConf>)
/** Touches par page des écrans Fanvil (modèles Wazo) ; autres modèles : 6 */
const FANVIL_PER_PAGE = { "fanvil-v61": 4, "fanvil-v62": 5, "fanvil-v63": 5, "fanvil-v64": 7, "fanvil-v65": 9, "fanvil-v66": 9, "fanvil-v67": 29,
  "fanvil-x4u": 6, "fanvil-x5u": 6, "fanvil-x6u": 12, "fanvil-x210": 32, "fanvil-x7": 10, "fanvil-x7a": 10, "fanvil-x3u-pro": 6 };
export function buildFanvilXml(user, phone, secret, server, names = new Map()) {
  const st = phone.settings || {};
  const [, tzOffset, , dst] = tzOf(st);
  const [, transportCode, port] = TRANSPORTS[st.transport] || TRANSPORTS.udp;
  const vSeries = /^fanvil-v6/.test(phone.model || "");
  const lang = vSeries ? (st.language === "en" ? "0" : "5") : (st.language || "fr");
  const name = nameOf(user);
  const keys = keyList(user, phone, names, server.codes?.pickup || "**");
  const per = FANVIL_PER_PAGE[phone.model] || 6;
  const pages = [];
  keys.forEach((k, i) => {
    const page = Math.floor(i / per), idx = (i % per) + 1;
    const fk = k.kind === "line" ? [2, "SIP1"] : k.kind === "blf" ? [1, `${k.value}@1/ba${k.pickup ? `${k.pickupCode}${k.value}` : ""}`] : k.kind === "speed" ? [1, `${k.value}@1/f`] : [0, ""];
    (pages[page] ||= []).push(`      <Fkey index="${idx}"><Type>${fk[0]}</Type><Value>${xml(fk[1])}</Value><Title>${xml(k.label)}</Title></Fkey>`);
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Callikoe — poste ${xml(user.id)} (${xml(name)}) — ${xml(phone.model)} — généré le ${new Date().toISOString()}. Ne pas modifier : régénéré par le PBX. -->`,
    "<sysConf>",
    "  <Version>2.0002</Version>",
    "  <sip>",
    `    <SIPPort>${port}</SIPPort>`,
    // Message check-sync du PBX : relire la configuration sans redémarrer
    "    <NotifyReboot>0</NotifyReboot>",
    '    <line index="1">',
    `      <PhoneNumber>${xml(user.id)}</PhoneNumber>`,
    `      <DisplayName>${xml(name)}</DisplayName>`,
    `      <SipName>${xml(`${user.id} ${name}`.slice(0, 32))}</SipName>`,
    `      <RegisterAddr>${xml(server.host)}</RegisterAddr>`,
    `      <RegisterPort>${port}</RegisterPort>`,
    `      <RegisterUser>${xml(secret.auth_id)}</RegisterUser>`,
    `      <RegisterPswd>${xml(secret.password)}</RegisterPswd>`,
    "      <RegisterTTL>600</RegisterTTL>",
    "      <EnableReg>1</EnableReg>",
    `      <Transport>${transportCode === 2 ? 3 : transportCode}</Transport>`,
    "      <NATKeepAlive>1</NATKeepAlive>",
    "      <MWINum>*97</MWINum>",
    "      <VoiceCodecMap>G722,PCMA,PCMU</VoiceCodecMap>",
    "    </line>",
    "  </sip>",
    "  <mm><capability><AudioCodecSets>G722,PCMA,PCMU</AudioCodecSets></capability></mm>",
    "  <phone>",
    `    <display><DefaultLanguage>${lang}</DefaultLanguage></display>`,
    "    <date>",
    "      <EnableSNTP>1</EnableSNTP>",
    "      <SNTPServer>pool.ntp.org</SNTPServer>",
    `      <TimeZone>${Math.round(Number(tzOffset) * 4)}</TimeZone>`,
    `      <TimeZoneName>UTC${tzOffset}</TimeZoneName>`,
    ...(dst ? ["      <EnableDST>2</EnableDST>", "      <DSTFixedType>2</DSTFixedType>", "      <DSTMinOffset>60</DSTMinOffset>",
      "      <DSTStartMon>3</DSTStartMon><DSTStartWeek>-1</DSTStartWeek><DSTStartWday>0</DSTStartWday><DSTStartHour>2</DSTStartHour>",
      "      <DSTEndMon>10</DSTEndMon><DSTEndWeek>-1</DSTEndWeek><DSTEndWday>0</DSTEndWday><DSTEndHour>3</DSTEndHour>"] : ["      <EnableDST>0</EnableDST>"]),
    `      <TimeFormat>${st.time_format === "12" ? 0 : 1}</TimeFormat>`,
    "    </date>",
    "  </phone>",
    ...(phone.admin_password ? ["  <web>", `    <account index="1"><Name>admin</Name><Password>${xml(phone.admin_password)}</Password><Level>10</Level></account>`, "  </web>"] : []),
    "  <dsskey>",
    ...pages.map((list, p) => [`    <dssSide index="${p + 1}">`, ...list, "    </dssSide>"]).flat(),
    "  </dsskey>",
    "  <ap>",
    "    <DownloadCommonConf>0</DownloadCommonConf>",
    "    <DownloadDeviceConf>1</DownloadDeviceConf>",
    "    <SaveProvisionInfo>1</SaveProvisionInfo>",
    `    <FlashServerIP>${xml(server.prov_url)}</FlashServerIP>`,
    "    <FlashFileName>$mac.cfg</FlashFileName>",
    `    <FlashProtocol>${String(server.prov_url).startsWith("https") ? 5 : 4}</FlashProtocol>`,
    "    <FlashMode>1</FlashMode>",
    "    <FlashInterval>1</FlashInterval>",
    "  </ap>",
    "</sysConf>",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ Snom (firmware 10.x)
const SNOM_TZ = { "Europe/Paris": "FRA+1", "Europe/Monaco": "FRA+1", "Europe/Brussels": "BEL+1", "Europe/Luxembourg": "LUX+1", "Europe/Zurich": "CHE+1" };
const SNOM_LANG = { fr: "Français", en: "English", de: "Deutsch", es: "Español", it: "Italiano", nl: "Nederlands" };
export function buildSnomPhoneXml(user, phone, secret, server, names = new Map()) {
  const st = phone.settings || {};
  const [, , port] = TRANSPORTS[st.transport] || TRANSPORTS.udp;
  const tr = st.transport === "tls" ? "tls" : st.transport === "tcp" ? "tcp" : "udp";
  const name = nameOf(user);
  const lang = SNOM_LANG[st.language] || "Français";
  const s = (tag, val, extra = "") => ` <${tag}${extra} perm="R">${xml(val)}</${tag}>`;
  const keys = keyList(user, phone, names, server.codes?.pickup || "**").map((k, i) => {
    const v = k.kind === "line" ? "line" : k.kind === "blf" ? `blf sip:${k.value}@${server.host}${k.pickup ? `|${k.pickupCode}` : ""}` : k.kind === "speed" ? `speed ${k.value}` : "none";
    return `  <fkey idx="${i}" context="${k.kind === "line" ? 1 : "active"}" label="${xml(k.label)}" perm="R">${xml(v)}</fkey>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Callikoe — poste ${xml(user.id)} (${xml(name)}) — ${xml(phone.model)} — généré le ${new Date().toISOString()} -->`,
    "<settings>",
    "<phone-settings>",
    ` <setting_server perm="RW">${xml(server.prov_url)}{mac}.xml</setting_server>`,
    s("update_policy", "auto_update"), s("settings_refresh_timer", 86400),
    s("user_active", "on", ' idx="1"'), s("user_realname", name, ' idx="1"'), s("user_name", user.id, ' idx="1"'), s("user_pname", secret.auth_id, ' idx="1"'),
    s("user_pass", secret.password, ' idx="1"'), s("user_host", `${server.host}:${port}`, ' idx="1"'), s("user_outbound", `${server.host}:${port};transport=${tr}`, ' idx="1"'),
    s("user_expiry", 600, ' idx="1"'), s("user_mailbox", "*97", ' idx="1"'), s("codec_priority_list", "g722,pcma,pcmu,telephone-event", ' idx="1"'),
    s("language", lang), s("web_language", lang), s("tone_scheme", "FRA"), s("timezone", SNOM_TZ[st.timezone] || "FRA+1"), s("ntp_server", "pool.ntp.org"),
    ...(/^snom-d8/.test(phone.model || "") ? [s("locale", st.language === "en" ? "en_US" : "fr_FR")] : []),
    ...(phone.admin_password ? [s("http_user", "admin"), s("http_pass", phone.admin_password), s("admin_mode_password", phone.admin_password)] : []),
    "</phone-settings>",
    "<functionKeys>", ...keys, "</functionKeys>",
    "</settings>",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ Grandstream GRP261x et + / GXP21xx (format « alias », config version 2)
const GS_KEYMODE = { line: "Line", blf: "BLF", speed: "SpeedDial", none: "None" };
const GS_LANG = { fr: "fr", en: "en", de: "de", es: "es", it: "it", nl: "nl" };
/** Les GRP260x n'ont que le format « P » (passerelles et anciens modèles : devices.mjs) */
export const grandstreamAlias = (model) => !/^grandstream-grp260/.test(model || "");
export function buildGrandstreamPhoneXml(user, phone, secret, server, names = new Map()) {
  const st = phone.settings || {};
  const [, , port] = TRANSPORTS[st.transport] || TRANSPORTS.udp;
  const name = nameOf(user);
  const it = (n, v) => `  <item name="${n}">${xml(v)}</item>`;
  const keys = keyList(user, phone, names, server.codes?.pickup || "**").flatMap((k, i) => {
    const p = `pks.vpk.${i + 1}`;
    return [it(`${p}.keyMode`, GS_KEYMODE[k.kind]), it(`${p}.account`, "Account1"), it(`${p}.description`, k.label), it(`${p}.value`, k.kind === "line" ? "" : k.value)];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Callikoe — poste ${xml(user.id)} (${xml(name)}) — ${xml(phone.model)} — généré le ${new Date().toISOString()} -->`,
    '<gs_provision version="1">',
    ...(phone.mac ? [`<mac>${xml(phone.mac)}</mac>`] : []),
    '<config version="2">',
    it("account.1.enable", "Yes"), it("account.1.name", `${user.id} ${name}`.slice(0, 32)), it("account.1.sip.server.1.address", `${server.host}:${port}`),
    it("account.1.sip.userid", user.id), it("account.1.sip.subscriber.userid", secret.auth_id), it("account.1.sip.subscriber.password", secret.password),
    it("account.1.sip.subscriber.name", name), it("account.1.sip.voicemail.number", "*97"), it("account.1.sip.registration", "Yes"),
    it("account.1.sip.registerExpiration", 10), it("account.1.sip.transport", st.transport === "tcp" ? "TCP" : st.transport === "tls" ? "TlsOrTcp" : "UDP"),
    it("account.1.codec.choice.1", "G.722"), it("account.1.codec.choice.2", "PCMA"), it("account.1.codec.choice.3", "PCMU"),
    it("account.1.sip.blf.callPickup.prefix", server.codes?.pickup || "**"),
    it("dateTime.timezone", "CET-1CEST-2,M3.5.0/02:00:00,M10.5.0/03:00:00"), it("dateTime.ntp.server.1", "pool.ntp.org"),
    it("language.gui", GS_LANG[st.language] || "fr"),
    ...(phone.admin_password ? [it("users.admin.password", phone.admin_password)] : []),
    it("provisioning.config.protocol", String(server.prov_url).startsWith("https") ? "HTTPS" : "HTTP"),
    it("provisioning.config.serverPath", String(server.prov_url).replace(/^https?:\/\//, "")),
    it("provisioning.auto.mode", "YesUpgradeHourOfDay"), it("provisioning.auto.hour", 2), it("provisioning.auto.endHour", 4), it("provisioning.auto.randomTime.enable", "Yes"),
    ...keys,
    "</config>",
    "</gs_provision>",
    "",
  ].join("\n");
}
