// Focus mode, in the sandbox: Ctrl+F leaves only the chat and the usage meters, and comes back.
//   node test/e2e/focus.e2e.mjs [shots dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "test-results"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const app = await electron.launch({ args: [root], cwd: root, env: launchEnv({ CONVERSATIONS_TEST_NO_RELAUNCH: "1" }), colorScheme: "dark", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1320, 860);
    w.show();
  });
  await win.waitForTimeout(3000);
  const state = () =>
    win.evaluate(() => {
      const d = document.querySelector(".detail")?.getBoundingClientRect();
      return { sidebar: !!document.querySelector(".sidebar"), list: !!document.querySelector(".list-col"), strip: !!document.querySelector(".focus-usage"), meters: document.querySelectorAll(".usage-meter").length, detailWidth: Math.round(d?.width ?? 0), width: window.innerWidth };
    });
  const before = await state();
  check("normally: sidebar and list show, no strip", before.sidebar && before.list && !before.strip, JSON.stringify(before));
  await win.keyboard.press("Control+F");
  await win.waitForTimeout(400);
  const focused = await state();
  check("Ctrl+F: only the chat, full width, with the usage strip", !focused.sidebar && !focused.list && focused.strip && focused.meters === before.meters && focused.detailWidth === focused.width, JSON.stringify(focused));
  await win.screenshot({ path: path.join(out, "focus-mode.png") });
  await win.keyboard.press("Control+F");
  await win.waitForTimeout(400);
  const back = await state();
  check("Ctrl+F again: everything comes back", back.sidebar && back.list && !back.strip, JSON.stringify(back));
  await win.keyboard.press("Control+F");
  await win.waitForTimeout(300);
  await win.keyboard.press("Control+K");
  await win.waitForTimeout(400);
  const search = await win.evaluate(() => ({ sidebar: !!document.querySelector(".sidebar"), typing: !!document.activeElement?.closest(".search-field") }));
  check("Ctrl+K in focus mode brings the sidebar back to search", search.sidebar && search.typing, JSON.stringify(search));
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
