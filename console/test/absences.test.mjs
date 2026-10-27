import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAbsence, absenceStep, absenceLabel, localDate } from "../lib/absences.mjs";

const users = new Map([["201", "Julie"], ["202", "Marc"]]);
const ctx = { selfId: "201", users, today: "2026-10-27" };

test("absences : contrôle de la saisie", () => {
  const a = validateAbsence({ start: "2026-11-03", end: "2026-11-14", dest: { type: "extension", target: "202" }, note: " Congés\n" }, ctx);
  assert.deepEqual(a, { start: "2026-11-03", end: "2026-11-14", dest: { type: "extension", target: "202" }, note: "Congés" });
  assert.equal(validateAbsence({ start: "2026-11-03", end: "2026-11-03", dest: { type: "external", target: "06 12 34 56 78" } }, ctx).dest.target, "0612345678");
  assert.equal(validateAbsence({ start: "2026-10-20", end: "2026-10-30", dest: { type: "voicemail" } }, ctx).dest.target, "");
  for (const [inp, msg] of [
    [{ start: "2026-02-30", end: "2026-03-01", dest: { type: "voicemail" } }, /début/],
    [{ start: "2026-11-14", end: "2026-11-03", dest: { type: "voicemail" } }, /avant le début/],
    [{ start: "2026-10-01", end: "2026-10-26", dest: { type: "voicemail" } }, /terminée/],
    [{ start: "2026-11-01", end: "2027-12-01", dest: { type: "voicemail" } }, /an/],
    [{ start: "2026-11-03", end: "2026-11-04", dest: { type: "extension", target: "201" } }, /lui-même/],
    [{ start: "2026-11-03", end: "2026-11-04", dest: { type: "extension", target: "999" } }, /collègue/],
    [{ start: "2026-11-03", end: "2026-11-04", dest: { type: "external", target: "0899123456" } }, /non autorisé/],
    [{ start: "2026-11-03", end: "2026-11-04", dest: { type: "hangup" } }, /où vont/],
  ]) assert.throws(() => validateAbsence(inp, ctx), msg);
});

test("absences : début, fin, libellé, date locale", () => {
  const a = { status: "planned", start: "2026-11-03", end: "2026-11-14" };
  assert.equal(absenceStep(a, "2026-11-02"), null);
  assert.equal(absenceStep(a, "2026-11-03"), "start");
  assert.equal(absenceStep({ ...a, status: "active" }, "2026-11-14"), null);
  assert.equal(absenceStep({ ...a, status: "active" }, "2026-11-15"), "end");
  assert.equal(absenceStep(a, "2026-11-20"), "skip");
  assert.equal(absenceLabel({ start: "2026-11-03", end: "2026-11-14", dest: { type: "extension", target: "202" } }, users), "du mar. 3 nov. au sam. 14 nov. → Marc (202)");
  assert.equal(absenceLabel({ start: "2026-11-03", end: "2026-11-03", dest: { type: "external", target: "0612345678" } }), "le mar. 3 nov. → 06 12 34 56 78");
  assert.equal(localDate(new Date("2026-10-27T23:30:00Z"), "Europe/Paris"), "2026-10-28");
});
