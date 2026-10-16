// Keeps this PC in step with GitHub in the background. A cheap ls-remote every
// 30 s while the window is open (5 min from the tray); a download only when it
// moved. Uploads of conversations are the hooks' job; the app uploads its own
// edits and anything that queued up while offline.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { net } from "electron";
import type { DeviceSummary, SyncActivity, SyncPhase, SyncStatus } from "../../shared/types";
import { appDataDir, readSyncConfig, repoDir, thisMachine } from "../paths";
import { settings } from "../settings";
import { log } from "../log";
import { stripUrlCredentials } from "../remote-display";
import { detectEngineVersion, runEngine, runEngineSerial } from "./engine-bridge";
import { HeadStore, RETRY_SKIPPED_MS, shouldPull } from "./pull-decision";

/** The repository's size on disk, from `git count-objects -v`, without blocking the app. */
export function repoSizeBytes(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["count-objects", "-v"], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const kb = (name: string) => Number(out.match(new RegExp(`^${name}: (\\d+)`, "m"))?.[1] ?? 0);
      resolve(code === 0 ? (kb("size") + kb("size-pack")) * 1024 : null);
    });
  });
}

interface EngineStatus {
  ok?: boolean;
  setUp: boolean;
  machine: string;
  webUrl: string | null;
  unpushedCommits: number;
  lastFetchAt: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  lastError: { at: string; message: string } | null;
  failingSince: string | null;
  sessions: Record<string, { pushedAt?: string; pulledAt?: string; key?: string }>;
  /** How long Claude Code's hooks wait after a reply before uploading (engine v3). */
  uploadQuietSeconds?: number;
  /** The cloud folder (OneDrive and the like) that ~/.claude is synced by, if any. */
  cloudSyncedClaudeDir?: string | null;
}

interface PullAllResult {
  ok: boolean;
  offline?: boolean;
  err?: string;
  downloaded?: { id: string; title: string; from: string }[];
  updated?: { id: string; title: string; from: string; added: number }[];
  retired?: string[];
  /** Left alone because they were being written (or are open in the app). */
  skippedLive?: string[];
}

const ATTENTION_AFTER_MS = 3 * 60_000;

export class SyncScheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private phase: SyncPhase = "idle";
  private engine: EngineStatus | null = null;
  private recent: SyncActivity[] = [];
  private nextAt: number | null = null;
  private repoSize: number | null = null;
  private repoSizeAt = 0;
  private engineVersion = 0;
  private announced = false;
  private lastEngineRefresh = 0;
  private heads: HeadStore;
  /** When to run pull-all again for conversations it skipped while they were live. */
  private retryPullAt: number | null = null;
  /** Requests to run pull-all again soon (a conversation the app had open was closed), and how many a finished pull-all covered. */
  private retryRequests = 0;
  private retryServed = 0;

  constructor(
    private opts: {
      isWindowVisible: () => boolean;
      devices: () => DeviceSummary[];
      pendingUploads: (sessions: EngineStatus["sessions"]) => number;
      onDownloaded: () => void;
      appVersion: string;
      /** Conversations the app has open: pull-all leaves them alone. */
      skipIds?: () => string[];
    },
  ) {
    super();
    this.heads = new HeadStore(path.join(appDataDir(), "sync-head.json"));
    try {
      this.recent = JSON.parse(fs.readFileSync(path.join(appDataDir(), "activity.json"), "utf8"));
    } catch {}
  }

  async start() {
    this.engineVersion = await detectEngineVersion();
    log("sync", `engine version ${this.engineVersion}`);
    await this.refreshEngineStatus();
    this.schedule(1500);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
    this.emitStatus();
  }

  /** Is a tick waiting to run? */
  get armed() {
    return this.timer !== null;
  }

  /** Window shown or focused: check soon instead of waiting for the tray interval, and re-arm if nothing is waiting. */
  nudge() {
    if (this.running) return;
    if (!this.timer || (this.nextAt && this.nextAt - Date.now() > 3000)) this.schedule(500);
  }

  /**
   * A conversation the app had open (and pull-all therefore left alone) was closed:
   * run pull-all again soon, even if GitHub hasn't moved, so it is brought up to date.
   */
  retrySoon() {
    this.retryRequests++;
    if (!this.running && (!this.nextAt || this.nextAt - Date.now() > 3000)) this.schedule(2000);
  }

  private get retryPending() {
    return this.retryRequests > this.retryServed;
  }

  async syncNow() {
    await this.tick(true);
  }

  setPaused(paused: boolean) {
    settings.set({ syncAutomatically: !paused });
    if (!paused) this.schedule(200);
    else this.emitStatus();
  }

  private record(a: Omit<SyncActivity, "at">) {
    this.recent.unshift({ ...a, at: new Date().toISOString() });
    this.recent = this.recent.slice(0, 20);
    try {
      fs.writeFileSync(path.join(appDataDir(), "activity.json"), JSON.stringify(this.recent));
    } catch {}
  }

  private async refreshEngineStatus() {
    const r = await runEngine<EngineStatus>(["status", "--json"], { timeoutMs: 60_000 });
    if (r.json && (r.json as EngineStatus).setUp !== undefined) this.engine = r.json;
    if (Date.now() - this.repoSizeAt > 10 * 60_000) {
      this.repoSizeAt = Date.now();
      void repoSizeBytes(repoDir()).then((size) => {
        if (size !== null && size !== this.repoSize) {
          this.repoSize = size;
          this.emitStatus();
        }
      });
    }
  }

  async tick(force = false) {
    if (this.running) return;
    const s = settings.get();
    if (!s.syncAutomatically && !force) {
      this.phase = "paused";
      // Nothing to do while paused, but the loop stays alive (resuming also re-arms it).
      this.schedule(s.checkFromTraySeconds * 1000);
      return;
    }
    if (!readSyncConfig()?.remote) {
      // Not set up yet (the installer may run while the app is open): keep looking.
      this.phase = "not-set-up";
      this.engineVersion = 0;
      this.schedule(30_000);
      return;
    }
    this.running = true;
    try {
      // The engine may have appeared or updated since the last look.
      if (this.engineVersion < 3) this.engineVersion = await detectEngineVersion(true);
      if (this.engineVersion < 3) {
        // The working copy still has the version 2 engine. Its own "pull list"
        // refreshes the working copy from GitHub (and nothing else), which brings
        // the newer engine once it is there. Until then the app only reads.
        if (Date.now() - this.lastEngineRefresh > 10 * 60_000) {
          this.lastEngineRefresh = Date.now();
          await runEngineSerial(["pull", "list", "--cwd", os.homedir()], { timeoutMs: 5 * 60_000 });
          this.opts.onDownloaded();
        }
        this.engineVersion = await detectEngineVersion(true);
        if (this.engineVersion < 3) {
          await this.refreshEngineStatus();
          this.phase = "idle";
          return; // finally re-arms the loop
        }
        log("sync", "the sync engine updated to version 3");
      }
      if (!this.announced) {
        this.announced = true;
        void runEngineSerial(["announce", "--json", "--app-version", this.opts.appVersion]);
      }
      if (!net.isOnline()) {
        this.phase = "offline";
        return;
      }
      this.phase = "checking";
      this.emitStatus();
      const check = await runEngine<{ ok: boolean; changed?: boolean; offline?: boolean; err?: string; remoteHead?: string | null }>(["check", "--json"], { timeoutMs: 60_000 });
      if (!check.ok) {
        await this.refreshEngineStatus();
        const since = this.engine?.failingSince ? Date.parse(this.engine.failingSince) : Date.now();
        this.phase = Date.now() - since > ATTENTION_AFTER_MS ? "attention" : "offline";
        if (this.phase === "attention" && this.recent[0]?.kind !== "failed") this.record({ kind: "failed", text: "Upload failed: github.com didn't answer" });
        return;
      }
      const remoteHead = check.json?.remoteHead ?? null;
      if (shouldPull({ remoteHead, lastProcessed: this.heads.get(), changed: check.json?.changed, force, retryAt: this.retryPending ? 0 : this.retryPullAt })) {
        this.phase = "downloading";
        this.emitStatus();
        const args = ["pull-all", "--json"];
        if (!s.keepResumeUpToDate) args.push("--no-local");
        const skip = this.opts.skipIds?.() ?? [];
        if (skip.length) args.push("--skip", skip.join(","));
        // Closes noted from here on come after this pull-all's skip list: they still need one.
        const requests = this.retryRequests;
        const pull = await runEngineSerial<PullAllResult>(args);
        const res = pull.json;
        if (res?.ok) {
          this.retryServed = Math.max(this.retryServed, requests);
          // This head is done; anything left alone because it was live is tried again shortly.
          if (remoteHead) this.heads.set(remoteHead);
          this.retryPullAt = res.skippedLive?.length ? Date.now() + RETRY_SKIPPED_MS : null;
          const got = [...(res.downloaded ?? []), ...(res.updated ?? [])];
          if (got.length) {
            const froms = [...new Set(got.map((g) => g.from).filter(Boolean))];
            this.record({ kind: "downloaded", text: `Downloaded ${got.length}${froms.length === 1 ? ` from ${froms[0]}` : ""}` });
          }
          this.opts.onDownloaded();
        } else {
          // Tried and failed: try again in a while, not straight away.
          this.retryServed = Math.max(this.retryServed, requests);
          this.retryPullAt = Date.now() + RETRY_SKIPPED_MS;
        }
      }
      await this.refreshEngineStatus();
      if ((this.engine?.unpushedCommits ?? 0) > 0) {
        this.phase = "uploading";
        this.emitStatus();
        const pp = await runEngineSerial<{ ok: boolean }>(["push-pending", "--json"]);
        if (pp.ok) this.record({ kind: "uploaded", text: "Uploaded changes made while offline" });
        await this.refreshEngineStatus();
      }
      this.phase = "idle";
    } catch (e) {
      log("sync", `tick failed: ${(e as Error).stack || e}`);
      this.phase = "attention";
    } finally {
      this.running = false;
      const visible = this.opts.isWindowVisible();
      const secs = visible ? s.checkWhileOpenSeconds : s.checkFromTraySeconds;
      // A conversation closed during this run still needs its pull-all: soon, not at the next interval.
      const next = this.retryPending && this.phase === "idle" ? 2 : this.phase === "offline" ? Math.min(secs, 30) : secs;
      this.schedule(next * 1000);
    }
  }

  /** Called by the app after it uploads an edit, so the status reflects it at once. */
  noteEdit(text: string, queued: boolean) {
    this.record({ kind: queued ? "saved" : "edit", text });
    void this.refreshEngineStatus().then(() => this.emitStatus());
  }

  status(): SyncStatus {
    const s = settings.get();
    const devices = this.opts.devices();
    const behind = devices.filter((d) => d.status === "old-sync");
    const total = devices.length;
    const current = total - behind.length;
    const e = this.engine;
    const lastSync = [e?.lastFetchAt, e?.lastPushAt, e?.lastCheckAt].filter(Boolean).sort().pop() ?? null;
    const pending = e ? this.opts.pendingUploads(e.sessions || {}) + (e.unpushedCommits || 0) : 0;
    const paused = !s.syncAutomatically;
    let headline: string;
    let detail: string;
    const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);
    if (this.phase === "not-set-up") {
      headline = "Sync is not set up";
      detail = "Run the installer on this PC";
    } else if (paused) {
      headline = "Sync paused";
      detail = lastSync ? `Last synced ${time(lastSync)}` : "Resume in the sync menu";
    } else if (this.phase === "offline") {
      headline = "Offline";
      detail = lastSync ? `Last synced ${time(lastSync)}` : "Saved on this PC";
    } else if (this.phase === "attention") {
      headline = "Can't reach GitHub";
      detail = "Retrying · saved on this PC";
    } else if (this.phase === "downloading" || this.phase === "uploading" || this.phase === "checking") {
      headline = total > 1 && behind.length ? `${current} of ${total} PCs up to date` : this.phase === "checking" ? "Up to date" : "Syncing…";
      detail = this.phase === "checking" ? (lastSync ? `Last synced ${time(lastSync)}` : "Checking GitHub") : this.phase === "downloading" ? "Downloading…" : "Uploading…";
    } else if (behind.length) {
      headline = `${current} of ${total} PCs up to date`;
      detail = behind.length === 1 ? `${behind[0].name} needs the new sync` : `${behind.length} PCs need the new sync`;
    } else {
      headline = total > 1 ? `All ${total} PCs up to date` : "Up to date";
      detail = lastSync ? `Last synced ${time(lastSync)}` : "Up to date";
    }
    return {
      phase: paused ? "paused" : this.phase,
      machine: e?.machine ?? thisMachine(),
      headline,
      detail,
      lastSyncAt: lastSync,
      nextCheckInMs: this.nextAt ? Math.max(0, this.nextAt - Date.now()) : null,
      pendingUploads: pending,
      failingSince: e?.failingSince ?? null,
      // git's messages can quote the remote, login included: never shown.
      lastError: stripUrlCredentials(e?.lastError?.message ?? null),
      repoSizeBytes: this.repoSize,
      repoWebUrl: stripUrlCredentials(e?.webUrl ?? null),
      uploadQuietSeconds: typeof e?.uploadQuietSeconds === "number" ? e.uploadQuietSeconds : null,
      cloudSyncedClaudeDir: typeof e?.cloudSyncedClaudeDir === "string" && e.cloudSyncedClaudeDir ? e.cloudSyncedClaudeDir : null,
      devices,
      recent: this.recent,
      paused,
    };
  }

  emitStatus() {
    this.emit("status", this.status());
  }

  /** Settings > Sync > Upload after a reply. The hooks read it from the engine's config. */
  async setUploadQuiet(seconds: number): Promise<{ ok: boolean; err?: string }> {
    if (![60, 120, 300].includes(seconds)) return { ok: false, err: "Choose 1, 2 or 5 minutes" };
    const r = await runEngineSerial<{ ok: boolean; err?: string }>(["config", "--json", "--set", `uploadQuietSeconds=${seconds}`], { timeoutMs: 30_000 });
    if (!r.json?.ok) return { ok: false, err: r.json?.err ?? "Couldn't change the setting" };
    await this.refreshEngineStatus();
    this.emitStatus();
    return { ok: true };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
