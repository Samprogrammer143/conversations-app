// Renders the macOS icons from scripts/icon-art.mjs: the app icon (1024 px, on Apple's icon
// grid: an 824 px tile with a soft shadow, which electron-builder turns into the .icns) and the
// menu bar icons, which are "template" images: black on transparent, so macOS can draw them
// light or dark to match the menu bar.
// Run with:  node scripts/make-mac-icons.mjs   (headless Chromium from Playwright; no window)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { iconSvg, trayTemplateSvg } from "./icon-art.mjs";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
async function png(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const buf = await page.locator("svg").first().screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(out, file), buf);
  console.log(file, size, buf.length);
}
await png(iconSvg({ size: 1024, grid: "mac" }), 1024, "icon-mac.png");
for (const [badge, name] of [[false, "trayTemplate"], [true, "trayBadgeTemplate"]]) {
  await png(trayTemplateSvg(18, badge), 18, `${name}.png`);
  await png(trayTemplateSvg(36, badge), 36, `${name}@2x.png`);
}
await browser.close();
