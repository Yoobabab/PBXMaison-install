import { test } from "node:test";
import assert from "node:assert/strict";
import { guessFirmware, validateFirmware, validateRunAt, validatePhonesJob, validatePbxJob, phoneStep, sameVersion, phonesOutcome, firmwareParams, snomFirmwareStatus } from "../lib/schedupdates.mjs";

const models = [{ id: "yealink-t46u", label: "Yealink T46U", format: "yealink" }, { id: "yealink-t54w", label: "Yealink T54W", format: "yealink" },
  { id: "gs-gxp2170", label: "Grandstream GXP2170", format: "grandstream" }, { id: "fanvil-x4u", label: "Fanvil X4U", format: "fanvil" }];
const NOW = Date.parse("2026-11-04T10:00:00Z");

test("firmware : marque et version devinées d'après le nom du fichier", () => {
  assert.deepEqual(guessFirmware("T46U-108.86.0.75.rom"), { format: "yealink", version: "108.86.0.75", file: "T46U-108.86.0.75.rom" });
  assert.equal(guessFirmware("https://support.yealink.com/fw/T54W(T57W,T53W)-96.86.0.70.rom?x=1").version, "96.86.0.70");
  assert.equal(guessFirmware("gxp2170fw.bin").format, "grandstream");
  assert.deepEqual(guessFirmware("snomD785-10.1.159.12-SIP-r.bin"), { format: "snom", version: "10.1.159.12", file: "snomD785-10.1.159.12-SIP-r.bin" });
  assert.equal(guessFirmware("photo.jpg").format, "");
});

test("firmware : fiche de la bibliothèque", () => {
  assert.deepEqual(validateFirmware({ format: "yealink", models: ["yealink-t46u", "yealink-t46u"], version: " 108.86.0.75 " }, models),
    { format: "yealink", models: ["yealink-t46u"], version: "108.86.0.75", url: "", name: "Yealink 108.86.0.75" });
  for (const [inp, re] of [[{ format: "fanvil", models: ["fanvil-x4u"], version: "1" }, /non prise en charge/], [{ format: "yealink", models: [], version: "1" }, /au moins un modèle/],
    [{ format: "yealink", models: ["gs-gxp2170"], version: "1" }, /n'est pas un téléphone Yealink/], [{ format: "yealink", models: ["yealink-t46u"] }, /version/],
    [{ format: "yealink", models: ["yealink-t46u"], version: "1", url: "ftp://x/y.rom" }, /Lien invalide/]])
    assert.throws(() => validateFirmware(inp, models), re);
});

test("date de lancement : maintenant, plus tard, pas dans le passé ni trop loin", () => {
  assert.equal(validateRunAt("now", NOW), "2026-11-04T10:00:00.000Z");
  assert.equal(validateRunAt("2026-11-05T01:30:00.000Z", NOW), "2026-11-05T01:30:00.000Z");
  assert.throws(() => validateRunAt("2026-11-03T10:00:00Z", NOW), /passée/);
  assert.throws(() => validateRunAt("2027-06-01T10:00:00Z", NOW), /90/);
  assert.throws(() => validateRunAt("demain", NOW), /invalide/);
});

test("tâche téléphones : postes compatibles seulement", () => {
  const phones = [{ ext: "201", name: "Julie", mac: "805ec0aabbcc", model: "yealink-t46u" }, { ext: "202", mac: "805ec0ddeeff", model: "yealink-t54w", model_label: "Yealink T54W" }, { ext: "203", mac: "", model: "yealink-t46u" }];
  const firmwares = [{ id: "a1b2c3d4e5f6", name: "T46U 108.86", version: "108.86.0.75", models: ["yealink-t46u"] }];
  const j = validatePhonesJob({ firmware: "a1b2c3d4e5f6", targets: ["201"], run_at: "2026-11-05T01:00:00Z", window_min: 60 }, { phones, firmwares, now: NOW });
  assert.equal(j.kind, "phones"); assert.equal(j.window_min, 60); assert.equal(j.wait_calls, true);
  assert.deepEqual(j.payload.targets, [{ ext: "201", name: "Julie", mac: "805ec0aabbcc", model: "yealink-t46u", status: "waiting", fw: "a1b2c3d4e5f6", version: "108.86.0.75", fw_name: "T46U 108.86" }]);
  assert.throws(() => validatePhonesJob({ firmware: "a1b2c3d4e5f6", targets: ["201", "202", "203"] }, { phones, firmwares, now: NOW }), /202 \(Yealink T54W\), 203 \(pas de téléphone/);
  assert.throws(() => validatePhonesJob({ firmware: "zz", targets: ["201"] }, { phones, firmwares, now: NOW }), /bibliothèque/);
  assert.throws(() => validatePhonesJob({ firmware: "a1b2c3d4e5f6", targets: [] }, { phones, firmwares, now: NOW }), /au moins un téléphone/);
  assert.equal(validatePhonesJob({ firmware: "a1b2c3d4e5f6", targets: ["201"], window_min: 999 }, { phones, firmwares, now: NOW }).window_min, 120);
  assert.equal(validatePbxJob({ run_at: "2026-11-05T02:00:00Z", wait_calls: false }, { now: NOW }).wait_calls, false);
  assert.throws(() => validatePbxJob({}, { now: NOW, tenant: true }), /multi-tenant/);
});

test("étape par téléphone : attend la fin de l'appel, redémarre, constate la version", () => {
  const base = { now: NOW, end: NOW + 3600_000, waitCalls: true, version: "108.86.0.75", firmware: "108.86.0.70" };
  assert.deepEqual(phoneStep({ status: "waiting" }, { ...base, online: false }), { status: "waiting", send: false });
  assert.deepEqual(phoneStep({ status: "waiting" }, { ...base, online: true, busy: true }), { status: "waiting", send: false });
  assert.deepEqual(phoneStep({ status: "waiting" }, { ...base, online: true, busy: true, waitCalls: false }), { status: "sent", send: true });
  assert.deepEqual(phoneStep({ status: "waiting" }, { ...base, online: true, busy: false }), { status: "sent", send: true });
  assert.deepEqual(phoneStep({ status: "waiting" }, { ...base, online: true, firmware: "108.86.0.75" }), { status: "already", send: false });
  const sent = { status: "sent", sent_at: new Date(NOW - 5 * 60_000).toISOString() };
  assert.deepEqual(phoneStep(sent, { ...base, online: false }), { status: "sent", send: false });
  assert.deepEqual(phoneStep(sent, { ...base, online: true, firmware: "108.86.0.75" }), { status: "done", send: false });
  assert.deepEqual(phoneStep({ ...sent, sent_at: new Date(NOW - 25 * 60_000).toISOString() }, { ...base, online: true }), { status: "sent", send: true, retry: true });
  assert.deepEqual(phoneStep({ ...sent, retried: true, sent_at: new Date(NOW - 25 * 60_000).toISOString() }, { ...base, online: true }), { status: "sent", send: false });
  // Fin de la plage
  assert.equal(phoneStep(sent, { ...base, now: base.end, online: true }).status, "unchanged");
  assert.equal(phoneStep({ status: "waiting" }, { ...base, now: base.end, online: false }).status, "offline");
  assert.equal(phoneStep({ status: "waiting" }, { ...base, now: base.end, online: true, busy: true }).status, "busy");
});

test("versions, bilan et paramètres de provisioning", () => {
  assert.ok(sameVersion("108.86.0.75", "108.86.0.75")); assert.ok(sameVersion("V108.86.0.75", "108.86.0.75")); assert.ok(sameVersion("T46U-108.86.0.75", "108.86.0.75"));
  assert.ok(!sameVersion("108.86.0.70", "108.86.0.75")); assert.ok(!sameVersion("11.2.3", "1.2.3")); assert.ok(!sameVersion("", "1"));
  assert.deepEqual(phonesOutcome([{ status: "done" }, { status: "already" }]), { status: "done", ok: 2, total: 2 });
  assert.equal(phonesOutcome([{ status: "done" }, { status: "offline" }]).status, "partial");
  assert.equal(phonesOutcome([{ status: "unchanged" }]).status, "failed");
  const fw = { url: "http://pbx.ex.fr/prov/tok/fw/a1/T46U-108.86.0.75.rom", dir: "https://pbx.ex.fr/prov/tok/fw/a1/", snom_status: "http://pbx.ex.fr/prov/tok/fw/a1/snom-firmware.xml" };
  assert.deepEqual(firmwareParams("yealink", fw), [["static.firmware.url", fw.url]]);
  assert.deepEqual(firmwareParams("grandstream", fw), [["provisioning.firmware.protocol", "HTTPS"], ["provisioning.firmware.serverPath", "pbx.ex.fr/prov/tok/fw/a1"]]);
  assert.deepEqual(firmwareParams("snom", fw), [["firmware_status", fw.snom_status]]);
  assert.deepEqual(firmwareParams("yealink", null), []);
  assert.match(snomFirmwareStatus("http://x/a.bin?a=1&b=2"), /<firmware perm="">http:\/\/x\/a\.bin\?a=1&amp;b=2<\/firmware>/);
});

test("le plus récent : comparaison de versions et choix par modèle", async () => {
  const { cmpVersion, bestFirmware, needsUpdate } = await import("../lib/schedupdates.mjs");
  assert.ok(cmpVersion("96.86.0.80", "96.86.0.75") > 0); assert.ok(cmpVersion("96.86.0.100", "96.86.0.75") > 0); assert.equal(cmpVersion("1.2.0", "1.2"), 0);
  const fws = [{ id: "lib1", models: ["yealink-t54w"], version: "96.86.0.75" }, { id: "cat:x", models: ["yealink-t54w", "yealink-t57w"], version: "96.86.0.80", url: "https://x/a.rom" }];
  assert.equal(bestFirmware("yealink-t54w", fws).id, "cat:x"); assert.equal(bestFirmware("yealink-t46u", fws), null);
  assert.ok(needsUpdate("96.86.0.70", fws[1])); assert.ok(!needsUpdate("96.86.0.80", fws[1])); assert.ok(!needsUpdate("96.86.0.85", fws[1])); assert.ok(needsUpdate("", fws[1]));
  assert.ok(needsUpdate("T54W-96.86.0.70", fws[1]));
  const phones = [{ ext: "201", mac: "a", model: "yealink-t57w", current: "96.86.0.70" }, { ext: "310", mac: "b", model: "yealink-t54w", current: "96.86.0.80" }, { ext: "203", mac: "c", model: "yealink-t46u", current: "108" }];
  const j = validatePhonesJob({ mode: "latest", targets: ["201", "310"] }, { phones, firmwares: fws, now: NOW });
  assert.equal(j.payload.mode, "latest");
  assert.deepEqual(j.payload.targets.map((t) => [t.ext, t.status, t.fw, t.version, t.url || ""]), [["201", "waiting", "cat:x", "96.86.0.80", "https://x/a.rom"], ["310", "already", "cat:x", "96.86.0.80", "https://x/a.rom"]]);
  assert.throws(() => validatePhonesJob({ mode: "latest", targets: ["310"] }, { phones, firmwares: fws, now: NOW }), /déjà la version la plus récente/);
  assert.throws(() => validatePhonesJob({ mode: "latest", targets: ["203"] }, { phones, firmwares: fws, now: NOW }), /aucun firmware connu/);
  // Mode fichier : même firmware pour tous, version par téléphone
  const f = validatePhonesJob({ firmware: "lib1", targets: ["310"] }, { phones, firmwares: fws, now: NOW });
  assert.deepEqual([f.payload.mode, f.payload.targets[0].fw, f.payload.targets[0].version, f.payload.targets[0].status], ["file", "lib1", "96.86.0.75", "waiting"]);
});
