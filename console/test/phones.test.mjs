import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPhone, validatePhone, normalizeMac, buildYealinkCfg, identifyDevice, connectionType } from "../lib/phones.mjs";

const ctx = { selfId: "201", macOwners: new Map([["805ec0000001", "205"]]), extensions: new Map([["201", "Marie"], ["202", "Paul"]]) };

test("adresse MAC", () => {
  assert.equal(normalizeMac("44:DB:D2:29:FA:7B"), "44dbd229fa7b");
  assert.equal(normalizeMac("44-db-d2-29-fa-7b"), "44dbd229fa7b");
  assert.equal(normalizeMac(""), "");
  assert.equal(normalizeMac("44:DB:D2"), null);
});

test("validation du téléphone", () => {
  assert.throws(() => validatePhone({ mac: "44dbd229fa7b" }, defaultPhone(), ctx), /modèle/);
  assert.throws(() => validatePhone({ model: "yealink-t57w", mac: "80:5E:C0:00:00:01" }, defaultPhone(), ctx), /poste 205/);
  const p = validatePhone({ model: "yealink-t57w", mac: "44:DB:D2:29:FA:7B", settings: { led: "both", backlight: "600", transfer: "blind" },
    keys: [{ type: "line" }, { type: "blf", value: "202" }, { type: "speed", value: "06 48 31", label: "Port" }, { type: "none" }] }, defaultPhone(), ctx);
  assert.equal(p.mac, "44dbd229fa7b");
  assert.equal(p.settings.backlight, 600);
  assert.equal(p.keys.length, 3);
  assert.deepEqual(p.keys[1], { type: "blf", value: "202", label: "Paul" });
  assert.match(p.admin_password, /^[A-Za-z0-9]{12}$/);
  assert.throws(() => validatePhone({ keys: [{ type: "blf", value: "999" }] }, defaultPhone(), ctx), /Touche 1/);
});

test("fichier Yealink", () => {
  const p = validatePhone({ model: "yealink-t57w", mac: "44dbd229fa7b", settings: { led: "missed", transfer: "attended" },
    keys: [{ type: "line" }, { type: "blf", value: "202" }] }, defaultPhone(), ctx);
  const cfg = buildYealinkCfg({ id: "201", first_name: "Marie", last_name: "D" }, p, { auth_id: "AbC", password: "pw" },
    { host: "pbx.exemple.fr", prov_url: "https://pbx.exemple.fr/prov/x/" });
  assert.match(cfg, /^#!version:1\.0\.0\.1/);
  assert.match(cfg, /^account\.1\.auth_name = AbC$/m);
  assert.match(cfg, /^lang\.gui = French$/m);
  assert.match(cfg, /^transfer\.dsskey_deal_type = 1$/m);
  assert.match(cfg, /^phone_setting\.mail_power_led_flash_enable = 0$/m);
  assert.match(cfg, /^phone_setting\.missed_call_power_led_flash\.enable = 1$/m);
  assert.match(cfg, /^linekey\.2\.type = 16$/m);
  assert.match(cfg, /^linekey\.29\.type = 0$/m);
});

test("reconnaissance des appareils", () => {
  assert.deepEqual(
    [identifyDevice("Yealink SIP-T57W 96.86.0.30 44:db:d2:29:fa:7b").kind, identifyDevice("Yealink SIP-T57W 96.86.0.30 44:db:d2:29:fa:7b").mac],
    ["phone", "44dbd229fa7b"]);
  assert.equal(identifyDevice("MicroSIP/3.21.3").kind, "pc");
  assert.equal(identifyDevice("Zoiper rv2.10.20.6 Android").kind, "mobile");
  assert.equal(identifyDevice("PBXMaison-Web/1.0").kind, "web");
  assert.equal(connectionType("192.168.1.20", "192.168.1.20").code, "local");
  assert.equal(connectionType("82.1.2.3", "192.168.1.20").code, "nat");
  assert.equal(connectionType("82.1.2.3", "82.1.2.3").code, "direct");
  assert.equal(connectionType("82.1.2.3", "10.0.0.2", [{ name: "Siège", ip: "82.1.2.3" }]).code, "sbc");
});

test("module d'extension : touches EXP50 provisionnées sur un T57W, refusé sur un T31", () => {
  const p = validatePhone({ model: "yealink-t57w", mac: "44dbd229fa7b", modules: [{ keys: [{ type: "none" }, { type: "blf", value: "202" }] }] }, defaultPhone(), ctx);
  assert.equal(p.modules[0].keys.length, 2);
  const cfg = buildYealinkCfg({ id: "201", first_name: "Marie", last_name: "D" }, p, { auth_id: "AbC", password: "pw" },
    { host: "pbx.exemple.fr", prov_url: "https://pbx.exemple.fr/prov/x/" });
  assert.match(cfg, /^expansion_module\.1\.key\.2\.type = 16$/m);
  assert.match(cfg, /^expansion_module\.1\.key\.2\.value = 202$/m);
  assert.match(cfg, /^expansion_module\.1\.key\.60\.type = 0$/m);
  assert.doesNotMatch(cfg, /^expansion_module\.2\./m);
  assert.throws(() => validatePhone({ model: "yealink-t31p", modules: [{ keys: [] }] }, defaultPhone(), ctx), /n'accepte pas de module/);
});

test("contactSource : adresse réelle du poste (PBX seul : Contact ; multi-tenant : Path de l'aiguilleur)", async () => {
  const { contactSource } = await import("../lib/phones.mjs");
  assert.deepEqual(contactSource({ uri: "sip:201@92.184.113.141:5060" }).slice(1, 3), ["92.184.113.141", "5060"]);
  const c = { uri: "sip:201@192.168.1.18:5060", path: "<sip:146.59.197.37;lr;received=sip:92.184.113.141:41234>" };
  assert.deepEqual(contactSource(c, true).slice(1, 3), ["92.184.113.141", "41234"]);
  assert.deepEqual(contactSource({ ...c, path: "<sip:1.2.3.4;lr;received=sip:92.184.113.141:5062%3Btransport%3Dtcp>" }, true).slice(1, 3), ["92.184.113.141", "5062"]);
  assert.deepEqual(contactSource({ ...c, path: "" }, true).slice(1, 3), ["192.168.1.18", "5060"]);
  assert.deepEqual(contactSource(c, false).slice(1, 3), ["192.168.1.18", "5060"]);
});

test("Surveillance : numéros vers l'étranger ou surtaxés", async () => {
  const { numberRisk, deviceCategory } = await import("../lib/watch.mjs");
  assert.equal(numberRisk("0048525223031"), "intl");
  assert.equal(numberRisk("+44 20 1234 5678"), "intl");
  assert.equal(numberRisk("+33612345678"), null);
  assert.equal(numberRisk("0612345678"), null);
  assert.equal(numberRisk("0899 12 34 56"), "premium");
  assert.equal(numberRisk("0825123456"), "premium");
  assert.equal(numberRisk("0800123456"), null);
  assert.equal(numberRisk("118712"), "premium");
  assert.equal(numberRisk("3949"), "premium");
  assert.equal(numberRisk("201"), null);
  assert.equal(numberRisk("15"), null);
  assert.equal(deviceCategory("phone"), "phone"); assert.equal(deviceCategory("mobile"), "app"); assert.equal(deviceCategory("web"), "softphone");
});

test("Téléphones supplémentaires d'un utilisateur : modèle, MAC unique", () => {
  const cur = { ...defaultPhone(), model: "yealink-t46u", mac: "44dbd229fa7b" };
  const p = validatePhone({ extra: [{ model: "yealink-t54w", mac: "44:DB:D2:00:00:01", label: "Atelier" }] }, cur, ctx);
  assert.deepEqual(p.extra, [{ model: "yealink-t54w", mac: "44dbd2000001", label: "Atelier" }]);
  assert.throws(() => validatePhone({ extra: [{ model: "yealink-t54w", mac: "44dbd229fa7b" }] }, cur, ctx), /déjà utilisée par ce poste/);
  assert.throws(() => validatePhone({ extra: [{ model: "yealink-t54w", mac: "805ec0000001" }] }, cur, ctx), /poste 205/);
  assert.throws(() => validatePhone({ extra: [{ model: "", mac: "44dbd2000001" }] }, cur, ctx), /modèle/);
  assert.equal(validatePhone({ extra: [] }, { ...cur, extra: [{ model: "yealink-t54w", mac: "44dbd2000001" }] }, ctx).extra.length, 0);
});
