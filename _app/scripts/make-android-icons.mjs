// The Android app's icons and splash, from the same drawing as the PC's (scripts/icon-art.mjs):
//   adaptive icon: the dark tile as the background layer, the chat as the foreground (inside
//   Android's safe zone), and the chat alone in one colour for themed icons (Android 13+);
//   older launchers: the whole icon, square and round; the splash: the chat on the dark tile colour.
//   node scripts/make-android-icons.mjs        (rendered with Chrome through Playwright)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { COLORS, iconSvg, trayTemplateSvg } from "./icon-art.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const res = path.join(root, "android", "app", "src", "main", "res");
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

// The pieces of iconSvg, taken apart: the tile's gradient and glow (filling the square: the launcher
// cuts the shape), and the chat at the size it has on the 824 grid.
const full = iconSvg({ size: 1024, grid: "mac" });
const defs = /<defs>([\s\S]*?)<\/defs>/.exec(full)[1];
const art = /<g transform="([^"]+)">([\s\S]*?)<\/g>\s*<\/g>/.exec(full);
const background = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${defs}</defs>
  <rect width="1024" height="1024" fill="url(#ci-tile)"/><rect width="1024" height="1024" fill="url(#ci-glow)"/></svg>`;
// Foreground: 108 dp with a 66 dp safe zone; the chat (about 520 of 1024 on the mac grid) fits it as drawn.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${defs}</defs>
  <g transform="${art[1]}">${art[2]}</g></svg>`;
// Themed icons: one colour, the chat with the prompt cut out, in the same safe zone.
const mono = trayTemplateSvg(1024).replace(/viewBox="([^"]+)"/, (m, vb) => {
  const [x, y, w, h] = vb.split(/\s+/).map(Number);
  const pad = w * 0.62;
  return `viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}"`;
});
const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${defs}<clipPath id="round"><circle cx="512" cy="512" r="490"/></clipPath></defs>
  <g clip-path="url(#round)"><rect width="1024" height="1024" fill="url(#ci-tile)"/><rect width="1024" height="1024" fill="url(#ci-glow)"/>
  <g transform="translate(512 512) scale(1.12) translate(-512 -512)"><g transform="${art[1]}">${art[2]}</g></g></g></svg>`;
const legacy = iconSvg({ size: 1024, grid: "full", inset: 0.04 });
const splash = (w, h) => {
  const s = Math.min(w, h) * 0.62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>
  <rect width="${w}" height="${h}" fill="${COLORS.tileBottom}"/>
  <g transform="translate(${(w - s) / 2} ${(h - s) / 2}) scale(${s / 1024})"><g transform="${art[1]}">${art[2]}</g></g></svg>`;
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
async function render(svg, w, h, file) {
  await page.setViewportSize({ width: w, height: h });
  const sized = svg.replace("<svg ", `<svg width="${w}" height="${h}" `);
  await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}

for (const [d, k] of Object.entries(DENSITIES)) {
  const dir = path.join(res, `mipmap-${d}`);
  await render(foreground, Math.round(108 * k), Math.round(108 * k), path.join(dir, "ic_launcher_foreground.png"));
  await render(background, Math.round(108 * k), Math.round(108 * k), path.join(dir, "ic_launcher_background.png"));
  await render(mono, Math.round(108 * k), Math.round(108 * k), path.join(dir, "ic_launcher_monochrome.png"));
  await render(legacy, Math.round(48 * k), Math.round(48 * k), path.join(dir, "ic_launcher.png"));
  await render(round, Math.round(48 * k), Math.round(48 * k), path.join(dir, "ic_launcher_round.png"));
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
for (const f of ["ic_launcher.xml", "ic_launcher_round.xml"]) fs.writeFileSync(path.join(res, "mipmap-anydpi-v26", f), adaptive);

// Every splash Capacitor made, redrawn at its own size.
for (const d of fs.readdirSync(res).filter((n) => n.startsWith("drawable"))) {
  const f = path.join(res, d, "splash.png");
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  await render(splash(w, h), w, h, f);
}
await browser.close();
console.log("android icons and splash made");
