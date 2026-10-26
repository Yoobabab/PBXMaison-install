import { test } from "node:test";
import assert from "node:assert/strict";
import { voicemailMail, alertMail, messagesToMail, smtpReady, smtpError } from "../lib/mail.mjs";

test("e-mail de message vocal", () => {
  const m = voicemailMail({ box: "201", boxName: "Marie Durand", caller: "0612345678", callerName: "Paul", at: "2026-10-17T12:30:00Z", duration: 42, pbxName: "Standard Martin" });
  assert.equal(m.subject, "Message vocal de Paul (06 12 34 56 78) (0 min 42 s)");
  assert.match(m.text, /pièce jointe/); assert.match(m.html, /samedi 17 octobre/);
  const x = voicemailMail({ box: "201", boxName: "<script>", caller: "", at: null, duration: 0, attach: false });
  assert.match(x.subject, /Numéro masqué/); assert.doesNotMatch(x.html, /<script>/); assert.match(x.text, /\*97/);
});

test("e-mail d'alerte, choix des messages à envoyer, réglages", () => {
  assert.match(alertMail({ title: "Trunk décroché", text: "Unyc", severity: "critical", pbxName: "PBX" }).subject, /^\[Urgent\] Trunk décroché — PBX$/);
  const now = Date.parse("2026-10-17T12:00:00Z");
  const list = [
    { key: "a", folder: "new", at: "2026-10-17T11:50:00Z" },
    { key: "b", folder: "new", at: "2026-10-17T08:00:00Z" },    // trop ancien
    { key: "c", folder: "old", at: "2026-10-17T11:55:00Z" },    // déjà écouté
    { key: "d", folder: "new", at: "2026-10-17T11:59:00Z" },
  ];
  assert.deepEqual(messagesToMail(list, new Set(["d"]), now).map((m) => m.key), ["a"]);
  assert.equal(smtpReady({ host: "smtp.x.fr", from: "a@x.fr" }), true); assert.equal(smtpReady({ host: "" }), false);
  assert.match(smtpError({ code: "EAUTH" }), /refusé/);
});
