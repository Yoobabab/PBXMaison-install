import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPcap, splitCalls, splitPcapFile } from "../lib/pcap-split.mjs";

// pcap « tcpdump -i any » (Linux cooked v2) fabriqué à la main : 2 appels + du bruit
function pcapOf(packets) {
  const gh = Buffer.alloc(24); gh.writeUInt32LE(0xa1b2c3d4, 0); gh.writeUInt16LE(2, 4); gh.writeUInt16LE(4, 6); gh.writeUInt32LE(262144, 16); gh.writeUInt32LE(276, 20);
  const recs = packets.map(([t, src, sport, dst, dport, payload]) => {
    const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
    const sll = Buffer.alloc(20); sll.writeUInt16BE(0x0800, 0);
    const ip = Buffer.alloc(20); ip[0] = 0x45; ip[9] = 17; ip.writeUInt16BE(28 + pl.length, 2);
    src.split(".").forEach((x, i) => (ip[12 + i] = +x)); dst.split(".").forEach((x, i) => (ip[16 + i] = +x));
    const udp = Buffer.alloc(8); udp.writeUInt16BE(sport, 0); udp.writeUInt16BE(dport, 2); udp.writeUInt16BE(8 + pl.length, 4);
    const data = Buffer.concat([sll, ip, udp, pl]);
    const rh = Buffer.alloc(16); rh.writeUInt32LE(t, 0); rh.writeUInt32LE(data.length, 8); rh.writeUInt32LE(data.length, 12);
    return Buffer.concat([rh, data]);
  });
  return Buffer.concat([gh, ...recs]);
}
const sdp = (ip, port) => `v=0\r\no=- 1 1 IN IP4 ${ip}\r\ns=-\r\nc=IN IP4 ${ip}\r\nt=0 0\r\nm=audio ${port} RTP/AVP 8\r\n`;
const sip = (first, cid, from, to, cseq, body = "") => `${first}\r\nVia: SIP/2.0/UDP x\r\nFrom: "Greg" <sip:${from}@pbx>;tag=a\r\nTo: <sip:${to}@pbx>\r\nCall-ID: ${cid}\r\nCSeq: ${cseq}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
const rtp = Buffer.from([0x80, 8, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3]);

test("Capture réseau : un fichier par appel (SIP + audio), le reste ignoré", () => {
  const buf = pcapOf([
    [1, "10.0.0.5", 5060, "1.2.3.4", 5060, sip("OPTIONS sip:op SIP/2.0", "opt1", "netw", "op", "1 OPTIONS")],
    [2, "92.1.1.1", 5060, "10.0.0.5", 5060, sip("INVITE sip:0612345678@pbx SIP/2.0", "c1", "201", "0612345678", "1 INVITE", sdp("192.168.1.18", 12000))],
    [3, "10.0.0.5", 5060, "92.1.1.1", 5060, sip("SIP/2.0 200 OK", "c1", "201", "0612345678", "1 INVITE", sdp("10.0.0.5", 10002))],
    [3, "92.1.1.1", 40000, "10.0.0.5", 10002, rtp],
    [4, "10.0.0.5", 10002, "92.1.1.1", 40000, rtp],
    [4, "10.0.0.5", 5060, "92.1.1.1", 5060, sip("INVITE sip:202@pbx SIP/2.0", "c2", "0499", "202", "1 INVITE", sdp("10.0.0.5", 10010))],
    [5, "92.1.1.1", 5060, "10.0.0.5", 5060, sip("SIP/2.0 486 Busy Here", "c2", "0499", "202", "1 INVITE")],
    [6, "92.1.1.1", 5060, "10.0.0.5", 5060, sip("BYE sip:x SIP/2.0", "c1", "201", "0612345678", "2 BYE")],
    [7, "8.8.8.8", 53, "10.0.0.5", 3333, Buffer.from("dns")],
  ]);
  const calls = splitCalls(readPcap(buf));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].from, "201"); assert.equal(calls[0].to, "0612345678"); assert.equal(calls[0].answered, true);
  assert.equal(calls[0].packets.size, 5); assert.equal(calls[0].audio, 2);
  assert.equal(calls[1].status, "486"); assert.equal(calls[1].answered, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  const f = path.join(dir, "c.pcap"); fs.writeFileSync(f, buf);
  const idx = splitPcapFile(f, path.join(dir, "appels"));
  assert.equal(idx[0].file, "appel-01-201-vers-0612345678.pcap");
  const one = readPcap(fs.readFileSync(path.join(dir, "appels", idx[0].file)));
  assert.equal(one.records.length, 5); assert.equal(one.linktype, 276);
});
