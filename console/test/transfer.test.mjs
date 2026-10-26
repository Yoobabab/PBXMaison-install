import { test } from "node:test";
import assert from "node:assert/strict";
import { readTable, writeCsv, usersRows, parseUsers, contactsRows, parseContacts, trunksRows, parseTrunks, outboundRows, parseOutbound,
  inboundRows, parseInbound, destText, parseDest } from "../lib/transfer.mjs";
import { defaultUser } from "../lib/users.mjs";

const user = (id, extra = {}) => {
  const u = { ...defaultUser(id), first_name: "Marie", last_name: "Durand", email: "marie@x.fr", mobile: "0612345678", dids: ["0123456789"],
    phone: { model: "yealink-t43u", mac: "44dbd229fa7b" } };
  u.options.role = "standard"; u.voicemail.pin = "1234"; u.voicemail.email = true;
  return Object.assign(u, extra);
};

test("CSV : écriture puis relecture (guillemets, point-virgule, virgule)", () => {
  const csv = writeCsv(["A", "B"], [['x;y', 'il dit "oui"'], ["1", ""]]);
  assert.ok(csv.startsWith("﻿"));
  const t = readTable(csv);
  assert.deepEqual(t.headers, ["A", "B"]); assert.deepEqual(t.rows, [['x;y', 'il dit "oui"'], ["1", ""]]);
  assert.equal(readTable(writeCsv(["A", "B"], [["a,b", "c"]], "3cx")).rows[0][0], "a,b");
  assert.throws(() => readTable(""), /vide/);
});

test("utilisateurs : aller-retour au format Callikoe", () => {
  const t = usersRows([user("201")]);
  assert.equal(t.rows[0][7], "Pilote"); assert.equal(t.rows[0][10], "Avec le message"); assert.equal(t.rows[0][15], "44:DB:D2:29:FA:7B");
  const [l] = parseUsers(readTable(writeCsv(t.headers, t.rows)));
  assert.equal(l.key, "201");
  assert.deepEqual(l.input.dids, ["0123456789"]);
  assert.equal(l.input.options.role, "standard");
  assert.deepEqual(l.input.voicemail, { enabled: true, pin: "1234", email: true, email_attach: true, email_delete: false });
  assert.deepEqual(l.input.phone, { model: "yealink-t43u", mac: "44dbd229fa7b" });
  assert.deepEqual(l.warnings, []);
});

test("utilisateurs : fichier 3CX (export puis import d'un fichier 3CX)", () => {
  const t = usersRows([user("201")], "3cx");
  assert.deepEqual(t.headers.slice(0, 4), ["Number", "FirstName", "LastName", "EmailAddress"]);
  // En-tête identique à un export 3CX (sinon 3CX refuse : « required columns are not found »)
  assert.equal(t.headers.join(","), "Number,FirstName,LastName,EmailAddress,MobileNumber,OutboundCallerID,DID,Role,Department,ClickToCallAuth,WMApprove,WebMeetingFriendlyName,MAC,Template,Model,Router,Language,Ringtone,QRingtone,PhoneSettings,VMEnable,VMLanguage,VMPlayMsgDateTime,VMPIN,VMEmailOptions,VMNoPin,VMPlayCallerID,RecordCalls,RecordExternal,ForbidRecording,RecordCanSee,RecordCanDelete,RecordStartStop,RecordNotify,Disabled,HideFWrules,DisableExternalCalls,HideInPhonebook,CallScreening,PinProtected,PinTimeout,Transcription,AllowLanOnly,SIPID,DeliverAudio,HotDesk,SRTPMode,EmailMissedCalls,MS365SignInDisabled,MS365CalendarDisabled,MS365ContactsDisabled,MS365TeamsDisabled,GoogleSignInDisabled,GoogleContactsDisabled,GoogleCalendarDisabled,BLF,AiAgent,AiAgentSettings");
  const col = (h) => t.rows[0][t.headers.indexOf(h)];
  assert.equal(t.rows[0].length, 58);
  assert.equal(col("Role"), '<role name="receptionists" />'); assert.equal(col("Model"), "Yealink T43U"); assert.equal(col("MAC"), "44DBD229FA7B");
  assert.equal(col("Department"), "DEFAULT"); assert.equal(col("BLF"), "<PhoneDevice><BLFS /></PhoneDevice>"); assert.equal(col("PinTimeout"), 60);
  // Le fichier exporté se relit (import 3CX → Callikoe)
  const [back] = parseUsers(readTable(writeCsv(t.headers, t.rows, "3cx")));
  assert.equal(back.input.number ?? back.number, "201");
  const file = 'Number,FirstName,LastName,EmailAddress,MobileNumber,DID,Role,VMEnable,VMEmailOptions,MAC,Model\r\n' +
    '105,Paul,Martin,paul@x.fr,+33 6 11 22 33 44,0123456780:*0123456781,"<role name=""system_admins"" />",1,3,805EC0AABBCC,Yealink T46U\r\n' +
    '106,Léa,Petit,,,,"<role name=""users"" />",0,0,,Cisco 7960\r\n';
  const [a, b] = parseUsers(readTable(file));
  assert.equal(a.is3cx, true);
  assert.deepEqual(a.input.dids, ["0123456780", "0123456781"]);
  assert.equal(a.input.options.role, "manager"); assert.match(a.warnings[0], /Superviseur/);
  assert.deepEqual(a.input.voicemail, { enabled: true, email: true, email_attach: true, email_delete: true });
  assert.deepEqual(a.input.phone, { model: "yealink-t46u", mac: "805ec0aabbcc" });
  assert.equal(b.input.options.role, "user"); assert.equal(b.input.voicemail.enabled, false); assert.equal(b.input.phone, undefined);
  // colonne absente = inchangé
  const [c] = parseUsers(readTable("Poste;Prénom\n203;Jean"));
  assert.deepEqual(c.input, { number: "203", first_name: "Jean" });
});

test("annuaire : Callikoe et 3CX", () => {
  const c = { first_name: "Ana", last_name: "Lopez", company: "Plomberie", email: "a@p.fr", notes: "",
    phones: [{ type: "work", number: "0140000000" }, { type: "mobile", number: "0611111111" }, { type: "mobile", number: "0622222222" }] };
  const t = contactsRows([c], "3cx");
  assert.deepEqual(t.rows[0].slice(0, 9), ["Ana", "Lopez", "Plomberie", "06 11 11 11 11", "06 22 22 22 22", "", "", "01 40 00 00 00", ""]);
  const [l] = parseContacts(readTable(writeCsv(t.headers, t.rows, "3cx")));
  assert.deepEqual(l.input.phones.map((p) => p.type), ["mobile", "mobile", "work"]);
  const back = parseContacts(readTable(writeCsv(...Object.values(contactsRows([c])))));
  assert.deepEqual(back[0].input.phones.map((p) => p.number), ["0140000000", "0611111111", "0622222222"]);
});

test("trunks : mot de passe jamais exporté, opérateur retrouvé par son nom", () => {
  const t = trunksRows([{ id: "ovh", operator: "OVH Télécom", number: "0123456789", host: "sip.ovh.fr", port: 5060, proxy: "", username: "0033123", codecs: ["alaw"], extra_dids: [] }]);
  assert.equal(t.rows[0][7], "");
  const [l] = parseTrunks(readTable(writeCsv(t.headers, t.rows)), [{ id: "ovh-std", label: "OVH Télécom" }]);
  assert.equal(l.input.template, "ovh-std"); assert.equal(l.input.password, undefined); assert.equal(l.error, "");
  assert.match(parseTrunks(readTable("Nom;Opérateur\nx;Inconnu"), [])[0].error, /Opérateur inconnu/);
});

test("règles sortantes : aller-retour", () => {
  const rules = [{ id: "a", name: "Mobiles", prefixes: ["06", "07"], extensions: [[200, 299]], lengths: [[10, 10]],
    routes: [{ trunk: "ovh", strip: 0, prepend: "", cid_mode: "custom", cid: "0140000000" }, { trunk: "unyc", strip: 1, prepend: "0033", cid_mode: "hidden", cid: "" }] }];
  const t = outboundRows(rules);
  assert.equal(t.headers.length, 12);
  const [l] = parseOutbound(readTable(writeCsv(t.headers, t.rows)));
  assert.deepEqual(l.input, { name: "Mobiles", prefixes: "06,07", extensions: "200-299", lengths: "10",
    routes: [{ trunk: "ovh", strip: 0, prepend: "", cid_mode: "custom", cid: "01 40 00 00 00" }, { trunk: "unyc", strip: 1, prepend: "0033", cid_mode: "hidden", cid: "" }] });
});

test("règles entrantes : destinations en texte, aller-retour et fichier façon 3CX", () => {
  const objects = [
    { kind: "group", id: "g1", number: "600", name: "Accueil", data: {} }, { kind: "queue", id: "q1", number: "700", name: "SAV", data: {} },
    { kind: "prompt", id: "p1", number: null, name: "Fermé", data: {} }, { kind: "schedule", id: "s1", number: null, name: "Bureau", data: {} },
  ];
  const users = new Map([["201", {}]]);
  const ctx = { users, objects, cc: "33" };
  for (const d of [{ type: "group", target: "g1" }, { type: "user_vm", target: "201" }, { type: "external", target: "0612345678" }, { type: "hangup", target: "" },
    { type: "queue", target: "q1", prompt: "p1" }]) assert.deepEqual(parseDest(destText(d, objects), ctx), d);
  assert.deepEqual(parseDest("Ring Group 600", ctx), { type: "group", target: "g1" });
  assert.deepEqual(parseDest("Extension 201", ctx), { type: "user", target: "201" });
  assert.deepEqual(parseDest("End Call", ctx), { type: "hangup", target: "" });
  assert.deepEqual(parseDest("700", ctx), { type: "queue", target: "q1" });
  assert.throws(() => parseDest("Groupe 999", ctx), /introuvable/);

  const rule = { kind: "rule", id: "r1", name: "Standard", data: { dids: ["0123456789"], is_default: false, schedule: "s1",
    open: { type: "group", target: "g1" }, closed: { type: "user_vm", target: "201" }, break: null, holiday: null } };
  const t = inboundRows([rule], objects);
  assert.deepEqual(t.rows[0], ["Standard", "01 23 45 67 89", "Non", "Bureau", "Groupe 600", "Messagerie 201", "", ""]);
  const [l] = parseInbound(readTable(writeCsv(t.headers, t.rows)), ctx);
  assert.deepEqual(l.input, { name: "Standard", dids: ["0123456789"], is_default: false, schedule: "s1", open: rule.data.open, closed: rule.data.closed, break: null, holiday: null });
  const [x] = parseInbound(readTable("Name,DID,Office Hours,Out of Office Hours\nPrincipal,+33123456789,Queue 700,Voicemail 201"), ctx);
  assert.equal(x.is3cx, true); assert.equal(x.error, "");
  assert.deepEqual(x.input.closed, { type: "user_vm", target: "201" });
});

test("CSV : guillemet au milieu d'une cellule, 0 enlevé par Excel, formules neutralisées", () => {
  const t = readTable(Buffer.from('Prénom;Nom;Mobile;Notes\nÉcran;27" bureau;612345678;=1+1\nJulie;Martin;06 11 22 33 44;\n'));
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][1], '27" bureau');
  const [a, b] = parseContacts(t);
  assert.equal(a.input.phones[0].number, "0612345678"); assert.equal(b.input.phones[0].number, "0611223344");
  assert.match(writeCsv(["A"], [["=HYPERLINK(1)"], ["+33 6 12 34 56 78"]]).toString(), /'=HYPERLINK\(1\)[\s\S]*\r\n\+33 6 12/);
});
