import test from "node:test";
import assert from "node:assert/strict";
import { validateContact, parseCsv, yealinkPhonebook, buildPhonebookDialplan } from "../lib/contacts.mjs";

test("validation d'un contact", () => {
  const c = validateContact({ first_name: "Jean", last_name: "Dupont", company: "Boulangerie Dupont", phones: [{ type: "work", number: "04 78 12 34 56" }, { type: "mobile", number: "+33 6 12 34 56 78" }] });
  assert.deepEqual(c.phones, [{ type: "work", number: "0478123456" }, { type: "mobile", number: "0612345678" }]);
  assert.throws(() => validateContact({ phones: [{ number: "0478123456" }] }), /nom ou une société/);
  assert.throws(() => validateContact({ last_name: "X", phones: [] }), /au moins un numéro/);
  assert.throws(() => validateContact({ last_name: "X", phones: [{ number: "abc" }] }), /invalide/);
});

test("import CSV (Excel, point-virgule, guillemets)", () => {
  const rows = parseCsv('﻿Prénom;Nom;Société;Téléphone;Mobile;E-mail\r\nJean;Dupont;"Boulangerie ""Chez Jean""";04 78 12 34 56;06 12 34 56 78;jean@ex.fr\r\n;;Plomberie Martin;0472000000;;\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].company, 'Boulangerie "Chez Jean"');
  assert.deepEqual(rows[0].phones, [{ type: "work", number: "04 78 12 34 56" }, { type: "mobile", number: "06 12 34 56 78" }]);
  assert.equal(rows[1].company, "Plomberie Martin");
  assert.throws(() => parseCsv("a;b\n1;2"), /En-têtes/);
});

test("annuaire Yealink et nom de l'appelant", () => {
  const contacts = [{ first_name: "Jean", last_name: "Dupont", company: "Boulangerie & Co", phones: [{ type: "work", number: "0478123456" }] }];
  const x = yealinkPhonebook([{ id: "201", name: "Sophie Durand" }], contacts);
  assert.match(x, /<Name>Sophie Durand<\/Name><Telephone>201<\/Telephone>/);
  assert.match(x, /<Name>Jean Dupont \(Boulangerie &amp; Co\)<\/Name><Telephone label="Bureau">0478123456<\/Telephone>/);
  const d = buildPhonebookDialplan(contacts);
  assert.match(d, /exten => 0478123456,1,Set\(CALLERID\(name\)=Jean Dupont Boulangerie & Co\)/);
  assert.match(d, /exten => _X\.,1,Return\(\)/);
  assert.match(d, /exten => 0478123456,1,Set\(CALLERID\(name\)=Jean Dupont Boulangerie & Co\)\n same => n,Set\(__CXNAME=Jean Dupont Boulangerie & Co\)\n same => n,Return\(\)/);
});

test("annuaire : affichage des appels entrants", async () => {
  const { validCidDisplay, CID_DISPLAYS } = await import("../lib/contacts.mjs");
  assert.deepEqual(Object.keys(CID_DISPLAYS), ["name_number", "number_name", "name", "number"]);
  assert.equal(validCidDisplay("number_name"), "number_name"); assert.equal(validCidDisplay("x"), "name"); assert.equal(validCidDisplay(undefined), "name");
});

test("annuaire : contact visible par tout le monde, certains postes ou certains rôles", async () => {
  const { validateVisibility, contactVisibleTo, validateContact } = await import("../lib/contacts.mjs");
  const u = (id, role = "user") => ({ id, options: { role } });
  assert.deepEqual(validateContact({ last_name: "A", phones: [{ number: "0412345678" }] }).visibility, { scope: "all" });
  const priv = { visibility: validateVisibility({ scope: "users", users: ["202", "x"] }) };
  assert.deepEqual(priv.visibility, { scope: "users", users: ["202"] });
  assert.equal(contactVisibleTo(priv, u("202")), true); assert.equal(contactVisibleTo(priv, u("203")), false); assert.equal(contactVisibleTo(priv, null), false);
  const mgr = { visibility: validateVisibility({ scope: "roles", roles: ["manager", "nope"] }) };
  assert.equal(contactVisibleTo(mgr, u("203", "manager")), true); assert.equal(contactVisibleTo(mgr, u("204")), false);
  assert.throws(() => validateVisibility({ scope: "users", users: [] }), /au moins une personne/);
  assert.equal(contactVisibleTo({}, null), true);
});
