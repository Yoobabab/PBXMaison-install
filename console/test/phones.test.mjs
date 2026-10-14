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
