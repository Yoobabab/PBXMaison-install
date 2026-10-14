import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listMessages, markRead, deleteMessage, audioPath, parseCallerId } from "../lib/voicemail.mjs";

function box() {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), "vm-"));
  const inbox = path.join(spool, "default", "201", "INBOX");
  fs.mkdirSync(inbox, { recursive: true });
  const add = (dir, n, cid, t) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `msg${n}.txt`), `;\n[message]\ncallerid=${cid}\norigtime=${t}\nduration=7\nmsg_id=${t}-${n}\n`);
    fs.writeFileSync(path.join(dir, `msg${n}.wav`), "RIFF");
  };
  add(inbox, "0000", '"Jean Dupont" <0612345678>', 1760000000);
  add(inbox, "0001", "<0478000000>", 1760001000);
  add(inbox, "0002", '"Bob" <202>', 1760002000);
  return { spool, inbox };
}

test("liste, écoute, lu et suppression avec renumérotation", () => {
  const { spool, inbox } = box();
  let list = listMessages("201", spool);
  assert.equal(list.length, 3);
  assert.equal(list[0].caller_name, "Bob"); // plus récent d'abord
  assert.equal(list[2].caller_number, "0612345678");
  assert.ok(audioPath("201", "INBOX/0001", spool).file.endsWith("msg0001.wav"));

  assert.equal(markRead("201", "INBOX/0000", spool), "Old/0000");
  assert.deepEqual(fs.readdirSync(inbox).sort(), ["msg0000.txt", "msg0000.wav", "msg0001.txt", "msg0001.wav"]);
  list = listMessages("201", spool);
  assert.equal(list.filter((m) => m.folder === "old").length, 1);

  deleteMessage("201", "INBOX/0000", spool);
  assert.deepEqual(fs.readdirSync(inbox).sort(), ["msg0000.txt", "msg0000.wav"]);
  assert.equal(listMessages("201", spool).length, 2);
});

test("chemins refusés", () => {
  const { spool } = box();
  assert.throws(() => audioPath("201", "../../etc/0000", spool));
  assert.throws(() => audioPath("../x", "INBOX/0000", spool));
  assert.throws(() => deleteMessage("201", "INBOX/9999", spool));
  assert.deepEqual(listMessages("999", spool), []);
});

test("numéro présenté", () => {
  assert.deepEqual(parseCallerId('"A B" <0102030405>'), { name: "A B", number: "0102030405" });
  assert.deepEqual(parseCallerId("0102030405"), { name: "", number: "0102030405" });
});
