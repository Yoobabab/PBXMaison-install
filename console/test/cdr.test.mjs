import test from "node:test";
import assert from "node:assert/strict";
import { summarize, forUser } from "../lib/cdr.mjs";

const T = (s) => `2026-10-15T09:00:${String(s).padStart(2, "0")}Z`;
const trunks = new Set(["dstny"]);

test("appel entrant vers un groupe : répondu par 202, 201 a sonné", () => {
  const rows = [
    { linkedid: "L1", uniqueid: "L1", calldate: T(0), enddate: T(40), clid: '"Client" <0612345678>', src: "0612345678", dst: "s", channel: "PJSIP/dstny-0001", dstchannel: "PJSIP/201-0002", disposition: "NO ANSWER", billsec: 0, did: "0465001540", direction: "in", lastapp: "Dial" },
    { linkedid: "L1", uniqueid: "L1", calldate: T(0), enddate: T(40), clid: '"Client" <0612345678>', src: "0612345678", dst: "s", channel: "PJSIP/dstny-0001", dstchannel: "PJSIP/202-web-0003", disposition: "ANSWERED", billsec: 30, did: "0465001540", direction: "in", lastapp: "Dial", rule: "Standard" },
  ];
  const [c] = summarize(rows, trunks);
  assert.equal(c.direction, "in");
  assert.equal(c.status, "answered");
  assert.equal(c.answered_by, "202");
  assert.deepEqual(c.rang, ["201", "202"]);
  assert.equal(c.talk, 30);
  assert.equal(c.rule, "Standard");
  assert.equal(forUser([c], "201")[0].status, "answered_elsewhere");
  assert.equal(forUser([c], "202")[0].status, "answered");
  assert.equal(forUser([c], "203").length, 0);
});

test("entrant manqué puis messagerie ; sortant ; interne", () => {
  const rows = [
    { linkedid: "L2", calldate: T(0), enddate: T(25), clid: "<0478000000>", channel: "PJSIP/dstny-0010", dstchannel: "PJSIP/201-0011", disposition: "NO ANSWER", billsec: 0, did: "0465001530", direction: "in", lastapp: "Dial" },
    { linkedid: "L2", calldate: T(20), enddate: T(25), clid: "<0478000000>", channel: "PJSIP/dstny-0010", dstchannel: "", disposition: "ANSWERED", billsec: 5, did: "0465001530", direction: "in", lastapp: "VoiceMail", lastdata: "201@default,u" },
    { linkedid: "L3", calldate: T(30), enddate: T(50), clid: '"Paul" <202>', channel: "PJSIP/202-0020", dstchannel: "PJSIP/dstny-0021", dst: "0612345678", disposition: "ANSWERED", billsec: 15, direction: "out", lastapp: "Dial" },
    { linkedid: "L4", calldate: T(51), enddate: T(55), clid: '"Paul" <202>', channel: "PJSIP/202-0030", dstchannel: "PJSIP/203-0031", dst: "203", disposition: "NO ANSWER", billsec: 0, lastapp: "Dial" },
  ];
  const calls = summarize(rows, trunks);
  const byId = Object.fromEntries(calls.map((c) => [c.id, c]));
  assert.equal(byId.L2.status, "voicemail");
  assert.equal(byId.L2.voicemail, "201");
  assert.equal(forUser(calls, "201").find((x) => x.id === "L2").status, "voicemail");
  assert.equal(byId.L3.direction, "out");
  assert.equal(byId.L3.external, "dstny");
  assert.equal(forUser(calls, "202").find((x) => x.id === "L3").number, "0612345678");
  assert.equal(byId.L4.direction, "internal");
  assert.equal(byId.L4.status, "missed");
  assert.equal(forUser(calls, "203")[0].status, "missed");
  assert.equal(forUser(calls, "203")[0].number, "202");
  assert.equal(calls[0].id, "L4"); // plus récent d'abord
});

test("journal : nom de l'appelant sans le numéro ajouté pour l'affichage", async () => {
  const { parseClid } = await import("../lib/cdr.mjs");
  assert.deepEqual(parseClid('"Jean Dupont - 0612345678" <0612345678>'), { name: "Jean Dupont", number: "0612345678" });
  assert.deepEqual(parseClid('"0612345678 - Jean Dupont" <0612345678>'), { name: "Jean Dupont", number: "0612345678" });
  assert.deepEqual(parseClid('"0612345678" <0612345678>'), { name: "", number: "0612345678" });
  assert.deepEqual(parseClid('"Jean - Paul" <0612345678>'), { name: "Jean - Paul", number: "0612345678" });
  assert.deepEqual(parseClid("0612345678"), { name: "", number: "0612345678" });
});
