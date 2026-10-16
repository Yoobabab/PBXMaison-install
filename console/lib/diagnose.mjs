/**
 * Dépannage (Gestion d'appels › Dépannage) : tests d'appel sans déranger le client.
 * Fonctions pures, testées dans console/test/diagnose.test.mjs :
 *   - chemin d'un appel entrant MAINTENANT (arbre du traceur réduit aux branches en vigueur) ;
 *   - postes qui sonneraient, état réel de leurs appareils (réponse aux interrogations SIP du PBX) ;
 *   - simulation d'un appel sortant depuis un poste (blocages, pays, règles sortantes, trunk, numéro présenté).
 */
import { displayName, nationalNumber } from "./users.mjs";

const EMERGENCY = ["15", "17", "18", "112", "114", "115", "116000", "119", "191", "196", "197"];
const fmt = (n) => /^0\d{9}$/.test(n) ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : n;

/** Arbre du traceur réduit à ce qui s'applique maintenant (horaires, planning…). */
export function pathNow(n) {
  const kids = n.children || [];
  const hasCurrent = kids.some((c) => c.current === true);
  return { ...n, children: kids.filter((c) => !hasCurrent || c.current !== false).map((c) => ({ ...c, node: pathNow(c.node) })) };
}

/** Postes rencontrés sur le chemin (dans l'ordre, sans doublon). */
export function ringTargets(root) {
  const out = [];
  const walk = (n) => { if (n.ext && !out.includes(n.ext)) out.push(n.ext); for (const c of n.children || []) walk(c.node); };
  walk(root);
  return out;
}

/** Sortie de « pjsip show contacts » → [{ aor, uri, status, rtt }] */
export function parseContacts(lines) {
  const out = [];
  for (const l of lines || []) {
    const m = /^\s*Contact:\s+([^/\s]+)\/(\S+)\s+\S+\s+(Avail|Unavail|NonQual|Unknown|Created|Updated|Removed|Reachable|Unreachable)\s*([\d.]+|nan)?/.exec(l);
    if (m) out.push({ aor: m[1], uri: m[2], status: m[3], rtt: m[4] && m[4] !== "nan" ? Number(m[4]) : null });
  }
  return out;
}

/**
 * État des appareils d'un poste : registrations (console) + interrogation SIP (qualify).
 * contacts : [{ uri, user_agent, device, local_ip, source_ip }] ; qual : sortie de parseContacts
 */
export function deviceStates(ext, contacts, qual) {
  return (contacts || []).map((c) => {
    const q = qual.find((x) => (x.aor === ext || x.aor === `${ext}-web`) && c.uri && (x.uri === c.uri || c.uri.startsWith(x.uri) || x.uri.startsWith(c.uri)));
    const web = c.device?.kind === "web" || c.device?.kind === "mobile";
    let state = "ok", text = "connecté";
    if (q?.status === "Avail" || q?.status === "Reachable") text = `répond${q.rtt != null ? ` en ${Math.round(q.rtt)} ms` : ""}`;
    else if (q?.status === "Unavail" || q?.status === "Unreachable") { state = "bad"; text = "ne répond plus (enregistré, mais injoignable : réseau, box, téléphone éteint ?)"; }
    else if (web) text = "connecté (navigateur ou appli ouverte)";
    return { label: c.device?.label || "Appareil", kind: c.device?.kind || "unknown", ip: c.source_ip || c.ip || "", local_ip: c.local_ip || "", state, text };
  });
}

/** Résumé d'un test entrant : verdict + phrase à donner au client. */
export function inboundVerdict(root, targets) {
  const bad = [], warn = [];
  const walk = (n) => { if (n.status === "bad") bad.push(n.title); else if (n.status === "warn") warn.push(n.title); for (const c of n.children || []) walk(c.node); };
  walk(root);
  const ringing = targets.filter((t) => t.rings && t.devices.some((d) => d.state === "ok"));
  if (!targets.length && !bad.length) return { level: warn.length ? "warn" : "ok", text: "L'appel ne fait sonner aucun poste : il part directement vers la destination ci-dessous." };
  if (ringing.length) return { level: bad.length ? "warn" : "ok", text: `L'appel fait bien sonner : ${ringing.map((t) => `${t.ext} ${t.name} (${t.devices.filter((d) => d.state === "ok").map((d) => d.label).join(", ")})`).join(" ; ")}.` };
  return { level: "bad", text: "Aucun téléphone ne peut sonner en ce moment : l'appel part directement en « sans réponse »." };
}

/**
 * Appel sortant simulé depuis un poste. Rien n'est composé.
 * ctx : { user, users: Map, security, rules, trunks: [{ id, number, outbound_cid, dial_format, cid_format, status }], outboundTrunk, cc }
 * → { number, steps: [{ status, title, detail }], verdict: { level, text } }
 */
export function simulateOutbound(rawNumber, ctx) {
  const steps = [];
  const add = (status, title, detail = "") => steps.push({ status, title, detail });
  const u = ctx.user;
  const stop = (text) => ({ number: rawNumber, steps, verdict: { level: "bad", text } });
  if (!u) return stop("Poste introuvable.");
  add(u.options.disabled ? "bad" : "ok", `Poste ${u.id} · ${displayName(u)}`, u.options.disabled ? "Utilisateur désactivé : il ne peut appeler que les urgences." : "");
  let n = String(rawNumber || "").replace(/[\s.\-()]/g, "");
  if (/^\+/.test(n)) {
    const nat = nationalNumber(n, ctx.cc || "33");
    if (nat && n.startsWith(`+${ctx.cc || "33"}`)) { add("info", `Numéro converti : ${n} → ${fmt(nat)}`, "Le poste compose les numéros français en 0…"); n = nat; }
    else { n = `00${n.slice(1)}`; add("info", `Numéro converti en ${n}`, "Format international composé depuis un poste : 00 + indicatif."); }
  }
  if (!/^[\d*#]+$/.test(n)) return stop("Numéro invalide.");
  if (EMERGENCY.includes(n)) {
    add(ctx.outboundTrunk ? "ok" : "bad", `Urgence ${n}`, ctx.outboundTrunk ? `Toujours autorisée, sans limite, par le trunk ${ctx.outboundTrunk}.` : "Aucun trunk sortant : l'appel d'urgence échouerait !");
    return { number: n, steps, verdict: ctx.outboundTrunk ? { level: "ok", text: `Appel d'urgence ${n} : passerait par le trunk ${ctx.outboundTrunk}.` } : { level: "bad", text: "Aucun trunk sortant : les urgences ne passeraient pas." } };
  }
  if (/^\d{3}$/.test(n)) {
    add("info", `Numéro interne ${n}`, ctx.users.has(n) ? `Utilisateur ${n} · ${displayName(ctx.users.get(n))} : utilise le test entrant avec ce numéro pour voir s'il sonne.` : "Groupe, file, SVI… : utilise le test entrant avec ce numéro.");
    return { number: n, steps, verdict: { level: "ok", text: "Appel interne : il ne sort pas par l'opérateur." } };
  }
  if (u.options.disabled) return stop("Le poste est désactivé.");
  if (u.options.block_external) { add("bad", "Appels externes interdits pour ce poste", "Fiche utilisateur › Options."); return stop("Ce poste n'a pas le droit d'appeler l'extérieur."); }
  const s = ctx.security || {};
  let kind;
  if (/^0[1-9]\d{8}$/.test(n)) kind = /^08(9)/.test(n) ? "premium" : "national";
  else if (/^089\d{7}$/.test(n) || /^118\d{3}$/.test(n)) kind = "premium";
  else if (/^3\d{3}$/.test(n)) kind = "short";
  else if (/^00\d+/.test(n)) kind = "intl";
  else return stop(`Numéro non reconnu (${n}) : ni national (0 + 9 chiffres), ni international (00…), ni numéro court.`);
  if (/^089/.test(n) || /^118/.test(n)) kind = "premium";
  if (kind === "premium") {
    if (s.block_premium !== false) { add("bad", "Numéro surtaxé (089, 118…) bloqué", "Sécurité › Numéros surtaxés."); return stop("Numéro surtaxé : bloqué par la sécurité du PBX."); }
    add("warn", "Numéro surtaxé autorisé", "Sécurité › Numéros surtaxés est désactivé.");
  } else if (kind === "intl") {
    const cc = (s.intl || []).find((c) => n.startsWith(`00${c}`));
    if (!cc) { add("bad", `International bloqué (${n.slice(0, 6)}…)`, "Pays non coché dans Sécurité › Appel Pays autorisés."); return stop("Pays non autorisé : l'appel serait refusé."); }
    add("ok", `International autorisé (indicatif +${cc})`, "Sécurité › Appel Pays autorisés. Compté dans la limite d'appels internationaux par jour.");
  } else add("ok", kind === "short" ? "Numéro court de service (3xxx)" : "Numéro national");
  const blocked = (s.out_block || []).find((e) => (e.prefix ? n.startsWith(e.number) : n === e.number));
  if (blocked) { add("bad", `Numéro bloqué en sortie (${blocked.number}${blocked.prefix ? "…" : ""})`, "Sécurité › Numéros bloqués."); return stop("Ce numéro est dans la liste des numéros bloqués."); }
  const trunks = new Map((ctx.trunks || []).map((t) => [t.id, t]));
  const fmtNum = (x, f) => (x.startsWith("0") && f === "e164" ? `${ctx.cc || "33"}${x.slice(1)}` : x.startsWith("0") && f === "e164_plus" ? `+${ctx.cc || "33"}${x.slice(1)}` : x);
  const trunkStep = (id, dialed, cid, label) => {
    const t = trunks.get(id);
    if (!t) { add("bad", `Trunk « ${id} » introuvable`); return false; }
    const st = t.status?.code || "Unknown";
    const lvl = st === "Registered" ? "ok" : st === "Unknown" ? "warn" : "bad";
    add(lvl, `${label} : trunk ${id}${t.operator ? ` (${t.operator})` : ""}`, `${t.status?.label || st}. Numéro envoyé à l'opérateur : ${dialed}. Numéro présenté : ${cid || "celui de l'opérateur"}.`);
    return lvl;
  };
  const ucid = u.outbound_cid || "";
  const rules = ctx.rules || [];
  if (rules.length) {
    const src = Number(u.id);
    const rule = rules.find((r) => (!r.prefixes.length || r.prefixes.some((p) => n.startsWith(p)))
      && (!r.lengths.length || r.lengths.some(([a, b]) => n.length >= a && n.length <= b))
      && (!r.extensions.length || r.extensions.some(([a, b]) => src >= a && src <= b)));
    if (!rule) { add("bad", "Aucune règle sortante ne correspond", "Règles sortantes : ajoute une règle pour ce type de numéro (ou une règle « tous les numéros »)."); return stop("Aucune règle sortante pour ce numéro : l'appel serait refusé."); }
    add("ok", `Règle sortante « ${rule.name} »`, `${rule.routes.length > 1 ? `${rule.routes.length} trunks en secours, dans l'ordre` : "1 trunk"}.`);
    let best = "bad";
    rule.routes.forEach((rt, k) => {
      const t = trunks.get(rt.trunk) || {};
      const dialed = fmtNum(`${rt.prepend}${n.slice(rt.strip)}`, t.dial_format);
      const c = rt.cid_mode === "hidden" ? "masqué" : rt.cid_mode === "custom" ? rt.cid : rt.cid_mode === "user" ? (ucid || t.outbound_cid) : t.outbound_cid;
      const lvl = trunkStep(rt.trunk, dialed, c && c !== "masqué" ? fmtNum(c, t.cid_format) : c, k ? `Si indisponible, route ${k + 1}` : "Route 1");
      if (lvl === "ok" || (lvl === "warn" && best === "bad")) best = lvl;
    });
    return { number: n, steps, verdict: best === "ok" ? { level: "ok", text: `L'appel vers ${fmt(n)} partirait par la règle « ${rule.name} ».` } : { level: best, text: best === "warn" ? "Route trouvée, mais l'état du trunk n'est pas confirmé." : "Route trouvée, mais aucun trunk n'est enregistré chez l'opérateur : l'appel échouerait." } };
  }
  if (!ctx.outboundTrunk) { add("bad", "Aucun trunk sortant", "Routes › Trunk sortant."); return stop("Aucun trunk sortant : l'appel serait refusé."); }
  const t = trunks.get(ctx.outboundTrunk) || {};
  const c = ucid || t.outbound_cid;
  const lvl = trunkStep(ctx.outboundTrunk, fmtNum(n, t.dial_format), c ? fmtNum(c, t.cid_format) : "", "Trunk sortant par défaut");
  return { number: n, steps, verdict: lvl === "ok" ? { level: "ok", text: `L'appel vers ${fmt(n)} partirait par le trunk ${ctx.outboundTrunk}${c ? `, en présentant le ${fmt(c)}` : ""}.` } : { level: lvl, text: lvl === "warn" ? "État du trunk non confirmé (trunk sans enregistrement, ou moteur injoignable)." : "Le trunk n'est pas enregistré chez l'opérateur : l'appel échouerait." } };
}
