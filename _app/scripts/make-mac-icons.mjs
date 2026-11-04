// Renders the macOS icons: the app icon (1024 px, on Apple's icon grid: an 824 px tile
// with a soft shadow, which electron-builder turns into the .icns) and the menu bar
// icons, which are "template" images: black on transparent, so macOS can draw them light
// or dark to match the menu bar. The glyph is the same message square as the Windows
// icons (scripts/make-icons.cjs).
// Run with:  node scripts/make-mac-icons.mjs   (headless Chromium from Playwright; no window)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources");
const GLYPH = '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>';

// Apple's grid: the tile is 824 of 1024, 100 in from each edge, corner radius about 185.
function appIcon() {
  const tile = 824, inset = 100, r = 185, g = tile * 0.56;
  const gx = inset + (tile - g) / 2, gy = inset + (tile - g) / 2 + tile * 0.02;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3394ff"/><stop offset="1" stop-color="#4f54eb"/></linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.3"/></filter>
  </defs>
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${r}" fill="url(#g)" filter="url(#s)"/>
  <svg x="${gx}" y="${gy}" width="${g}" height="${g}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</svg>
</svg>`;
}

// The menu bar icon: the glyph alone, 18 pt; with a dot at the top right when Claude is
// waiting for you (a template image can't be orange, so the dot says it by shape).
function trayIcon(px, badge) {
  const sw = px <= 18 ? 1.9 : 1.75;
  const dot = badge ? `<circle cx="19.6" cy="4.4" r="4.1" fill="#000"/>` : "";
  // With the dot, a gap is cut round it so it reads as separate from the square.
  const mask = badge ? `<mask id="m"><rect width="24" height="24" fill="#fff"/><circle cx="19.6" cy="4.4" r="5.9" fill="#000"/></mask>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">
  <defs>${mask}</defs>
  <g fill="none" stroke="#000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${badge ? ' mask="url(#m)"' : ""}>${GLYPH}</g>
  ${dot}
</svg>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
async function png(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const buf = await page.locator("svg").first().screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(out, file), buf);
  console.log(file, size, buf.length);
}
await png(appIcon(), 1024, "icon-mac.png");
for (const [badge, name] of [[false, "trayTemplate"], [true, "trayBadgeTemplate"]]) {
  await png(trayIcon(18, badge), 18, `${name}.png`);
  await png(trayIcon(36, badge), 36, `${name}@2x.png`);
}
await browser.close();
