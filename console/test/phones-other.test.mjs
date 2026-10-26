import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFanvilXml, buildSnomPhoneXml, buildGrandstreamPhoneXml, grandstreamAlias, keyList } from "../lib/phones-other.mjs";
import { parseXml, kid, kids, txt } from "../lib/xmlmini.mjs";

const user = { id: "201", first_name: "Sophie", last_name: "Durand & Co" };
const phone = (model) => ({ model, mac: "0c383e775436", admin_password: "Adm1n<pw>", settings: { language: "fr", timezone: "Europe/Paris", transport: "udp", time_format: "24" },
  keys: [{ type: "line" }, { type: "blf", value: "202" }, { type: "speed", value: "0612345678", label: "Mobile" }, { type: "status" }] });
const secret = { auth_id: "aBc123", password: "s3cr&t" };
const server = { host: "pbx.example.fr", prov_url: "http://pbx.example.fr/prov/tok/", codes: { pickup: "**" } };
const names = new Map([["202", "Paul"]]);

test("touches : BLF avec interception, statut, numérotation rapide", () => {
  const k = keyList(user, phone("x"), names, "*8");
  assert.deepEqual(k.map((x) => [x.kind, x.value, x.label]), [["line", "", "201"], ["blf", "202", "Paul"], ["speed", "0612345678", "Mobile"], ["blf", "status201", "Ne pas déranger"]]);
});

test("Fanvil : XML sysConf (compte, codecs, heure de Paris, touches, provisioning)", () => {
  const x = parseXml(buildFanvilXml(user, phone("fanvil-v61"), secret, server, names));
  assert.equal(x.tag, "sysConf");
  const line = kid(x, "sip/line");
  assert.equal(txt(line, "PhoneNumber"), "201"); assert.equal(txt(line, "RegisterUser"), "aBc123"); assert.equal(txt(line, "RegisterPswd"), "s3cr&t");
  assert.equal(txt(line, "DisplayName"), "Sophie Durand & Co"); assert.equal(txt(line, "Transport"), "0");
  assert.equal(txt(x, "phone/date/TimeZone"), "4"); assert.equal(txt(x, "phone/date/EnableDST"), "2");
  assert.equal(txt(x, "phone/display/DefaultLanguage"), "5");   // série V : français = 5
  assert.equal(txt(x, "ap/FlashServerIP"), server.prov_url); assert.equal(txt(x, "ap/FlashFileName"), "$mac.cfg");
  const fk = kids(kid(x, "dsskey"), "dssSide").flatMap((p) => kids(p, "Fkey"));
  assert.deepEqual(fk.map((k) => [txt(k, "Type"), txt(k, "Value")]), [["2", "SIP1"], ["1", "202@1/ba**202"], ["1", "0612345678@1/f"], ["1", "status201@1/ba"]]);
  assert.equal(kids(kid(x, "dsskey"), "dssSide").length, 1);   // V61W : 4 touches par page
  assert.equal(txt(parseXml(buildFanvilXml(user, phone("fanvil-x4u"), secret, server, names)), "phone/display/DefaultLanguage"), "fr");
});

test("Snom : réglages, langue, fuseau, touches BLF", () => {
  const t = buildSnomPhoneXml(user, phone("snom-d785"), secret, server, names);
  const x = parseXml(t), ps = kid(x, "phone-settings");
  const get = (tag) => ps.children.find((c) => c.tag === tag)?.text;
  assert.equal(get("user_name"), "201"); assert.equal(get("user_pname"), "aBc123"); assert.equal(get("user_pass"), "s3cr&t");
  assert.equal(get("user_host"), "pbx.example.fr:5060"); assert.equal(get("timezone"), "FRA+1"); assert.equal(get("language"), "Français");
  assert.equal(get("setting_server"), "http://pbx.example.fr/prov/tok/{mac}.xml");
  assert.deepEqual(kids(kid(x, "functionKeys"), "fkey").map((k) => k.text), ["line", "blf sip:202@pbx.example.fr|**", "speed 0612345678", "blf sip:status201@pbx.example.fr"]);
});

test("Grandstream : format alias (GRP261x), touches VPK ; GRP260x au format P", () => {
  const x = parseXml(buildGrandstreamPhoneXml(user, phone("grandstream-grp2614"), secret, server, names));
  const items = Object.fromEntries(kids(kid(x, "config"), "item").map((i) => [i.attrs.name, i.text]));
  assert.equal(items["account.1.sip.userid"], "201"); assert.equal(items["account.1.sip.subscriber.userid"], "aBc123");
  assert.equal(items["account.1.sip.subscriber.password"], "s3cr&t"); assert.equal(items["provisioning.config.serverPath"], "pbx.example.fr/prov/tok/");
  assert.equal(items["pks.vpk.2.keyMode"], "BLF"); assert.equal(items["pks.vpk.2.value"], "202"); assert.equal(items["pks.vpk.3.keyMode"], "SpeedDial");
  assert.equal(grandstreamAlias("grandstream-grp2602"), false); assert.equal(grandstreamAlias("grandstream-grp2614"), true);
});
