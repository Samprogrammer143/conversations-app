// Renders the app and tray icons (scripts/icon-art.mjs: the chat with a prompt on a graphite
// tile) at every Windows size and packs them into .ico files. 32 px and under use the small
// drawing (no glow or shadow, a bigger chat, the prompt only), which stays legible.
// Run with Electron:  npx electron scripts/make-icons.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const out = path.resolve(__dirname, "..", "resources");

async function render(win, size, svg) {
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
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
  const art = await import(pathToFileURL(path.join(__dirname, "icon-art.mjs")).href);
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  const make = async (name, sizes, draw) => {
    const pngs = [];
    for (const size of sizes) pngs.push({ size, data: await render(win, size, draw(size)) });
    fs.writeFileSync(path.join(out, name), ico(pngs));
    console.log(`${name}: ${sizes.join(", ")}`);
    return pngs;
  };
  const big = await make("icon.ico", [16, 20, 24, 32, 40, 48, 64, 128, 256], (size) => art.iconSvg({ size, grid: "full", small: size <= 32 }));
  fs.writeFileSync(path.join(out, "icon.png"), big[big.length - 1].data);
  await make("tray.ico", [16, 20, 24, 32, 40, 48], (size) => art.trayIconSvg(size, false));
  await make("tray-badge.ico", [16, 20, 24, 32, 40, 48], (size) => art.trayIconSvg(size, true));
  app.quit();
});
