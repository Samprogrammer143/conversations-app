// Switching model from the keyboard, in the sandbox (a new chat: nothing is sent):
// Up and Down in the message box, Ctrl+M at any time.
//   node test/e2e/model-keys.e2e.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await win.waitForTimeout(3000);
  await win.keyboard.press("Control+N");
  await win.waitForTimeout(800);
  const box = 'textarea[aria-label="Message"]';
  const chip = () => win.evaluate(() => document.querySelector('button[aria-label="Model"]')?.textContent?.trim());
  await win.click(box);
  await win.fill(box, "");
  const first = await chip();
  await win.keyboard.press("ArrowDown");
  await win.waitForTimeout(200);
  const second = await chip();
  check("Down, in the message box, goes to the next model", !!second && second !== first, `${first} -> ${second}`);
  await win.keyboard.press("ArrowUp");
  await win.waitForTimeout(200);
  check("Up goes back", (await chip()) === first, await chip());
  const seen = new Set([first]);
  for (let i = 0; i < 12; i++) {
    await win.keyboard.press("ArrowDown");
    await win.waitForTimeout(80);
    seen.add(await chip());
  }
  check("it goes round the current models and no others", seen.size >= 2 && seen.size <= 6 && ![...seen].some((m) => !m), [...seen].join(", "));

  await win.fill(box, "half a message");
  const typed = await chip();
  await win.keyboard.press("ArrowDown");
  await win.waitForTimeout(200);
  check("it works while typing, and keeps the text", (await chip()) !== typed && (await win.inputValue(box)) === "half a message", await chip());

  await win.fill(box, "line one\nline two");
  await win.waitForTimeout(100);
  const multi = await chip();
  await win.keyboard.press("ArrowUp");
  await win.waitForTimeout(200);
  check("over several lines, Up moves the cursor, not the model", (await chip()) === multi);
  await win.keyboard.press("Control+M");
  await win.waitForTimeout(200);
  check("Ctrl+M still switches there", (await chip()) !== multi, await chip());

  await win.fill(box, "/");
  await win.waitForTimeout(400);
  const slash = await chip();
  await win.keyboard.press("ArrowDown");
  await win.waitForTimeout(200);
  check("a /command being typed keeps its arrows", (await chip()) === slash, `${slash} -> ${await chip()}`);

  await win.fill(box, "");
  await win.click('button[aria-label="Model"]');
  // (Opening the menu refreshes the list, which can rename the chip.)
  await win.waitForTimeout(2500);
  const open = await chip();
  await win.keyboard.press("ArrowDown");
  await win.waitForTimeout(200);
  check("not while the model menu is open", (await chip()) === open, `${open} -> ${await chip()}`);
  await win.keyboard.press("Escape");
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
