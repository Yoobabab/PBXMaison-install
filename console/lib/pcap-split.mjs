/**
 * Capture réseau : découpe un fichier pcap en un fichier par appel (dialogue SIP INVITE),
 * avec ses messages SIP et, si la capture contient l'audio, ses paquets RTP (ports annoncés dans le SDP).
 * Sans dépendance : lit les formats pcap courants (tcpdump -i any → Linux cooked v1/v2, Ethernet, IP brut).
 */
import fs from "node:fs";
import path from "node:path";

const SIP_START = /^(INVITE|ACK|BYE|CANCEL|OPTIONS|REGISTER|SUBSCRIBE|NOTIFY|REFER|INFO|UPDATE|PRACK|MESSAGE|PUBLISH) [^ ]+ SIP\/2\.0\r?\n|^SIP\/2\.0 \d{3}/;

export function readPcap(buf) {
  if (buf.length < 24) throw new Error("Fichier pcap trop court.");
  const magic = buf.readUInt32LE(0);
  let le;
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) le = true;
  else if (magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) le = false;
  else throw new Error("Ce n'est pas un fichier pcap.");
  const nano = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const linktype = u32(20) & 0x0fffffff;
  const records = [];
  let o = 24;
  while (o + 16 <= buf.length) {
    const sec = u32(o), frac = u32(o + 4), incl = u32(o + 8);
    if (o + 16 + incl > buf.length) break;
    records.push({ at: sec + frac / (nano ? 1e9 : 1e6), start: o, end: o + 16 + incl, data: buf.subarray(o + 16, o + 16 + incl) });
    o += 16 + incl;
  }
  return { header: buf.subarray(0, 24), linktype, records };
}

/** Paquet → { src, dst, sport, dport, proto, payload } (IPv4 / IPv6, UDP / TCP), ou null. */
export function decode(linktype, d) {
  let off, eth;
  if (linktype === 1) { eth = d.readUInt16BE(12); off = 14; while (eth === 0x8100 && d.length > off + 4) { eth = d.readUInt16BE(off + 2); off += 4; } }
  else if (linktype === 113) { eth = d.readUInt16BE(14); off = 16; }
  else if (linktype === 276) { eth = d.readUInt16BE(0); off = 20; }
  else if (linktype === 0 || linktype === 108) { const fam = d.readUInt32LE(0); eth = fam === 2 ? 0x0800 : 0x86dd; off = 4; }
  else if (linktype === 101 || linktype === 12 || linktype === 228 || linktype === 229) { eth = (d[0] >> 4) === 6 ? 0x86dd : 0x0800; off = 0; }
  else return null;
  let proto, src, dst, l4;
  if (eth === 0x0800) {
    if (d.length < off + 20) return null;
    const ihl = (d[off] & 15) * 4; proto = d[off + 9];
    src = [...d.subarray(off + 12, off + 16)].join("."); dst = [...d.subarray(off + 16, off + 20)].join(".");
    l4 = off + ihl;
  } else if (eth === 0x86dd) {
    if (d.length < off + 40) return null;
    proto = d[off + 6];
    const hex = (a) => [...Array(8)].map((_, i) => a.readUInt16BE(i * 2).toString(16)).join(":");
    src = hex(d.subarray(off + 8, off + 24)); dst = hex(d.subarray(off + 24, off + 40));
    l4 = off + 40;
  } else return null;
  if (proto === 17 && d.length >= l4 + 8) return { src, dst, sport: d.readUInt16BE(l4), dport: d.readUInt16BE(l4 + 2), proto: "udp", payload: d.subarray(l4 + 8) };
  if (proto === 6 && d.length >= l4 + 20) { const doff = (d[l4 + 12] >> 4) * 4; return { src, dst, sport: d.readUInt16BE(l4), dport: d.readUInt16BE(l4 + 2), proto: "tcp", payload: d.subarray(l4 + doff) }; }
  return null;
}

const hdr = (msg, ...names) => {
  for (const n of names) { const m = new RegExp(`^(?:${n})\\s*:\\s*(.*)$`, "im").exec(msg); if (m) return m[1].trim(); }
  return "";
};
const userOf = (v) => (/<?sips?:([^@;>]+)@/.exec(v)?.[1] || /<?(?:sips?|tel):([^;>]+)/.exec(v)?.[1] || "").replace(/^(\+|00)33/, "0");
const nameOf = (v) => /^"?([^"<]+?)"?\s*</.exec(v)?.[1]?.trim() || "";

/** Messages SIP d'un paquet (TCP : plusieurs messages possibles dans un segment). */
function sipMessages(payload) {
  const text = payload.toString("latin1");
  if (!SIP_START.test(text)) return [];
  const out = [];
  let rest = text;
  while (rest && SIP_START.test(rest)) {
    const end = rest.indexOf("\r\n\r\n");
    if (end < 0) { out.push(rest); break; }
    const len = Number(hdr(rest.slice(0, end), "Content-Length", "l")) || 0;
    out.push(rest.slice(0, end + 4 + len));
    rest = rest.slice(end + 4 + len);
  }
  return out;
}

/** Analyse : liste des appels avec les numéros d'enregistrements pcap qui leur appartiennent. */
export function splitCalls(pcap) {
  const calls = new Map();   // Call-ID → appel
  const media = new Map();   // "ip:port" et ":port" → Call-ID
  const pkts = pcap.records.map((r) => ({ r, p: decode(pcap.linktype, r.data) }));
  // 1er passage : SIP
  pkts.forEach(({ r, p }, i) => {
    if (!p || !p.payload.length) return;
    for (const msg of sipMessages(p.payload)) {
      const cid = hdr(msg, "Call-ID", "i");
      if (!cid) continue;
      const first = msg.slice(0, msg.indexOf("\n"));
      const isReq = !first.startsWith("SIP/2.0");
      const method = isReq ? first.split(" ")[0] : (hdr(msg, "CSeq").split(/\s+/)[1] || "");
      let c = calls.get(cid);
      if (!c && isReq && method === "INVITE") {
        const from = hdr(msg, "From", "f"), to = hdr(msg, "To", "t");
        c = { callid: cid, from: userOf(from), from_name: nameOf(from), to: userOf(first.split(" ")[1]) || userOf(to), start: r.at, end: r.at, packets: new Set(), audio: 0, answered: false, status: "" };
        calls.set(cid, c);
      }
      if (!c) continue;
      c.packets.add(i); c.end = Math.max(c.end, r.at);
      if (!isReq && method === "INVITE") { const code = Number(first.split(" ")[1]); if (code >= 200) { c.status = c.status || String(code); if (code < 300) c.answered = true; } }
      const body = msg.slice(msg.indexOf("\r\n\r\n") + 4);
      if (/^v=0/m.test(body)) {
        const ip = /^c=IN IP[46] (\S+)/m.exec(body)?.[1] || p.src;
        for (const m of body.matchAll(/^m=(?:audio|video) (\d+)/gm)) { media.set(`${ip}:${m[1]}`, cid); media.set(`:${m[1]}`, cid); }
      }
    }
  });
  // 2e passage : audio (RTP / RTCP) vers les ports annoncés par le SDP
  pkts.forEach(({ r, p }, i) => {
    if (!p || p.proto !== "udp" || !p.payload.length || (p.payload[0] >> 6) !== 2) return;
    const cid = media.get(`${p.dst}:${p.dport}`) || media.get(`${p.src}:${p.sport}`) || media.get(`:${p.dport}`) || media.get(`:${p.sport}`)
      || media.get(`:${p.dport - 1}`) || media.get(`:${p.sport - 1}`);
    const c = cid && calls.get(cid);
    if (!c || r.at < c.start - 2) return;
    c.packets.add(i); c.audio++; c.end = Math.max(c.end, r.at);
  });
  return [...calls.values()].sort((a, b) => a.start - b.start);
}

const safe = (s) => String(s || "inconnu").replace(/[^A-Za-z0-9+_-]/g, "").slice(0, 24) || "inconnu";

/** Écrit <dossier>/appel-NN-<de>-vers-<à>.pcap et index.json ; renvoie l'index. */
export function splitPcapFile(file, outDir) {
  const buf = fs.readFileSync(file);
  const pcap = readPcap(buf);
  const calls = splitCalls(pcap);
  fs.mkdirSync(outDir, { recursive: true });
  const index = calls.map((c, n) => {
    const name = `appel-${String(n + 1).padStart(2, "0")}-${safe(c.from)}-vers-${safe(c.to)}.pcap`;
    const parts = [pcap.header, ...[...c.packets].sort((a, b) => a - b).map((i) => buf.subarray(pcap.records[i].start, pcap.records[i].end))];
    fs.writeFileSync(path.join(outDir, name), Buffer.concat(parts), { mode: 0o640 });
    return { file: name, from: c.from, from_name: c.from_name, to: c.to, start: new Date(c.start * 1000).toISOString(),
      duration: Math.round(c.end - c.start), answered: c.answered, status: c.status, packets: c.packets.size, audio_packets: c.audio };
  });
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ calls: index }), { mode: 0o640 });
  return index;
}
