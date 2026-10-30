// Open in CLI hands a conversation to a terminal with exactly one writer, in the
// folder where --resume finds it. Everything that touches the PC is a stand-in.
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatStatus } from "../src/shared/types";
import { CONTINUING, handOver, NO_FOLDER, NOT_HERE, OPEN_ON_THIS_PC, WRITTEN_JUST_NOW, type HandoverDeps, type PullOutcome } from "../src/main/handover";
import { ChatManager, STOPPED_BEFORE_START, type SessionLike } from "../src/main/chat/manager";
import type { SessionOptions } from "../src/main/chat/session";

process.env.CONVERSATIONS_DATA_DIR = path.join(os.tmpdir(), `conversations-test-${process.pid}`);

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PROJECT = "C:\\Users\\me\\Documents\\site";
const CLONE = "C:\\Users\\me\\Documents\\site-seo";
const T_CLONE = `C:\\Users\\me\\.claude\\projects\\C--Users-me-Documents-site-seo\\${ID}.jsonl`;
const T_PROJECT = `C:\\Users\\me\\.claude\\projects\\C--Users-me-Documents-site\\${ID}.jsonl`;

function deps(over: Partial<HandoverDeps> = {}) {
  const calls: string[] = [];
  const launched: { folder: string; id: string }[] = [];
  const focused: number[] = [];
  let clock = 1_000_000;
  const d: HandoverDeps = {
    terminals: async () => [],
    processes: async () => [],
    stopAppSession: async () => {
      calls.push("stop");
    },
    pull: async (_id, cwd) => {
      calls.push(`pull ${cwd}`);
      return { ok: true, dest: cwd === CLONE ? T_CLONE : T_PROJECT };
    },
    localTranscript: () => T_PROJECT,
    appLastWriteAt: () => 0,
    mtimeOf: () => null,
    // Real rule: the folder whose name maps to the transcript's folder.
    folderFor: (t, c) => c.find((x) => !!x && t.includes(`\\${x.replace(/[^A-Za-z0-9]/g, "-")}\\`)) ?? null,
    launch: (folder, id) => {
      calls.push("launch");
      launched.push({ folder, id });
    },
    focus: (pid) => focused.push(pid),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { d, calls, launched, focused };
}

describe("N1: never a second writer", () => {
  it("refuses, and brings the terminal forward, when a terminal here has it open", async () => {
    const { d, calls, launched, focused } = deps({ terminals: async () => [{ pid: 4242 }] });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toEqual({ ok: false, message: OPEN_ON_THIS_PC });
    expect(focused).toEqual([4242]);
    expect(launched).toEqual([]);
    // The app's own session is left alone when nothing is handed over.
    expect(calls).toEqual([]);
  });

  it("refuses when the download finds it in use by a Claude Code process", async () => {
    let pulled = false;
    const { d, launched, focused } = deps({
      pull: async () => {
        pulled = true;
        return { ok: false, live: true };
      },
      processes: async () => (pulled ? [{ pid: 77 }] : []),
    });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toEqual({ ok: false, message: OPEN_ON_THIS_PC });
    expect(focused).toEqual([77]);
    expect(launched).toEqual([]);
  });

  it("refuses a copy written in the last two minutes by something other than the app", async () => {
    const { d, launched } = deps({ pull: async () => ({ ok: false, live: true }), mtimeOf: () => 1_000_000, appLastWriteAt: () => 0 });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toEqual({ ok: false, message: WRITTEN_JUST_NOW });
    expect(launched).toEqual([]);
  });

  it("goes ahead when the only recent writer was the app itself, which has just stopped", async () => {
    const { d, launched } = deps({ pull: async () => ({ ok: false, live: true }), mtimeOf: () => 1_000_000, appLastWriteAt: () => 999_000 });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toEqual({ ok: true, message: CONTINUING, folder: PROJECT });
    expect(launched).toEqual([{ folder: PROJECT, id: ID }]);
  });

  it("stops the app's session first and waits for its Claude Code to exit before pulling", async () => {
    let alive = 3;
    const { d, calls } = deps({ processes: async () => (alive-- > 0 ? [{ pid: 9 }] : []) });
    const r = await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["stop", `pull ${PROJECT}`, "launch"]);
  });

  it("refuses if a process still has it open after waiting", async () => {
    const { d, launched } = deps({ processes: async () => [{ pid: 9 }] });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toEqual({ ok: false, message: OPEN_ON_THIS_PC });
    expect(launched).toEqual([]);
  });
});

describe("N3: the folder where --resume finds it", () => {
  it("prefers the folder the conversation ran in (a second clone), and pulls into it", async () => {
    const { d, calls, launched } = deps();
    const r = await handOver(ID, { projectFolder: PROJECT, recordedCwd: CLONE }, d);
    expect(r).toEqual({ ok: true, message: CONTINUING, folder: CLONE });
    expect(calls).toContain(`pull ${CLONE}`);
    expect(launched[0].folder).toBe(CLONE);
  });

  it("follows the copy the download kept, wherever it is", async () => {
    // The only copy is in the clone's folder; the project folder is the one chosen.
    const { d, launched } = deps({ pull: async () => ({ ok: true, dest: T_CLONE }) });
    expect((await handOver(ID, { projectFolder: PROJECT, recordedCwd: CLONE }, d)).folder).toBe(CLONE);
    expect(launched[0].folder).toBe(CLONE);
  });

  it("uses the copy on this PC when the download fails, and says so when there is none", async () => {
    const failing = async (): Promise<PullOutcome> => ({ ok: false, err: "github.com didn't answer" });
    const a = deps({ pull: failing });
    expect((await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, a.d)).folder).toBe(PROJECT);
    const b = deps({ pull: failing, localTranscript: () => null });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, b.d)).toEqual({ ok: false, message: "Couldn't bring it to this PC: github.com didn't answer" });
    const c = deps({ pull: async () => null, localTranscript: () => null });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, c.d)).toEqual({ ok: false, message: NOT_HERE });
  });

  it("refuses when no folder on this PC maps to the transcript", async () => {
    const { d, launched } = deps({ pull: async () => ({ ok: true, dest: `C:\\Users\\me\\.claude\\projects\\C--Users-jordan-elsewhere\\${ID}.jsonl` }) });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toEqual({ ok: false, message: NO_FOLDER });
    expect(launched).toEqual([]);
  });
});

// ------------------------------------------------------------------ race R1

class SlowSession extends EventEmitter implements SessionLike {
  id: string | null;
  cwd: string;
  status: ChatStatus;
  alive = true;
  busy = true;
  lastActivity = Date.now();
  lastWriteAt = 0;
  constructor(o: SessionOptions) {
    super();
    this.id = o.resume ?? null;
    this.cwd = o.cwd;
    this.status = { conversationId: this.id ?? "", state: "thinking", activity: null, model: null, permissionMode: o.permissionMode, contextPercent: null, queued: [], error: null, permission: null, streamingText: "", turnTokens: null };
  }
  start() {}
  send() {}
  pendingRequests() {
    return [];
  }
  respond() {
    return false;
  }
  async interrupt() {
    this.busy = false;
  }
  async setModel() {}
  async setPermissionMode() {}
  async models() {
    return [];
  }
  close() {
    this.alive = false;
    this.emit("ended");
  }
}

describe("a chat kept under a folder this PC doesn't use", () => {
  const FOREIGN = `C:\\Users\\me\\.claude\\projects\\C--Other-PC-site\\${ID}.jsonl`;
  it("moves to the folder chosen for it, and continues there", async () => {
    const { d, launched } = deps({ pull: async () => ({ ok: true, dest: FOREIGN }), chooseFolder: async () => PROJECT, pullInto: async () => ({ ok: true, dest: T_PROJECT }) });
    expect((await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).ok).toBe(true);
    expect(launched).toEqual([{ folder: PROJECT, id: ID }]);
  });
  it("says so, and starts nothing, when it can't be moved", async () => {
    const { d, launched } = deps({ pull: async () => ({ ok: true, dest: FOREIGN }), chooseFolder: async () => PROJECT, pullInto: async () => ({ ok: false, err: "x" }) });
    expect(await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).toMatchObject({ ok: false, message: NO_FOLDER });
    expect(launched).toEqual([]);
  });
  it("never moves without you choosing: Cancel leaves it where it is", async () => {
    let moved = false;
    const { d, launched } = deps({
      pull: async () => ({ ok: true, dest: FOREIGN }),
      chooseFolder: async () => null,
      pullInto: async () => {
        moved = true;
        return { ok: true, dest: T_PROJECT };
      },
    });
    expect((await handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d)).ok).toBe(false);
    expect(moved).toBe(false);
    expect(launched).toEqual([]);
  });
});

describe("N2 (race R1): Open in CLI while the app is still starting Claude Code", () => {
  it("calls the start off: no app session exists, or is made, once the terminal launches", async () => {
    let finishPull: () => void = () => {};
    let downloading = false;
    const pull = new Promise<void>((r) => (finishPull = r));
    const created: SlowSession[] = [];
    const m = new ChatManager({
      claudePath: () => "claude.exe",
      machine: () => "Home PC",
      localTranscript: () => null,
      syncBeforeResume: async () => {
        downloading = true;
        await pull;
        return { cwd: PROJECT };
      },
      terminalHas: async () => false,
      createSession: (o) => {
        const s = new SlowSession(o);
        created.push(s);
        return s;
      },
    });
    try {
      // 1. The user sends: the app starts Claude Code (and is still downloading).
      const send = m.send({ id: ID, text: "carry on", cwd: PROJECT });
      expect(m.status(ID)?.state).toBe("starting");
      while (!downloading) await new Promise((r) => setTimeout(r, 1));
      // 2. Open in CLI is pressed before the start finishes.
      const launchedWith: number[] = [];
      const { d } = deps({
        stopAppSession: (id) => m.release(id),
        launch: () => launchedWith.push(m.openIds().size + created.length),
      });
      const opening = handOver(ID, { projectFolder: PROJECT, recordedCwd: null }, d);
      // The download finishes only now, after release() has been asked for.
      await new Promise((r) => setTimeout(r, 10));
      finishPull();
      const r = await opening;
      expect(r.ok).toBe(true);
      // At the moment the terminal launched, the app had no session and none was made.
      expect(launchedWith).toEqual([0]);
      expect(await send).toEqual({ ok: false, err: STOPPED_BEFORE_START });
      // And none appears afterwards.
      await new Promise((r) => setTimeout(r, 10));
      expect(created.length).toBe(0);
      expect(m.isOpenInApp(ID)).toBe(false);
    } finally {
      m.closeAll();
    }
  });
});
