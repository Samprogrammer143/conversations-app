// A screenshot over the API's limit, against this PC's real Claude Code (one short Haiku
// turn): dropped in and picked from a file it is made smaller and attached, not refused, and
// Claude really reads it.
//   node test/e2e/big-image.e2e.mjs <scratch folder>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, collectE2eTranscripts } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = path.resolve(process.argv[2]);
fs.mkdirSync(scratch, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await win.waitForTimeout(2500);
  const projectId = "folder:big-image-e2e";
  await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });
  await win.keyboard.press("ControlOrMeta+N");
  await win.waitForTimeout(800);
  await win.fill('textarea[aria-label="Message"]', "");

  // A 4K "screenshot": mostly solid green with noise, far over 5 MB as a PNG.
  const makePng = () =>
    win.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 3840;
      c.height = 2160;
      const x = c.getContext("2d");
      const img = x.createImageData(c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 60;
        img.data[i + 1] = 170 + Math.random() * 85;
        img.data[i + 2] = Math.random() * 60;
        img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      window.__png = blob;
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768));
      return btoa(s);
    });
  const b64 = await makePng();
  const file = path.join(scratch, "screenshot.png");
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  const mb = fs.statSync(file).size / 1048576;
  check("the test image is over the limit", mb > 6, `${mb.toFixed(1)} MB`);

  const chips = () => win.evaluate(() => [...document.querySelectorAll(".attach-chip img")].map((i) => ({ type: i.src.slice(5, i.src.indexOf(";")), base64: i.src.length - i.src.indexOf(",") - 1 })));
  const until = async (fn, ms) => {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < ms) {
      v = await fn();
      if (v) return v;
      await win.waitForTimeout(300);
    }
    return v;
  };

  // Dropped in.
  await win.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([window.__png], "screenshot.png", { type: "image/png" }));
    document.querySelector(".composer").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const dropped = await until(async () => {
    const c = await chips();
    return c.length === 1 ? c[0] : null;
  }, 30_000);
  check("dropped in, it is attached and fits", !!dropped && dropped.base64 <= 5 * 1048576, JSON.stringify(dropped));
  const toast = await win.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));
  check("nothing says it was too big", !/5 MB|couldn't/.test(toast), toast);

  // Picked from a file.
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, file);
  await win.click('.composer button[aria-label^="Attach"]');
  const picked = await until(async () => {
    const c = await chips();
    return c.length === 2 ? c[1] : null;
  }, 30_000);
  check("picked from a file, it is attached and fits", !!picked && picked.base64 <= 5 * 1048576, JSON.stringify(picked));
  check("...not turned into a file path in the message", !(await win.inputValue('textarea[aria-label="Message"]')).includes("Attached file"));
  await win.click('.attach-chip .remove');

  // Claude really reads it.
  const box = 'textarea[aria-label="Message"]';
  await win.fill(box, "What is the main colour of this image? Reply with one word.");
  await win.click('button[aria-label="Model"]');
  await win.waitForTimeout(500);
  await win.evaluate(() => [...document.querySelectorAll(".menu.choice .menu-item")].find((b) => /haiku/i.test(b.textContent))?.click());
  await win.press(box, "Enter");
  const reply = await until(() => win.evaluate(() => [...document.querySelectorAll(".claude")].map((e) => e.textContent).find((t) => /green/i.test(t)) ?? null), 120_000);
  const err = await win.evaluate(() => document.querySelector(".notice.error")?.textContent ?? "");
  check("Claude accepts it and sees it", !!reply, reply ?? err);
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  try {
    collectE2eTranscripts(scratch);
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
