/**
 * Routage décrit en français → proposition de routage (objet « flow »), sans IA ni service extérieur.
 * Exemple : « Quand on appelle le 04 65 00 15 40 : Accueil sonne 30 s puis groupe avec Paul et Julie
 *             pendant 15 s puis messagerie de Marine. En dehors des horaires : annonce Fermé. »
 * Renvoie la proposition, ce qui a été compris (phrases lisibles) et ce qui ne l'a pas été :
 * rien n'est appliqué avant validation dans l'éditeur visuel.
 */
import { nationalNumber } from "./users.mjs";

export const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const fmt = (n) => /^0\d{9}$/.test(n) ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : n;
const PHONE = /(?:\+33\s?|0033\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g;

const PROTECT = [
  [/l'une? apres l'autre|a tour de role|chacun (?:son|a son) tour|dans l'ordre|un par un|1 a 1|l'un puis l'autre/g, " §hunt§ "],
  [/tous en meme temps|en meme temps|tous ensemble|ensemble|simultanement|sonne tous/g, " §all§ "],
  [/s'il ne repond pas|s'ils ne repondent pas|si (?:personne|elle|il|ils|elles|on) ne repond(?:ent)? pas|si personne ne repond|si pas de reponse|sans reponse|en cas de non[- ]reponse|si occupe/g, " puis "],
];
const BRANCH_MARKERS = [
  ["closed", /(?:^|[.;,]\s*|\s)(?:sinon\s*,?\s*|et\s+)?(?:en dehors des (?:horaires|heures)(?: d'ouverture| de bureau)?|hors (?:horaires|heures)(?: d'ouverture| de bureau)?|(?:quand|si|lorsque) (?:c'est |on est |le bureau est |l'agence est |la boutique est |le magasin est |nous sommes )?fermes?|le soir et le week-end|la nuit et le week-end|la nuit|le soir|le week-end|en fermeture)\s*[:,-]?\s*/g],
  ["break", /(?:^|[.;,]\s*|\s)(?:et\s+)?(?:pendant (?:la |les )?pauses?|(?:a|le) midi|(?:a la |pendant la )?pause (?:dejeuner|de midi)|entre midi et (?:deux|14h))\s*[:,-]?\s*/g],
  ["holiday", /(?:^|[.;,]\s*|\s)(?:et\s+)?(?:(?:les |pendant les |le |un )?jours? feries?|(?:les |pendant les )?(?:feries|conges|vacances))\s*[:,-]?\s*/g],
  ["open", /(?:^|[.;,]\s*|\s)(?:pendant les (?:horaires|heures)(?: d'ouverture| de bureau)?|aux heures (?:d'ouverture|de bureau)|en journee|(?:quand|si) (?:c'est |on est )?ouverts?|heures d'ouverture)\s*[:,-]?\s*/g],
];
const STEP_KW = "messagerie|boite|repondeur|file|svi|serveur vocal|standard automatique|menu|annonce|message|raccroch|terminer|groupe|renvoi|transf|bascule|mobile|portable|tout le monde|tous les postes|sonne|0[1-9]|\\+33";

/** Index des noms connus : utilisateurs, groupes, files, SVI, annonces, messageries de groupe, horaires. */
function buildIndex(ctx) {
  const idx = [];
  const firstCount = new Map(), lastCount = new Map();
  for (const u of ctx.users) {
    const f = norm(u.first_name), l = norm(u.last_name);
    if (f) firstCount.set(f, (firstCount.get(f) || 0) + 1);
    if (l) lastCount.set(l, (lastCount.get(l) || 0) + 1);
  }
  for (const u of ctx.users) {
    const f = norm(u.first_name), l = norm(u.last_name);
    const keys = new Set([`poste ${u.id}`, u.id]);
    if (f && l) { keys.add(`${f} ${l}`); keys.add(`${l} ${f}`); }
    if (f && firstCount.get(f) === 1) keys.add(f);
    if (l && lastCount.get(l) === 1) keys.add(l);
    if (!f && !l && u.name) keys.add(norm(u.name));
    for (const k of keys) idx.push({ kind: "user", id: u.id, key: k, label: `${u.name} (${u.id})` });
  }
  for (const o of ctx.objects) {
    if (!["group", "queue", "ivr", "groupvm", "prompt", "schedule"].includes(o.kind)) continue;
    const label = `${o.name}${o.number ? ` (${o.number})` : ""}`;
    idx.push({ kind: o.kind, id: o.id, key: norm(o.name), label });
    if (o.number) idx.push({ kind: o.kind, id: o.id, key: o.number, label });
  }
  return idx.filter((x) => x.key.length >= 2).sort((a, b) => b.key.length - a.key.length);
}
/** Noms présents dans un segment (mots entiers, le plus long d'abord, sans chevauchement). */
function findNames(seg, idx, kinds) {
  const text = ` ${seg.replace(/[^a-z0-9'§]+/g, " ")} `;
  const taken = new Array(text.length).fill(false);
  const out = [];
  for (const c of idx) {
    if (kinds && !kinds.includes(c.kind)) continue;
    let from = 0, pos;
    while ((pos = text.indexOf(` ${c.key} `, from)) >= 0) {
      const a = pos + 1, b = a + c.key.length;
      if (!taken.slice(a, b).some(Boolean)) {
        for (let i = a; i < b; i++) taken[i] = true;
        if (!out.some((x) => x.kind === c.kind && x.id === c.id)) out.push({ ...c, pos: a });
      }
      from = pos + 1;
    }
  }
  return out.sort((x, y) => x.pos - y.pos);
}
function timeOf(seg) {
  let m = seg.match(/(\d+)\s*(?:min|minutes?|mn)\b/);
  if (m) return Number(m[1]) * 60;
  m = seg.match(/(\d+)\s*(?:s\b|sec\b|secondes?|")/);
  return m ? Number(m[1]) : null;
}

/**
 * ctx : { users: [{ id, name, first_name, last_name, mobile, voicemail }], objects: [{ kind, id, number, name }],
 *         trunkDids: [sda], cc }
 */
export function parseRouting(text, ctx) {
  const understood = [], warnings = [];
  const idx = buildIndex(ctx);
  const one = (kind) => { const l = ctx.objects.filter((o) => o.kind === kind); return l.length === 1 ? l[0] : null; };
  let t = norm(text);
  if (!t) return { proposal: null, understood, warnings: ["Décris le routage, par exemple : « Accueil sonne 30 s puis messagerie de Marine »."] };

  // 1. SDA : numéros déclarés dans les trunks, ou cités en tête (« quand on appelle le … : »), ou après « SDA »
  const dids = [];
  const head = t.includes(":") ? t.slice(0, t.indexOf(":")) : "";
  t = t.replace(PHONE, (raw, offset) => {
    const n = nationalNumber(raw, ctx.cc || "33");
    if (!n) return raw;
    const before = t.slice(Math.max(0, offset - 25), offset);
    const isDid = ctx.trunkDids.includes(n) || (head && offset < head.length) || /\b(?:sda|numero|appelle(?: le)?|appels? (?:sur|au|du)|ligne)\s*(?:le |la |au )?$/.test(before);
    if (isDid && !/(?:vers|renvoi|transfert|transferer|mobile|portable)\s*(?:le |au |sur le )?$/.test(before)) { if (!dids.includes(n)) dids.push(n); return " "; }
    return ` ${n} `;
  });
  t = t.replace(/\b(?:quand on appelle|pour les appels (?:sur|au|du)|appels? (?:sur|au|du)|sur la sda|la sda|les sda|sda|le numero|numero)\s*(?:le |la |les )?(?:et\s*)*(?=[:,]|\s*$|\s)/g, " ");
  if (dids.length) understood.push(`SDA : ${dids.map(fmt).join(", ")}`);
  const isDefault = /par defaut|toutes les sda|tous les numeros|tous les appels entrants/.test(t);
  if (isDefault) understood.push("Routage par défaut (SDA sans règle)");

  for (const [re, rep] of PROTECT) t = t.replace(re, rep);

  // 2. Horaires et branches (ouvert / fermé / pause / férié)
  const marks = [];
  for (const [b, re] of BRANCH_MARKERS) { re.lastIndex = 0; let m; while ((m = re.exec(t))) marks.push({ b, start: m.index, end: m.index + m[0].length }); }
  marks.sort((a, b) => a.start - b.start);
  const clean = marks.filter((m, i) => !marks.slice(0, i).some((p) => m.start < p.end));
  const texts = { open: "", closed: null, break: null, holiday: null };
  texts.open = clean.length ? t.slice(0, clean[0].start) : t;
  clean.forEach((m, i) => { const part = t.slice(m.end, clean[i + 1]?.start ?? t.length); texts[m.b] = `${texts[m.b] || ""} ${part}`.trim(); });
  if (!texts.open.trim() && texts.closed === null) texts.open = t;
  let schedule = "";
  const sch = findNames(t, idx, ["schedule"]);
  if (sch.length) { schedule = sch[0].id; understood.push(`Horaires « ${sch[0].label} »`); }
  const needSched = ["closed", "break", "holiday"].some((b) => texts[b] !== null);
  if (needSched && !schedule) {
    const s1 = one("schedule");
    if (s1) { schedule = s1.id; understood.push(`Horaires « ${s1.name} » (les seuls existants)`); }
    else warnings.push(ctx.objects.some((o) => o.kind === "schedule") ? "Plusieurs horaires existent : précise lesquels (ex. « horaires Bureau »)." : "Aucun horaire n'existe : crée-les dans Horaires pour les branches « fermé / pause / férié ».");
  }
  // Retirer les mentions d'horaires du texte des étapes
  const dropSched = (s) => s.replace(/(?:selon |avec |suivant )?(?:les )?horaires?(?: d'ouverture| de bureau)?(?: (?:de |du |d')?[a-z0-9' -]+)?\s*[:,]?/g, (m) => findNames(m, idx, ["schedule"]).length || /horaires?\s*[:,]?\s*$/.test(m) ? " " : m);

  const branches = { open: [], closed: null, break: null, holiday: null };
  for (const b of ["open", "closed", "break", "holiday"]) {
    if (texts[b] === null) continue;
    const steps = parseSteps(dropSched(texts[b]), idx, ctx, warnings, b);
    if (b === "open") branches.open = steps; else if (schedule) branches[b] = steps;
  }
  const B = { open: schedule ? "Heures d'ouverture" : "Tous les appels", closed: "Bureau fermé", break: "Pause", holiday: "Jour férié / congés" };
  for (const b of ["open", "closed", "break", "holiday"]) {
    if (!branches[b]) continue;
    understood.push(`${B[b]} : ${branches[b].map((s, i) => `${i + 1}. ${describe(s, ctx)}`).join(" → ") || "rien compris"}`);
  }
  if (!dids.length && !isDefault) warnings.push("Aucune SDA trouvée : glisse une SDA dans l'éditeur, ou commence par « Quand on appelle le 04… : ».");
  const name = dids.length ? `Routage ${fmt(dids[0])}` : isDefault ? "Routage par défaut" : "Nouveau routage";
  return { proposal: { name, dids, is_default: isDefault, schedule, branches }, understood, warnings };
}

function parseSteps(text, idx, ctx, warnings, branch) {
  let s = ` ${text} `;
  s = s.replace(/\s*(?:,\s*)?(?:\bpuis\b|\bensuite\b|\bapres ca\b|\bapres\b|\bet enfin\b|\benfin\b|\bsinon\b|->|→|=>|;|\.\s)\s*/g, " | ");
  s = s.replace(new RegExp(`\\s*,\\s*(?=(?:${STEP_KW}))`, "g"), " | ");
  s = s.replace(new RegExp(`\\s+et\\s+(?=(?:${STEP_KW.replace("|sonne", "")}))`, "g"), " | ");
  const segs = s.split("|").map((x) => x.replace(/^[\s,.:-]+|[\s,.:-]+$/g, "").trim()).filter((x) => x && !/^(?:et|alors|ca|cela|l'appel|les appels|on)$/.test(x));
  const steps = [];
  for (const seg of segs) {
    const st = parseSegment(seg, idx, ctx, steps, warnings);
    if (st) {
      if (steps.length && ["ivr", "user", "user_vm", "groupvm", "external", "hangup"].includes(steps.at(-1).type)) {
        warnings.push(`« ${seg} » ignoré : rien ne peut suivre ${describe(steps.at(-1), ctx)}.`);
        continue;
      }
      steps.push(st);
    }
  }
  if (!steps.length) warnings.push(`${branch === "open" ? "Routage" : "Branche"} : aucune étape comprise.`);
  return steps;
}

function parseSegment(seg, idx, ctx, prev, warnings) {
  const time = timeOf(seg);
  const strategy = seg.includes("§hunt§") ? "hunt" : "all";
  const names = (kinds) => findNames(seg.replace(/§\w+§/g, " "), idx, kinds);
  const first = (kind) => names([kind])[0];
  const one = (kind) => { const l = ctx.objects.filter((o) => o.kind === kind); return l.length === 1 ? l[0] : null; };
  const nameOf = (kind, id) => ctx.objects.find((o) => o.kind === kind && o.id === id);

  if (/raccroch|terminer l'appel|termine l'appel|fin (?:de l')?appel|couper|on coupe/.test(seg)) return { type: "hangup" };
  if (/\bsvi\b|standard automatique|serveur vocal|repondeur numerique|\bmenu\b/.test(seg)) {
    const x = first("ivr") || (one("ivr") && { id: one("ivr").id });
    if (x) return { type: "ivr", target: x.id };
    warnings.push(`« ${seg} » : quel SVI ? (aucun SVI de ce nom)`); return null;
  }
  if (/messagerie|boite vocale|boite aux lettres|repondeur|message vocal|laisser un message|\bmevo\b/.test(seg)) {
    const g = first("groupvm");
    if (g || /de groupe|partagee|commune|generale/.test(seg)) {
      const x = g || (one("groupvm") && { id: one("groupvm").id });
      if (x) return { type: "groupvm", target: x.id };
      warnings.push(`« ${seg} » : aucune messagerie de groupe de ce nom.`); return null;
    }
    const u = first("user");
    if (u) return { type: "user_vm", target: u.id };
    // « puis messagerie » : celle de la dernière personne qui a sonné seule
    const last = [...prev].reverse().find((x) => (x.type === "ring" && x.users.length === 1) || x.type === "user");
    if (last) return { type: "user_vm", target: last.type === "ring" ? last.users[0] : last.target };
    warnings.push(`« ${seg} » : la messagerie de qui ? (ex. « messagerie de Marine »)`); return null;
  }
  if (/\bfile\b/.test(seg)) {
    const x = first("queue") || (one("queue") && { id: one("queue").id });
    if (x) return { type: "queue", target: x.id };
    warnings.push(`« ${seg} » : quelle file d'attente ?`); return null;
  }
  if (/annonce|message|jouer|diffuser/.test(seg)) {
    const x = first("prompt");
    if (x) return { type: "prompt", target: x.id };
    warnings.push(`« ${seg} » : quelle annonce ? (ajoute-la dans Annonces, puis cite son nom)`); return null;
  }
  const num = seg.match(/\b0[1-9]\d{8}\b/);
  if (num) return { type: "external", target: num[0] };
  if (/mobile|portable/.test(seg)) {
    const last = prev.at(-1);
    const uid = names(["user"])[0]?.id || (last?.type === "ring" && last.users.length === 1 ? last.users[0] : null);
    const uu = uid && ctx.users.find((x) => x.id === uid);
    if (uu?.mobile) return { type: "external", target: uu.mobile };
    warnings.push(`« ${seg} » : ${uu ? `${uu.name} n'a pas de mobile dans sa fiche` : "le mobile de qui ?"}.`); return null;
  }
  const groups = names(["group"]);
  const users = names(["user"]);
  if (/renvoi|transf|bascule/.test(seg) && users.length === 1 && !groups.length) return { type: "user", target: users[0].id };
  if (groups.length && (!users.length || groups[0].pos <= users[0].pos)) {
    const g = nameOf("group", groups[0].id);
    return { type: "group", target: groups[0].id, time: time ?? null, ...(g ? {} : {}) };
  }
  if (/tout le monde|tous les postes|tous les utilisateurs|toute l'equipe/.test(seg)) return { type: "ring", users: ctx.users.map((u) => u.id), strategy, time: time ?? 20 };
  if (users.length) return { type: "ring", users: users.map((u) => u.id), strategy, time: time ?? 20 };
  if (/groupe/.test(seg)) { warnings.push(`« ${seg} » : quel groupe ? Cite son nom, ou « groupe avec Paul et Julie ».`); return null; }
  warnings.push(`Je n'ai pas compris « ${seg.replace(/§\w+§/g, "").trim()} ».`);
  return null;
}

export function describe(st, ctx) {
  const u = (id) => ctx.users.find((x) => x.id === id)?.name || id;
  const o = (kind, id) => ctx.objects.find((x) => x.kind === kind && x.id === id);
  switch (st.type) {
    case "ring": return `sonne ${st.time} s chez ${st.users.map(u).join(", ")}${st.users.length > 1 ? (st.strategy === "hunt" ? " (l'un après l'autre)" : " (en même temps)") : ""}`;
    case "group": { const g = o("group", st.target); return `groupe ${g ? `${g.number} ${g.name}` : "?"}${st.time ? ` (${st.time} s)` : ""}`; }
    case "queue": return `file d'attente ${o("queue", st.target)?.name || "?"}`;
    case "ivr": return `SVI ${o("ivr", st.target)?.name || "?"}`;
    case "prompt": return `annonce « ${o("prompt", st.target)?.name || "?"} »`;
    case "user": return `${u(st.target)} (avec ses renvois)`;
    case "user_vm": return `messagerie de ${u(st.target)}`;
    case "groupvm": return `messagerie de groupe ${o("groupvm", st.target)?.name || "?"}`;
    case "external": return `numéro externe ${fmt(st.target)}`;
    case "hangup": return "raccroche";
    default: return st.type;
  }
}
