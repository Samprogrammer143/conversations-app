// Checks the usage meters under the sidebar in the sandbox, with the real numbers
// Claude Code reports for this account, and saves light and dark pictures of them.
//   node test/e2e/usage.e2e.mjs <shots dir>
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

for (const scheme of ["light", "dark"]) {
  const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: scheme, timeout: 60_000 });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1280, 820);
      w.show();
    });
    // The first reading is asked for a few seconds after start.
    let meters = [];
    for (let i = 0; i < 30 && meters.length < 3; i++) {
      meters = await win.evaluate(() => [...document.querySelectorAll(".usage-meter")].map((m) => ({ label: m.querySelector(".usage-label")?.textContent, pct: m.querySelector(".usage-pct")?.textContent, now: m.querySelector(".usage-track")?.getAttribute("aria-valuenow"), width: m.querySelector(".usage-fill")?.style.width, title: m.getAttribute("title") })));
      if (meters.length < 3) await win.waitForTimeout(1000);
    }
    if (scheme === "light") {
      console.log(JSON.stringify(meters, null, 1));
      check("three meters show", meters.length >= 3, meters.map((m) => `${m.label} ${m.pct}`).join(" | "));
      check("in order: session, all models, Fable", meters[0]?.label === "Current session" && meters[1]?.label === "Weekly · All models" && meters[2]?.label === "Weekly · Fable");
      check("each bar matches its number", meters.every((m) => m.pct === `${m.now}%` && m.width === `${m.now}%`));
      check("each says when it resets", meters.every((m) => /Resets /.test(m.title ?? "")));
      const api = await win.evaluate(() => window.conversations.chat.usage());
      check("the reading is kept for the next start", !!api?.meters?.length);
      const box = await win.evaluate(() => {
        const a = document.querySelector(".sb-usage").getBoundingClientRect();
        const b = document.querySelector(".sync-status").getBoundingClientRect();
        const s = document.querySelector(".sidebar").getBoundingClientRect();
        return { usageBottom: a.bottom, syncTop: b.top, inside: a.left >= s.left && a.right <= s.right + 0.5, overflow: document.querySelector(".sb-usage").scrollWidth > document.querySelector(".sb-usage").clientWidth };
      });
      check("sits above the sync status, inside the sidebar, without overflow", box.usageBottom <= box.syncTop + 1 && box.inside && !box.overflow, JSON.stringify(box));
    }
    // The sidebar is see-through (Mica), which a screenshot cannot capture; the
    // solid fallback shows the colours as they sit on the real backdrop.
    await win.evaluate(() => document.body.classList.add("solid"));
    await win.waitForTimeout(600);
    const sb = await win.evaluate(() => {
      const r = document.querySelector(".sidebar").getBoundingClientRect();
      return { x: r.left, y: Math.max(0, r.bottom - 300), width: r.width, height: Math.min(300, r.height) };
    });
    await win.screenshot({ path: path.join(out, `usage-${scheme}.png`), clip: sb });
    await win.screenshot({ path: path.join(out, `usage-${scheme}-window.png`) });
  } finally {
    await app.close();
  }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
