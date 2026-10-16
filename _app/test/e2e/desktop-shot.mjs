// Captures the real window from the screen (not just the page), to check what
// only Windows draws: Mica behind the sidebar, and the native caption buttons.
//   node test/e2e/desktop-shot.mjs <out.png> [--dark]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, sandboxEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2]);
const dark = process.argv.includes("--dark");
const settingsFile = path.join(sandboxEnv.CONVERSATIONS_DATA_DIR, "settings.json");
const saved = fs.readFileSync(settingsFile, "utf8");
fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(saved), windowMaterial: "mica", theme: dark ? "dark" : "light" }));
try {
  const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: dark ? "dark" : "light", timeout: 60_000 });
  const win = await app.firstWindow();
  // Screen capture works in physical pixels; the window is placed in device-independent ones.
  const b = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: 80, y: 60, width: 1440, height: 900 });
    w.show();
    w.focus();
    w.moveTop();
    const r = screen.dipToScreenRect(w, w.getBounds());
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await win.waitForTimeout(3500);
  const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms;
$bmp = New-Object System.Drawing.Bitmap ${b.width}, ${b.height};
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen(${b.x}, ${b.y}, 0, 0, $bmp.Size);
$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) console.log(r.stderr);
  console.log(`bounds ${JSON.stringify(b)}; saved ${out}`);
  await app.close();
} finally {
  fs.writeFileSync(settingsFile, saved);
}
