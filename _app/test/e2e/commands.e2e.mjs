// Slash commands through the app, against this PC's real Claude Code, in a scratch
// folder (one short Haiku turn; the test chats are moved into the sandbox after):
// - a local command's output shows under what you typed (/output-style, /context);
// - /mcp opens the servers panel, live, and Reconnect works;
// - /model on its own opens the model menu; /clear starts a new chat in the same folder;
// - /mcp in a new chat (nothing running) lists what it would have.
//   node test/e2e/commands.e2e.mjs <scratch folder> [shots dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, collectE2eTranscripts } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] ?? path.join(root, "test-results"));
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

let chatId = null;
let app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1320, 900);
    w.show();
  });
  await win.waitForTimeout(2500);
  const projectId = "folder:commands-e2e";
  await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });

  const sent = await win.evaluate(({ projectId }) => window.conversations.chat.send(null, "Reply with just the word OK.", { projectId, model: "haiku", permissionMode: "default" }), { projectId });
  check("a chat starts", sent.ok && !!sent.conversationId, JSON.stringify(sent));
  const id = sent.conversationId;
  chatId = id;
  for (let i = 0; i < 60; i++) {
    const st = await win.evaluate((cid) => window.conversations.chat.status(cid), id);
    const listed = await win.evaluate((cid) => !!document.querySelector(`[data-id="${cid}"]`), id);
    if (st?.state === "idle" && listed) break;
    await win.waitForTimeout(1000);
  }
  await win.evaluate((cid) => document.querySelector(`[data-id="${cid}"]`)?.click(), id);
  await win.waitForTimeout(1200);

  const box = 'textarea[aria-label="Message"]';
  const run = async (text) => {
    await win.click(box);
    await win.fill(box, text);
    await win.press(box, "Enter");
  };
  const waitFor = async (fn, arg, ms = 20_000) => {
    const t0 = Date.now();
    let v = null;
    while (Date.now() - t0 < ms) {
      v = await win.evaluate(fn, arg);
      if (v) return v;
      await win.waitForTimeout(400);
    }
    return v;
  };
  const lastCommand = (name) => {
    const runs = [...document.querySelectorAll(".command-run")].filter((r) => r.querySelector(".command-typed")?.textContent?.replace(/\s+/g, " ").trim().startsWith(`/${name}`));
    const r = runs.at(-1);
    return r ? { typed: r.querySelector(".command-typed")?.textContent ?? "", output: r.querySelector(".command-output")?.textContent ?? "" } : null;
  };

  // Claude knows it runs in the app: a failed MCP server is fixed with /mcp here, not in a terminal.
  await run("The figma-local MCP server failed to connect and I have just started Figma. In one or two sentences: what should I do so you can use it in this chat? Don't use any tools.");
  // Its answer: the last reply once Claude is done, and not the first chat's "OK".
  await waitFor((cid) => window.conversations.chat.status(cid).then((s) => s?.state !== "idle"), id, 15_000);
  await waitFor((cid) => window.conversations.chat.status(cid).then((s) => s?.state === "idle"), id, 90_000);
  const said = await waitFor(() => {
    const t = [...document.querySelectorAll(".claude")].at(-1)?.textContent ?? "";
    return /figma|mcp/i.test(t) ? t : null;
  }, null, 10_000) ?? "";
  check("Claude sends you to /mcp in the app, not to a terminal", /\/mcp/.test(said) && !/\bterminal\b|\bCLI\b/i.test(said), said.replace(/\s+/g, " ").slice(0, 220));

  // A local command: what you typed, and what it printed.
  await run("/output-style");
  const os1 = await waitFor((n) => {
    const runs = [...document.querySelectorAll(".command-run")].filter((r) => r.querySelector(".command-typed")?.textContent?.includes(n));
    const r = runs.at(-1);
    return r && r.querySelector(".command-output") ? { typed: r.querySelector(".command-typed").textContent, output: r.querySelector(".command-output").textContent } : null;
  }, "output-style");
  check("/output-style shows what you typed and what it printed", !!os1 && os1.output.includes("Output style"), JSON.stringify(os1)?.slice(0, 200));
  const pendingLeft = await win.evaluate(() => [...document.querySelectorAll(".you .bubble")].filter((b) => !b.closest(".command-run") && b.textContent.trim() === "/output-style").length);
  check("the waiting bubble is replaced by the command (not left behind)", pendingLeft === 0, `${pendingLeft} left`);

  await run("/context");
  const ctx = await waitFor((n) => {
    const runs = [...document.querySelectorAll(".command-run")].filter((r) => r.querySelector(".command-typed")?.textContent?.includes(n));
    const out = runs.at(-1)?.querySelector(".command-output")?.textContent ?? "";
    return out.includes("Context") ? out.slice(0, 120) : null;
  }, "context");
  check("/context shows the context breakdown", !!ctx, ctx ?? "");
  await win.screenshot({ path: path.join(out, "commands-output.png") });

  // /mcp: the panel, live (the chat's Claude Code is running here).
  await run("/mcp");
  const panel = await waitFor(() => {
    const p = document.querySelector(".mcp-panel");
    const rows = p ? [...p.querySelectorAll(".mcp-row")].map((r) => ({ name: r.querySelector(".mcp-name")?.textContent, status: r.getAttribute("data-status"), buttons: [...r.querySelectorAll(".mcp-actions button")].map((b) => b.textContent.trim()) })) : [];
    return rows.length ? { rows, foot: p.querySelector(".mcp-foot")?.textContent ?? null, text: document.querySelector('textarea[aria-label="Message"]')?.value } : null;
  }, null, 30_000);
  check("/mcp opens the servers panel instead of sending", !!panel && panel.text === "", JSON.stringify(panel?.rows?.slice(0, 3)));
  check("it is live: servers can be reconnected", !!panel && panel.rows.some((r) => r.buttons.includes("Reconnect")) && !panel.foot, JSON.stringify(panel?.rows?.map((r) => `${r.name}:${r.status}`)));
  await win.screenshot({ path: path.join(out, "mcp-panel-live.png") });
  const target = panel?.rows.find((r) => r.status === "connected" && r.buttons.includes("Reconnect"));
  if (target) {
    await win.evaluate((name) => [...document.querySelectorAll(".mcp-row")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-actions button")?.click(), target.name);
    const toastText = await waitFor(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).find((t) => t.includes("connected") || t.includes(":")) ?? null, null, 30_000);
    check("Reconnect works on a server", !!toastText && toastText.includes(`${target.name} is connected`), toastText ?? "no toast");
  } else check("Reconnect works on a server", false, "no connected server to try");

  // A server's details: clicking it shows where it is set up, its type and its tools.
  if (target) {
    await win.evaluate((name) => [...document.querySelectorAll(".mcp-item")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-expand")?.click(), target.name);
    const details = await waitFor(
      (name) => {
        const item = [...document.querySelectorAll(".mcp-item")].find((r) => r.querySelector(".mcp-name")?.textContent === name);
        const d = item?.querySelector(".mcp-details");
        return d ? { tools: d.querySelectorAll(".mcp-tool-name").length, rows: [...d.querySelectorAll("dt")].map((x) => x.textContent) } : null;
      },
      target.name,
      5000,
    );
    check("clicking a server shows its details and tools", !!details && details.tools > 0 && details.rows.includes("Set up in"), JSON.stringify(details));
    await win.screenshot({ path: path.join(out, "mcp-panel-details.png") });
  }

  // Sign in, without the terminal: the provider's page opens in the browser (caught here,
  // so no browser opens) and the panel waits, with a box for the address if it can't come back.
  const signable = panel?.rows.find((r) => r.status === "needs-auth" && r.buttons.includes("Sign in") && !r.name.startsWith("claude.ai "));
  if (signable) {
    await app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openExternal = async (u) => {
        globalThis.__opened.push(u);
      };
    });
    await win.evaluate((name) => [...document.querySelectorAll(".mcp-row")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-actions .btn-primary")?.click(), signable.name);
    const waiting = await waitFor(
      (name) => {
        const item = [...document.querySelectorAll(".mcp-item")].find((r) => r.querySelector(".mcp-name")?.textContent === name);
        const w = item?.querySelector(".mcp-signin");
        return w ? { text: w.textContent, paste: !!w.querySelector("input") } : null;
      },
      signable.name,
      30_000,
    );
    const opened = await app.evaluate(() => globalThis.__opened);
    check("Sign in opens the server's sign-in page in the browser, not the terminal", opened.length === 1 && /^https:\/\//.test(opened[0]), JSON.stringify(opened.map((u) => new URL(u).host)));
    check("the panel waits for it, with a box for the browser's address", !!waiting && waiting.paste && waiting.text.includes("in your browser"), JSON.stringify(waiting));
    await win.screenshot({ path: path.join(out, "mcp-panel-signin.png") });
    // Closing the panel and opening it again keeps waiting for that sign-in.
    await win.keyboard.press("Escape");
    await waitFor(() => !document.querySelector(".mcp-panel"), null, 3000);
    await run("/mcp");
    const kept = await waitFor((name) => !![...document.querySelectorAll(".mcp-item")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-signin"), signable.name, 30_000);
    check("closing and reopening the panel keeps waiting for the sign-in", !!kept);
    const bad = await win.evaluate(
      ({ id, name }) => window.conversations.chat.mcpAction(id, name, "callback", { url: "http://localhost:1/callback?nothing=1" }),
      { id, name: signable.name },
    );
    check("an address without a code is refused, the sign-in still waiting", !bad.ok && /code/i.test(bad.err ?? ""), bad.err ?? "accepted");
    await win.evaluate(() => [...document.querySelectorAll(".mcp-signin button")].find((b) => b.textContent.trim() === "Cancel")?.click());
    const cancelled = await waitFor(() => !document.querySelector(".mcp-signin"), null, 3000);
    check("Cancel stops waiting", !!cancelled);
  } else console.log("SKIP  sign-in: no server here needs a sign-in");

  // A claude.ai connector signs in on claude.ai: its page opens, then Done reconnects it here.
  const connector = panel?.rows.find((r) => r.status === "needs-auth" && r.name.startsWith("claude.ai "));
  if (connector) {
    await app.evaluate(() => {
      globalThis.__opened = [];
    });
    await win.evaluate((name) => [...document.querySelectorAll(".mcp-row")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-actions .btn-primary")?.click(), connector.name);
    const waiting = await waitFor(
      (name) => {
        const w = [...document.querySelectorAll(".mcp-item")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-signin");
        return w ? { text: w.textContent, done: [...w.querySelectorAll("button")].some((b) => b.textContent.trim() === "Done") } : null;
      },
      connector.name,
      30_000,
    );
    const opened = await app.evaluate(() => globalThis.__opened);
    check("a claude.ai connector's Sign in opens its page on claude.ai", opened.length === 1 && new URL(opened[0]).host.endsWith("claude.ai"), JSON.stringify(opened.map((u) => new URL(u).host)));
    check("and the panel offers Done for when it is connected there", !!waiting && waiting.done, waiting?.text ?? "");
    await win.screenshot({ path: path.join(out, "mcp-panel-connector.png") });
    await win.evaluate(() => [...document.querySelectorAll(".mcp-signin button")].find((b) => b.textContent.trim() === "Cancel")?.click());
  }
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);

  // Esc closes the panel and never also stops Claude: open /mcp while a reply runs, press Esc.
  await run("Count from 1 to 60, one number per line, nothing else.");
  await waitFor((cid) => window.conversations.chat.status(cid).then((s) => ["thinking", "writing", "running-tool"].includes(s?.state)), id, 15_000);
  await run("/mcp");
  await waitFor(() => !!document.querySelector(".mcp-panel"), null, 5000);
  await win.press(box, "Escape");
  const closed = await waitFor(() => !document.querySelector(".mcp-panel"), null, 3000);
  const finished = await waitFor((cid) => window.conversations.chat.status(cid).then((s) => (s?.state === "idle" ? s : null)), id, 60_000);
  const counted = await waitFor(() => {
    const t = [...document.querySelectorAll(".claude")].at(-1)?.textContent ?? "";
    return t.includes("60") ? t.length : null;
  }, null, 20_000);
  check("Esc closes the panel and the reply still finishes", !!closed && !!finished && !!counted, JSON.stringify({ closed, counted }));

  // /model on its own: the model menu opens.
  await run("/model");
  const menu = await waitFor(() => !!document.querySelector(".menu.choice"), null, 3000);
  check("/model on its own opens the model menu", !!menu);
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);

  // /clear: a new chat in the same folder; the old one stays.
  await run("/new carry this over");
  const draft = await waitFor(() => (document.querySelector(".detail")?.getAttribute("aria-label") === "New chat" ? document.querySelector(".detail-title .t2")?.textContent ?? "" : null), null, 5000);
  check("/new (like /clear) starts a new chat in the same folder", !!draft && draft.includes(path.basename(scratch)), draft ?? "");
  const carried = await waitFor(() => document.querySelector('textarea[aria-label="Message"]')?.value || null, null, 3000);
  check("what was typed after it waits in the new chat's box, unsent", carried === "carry this over", JSON.stringify(carried));
  const stillListed = await win.evaluate((cid) => !!document.querySelector(`[data-id="${cid}"]`), id);
  check("the previous chat stays in the list", stillListed);

  // A typo in /model is not taken as a model for the new chat.
  const chipBefore = await win.evaluate(() => document.querySelector('button[aria-label="Model"]')?.textContent?.trim());
  await run("/model opsu");
  const typo = await waitFor(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).find((t) => t.includes("no model called")) ?? null, null, 3000);
  const chipAfter = await win.evaluate(() => document.querySelector('button[aria-label="Model"]')?.textContent?.trim());
  check("a mistyped /model in a new chat is refused, the chip unchanged", !!typo && chipBefore === chipAfter, JSON.stringify({ typo, chipBefore, chipAfter }));

  // /mcp in the new chat: nothing runs yet, so it lists what the chat would have.
  await run("/mcp");
  const offline = await waitFor(() => {
    const p = document.querySelector(".mcp-panel");
    const rows = p ? p.querySelectorAll(".mcp-row").length : 0;
    return rows ? { rows, foot: p.querySelector(".mcp-foot")?.textContent ?? "", buttons: p.querySelectorAll(".mcp-actions button").length } : null;
  }, null, 40_000);
  check("/mcp in a new chat lists its servers, read-only", !!offline && offline.buttons === 0 && offline.foot.includes("hasn’t started"), JSON.stringify(offline));
  await win.screenshot({ path: path.join(out, "mcp-panel-new-chat.png") });
  await win.keyboard.press("Escape");
} finally {
  await app.close();
}

// After a restart the chat is not running. /mcp starts its Claude Code (nothing is
// sent), so its servers can be reconnected; your next message goes to that same one.
const transcriptOf = (cid) => {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE, ".claude"), "projects");
  for (const d of fs.readdirSync(base)) {
    const f = path.join(base, d, `${cid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
};
const replies = (cid) => {
  const f = transcriptOf(cid);
  return f ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"type":"assistant"')).length : -1;
};
app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1320, 900);
    w.show();
  });
  await win.waitForTimeout(3000);
  const waitFor = async (fn, arg, ms = 20_000) => {
    const t0 = Date.now();
    let v = null;
    while (Date.now() - t0 < ms) {
      v = await win.evaluate(fn, arg);
      if (v) return v;
      await win.waitForTimeout(400);
    }
    return v;
  };
  const box = 'textarea[aria-label="Message"]';
  await win.evaluate((cid) => document.querySelector(`[data-id="${cid}"]`)?.click(), chatId);
  await win.waitForTimeout(1200);
  const before = await win.evaluate((cid) => window.conversations.chat.status(cid), chatId);
  check("after a restart the chat is not running", !before || before.state === "idle", JSON.stringify(before?.state ?? null));
  const repliesBefore = replies(chatId);
  await win.click(box);
  await win.fill(box, "/mcp");
  await win.press(box, "Enter");
  const panel = await waitFor(() => {
    const p = document.querySelector(".mcp-panel");
    const rows = p ? [...p.querySelectorAll(".mcp-row")].map((r) => ({ name: r.querySelector(".mcp-name")?.textContent, status: r.getAttribute("data-status"), buttons: [...r.querySelectorAll(".mcp-actions button")].map((b) => b.textContent.trim()) })) : [];
    return rows.length ? { rows, foot: p.querySelector(".mcp-foot")?.textContent ?? null } : null;
  }, null, 60_000);
  check("/mcp on a chat that isn't running starts it, with Reconnect and Turn off", !!panel && !panel.foot && panel.rows.some((r) => r.buttons.includes("Reconnect")) && panel.rows.every((r) => r.buttons.length > 0), JSON.stringify(panel?.rows?.slice(0, 4)));
  await win.screenshot({ path: path.join(out, "mcp-panel-started.png") });
  const target = panel?.rows.find((r) => r.status === "connected" && r.buttons.includes("Reconnect"));
  if (target) {
    await win.evaluate((name) => [...document.querySelectorAll(".mcp-row")].find((r) => r.querySelector(".mcp-name")?.textContent === name)?.querySelector(".mcp-actions button")?.click(), target.name);
    const t = await waitFor((name) => [...document.querySelectorAll(".toast")].map((x) => x.textContent).find((x) => x.includes(name)) ?? null, target.name, 30_000);
    check("Reconnect works there", !!t && t.includes("is connected"), t ?? "no toast");
  } else check("Reconnect works there", false, "no connected server");
  await win.keyboard.press("Escape");
  check("starting it for /mcp sent nothing to Claude", replies(chatId) === repliesBefore, `${repliesBefore} -> ${replies(chatId)}`);
  const live = await win.evaluate((cid) => window.conversations.chat.status(cid), chatId);
  check("the chat's Claude Code is now running here, waiting", live?.state === "idle", JSON.stringify(live?.state ?? null));
  // The next message goes to it and is answered.
  await win.click(box);
  await win.fill(box, "Reply with just the word READY.");
  await win.press(box, "Enter");
  const answered = await waitFor(() => {
    const t = [...document.querySelectorAll(".claude")].at(-1)?.textContent ?? "";
    return t.includes("READY") ? t.slice(0, 40) : null;
  }, null, 90_000);
  check("your next message is answered by that same Claude Code", !!answered && replies(chatId) > repliesBefore, `${answered ?? "no reply"}; replies ${repliesBefore} -> ${replies(chatId)}`);
} finally {
  await app.close();
  const moved = collectE2eTranscripts(scratch);
  console.log(moved.length ? `moved ${moved.length} test conversation folder(s) into the sandbox` : "no test conversation folders to move");
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
