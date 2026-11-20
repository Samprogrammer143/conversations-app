// Tags in the development sandbox: makes two tags from a chat's menu, then photographs
// the picker, the list with its chips and the sidebar's Tags, a tag's own menu, and the
// list filtered by a tag. Deletes the two tags at the end.
//   node test/e2e/tags.e2e.mjs <out dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, sandboxEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2] ?? "tags-shots");
fs.mkdirSync(out, { recursive: true });
const settingsFile = path.join(sandboxEnv.CONVERSATIONS_DATA_DIR, "settings.json");
const saved = fs.readFileSync(settingsFile, "utf8");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
};

fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(saved), windowMaterial: "solid", welcomed: true }));
const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log(`[page:error] ${e.message}`));
  await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "light";
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(1440, 900);
    w.show();
  });
  await win.waitForSelector(".row", { timeout: 30_000 });
  const shot = async (name, wait = 600) => {
    await win.waitForTimeout(wait);
    await win.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`saved ${name}`);
  };
  const menuOn = async (i) => {
    const box = await win.locator(".row").nth(i).boundingBox();
    await win.locator(".row").nth(i).click({ button: "right", position: { x: 60, y: 20 } });
    return box;
  };

  // 1. A chat's menu has Tags…; T opens the picker.
  await menuOn(0);
  check("the chat menu has Tags…", (await win.locator(".menu.context .menu-item", { hasText: "Tags…" }).count()) === 1);
  await win.keyboard.press("t");
  await win.waitForSelector(".tag-picker");
  await win.keyboard.type("E2E Bugs", { delay: 20 });
  await shot("1-picker-typing-new", 300);
  check("typing a new name offers Create", (await win.locator(".tag-option", { hasText: "Create tag “E2E Bugs”" }).count()) === 1);
  await win.keyboard.press("Enter");
  await win.keyboard.type("E2E Client work", { delay: 20 });
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  await shot("2-picker-after-create");
  check("both tags are ticked in the picker", (await win.locator('.tag-option[aria-selected="true"]').count()) === 2);
  await win.keyboard.press("Escape");
  await win.waitForTimeout(200);

  // 2. The second chat gets one of them by typing part of its name.
  await menuOn(1);
  await win.locator(".menu.context .menu-item", { hasText: "Tags…" }).click();
  await win.keyboard.type("bug", { delay: 20 });
  await shot("3-picker-typing-existing", 300);
  await win.keyboard.press("Enter");
  await win.keyboard.press("Escape");
  await win.mouse.click(5, 450);

  // 3. Chips on the rows, Tags in the sidebar.
  await shot("4-list-and-sidebar", 1500);
  const sideTags = await win.locator(".sb-item", { hasText: "E2E" }).allInnerTexts();
  check("the sidebar lists both tags with counts", sideTags.some((t) => /E2E Bugs\s*2/.test(t)) && sideTags.some((t) => /E2E Client work\s*1/.test(t)), JSON.stringify(sideTags));
  check("rows show chips", (await win.locator(".row .tag-chip").count()) >= 2);

  // 4. A tag's own menu.
  await win.locator(".sb-item", { hasText: "E2E Bugs" }).click({ button: "right" });
  await shot("5-tag-menu", 400);
  check("a tag's menu has Rename, colours and Delete", (await win.locator(".tag-menu .tag-swatch").count()) === 8 && (await win.locator(".tag-menu .menu-item", { hasText: "Delete tag" }).count()) === 1);
  await win.locator(".tag-menu .tag-swatch.c-teal").click();
  await win.waitForTimeout(600);

  // 5. Filter by the tag.
  await win.locator(".sb-item", { hasText: "E2E Bugs" }).click();
  await shot("6-filtered", 1200);
  check("filtering by a tag shows its two chats", (await win.locator(".row").count()) === 2 && (await win.locator(".list-toolbar, .list-head, header").first().innerText()).includes("E2E Bugs"));

  // 6. Rename, then clean up: delete both tags.
  await win.locator(".sb-item", { hasText: "E2E Bugs" }).click({ button: "right" });
  await win.locator(".tag-menu .menu-item", { hasText: "Rename…" }).click();
  await win.keyboard.press("Control+A");
  await win.keyboard.type("E2E Fixes", { delay: 20 });
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  check("renaming a tag changes it in the sidebar", (await win.locator(".sb-item", { hasText: "E2E Fixes" }).count()) === 1);
  for (const name of ["E2E Fixes", "E2E Client work"]) {
    await win.locator(".sb-item", { hasText: name }).click({ button: "right" });
    await win.locator(".tag-menu .menu-item", { hasText: "Delete tag" }).click();
    await win.waitForTimeout(800);
  }
  check("deleted tags leave the sidebar and the rows", (await win.locator(".sb-item", { hasText: "E2E" }).count()) === 0 && (await win.locator(".row .tag-chip").count()) === 0);
} finally {
  await app.close();
  fs.writeFileSync(settingsFile, saved);
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
