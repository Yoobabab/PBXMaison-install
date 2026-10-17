import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shades, contrastWithWhite, hexToHsl, hslToHex, sniffImage, saveAsset, readTheme, writeTheme, themeCss, PALETTE } from "../lib/theme.mjs";

test("couleurs : conversion, contraste des boutons garanti", () => {
  assert.equal(hslToHex(hexToHsl("#1d4ed8")), "#1d4ed8");
  for (const p of PALETTE) assert.ok(contrastWithWhite(shades(p.color).accent) >= 4.5, p.name);
  const yellow = shades("#ffe14d");                    // couleur trop claire : foncée automatiquement
  assert.ok(contrastWithWhite(yellow.accent) >= 4.5);
  assert.match(shades("#1d4ed8").grad, /^linear-gradient\(100deg,#/);
});

test("fichiers : type réel vérifié, SVG avec script refusé", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  assert.equal(sniffImage(png), "image/png");
  assert.equal(sniffImage(Buffer.from("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")), "image/svg+xml");
  assert.equal(sniffImage(Buffer.from("<html><script>alert(1)</script></html>")), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-"));
  assert.throws(() => saveAsset("logo", Buffer.from("<svg onload=\"alert(1)\"></svg>"), dir), /code/);
  assert.throws(() => saveAsset("bg", Buffer.from("<svg></svg>"), dir), /PNG, JPEG ou WebP/);
  assert.throws(() => saveAsset("logo", Buffer.from("pas une image"), dir), /PNG/);
  assert.equal(saveAsset("logo", png, dir), "image/png");
  assert.ok(fs.existsSync(path.join(dir, "logo")));
});

test("feuille de style : rien à changer par défaut, couleur, logo et fond", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-"));
  assert.equal(readTheme(dir).color, "#d8141c");
  assert.doesNotMatch(themeCss(readTheme(dir)), /--accent/);
  writeTheme({ color: "#1d4ed8", logo: true, bg: true }, dir);
  const css = themeCss(readTheme(dir));
  assert.match(css, /--accent:#1d4ed8/); assert.match(css, /--accent-rgb:29,78,216/);
  assert.match(css, /prefers-color-scheme:dark/); assert.match(css, /\/theme\/logo\?v=\d+/); assert.match(css, /\/theme\/bg\?v=\d+/);
  fs.writeFileSync(path.join(dir, "theme.json"), "{\"color\":\"rouge\"}");
  assert.equal(readTheme(dir).color, "#d8141c");     // couleur invalide : thème par défaut
});
