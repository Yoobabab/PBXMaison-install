/**
 * Thème d'un serveur multi-tenant (couleur, logo, fond d'écran) : réglé dans la console du serveur,
 * appliqué à la console du serveur et à tous ses PBX (console, softphone, appli).
 * Fichiers dans CX_THEME_DIR (/var/lib/callikoe/theme) : theme.json, logo, bg.
 */
import fs from "node:fs";
import path from "node:path";

export const THEME_DIR = process.env.CX_THEME_DIR || "/var/lib/callikoe/theme";
export const PALETTE = [
  { id: "callikoe", name: "Rouge Callikoe", color: "#d8141c" },
  { id: "bleu", name: "Bleu", color: "#1d4ed8" },
  { id: "nuit", name: "Bleu nuit", color: "#1e3a8a" },
  { id: "ciel", name: "Bleu ciel", color: "#0369a1" },
  { id: "turquoise", name: "Turquoise", color: "#0f766e" },
  { id: "vert", name: "Vert", color: "#15803d" },
  { id: "violet", name: "Violet", color: "#6d28d9" },
  { id: "rose", name: "Rose", color: "#be185d" },
  { id: "orange", name: "Orange", color: "#c2410c" },
  { id: "anthracite", name: "Anthracite", color: "#374151" },
];
export const DEFAULT_THEME = { color: "#d8141c", logo: null, bg: null, walls: null, v: 0 };
/** Tailles d'écran des téléphones de bureau (fonds d'écran dessinés aux couleurs du thème par la page Apparence) */
export const WALL_SIZES = ["320x240", "480x272", "800x480", "1024x600"];
export const ASSETS = {
  logo: { max: 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] },
  bg: { max: 4 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp"] },
};

// ------------------------------------------------------------------ Couleurs
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
export function hslToHex({ h, s, l }) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return `${n >> 16},${(n >> 8) & 255},${n & 255}`; };
/** Luminance relative (WCAG) */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
}
export const contrastWithWhite = (hex) => 1.05 / (lum(hex) + 0.05);

/** Couleur choisie → toutes les teintes de l'interface (clair et sombre) */
export function shades(color) {
  const c = hexToHsl(color) || hexToHsl(DEFAULT_THEME.color);
  // Accent assez foncé pour que le texte blanc des boutons reste lisible (contraste ≥ 4,5)
  let accent = hslToHex(c);
  for (let l = c.l; contrastWithWhite(accent) < 4.5 && l > 5; l -= 2) accent = hslToHex({ ...c, l });
  const a = hexToHsl(accent);
  const dark = { ...a, l: clamp(Math.max(a.l, 60), 55, 72), s: clamp(a.s, 0, 95) };
  return {
    accent, hover: hslToHex({ ...a, l: a.l - 8 }), soft: hslToHex({ h: a.h, s: clamp(a.s * 0.85, 0, 90), l: 95 }), rgb: rgbOf(accent),
    darkAccent: hslToHex(dark), darkHover: hslToHex({ ...dark, l: dark.l + 7 }), darkSoft: hslToHex({ h: a.h, s: clamp(a.s * 0.45, 0, 60), l: 15 }),
    sideAccent: hslToHex(dark), sideAccent2: hslToHex({ ...dark, l: dark.l + 7 }), brandSub: hslToHex({ ...dark, l: clamp(dark.l + 14, 70, 82) }),
    grad: `linear-gradient(100deg,${hslToHex({ h: a.h + 14, s: a.s, l: clamp(a.l + 14, 30, 70) })} 0%,${accent} 45%,${hslToHex({ h: a.h - 16, s: a.s, l: clamp(a.l + 2, 25, 60) })} 100%)`,
  };
}

// ------------------------------------------------------------------ Lecture / écriture
export function readTheme(dir = THEME_DIR) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf8"));
    return { ...DEFAULT_THEME, ...t, color: hexToHsl(t.color) ? t.color.toLowerCase() : DEFAULT_THEME.color };
  } catch { return { ...DEFAULT_THEME }; }
}
export function writeTheme(t, dir = THEME_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const out = { color: t.color, logo: t.logo || null, bg: t.bg || null, walls: t.walls || null, v: Date.now() };
  fs.writeFileSync(path.join(dir, "theme.json.new"), JSON.stringify(out), { mode: 0o644 });
  fs.renameSync(path.join(dir, "theme.json.new"), path.join(dir, "theme.json"));
  return out;
}
/** Vérifie un fichier image envoyé (type réel lu dans les premiers octets) ; renvoie son type */
export function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}
export function saveAsset(kind, buf, dir = THEME_DIR) {
  const spec = ASSETS[kind];
  if (!spec) throw new Error("Fichier inconnu.");
  if (!buf?.length) throw new Error("Fichier vide.");
  if (buf.length > spec.max) throw new Error(`Fichier trop lourd (${Math.round(spec.max / 1024 / 1024)} Mo au maximum).`);
  const type = sniffImage(buf);
  if (!type || !spec.types.includes(type)) throw new Error(kind === "logo" ? "Logo : PNG, JPEG, WebP ou SVG." : "Fond d'écran : PNG, JPEG ou WebP.");
  if (type === "image/svg+xml" && /<script|\son\w+\s*=|javascript:|<foreignObject/i.test(buf.toString("utf8"))) throw new Error("Ce SVG contient du code : exporte-le sans script.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${kind}.new`), buf, { mode: 0o644 });
  fs.renameSync(path.join(dir, `${kind}.new`), path.join(dir, kind));
  return type;
}
export function removeAsset(kind, dir = THEME_DIR) { if (ASSETS[kind] || isWall(kind)) fs.rmSync(path.join(dir, kind), { force: true }); }
const isWall = (kind) => WALL_SIZES.some((sz) => kind === `wall-${sz}`);
/** Fonds d'écran des téléphones : PNG aux tailles connues, écrits ensemble */
export function saveWalls(images, dir = THEME_DIR) {
  const bufs = {};
  for (const sz of WALL_SIZES) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(images?.[sz] || ""));
    if (!m) throw new Error(`Fond d'écran ${sz} manquant.`);
    const buf = Buffer.from(m[1], "base64");
    if (sniffImage(buf) !== "image/png" || buf.length > 2 * 1024 * 1024) throw new Error(`Fond d'écran ${sz} invalide.`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (`${w}x${h}` !== sz) throw new Error(`Fond d'écran ${sz} : mauvaise taille (${w}x${h}).`);
    bufs[sz] = buf;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const [sz, buf] of Object.entries(bufs)) { fs.writeFileSync(path.join(dir, `wall-${sz}.new`), buf, { mode: 0o644 }); fs.renameSync(path.join(dir, `wall-${sz}.new`), path.join(dir, `wall-${sz}`)); }
}
export function removeWalls(dir = THEME_DIR) { for (const sz of WALL_SIZES) fs.rmSync(path.join(dir, `wall-${sz}`), { force: true }); }
/** Adresse du fond d'écran d'un téléphone (null : fond Callikoe d'origine) ; le nom change avec le thème pour que le poste le recharge */
export function wallpaperName(screen, t = readTheme()) {
  return t.walls && WALL_SIZES.includes(screen) ? `wall-${screen}-${t.walls}.png` : null;
}
/** Couleurs publiques du thème (appli mobile) */
export function themePublic(t = readTheme()) {
  const d = shades(t.color);
  const stops = d.grad.match(/#[0-9a-f]{6}/gi) || [];
  return { color: d.accent, dark: d.darkAccent, soft: d.soft, gradient: stops, logo: !!t.logo, custom: t.color !== DEFAULT_THEME.color || !!t.logo, v: t.v || 0 };
}
export function assetFile(kind, dir = THEME_DIR) {
  if (!ASSETS[kind] && !isWall(kind)) return null;
  const f = path.join(dir, kind);
  try { const buf = fs.readFileSync(f); return { buf, type: sniffImage(buf) }; } catch { return null; }
}

// ------------------------------------------------------------------ Feuille de style du thème
export function themeCss(t = readTheme()) {
  const d = shades(t.color), v = t.v || 0;
  const custom = t.color.toLowerCase() !== DEFAULT_THEME.color;
  let css = "/* Thème du serveur Callikoe (généré) */\n";
  if (custom) {
    const light = `--accent:${d.accent};--accent-hover:${d.hover};--accent-soft:${d.soft};--accent-rgb:${d.rgb};--grad:${d.grad};--side-accent:${d.sideAccent};--side-accent-2:${d.sideAccent2};--brand-sub:${d.brandSub}`;
    const dark = `--accent:${d.darkAccent};--accent-hover:${d.darkHover};--accent-soft:${d.darkSoft}`;
    css += `:root,:root[data-theme="light"]{${light}}\n@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}\n:root[data-theme="dark"]{${light};${dark}}\n`;
  }
  if (t.logo) {
    const u = `url("/theme/logo?v=${v}")`;
    css += `.brand .mark,.rail-logo{background:#fff ${u} center/80% no-repeat;box-shadow:0 2px 8px rgba(0,0,0,.18)}.brand .mark::after,.rail-logo i{display:none}\n`;
    css += `.login::before,.wizard::before{content:"";display:block;height:56px;margin:0 auto 18px;background:${u} center/contain no-repeat}\n`;
    css += `.sp-brand i{width:44px;height:44px;border-radius:10px;background:${u} center/contain no-repeat;box-shadow:none}\n`;
  }
  if (t.bg) {
    const u = `url("/theme/bg?v=${v}")`;
    css += `body.no-side{background:var(--bg) ${u} center/cover no-repeat fixed}\n.sp-login-wrap{background:${u} center/cover no-repeat}\n`;
  }
  return css;
}
/** Réponses HTTP communes (console du serveur et consoles des PBX) */
export function registerThemeRoutes(app, dir = () => THEME_DIR) {
  app.get("/theme.json", async (req, reply) => reply.header("cache-control", "no-cache").header("access-control-allow-origin", "*").send(themePublic(readTheme(dir()))));
  // Téléphones de bureau : fond d'écran du thème (le numéro de version dans le nom force le téléchargement après un changement)
  app.get("/phone/theme/:file", async (req, reply) => {
    const m = /^wall-(\d+x\d+)-\d+\.png$/.exec(req.params.file);
    const f = m && assetFile(`wall-${m[1]}`, dir());
    if (!f) return reply.code(404).send("");
    return reply.type("image/png").header("cache-control", "public, max-age=31536000, immutable").send(f.buf);
  });
  app.get("/theme.css", async (req, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "no-cache").send(themeCss(readTheme(dir()))));
  app.get("/theme/:kind", async (req, reply) => {
    const f = assetFile(req.params.kind, dir());
    if (!f?.type) return reply.code(404).send("");
    return reply.type(f.type).header("cache-control", "public, max-age=86400").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(f.buf);
  });
}
