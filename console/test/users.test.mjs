import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultUser, validateUser, nationalNumber, buildUsersDialplan, buildVoicemail, forwardSummary, fromRow, userOpts, ringsForGroups } from "../lib/users.mjs";

const ctx = (extra = {}) => ({ cc: "33", extensions: new Set(["201", "202", "203"]), didOwners: new Map(), ...extra });
const base = () => ({ ...defaultUser("201"), first_name: "Marie" });

test("numéros nationaux", () => {
  assert.equal(nationalNumber("06 12 34 56 78"), "0612345678");
  assert.equal(nationalNumber("+33 6 12 34 56 78"), "0612345678");
  assert.equal(nationalNumber("0033612345678"), "0612345678");
  assert.equal(nationalNumber("33612345678"), "0612345678");
  assert.equal(nationalNumber(""), "");
  assert.equal(nationalNumber("0044123456"), null);
  assert.equal(nationalNumber("06 12"), null);
  assert.equal(nationalNumber("abc"), null);
});

test("création : prénom ou nom obligatoire, PIN généré", () => {
  assert.throws(() => validateUser({}, defaultUser("201"), ctx()), /prénom ou un nom/);
  const u = validateUser({ first_name: "  Marie  ", last_name: "Dupont" }, defaultUser("201"), ctx());
  assert.equal(u.first_name, "Marie");
  assert.match(u.voicemail.pin, /^\d{6}$/);
});

test("renvois : validation des destinations", () => {
  const u = validateUser({ forwarding: { timeout: "25", no_answer: { type: "external", target: "06 12 34 56 78" }, busy: { type: "extension", target: "202" } } }, base(), ctx());
  assert.equal(u.forwarding.timeout, 25);
  assert.deepEqual(u.forwarding.no_answer, { type: "external", target: "0612345678" });
  assert.deepEqual(u.forwarding.busy, { type: "extension", target: "202" });
  assert.throws(() => validateUser({ forwarding: { busy: { type: "extension", target: "201" } } }, base(), ctx()), /lui-même/);
  assert.throws(() => validateUser({ forwarding: { busy: { type: "extension", target: "999" } } }, base(), ctx()), /Choisis/);
  assert.throws(() => validateUser({ forwarding: { busy: { type: "external", target: "0044 20 1234" } } }, base(), ctx()), /international/);
  assert.throws(() => validateUser({ forwarding: { busy: { type: "external", target: "0899 123 456" } } }, base(), ctx()), /surtaxés/);
  assert.throws(() => validateUser({ forwarding: { timeout: 2 } }, base(), ctx()), /5 à 120/);
  assert.throws(() => validateUser({ options: { ring_mobile: true } }, base(), ctx()), /mobile/);
});

test("SDA : format et unicité", () => {
  const u = validateUser({ dids: ["04 65 00 15 30", "+33465001531", ""] }, base(), ctx());
  assert.deepEqual(u.dids, ["0465001530", "0465001531"]);
  assert.throws(() => validateUser({ dids: ["0465001530"] }, base(), ctx({ didOwners: new Map([["0465001530", "202"]]) })), /déjà attribuée au poste 202/);
});

test("plan de numérotation généré", () => {
  const a = validateUser({ mobile: "0612345678", options: { ring_mobile: true }, dids: ["0465001530"], voicemail: { pin: "1234" } }, base(), ctx());
  const b = validateUser({ first_name: "Paul", status: "away", forwarding: { away: { type: "extension", target: "201" } } }, defaultUser("202"), ctx());
  const c = validateUser({ first_name: "Off", options: { disabled: true } }, defaultUser("203"), ctx());
  const conf = buildUsersDialplan([a, b, c]);
  assert.match(conf, /exten => 201,1,NoOp/);
  assert.match(conf, /Dial\(PJSIP\/201&PJSIP\/201-web&Local\/201@cx-app\/n&Local\/0612345678@user-external\/n,20,tTb\(pickup-mark\^s\^1\)\)/);
  assert.match(conf, /\[users-hints\]\nexten => 201,hint,PJSIP\/201&PJSIP\/201-web/);
  assert.match(conf, /n\(noanswer\),VoiceMail\(201@default,u\)/);
  assert.match(conf, /exten => 202,1.*\n.*\n.*\n same => n,Goto\(users,201,1\)/);
  assert.match(conf, /exten => 203[\s\S]*?Playback\(ss-noservice\)/);
  assert.match(conf, /\[did-map\]\nexten => 0465001530,1,Goto\(users,201,1\)/);
  assert.match(conf, /VoiceMailMain\(201@default,s\)/);
  assert.match(buildVoicemail([a, b]), /^201 => 1234,Marie,,,tz=paris$/m);
  assert.equal(userOpts(c), "USER_OPTS=,1");
  assert.equal(ringsForGroups(b), false);
  assert.equal(ringsForGroups(a), true);
});

test("résumé des renvois", () => {
  const b = validateUser({ first_name: "Paul", status: "away", forwarding: { away: { type: "external", target: "0612345678" } } }, defaultUser("202"), ctx());
  assert.deepEqual(forwardSummary(b), [{ level: "warn", text: "Absent : tout vers 06 12 34 56 78" }]);
});

test("ancienne fiche (nom seul) relue", () => {
  const u = fromRow({ id: "201", name: "Accueil", forwarding: {}, options: {}, voicemail: {} });
  assert.equal(u.first_name, "Accueil");
  assert.equal(u.forwarding.timeout, 20);
});
