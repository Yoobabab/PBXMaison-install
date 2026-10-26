import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, kid, kids, txt } from "../lib/xmlmini.mjs";
import { convert3cx, trunkSlug } from "../lib/import3cx.mjs";

// Sauvegarde 3CX v20 réduite (données inventées)
const XML = `﻿<?xml version="1.0" encoding="utf-8"?>
<PhoneSystem><header><version>20.0.10.1716</version></header>
<Gateways><VoipProvider><Host>sip.netw.fr</Host><Port>5060</Port><Name>NETW</Name><Codecs><codec>PCMA</codec><codec>G729</codec></Codecs></VoipProvider></Gateways>
<Tenants><Tenant><Name>t</Name>
 <Groups><Group><Members><Member DN="101"><role name="system_owners" /></Member><Member DN="102"><role name="users" /></Member></Members>
  <Hours HoursType="SpecificHoursExcludingHolidays"><PeriodsOfDay DayOfWeek="Monday"><PeriodOfDay begin="08:30" end="12:00" /><PeriodOfDay begin="14:00" end="18:00" /></PeriodsOfDay></Hours></Group></Groups>
 <OutboundRules><OutboundRule><OutboundRoutes><OutboundRoute><StripDigits>0</StripDigits><Gateway>NETW</Gateway></OutboundRoute><OutboundRoute><StripDigits>0</StripDigits></OutboundRoute></OutboundRoutes>
  <DNGroups><Group>__DEFAULT__</Group></DNGroups><Name>Sortant &amp; national</Name></OutboundRule></OutboundRules>
 <PhoneBookEntries><PhoneBookEntry><FirstName>Jean</FirstName><LastName>Test</LastName><CompanyName>ACME</CompanyName><PhoneNumber>0412345678</PhoneNumber></PhoneBookEntry></PhoneBookEntries>
 <DN>
  <Extension><AuthID>a</AuthID><EmailAddress>a@b.fr</EmailAddress><Enabled>True</Enabled><FirstName>Alice</FirstName><LastName>Martin</LastName>
   <FwdProfiles><FwdProfile><Name>Available</Name><NoAnswerTimeout>25</NoAnswerTimeout><AvailableRoute><NoAnswer><AllCalls><To>External</To><External Number="0612345678" /></AllCalls></NoAnswer><Busy><AllCalls><To>VoiceMail</To><Internal DN="101" /></AllCalls></Busy></AvailableRoute></FwdProfile>
   <FwdProfile><Name>Away</Name><AwayRoute><External><AllHours><To>Extension</To><Internal DN="102" /></AllHours></External></AwayRoute></FwdProfile></FwdProfiles>
   <VMEmailOptions>Attachment</VMEmailOptions><VMEnabled>True</VMEnabled><VMPIN>1234</VMPIN><Number>101</Number>
   <Properties><DNProperty><Name>MOBILENUMBER</Name><Value>0698765432</Value></DNProperty></Properties></Extension>
  <Extension><Enabled>False</Enabled><FirstName>Bob</FirstName><VMEnabled>False</VMEnabled><Number>102</Number><Properties><DNProperty><Name>DONT_SHOW_EXT_IN_PHBK</Name><Value>1</Value></DNProperty></Properties></Extension>
  <RingGroup><Name>Accueil</Name><Number>600</Number></RingGroup>
  <IVR><Name>PIN</Name><Number>777</Number><Properties><DNProperty><Name>PINPROTECTIONIVR</Name><Value>1</Value></DNProperty></Properties></IVR>
  <ExternalLine><AuthID>33100000001</AuthID><AuthPassword>secret</AuthPassword><DIDNumbers>33100000001:33100000002</DIDNumbers><ExternalNumber>33100000001</ExternalNumber><Gateway>NETW</Gateway>
   <RoutingRules><ExternalLineRule><Conditions><Condition Type="ForwardAll" /></Conditions><ForwardDestinations><AlterDestinationDuringOutOfOfficeHours>True</AlterDestinationDuringOutOfOfficeHours>
    <OfficeHoursDestination><To>RingGroup</To><Internal DN="600" /></OfficeHoursDestination><OutOfOfficeHoursDestination><To>VoiceMail</To><Internal DN="101" /></OutOfOfficeHoursDestination></ForwardDestinations>
    <Hours HoursType="OfficeHours" /></ExternalLineRule></RoutingRules><Number>10000</Number></ExternalLine>
 </DN></Tenant></Tenants></PhoneSystem>`;

test("XML : éléments, attributs, entités", () => {
  const r = parseXml(XML);
  assert.equal(r.tag, "PhoneSystem");
  const t = kid(r, "Tenants/Tenant");
  assert.equal(kids(t, "DN/Extension").length, 2);
  assert.equal(txt(t, "OutboundRules/OutboundRule/Name"), "Sortant & national");
  assert.equal(kid(t, "Groups/Group/Members/Member").attrs.DN, "101");
  assert.equal(parseXml('<a x="1 > 0"><b/>t&#233;l</a>').text, "tél");
});

test("sauvegarde 3CX → tableaux d'import Callikoe", () => {
  const r = convert3cx(XML, { templates: [{ id: "netw", label: "NETW (Networth)" }, { id: "generique", label: "Opérateur générique" }] });
  assert.equal(r.version, "20.0.10.1716");
  assert.deepEqual(r.tables.trunks.rows, [["netw", "NETW (Networth)", "0100000001", "sip.netw.fr", "5060", "", "33100000001", "secret", "0100000002", "alaw"]]);
  const [alice, bob] = r.tables.users.rows;
  assert.deepEqual(alice.slice(0, 11), ["101", "Alice", "Martin", "a@b.fr", "0698765432", "", "", "Superviseur", "Oui", "1234", "Avec le message"]);
  assert.equal(bob[7], "Utilisateur"); assert.equal(bob[11], "Oui"); assert.equal(bob[12], "Oui");
  assert.deepEqual(r.forwards, [{ ext: "101", forwarding: { timeout: 25, no_answer: { type: "external", target: "0612345678" }, busy: { type: "voicemail", target: "" }, away: { type: "extension", target: "102" } } }]);
  assert.deepEqual(r.schedules[0].data.week.mon, [["08:30", "12:00"], ["14:00", "18:00"]]);
  assert.deepEqual(r.tables.inbound.rows, [["Ligne netw", "0100000001, 0100000002", "Non", "Horaires du bureau (3CX)", "Groupe 600", "Messagerie 101", "", ""]]);
  assert.deepEqual(r.tables.outbound.rows, [["Sortant & national", "", "", "", "netw", "0", "", "Utilisateur"]]);
  assert.deepEqual(r.tables.contacts.rows[0].slice(0, 4), ["Jean", "Test", "ACME", "0412345678"]);
  assert.deepEqual(r.notes, ["Groupe d'appel 600 « Accueil » : à recréer dans Gestion d'appels."]);
  assert.equal(trunkSlug("Orange Pro Siège"), "orange-pro-siege");
  assert.throws(() => convert3cx("<html/>"), /pas une sauvegarde 3CX/);
});
