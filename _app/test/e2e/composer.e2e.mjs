// Checks the composer's controls in the sandbox: the model menu lists Claude
// Code's real models, the + button opens the file dialog, and a pasted image
// becomes an attachment.   node test/e2e/composer.e2e.mjs <shots dir>
import fs from "node:fs";
import os from "node:os";
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

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 900);
    w.show();
  });
  await win.waitForTimeout(2500);
  await win.evaluate(() => document.querySelector(".row")?.click());
  await win.waitForTimeout(1200);

  // The model list comes from Claude Code itself; give the background fetch time.
  let models = [];
  for (let i = 0; i < 20 && models.length < 6; i++) {
    models = await win.evaluate(() => window.conversations.chat.models());
    if (models.length < 6) await win.waitForTimeout(1500);
  }
  check("the model list comes from Claude Code", models.length >= 6, `${models.length} models: ${models.map((m) => m.label).join(", ")}`);
  check("it includes Fable", models.some((m) => /fable/i.test(m.label)));
  await win.click('button[aria-label="Model"]');
  await win.waitForTimeout(400);
  const shown = await win.evaluate(() => [...document.querySelectorAll(".menu.choice .menu-item")].map((b) => b.textContent));
  check("the menu shows them", shown.length === models.length, `${shown.length} rows`);
  await win.screenshot({ path: path.join(out, "model-menu.png") });
  const fable = await win.evaluate(() => [...document.querySelectorAll(".menu.choice .menu-item")].findIndex((b) => /^Fable/i.test(b.querySelector(".text > span")?.textContent ?? "")));
  if (fable >= 0) {
    await win.locator(".menu.choice .menu-item").nth(fable).click();
    await win.waitForTimeout(300);
    const chip = await win.textContent('button[aria-label="Model"]');
    check("picking Fable shows it on the chip", /fable/i.test(chip ?? ""), chip ?? "");
  }

  // Effort: a chip with the levels the chosen model takes.
  await win.click('button[aria-label^="Effort"]');
  await win.waitForTimeout(300);
  const levels = await win.evaluate(() => [...document.querySelectorAll(".menu.choice .menu-item .text > span:first-child")].map((s) => s.textContent));
  check("the effort menu lists the levels", levels.includes("High") && levels.includes("Max"), levels.join(", "));
  const xhigh = levels.indexOf("Extra high");
  if (xhigh >= 0) await win.locator(".menu.choice .menu-item").nth(xhigh).click();
  await win.waitForTimeout(200);
  check("picking a level shows it on the chip", /Extra high/.test((await win.textContent('button[aria-label^="Effort"]')) ?? ""));

  // "/": the folder's commands and skills, filtered as you type.
  await win.fill("textarea[aria-label=Message]", "/");
  let names = [];
  for (let i = 0; i < 20 && names.length === 0; i++) {
    await win.waitForTimeout(500);
    names = await win.evaluate(() => [...document.querySelectorAll(".slash-item .slash-name")].map((n) => n.textContent));
  }
  check("typing / lists commands and skills", names.length > 10, `${names.length} shown`);
  await win.screenshot({ path: path.join(out, "slash-menu.png") });
  await win.fill("textarea[aria-label=Message]", "/conte");
  await win.waitForTimeout(300);
  const filtered = await win.evaluate(() => [...document.querySelectorAll(".slash-item .slash-name")].map((n) => n.textContent.trim()));
  check("typing narrows the list", filtered.length > 0 && filtered[0].startsWith("/context"), filtered.slice(0, 3).join(", "));
  await win.press("textarea[aria-label=Message]", "Tab");
  await win.waitForTimeout(200);
  check("Tab completes the name", (await win.inputValue("textarea[aria-label=Message]")) === "/context ");
  await win.fill("textarea[aria-label=Message]", "");

  // +: the dialog is replaced so the test can see it was asked for.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogCalls = 0;
    dialog.showOpenDialog = async () => {
      globalThis.__dialogCalls++;
      return { canceled: true, filePaths: [] };
    };
  });
  await win.click('button[aria-label="Attach an image or file"]');
  await win.waitForTimeout(600);
  const calls = await app.evaluate(() => globalThis.__dialogCalls);
  check("the + button opens the file dialog", calls === 1, `${calls} call(s)`);

  // New chat in a folder: the picker is replaced with a temp folder.
  const tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), "conv-folder-"));
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, tmpFolder);
  await win.evaluate(() => window.dispatchEvent(new Event("app:focus-search")));
  await win.keyboard.type("folder", { delay: 20 });
  await win.waitForTimeout(400);
  const row = await win.evaluate(() => [...document.querySelectorAll(".palette-row")].findIndex((b) => /New chat in a folder/.test(b.textContent)));
  check("the search palette offers New chat in a folder", row >= 0);
  if (row >= 0) await win.locator(".palette-row").nth(row).click();
  await win.waitForTimeout(600);
  const draftTitle = await win.evaluate(() => document.querySelector(".detail .empty .title")?.textContent ?? "");
  check("the draft runs in the picked folder", draftTitle === `New chat in ${path.basename(tmpFolder)}`, draftTitle);
  const draftLine = await win.evaluate(() => document.querySelector(".detail .empty .line")?.textContent ?? "");
  check("and says where", draftLine.includes(tmpFolder), draftLine.slice(0, 80));
  await win.screenshot({ path: path.join(out, "new-chat-folder.png") });
  await win.keyboard.press("Escape");

  // Paste: a 1x1 PNG as a clipboard file.
  await win.focus("textarea[aria-label=Message]");
  await win.evaluate(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    document.querySelector("textarea[aria-label=Message]").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(500);
  const chips = await win.evaluate(() => document.querySelectorAll(".attach-chip").length);
  check("a pasted image becomes an attachment", chips === 1, `${chips} chip(s)`);
  await win.screenshot({ path: path.join(out, "attachment.png") });
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
