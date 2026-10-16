// Smoke test of the packaged app (release/win-unpacked) in the development
// sandbox: the shell starts, picks the app code, and the window shows the list.
//   node test/e2e/packaged.e2e.mjs <screenshot folder>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, sandboxEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = path.join(root, "release", "win-unpacked", "Conversations.exe");
const shots = path.resolve(process.argv[2] ?? path.join(root, "test-results"));
fs.mkdirSync(shots, { recursive: true });

const app = await electron.launch({ executablePath: exe, args: [], env: launchEnv(), colorScheme: "light", timeout: 60_000 });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Conversations") ?? BrowserWindow.getAllWindows()[0];
  w.setContentSize(1280, 800);
  w.show();
});
await win.waitForTimeout(3000);
const info = await win.evaluate(() => window.conversations.app.info());
const rows = await win.evaluate(() => document.querySelectorAll(".row").length);
const packaged = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), shell: process.env.CONVERSATIONS_SHELL_VERSION }));
console.log(JSON.stringify({ version: info.version, machine: info.machine, rows, ...packaged }));
await win.screenshot({ path: path.join(shots, "packaged.png") });
await app.close();
const ok = packaged.packaged && packaged.shell === "1.0.0" && rows > 0;
console.log(ok ? "PASS packaged app starts through the shell and lists conversations" : "FAIL");
process.exit(ok ? 0 : 1);
