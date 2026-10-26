// Petit lecteur XML (sans dépendance) : assez pour les sauvegardes 3CX (éléments, attributs, texte, entités, CDATA).
// Arbre : { tag, attrs: {}, children: [], text } ; outils : kid(), kids(), txt(), find().
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m);

export function parseXml(src) {
  const s = String(src).replace(/^﻿/, "");
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) top().text += decode(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt + 9); top().text += s.slice(lt + 9, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 3; continue; }
    if (s[lt + 1] === "?" || s[lt + 1] === "!") { const e = s.indexOf(">", lt); i = e < 0 ? s.length : e + 1; continue; }
    const gt = s.indexOf(">", lt);
    if (gt < 0) throw new Error("XML incomplet");
    let body = s.slice(lt + 1, gt);
    // Un « > » dans une valeur d'attribut : chercher la vraie fin de balise
    let end = gt;
    while ((body.match(/"/g) || []).length % 2 === 1) { end = s.indexOf(">", end + 1); if (end < 0) throw new Error("XML incomplet"); body = s.slice(lt + 1, end); }
    i = end + 1;
    if (body[0] === "/") {
      const name = body.slice(1).trim();
      while (stack.length > 1) { const el = stack.pop(); if (el.tag === name) break; }
      continue;
    }
    const self = body.endsWith("/");
    if (self) body = body.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(body);
    const el = { tag: m[1], attrs: {}, children: [], text: "" };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(body.slice(m[1].length)))) el.attrs[a[1]] = decode(a[3] ?? a[4] ?? "");
    top().children.push(el);
    if (!self) stack.push(el);
  }
  return root.children[0] || root;
}

/** Premier enfant direct (chemin « A/B/C » possible) */
export function kid(el, path) {
  let cur = el;
  for (const t of String(path).split("/")) { cur = cur?.children.find((c) => c.tag === t); if (!cur) return null; }
  return cur;
}
/** Tous les enfants directs d'un nom (chemin : le dernier niveau est multiple) */
export function kids(el, path) {
  const parts = String(path).split("/"), last = parts.pop();
  const p = parts.length ? kid(el, parts.join("/")) : el;
  return p ? p.children.filter((c) => c.tag === last) : [];
}
/** Texte d'un enfant (chemin), sans espaces autour */
export const txt = (el, path) => (kid(el, path)?.text || "").trim();
/** Premier descendant (profondeur) qui vérifie fn */
export function find(el, fn) {
  for (const c of el?.children || []) { if (fn(c)) return c; const x = find(c, fn); if (x) return x; }
  return null;
}
