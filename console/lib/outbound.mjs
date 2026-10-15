/**
 * Règles sortantes (comme 3CX) : selon le numéro composé (préfixe, longueur) et le poste appelant,
 * l'appel part par une route (trunk) ; si le trunk est indisponible, on essaie la route suivante (jusqu'à 5).
 * Fonctions pures, testées dans console/test/outbound.test.mjs.
 */
import { UserError, nationalNumber } from "./users.mjs";

export const CID_MODES = { user: "Numéro de l'utilisateur (sinon celui du trunk)", trunk: "Numéro du trunk", custom: "Numéro choisi", hidden: "Masqué (appel anonyme)" };
const clean = (s, max = 60) => String(s ?? "").replace(/[\r\n"<>,;|\\()[\]{}$]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** « 06,07,1-3 » → ["06","07","1","2","3"] ; vide → [] (tout préfixe) */
export function parsePrefixes(input, field = "prefixes") {
  const out = [];
  for (const raw of String(input || "").split(/[\s,;]+/).filter(Boolean)) {
    const m = raw.match(/^(\d+)-(\d+)$/);
    if (m) {
      if (m[1].length !== m[2].length || Number(m[2]) < Number(m[1]) || Number(m[2]) - Number(m[1]) > 99) throw new UserError(`Plage de préfixes invalide : ${raw}.`, field);
      for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push(String(n).padStart(m[1].length, "0"));
    } else if (/^[\d*#+]{1,12}$/.test(raw)) out.push(raw);
    else throw new UserError(`Préfixe invalide : ${raw}.`, field);
  }
  return [...new Set(out)];
}
/** « 100,103-105 » → [[100,100],[103,105]] */
export function parseRanges(input, field, { min = 1, max = 99999 } = {}) {
  const out = [];
  for (const raw of String(input || "").split(/[\s,;]+/).filter(Boolean)) {
    const m = raw.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new UserError(`Valeur invalide : ${raw}.`, field);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (b < a || a < min || b > max) throw new UserError(`Plage invalide : ${raw}.`, field);
    out.push([a, b]);
  }
  return out;
}
export const rangesText = (r) => (r || []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");

export function defaultRule() {
  return { name: "", prefixes: [], extensions: [], lengths: [], routes: [{ trunk: "", strip: 0, prepend: "", cid_mode: "user", cid: "" }] };
}

/** ctx : { trunks: Set(id), cc } */
export function validateRule(input, ctx) {
  const r = defaultRule();
  r.name = clean(input.name, 60);
  if (!r.name) throw new UserError("Donne un nom à la règle.", "name");
  r.prefixes = Array.isArray(input.prefixes) ? parsePrefixes(input.prefixes.join(","), "prefixes") : parsePrefixes(input.prefixes, "prefixes");
  r.extensions = Array.isArray(input.extensions) ? input.extensions : parseRanges(input.extensions, "extensions", { min: 100, max: 999 });
  r.lengths = Array.isArray(input.lengths) ? input.lengths : parseRanges(input.lengths, "lengths", { min: 1, max: 20 });
  const routes = [];
  (Array.isArray(input.routes) ? input.routes : []).slice(0, 5).forEach((x, i) => {
    if (!x || !x.trunk) return;
    const f = `routes.${i}`;
    if (!ctx.trunks.has(x.trunk)) throw new UserError(`Route ${i + 1} : trunk inconnu.`, `${f}.trunk`);
    const strip = Number(x.strip || 0);
    if (!Number.isInteger(strip) || strip < 0 || strip > 10) throw new UserError(`Route ${i + 1} : chiffres à retirer entre 0 et 10.`, `${f}.strip`);
    const prepend = String(x.prepend || "").trim();
    if (prepend && !/^[\d*#+]{1,10}$/.test(prepend)) throw new UserError(`Route ${i + 1} : « ajouter » ne peut contenir que des chiffres.`, `${f}.prepend`);
    const mode = CID_MODES[x.cid_mode] ? x.cid_mode : "user";
    let cid = "";
    if (mode === "custom") {
      cid = nationalNumber(x.cid, ctx.cc || "33") || "";
      if (!cid) throw new UserError(`Route ${i + 1} : numéro présenté invalide.`, `${f}.cid`);
    }
    routes.push({ trunk: x.trunk, strip, prepend, cid_mode: mode, cid });
  });
  if (!routes.length) throw new UserError("Configure au moins une route (un trunk).", "routes.0.trunk");
  r.routes = routes;
  return r;
}

/** Description lisible d'une règle (liste, traceur). */
export function describeRule(r) {
  const parts = [];
  parts.push(r.prefixes.length ? `numéros commençant par ${r.prefixes.join(", ")}` : "tous les numéros");
  if (r.lengths.length) parts.push(`de ${rangesText(r.lengths)} chiffres`);
  if (r.extensions.length) parts.push(`appelés par ${rangesText(r.extensions)}`);
  return parts.join(", ");
}

const esc = (s) => String(s).replace(/[\\^$.|?*+()[\]{}]/g, (c) => `\\${c}`);
/**
 * Contexte [out-rules] : une seule extension _X. qui teste les règles dans l'ordre.
 * trunks : Map(id → { dial_format, cid_format, outbound_cid })
 */
export function buildOutboundDialplan(rules, trunks) {
  const L = ["", "; Règles sortantes — écrit par la console web", "[out-rules]"];
  if (!rules.length) return L.join("\n") + "\n";
  L.push("exten => _X.,1,Set(N=${EXTEN})",
    " same => n,Set(SRC=${CUT(CUT(CHANNEL(name),/,2),-,1)})",
    " same => n,ExecIf($[\"${SRC}\" = \"\" | ${REGEX(\"[^0-9]\" ${SRC})}]?Set(SRC=0))");
  rules.forEach((r, i) => {
    const cond = [];
    if (r.prefixes.length) cond.push(`\${REGEX("^(${r.prefixes.map(esc).join("|")})" \${N})}`);
    if (r.lengths.length) cond.push(`(${r.lengths.map(([a, b]) => a === b ? `\${LEN(\${N})} = ${a}` : `(\${LEN(\${N})} >= ${a} & \${LEN(\${N})} <= ${b})`).join(" | ")})`);
    if (r.extensions.length) cond.push(`(${r.extensions.map(([a, b]) => a === b ? `\${SRC} = ${a}` : `(\${SRC} >= ${a} & \${SRC} <= ${b})`).join(" | ")})`);
    L.push(` same => n,GotoIf(${cond.length ? `$[${cond.join(" & ")}]` : "1"}?r${i + 1}-1)`);
  });
  L.push(" same => n,Goto(nomatch)");
  rules.forEach((r, i) => {
    r.routes.forEach((rt, k) => {
      const t = trunks.get(rt.trunk) || { dial_format: "national", cid_format: "national", outbound_cid: "" };
      const lbl = `r${i + 1}-${k + 1}`;
      L.push(` same => n(${lbl}),NoOp(Règle sortante ${i + 1} « ${String(r.name).replace(/[(),]/g, " ")} », route ${k + 1} : ${rt.trunk})`,
        ` same => n,Set(D=${rt.prepend}\${N:${rt.strip}})`,
        ` same => n,Gosub(fmt-num,s,1(\${D},${t.dial_format}))`,
        " same => n,Set(D=${GOSUB_RETVAL})",
        ` same => n,Gosub(out-cid,s,1(${rt.cid_mode},${rt.cid},${t.outbound_cid || ""},${t.cid_format}))`,
        ` same => n,Dial(PJSIP/\${D}@${rt.trunk},120,T)`);
      const next = k + 1 < r.routes.length ? `r${i + 1}-${k + 2}` : "";
      if (next) L.push(` same => n,GotoIf($["\${DIALSTATUS}" = "CHANUNAVAIL" | "\${DIALSTATUS}" = "CONGESTION"]?${next})`);
      L.push(" same => n,Hangup()");
    });
  });
  L.push(" same => n(nomatch),Log(NOTICE,Aucune règle sortante pour ${N} (poste ${SRC}))", " same => n,Playback(ss-noservice)", " same => n,Hangup()", "");
  return L.join("\n");
}
