// Launches the built app in the development sandbox and saves screenshots, for
// checking the window against the Figma frames.
//
//   node scripts/shot.mjs <out dir> [--width 1440 --height 900] [--dark] [--steps steps.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, sandboxEnv } from "./dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const out = path.resolve(args[0] ?? path.join(root, "test-results", "shots"));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const width = Number(opt("width", 1440));
const height = Number(opt("height", 900));
const dark = args.includes("--dark");
const stepsFile = opt("steps", null);
fs.mkdirSync(out, { recursive: true });

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: launchEnv({ CONVERSATIONS_DEBUG: "1" }),
  timeout: 60_000,
  // Playwright emulates a light colour scheme unless told otherwise.
  colorScheme: dark ? "dark" : "light",
});
app.process().stdout?.on("data", (d) => process.stdout.write(`[main] ${d}`));
app.process().stderr?.on("data", (d) => process.stdout.write(`[main!] ${d}`));
const win = await app.firstWindow();
win.on("console", (m) => console.log(`[page:${m.type()}] ${m.text()}`));
win.on("pageerror", (e) => console.log(`[page:error] ${e.message}`));
await app.evaluate(({ BrowserWindow, nativeTheme }, { width, height, dark }) => {
  nativeTheme.themeSource = dark ? "dark" : "light";
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Conversations") ?? BrowserWindow.getAllWindows()[0];
  w.unmaximize();
  w.setContentSize(width, height);
  w.center();
  w.show();
}, { width, height, dark });
await win.waitForLoadState("domcontentloaded");
await win.waitForTimeout(2500);

const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, "utf8")) : [{ shot: "main" }];
for (const s of steps) {
  if (s.eval) await win.evaluate(s.eval);
  if (s.click) await win.click(s.click);
  if (s.type) await win.keyboard.type(s.type, { delay: 20 });
  if (s.press) await win.keyboard.press(s.press);
  if (s.down) await win.keyboard.down(s.down);
  if (s.up) await win.keyboard.up(s.up);
  if (s.wait) await win.waitForTimeout(s.wait);
  if (s.shot) {
    await win.waitForTimeout(s.settle ?? 400);
    await win.screenshot({ path: path.join(out, `${s.shot}.png`) });
    console.log(`saved ${s.shot}.png`);
  }
}
await app.close();
