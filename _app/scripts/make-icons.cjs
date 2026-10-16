// Renders the app and tray icons (the Figma app icon: a blue gradient tile with
// the message-square glyph) at every Windows size and packs them into .ico files.
// Run with Electron:  npx electron scripts/make-icons.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const out = path.resolve(__dirname, "..", "resources");
const GLYPH = '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>';

function svg(size, { badge = false, tray = false } = {}) {
  // Small sizes get a heavier stroke and less inset so the glyph stays legible.
  const r = Math.round(size * 0.225);
  const inset = tray ? size * 0.04 : size * 0.06;
  const tile = size - inset * 2;
  const g = tile * (size <= 20 ? 0.66 : 0.58);
  const sw = size <= 20 ? 2.4 : size <= 32 ? 2.1 : 1.8;
  const gx = inset + (tile - g) / 2;
  const gy = inset + (tile - g) / 2 + tile * 0.02;
  const dot = size * 0.34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3394ff"/><stop offset="1" stop-color="#4f54eb"/></linearGradient></defs>
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${r}" fill="url(#g)"/>
  <svg x="${gx}" y="${gy}" width="${g}" height="${g}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</svg>
  ${badge ? `<circle cx="${size - dot / 2 - 0.5}" cy="${dot / 2 + 0.5}" r="${dot / 2}" fill="#ff9500" stroke="#fff" stroke-width="${Math.max(1, size / 16)}"/>` : ""}
</svg>`;
}

async function render(win, size, opts) {
  const html = `<html><body style="margin:0;background:transparent">${svg(size, opts)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 60));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size }).toPNG();
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  const make = async (name, sizes, opts) => {
    const pngs = [];
    for (const size of sizes) pngs.push({ size, data: await render(win, size, opts) });
    fs.writeFileSync(path.join(out, name), ico(pngs));
    console.log(`${name}: ${sizes.join(", ")}`);
    return pngs;
  };
  const big = await make("icon.ico", [16, 20, 24, 32, 40, 48, 64, 128, 256], {});
  fs.writeFileSync(path.join(out, "icon.png"), big[big.length - 1].data);
  await make("tray.ico", [16, 20, 24, 32, 40, 48], { tray: true });
  await make("tray-badge.ico", [16, 20, 24, 32, 40, 48], { tray: true, badge: true });
  app.quit();
});
