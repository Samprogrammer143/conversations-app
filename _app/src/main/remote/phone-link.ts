// The PC's end of the phone link. The app keeps one connection to the relay (see
// shared/relay-link.ts) and answers its workspace's allowed phones with the same handlers
// the window uses, so the phone can do what the window does, minus what only makes sense
// at this PC (REMOTE_CHANNELS). What the window hears (broadcast) the phones hear too.
//
// Shared through the chat repository, like everything else a workspace's PCs agree on:
//   _devices/relay.json         { url, room }: where the relay is, and this workspace's room
//   _devices/keys/<pc>.json     each PC's public key, which the phone encrypts to
//   _devices/phones/<id>.json   each phone a PC allowed: its key, name, who allowed it
// A phone asks every PC that's on; one Allow lets it in on all of them (they read the file).

import fs from "node:fs";
import path from "node:path";
import { appDataDir, repoDir, syncDir } from "../paths";
import { log as appLog } from "../log";

const log = (m: string) => appLog("phone", m);
import { runEngineSerial } from "../sync/engine-bridge";
import { RelayLink, type LinkState, type Peer } from "../../shared/relay-link";
import { b64u, loadIdentity, newIdentity, pairingCode, type Identity, type StoredIdentity } from "../../shared/relay-crypto";

/** The relay a workspace's first PC sets up its room on (relay/, on Cloudflare). Empty: the phone link stays off. */
export const DEFAULT_RELAY_URL = "wss://conversations-relay.conversations-relay.workers.dev";

/** What a phone can ask for. Not: pickers and folders on this PC, restarts, windows, workspace switching. */
export const REMOTE_CHANNELS = new Set([
  "app:info",
  "list:sidebar",
  "list:conversations",
  "list:detail",
  "list:items",
  "list:markSeen",
  "list:search",
  "list:image",
  "edit:apply",
  "sync:status",
  "sync:now",
  "chat:send",
  "chat:stop",
  "chat:respond",
  "chat:answer",
  "chat:setModel",
  "chat:setEffort",
  "chat:commands",
  "chat:setPermissionMode",
  "chat:status",
  "chat:agent",
  "chat:stopAgent",
  "chat:models",
  "chat:pending",
  "chat:usage",
  "settings:get",
  "composer:load",
  "workspace:list",
]);

/**
 * Why a phone can't make this call, though the channel is open to it; null when it can. A phone
 * can't run "!" shell commands, nor start a chat in any folder of this PC: new chats start in a
 * project the PC already has.
 */
export function remoteRefusal(channel: string, args: unknown[]): string | null {
  if (channel === "chat:commands" && args[2]) return "Commands in another folder are listed on the PC";
  if (channel === "chat:send") {
    const opts = (args[2] ?? {}) as { shell?: unknown; folder?: unknown };
    if (opts.shell) return "Shell commands only run from the PC";
    if (opts.folder) return "A chat in a new folder starts on the PC";
  }
  return null;
}

/** What a phone hears. */
export const REMOTE_EVENTS = new Set(["index-changed", "sync-status", "chat-status", "chat-returned", "chat-pending", "usage", "alert", "settings-changed"]);

export interface PhoneRecord {
  id: string;
  key: string;
  name: string;
  allowedBy: string;
  allowedAt: string;
}

export interface RelayConfig {
  url: string;
  room: string;
}

export interface PhoneLinkStatus {
  state: LinkState | "off";
  /** Why it's off: no relay address yet, or it hasn't started. */
  reason?: string;
  phones: { id: string; name: string; allowedAt: string; online: boolean }[];
}

type Handler = (...args: unknown[]) => unknown;

interface Options {
  handlers: Map<string, Handler>;
  /** Shows "Allow this phone?"; true when allowed. */
  askAllow(req: { name: string; code: string; /** Allowed already on this PC of yours (asked here once too). */ allowedOn: string | null }): Promise<boolean>;
  /** The relay's address when this workspace has none yet (a first PC): settings, else the built-in one. */
  relayUrl(): string | null;
  onStatus?(s: PhoneLinkStatus): void;
  /** "Keep this PC awake for my phone" (Figma M12, D2): on or off, kept by the phone link. */
  onKeepAwake?(on: boolean): void;
  /** Whether this PC runs on its battery now (keeping awake only counts when plugged in). */
  onBattery?(): boolean;
}

/** This PC's own phone-link settings (not the repository's: each PC decides for itself). */
interface LinkSettings {
  keepAwake: boolean;
}
const settingsPath = () => path.join(appDataDir(), "phone-link-settings.json");

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/** This PC's name and file name in the repository, as the sync engine has them. */
function thisPc(): { name: string; slug: string | null } {
  const c = readJson<{ machine?: string; slug?: string }>(path.join(syncDir(), "config.json")) ?? {};
  return { name: c.machine || (process.env.COMPUTERNAME ?? "This PC"), slug: c.slug ?? null };
}

const devicesDir = () => path.join(repoDir(), "_devices");

export function readRelayConfig(): RelayConfig | null {
  const c = readJson<RelayConfig>(path.join(devicesDir(), "relay.json"));
  return c && typeof c.url === "string" && typeof c.room === "string" ? c : null;
}

export function readPhones(): PhoneRecord[] {
  const dir = path.join(devicesDir(), "phones");
  const out: PhoneRecord[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const r = f.endsWith(".json") ? readJson<PhoneRecord>(path.join(dir, f)) : null;
      if (r && typeof r.id === "string" && typeof r.key === "string" && f === `${r.id}.json`) out.push(r);
    }
  } catch {}
  return out;
}

async function writeDevices(changes: { path: string; value: unknown }[], message: string): Promise<{ ok: boolean; err?: string }> {
  const b64 = Buffer.from(JSON.stringify(changes), "utf8").toString("base64");
  const r = await runEngineSerial<{ ok: boolean; err?: string }>(["devices-write", "--json", "--changes", b64, "--message", message]);
  return r.json ?? { ok: false, err: r.stderr.split("\n")[0] || "the sync engine didn't answer" };
}

/** A phone's request to be allowed, as GitHub has it now (the phone writes it before asking). */
async function readRequestFresh(id: string): Promise<{ key?: string; name?: string } | null> {
  const r = await runEngineSerial<{ ok: boolean; value?: { key?: string; name?: string } | null }>(["devices-read", "--json", "--fresh", "--path", `requests/${id}.json`]);
  return r.json?.ok ? (r.json.value ?? null) : null;
}

/**
 * Which phones this PC itself trusts: ones you allowed here (in this PC's own dialog), and ones
 * you took off here. Kept on this PC, not in the repository: a phone (or anyone with the GitHub
 * sign-in) that writes itself back into _devices/phones isn't let in here without asking you.
 */
interface Trust {
  trusted: string[];
  removed: string[];
}
const trustPath = () => path.join(appDataDir(), "phone-link-trust.json");
function loadTrust(): Trust {
  const t = readJson<Trust>(trustPath());
  return { trusted: Array.isArray(t?.trusted) ? t.trusted : [], removed: Array.isArray(t?.removed) ? t.removed : [] };
}
function saveTrust(t: Trust) {
  fs.writeFileSync(trustPath(), JSON.stringify(t, null, 2));
}

/** A name from a phone, fit to show in a dialog: one line, no control characters. */
export function cleanName(name: unknown): string {
  const s = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return s || "Phone";
}

async function identity(): Promise<Identity> {
  const p = path.join(appDataDir(), "phone-link-key.json");
  let s = readJson<StoredIdentity>(p);
  if (!s || s.v !== 1) {
    s = await newIdentity();
    fs.writeFileSync(p, JSON.stringify(s), { mode: 0o600 });
  }
  return loadIdentity(s);
}

export class PhoneLink {
  private link: RelayLink | null = null;
  private me: Identity | null = null;
  private phones = new Map<string, PhoneRecord>();
  private listening = new Set<string>();
  private asking = new Map<string, Promise<boolean>>();
  /** One pairing (the check on GitHub and "Allow this phone?") at a time. */
  private dialogOpen = false;
  private trust = loadTrust();
  private settings: LinkSettings = { keepAwake: false, ...(readJson<LinkSettings>(settingsPath()) ?? {}) };
  /** Phones allowed in the repository (by any PC); `phones` holds only those this PC trusts too. */
  private allowedAnywhere = new Map<string, PhoneRecord>();
  /** When GitHub was last asked for requests (at most every 15 s), and phones it had none for. */
  private lastRequestFetch = 0;
  private noRequestUntil = new Map<string, number>();
  /** Each listening phone's session (from "welcome"): calls must carry it, so one recorded earlier can't be played again after a restart. */
  private sessions = new Map<string, string>();
  private peers: Peer[] = [];
  private status: PhoneLinkStatus = { state: "off", reason: "starting", phones: [] };
  private config: RelayConfig | null = null;

  constructor(private o: Options) {}

  current(): PhoneLinkStatus {
    return this.status;
  }

  private emit(state?: LinkState | "off", reason?: string) {
    const online = new Set(this.peers.map((p) => p.device));
    this.status = {
      state: state ?? this.status.state,
      reason: state === "off" ? reason : undefined,
      phones: [...this.phones.values()].map((p) => ({ id: p.id, name: p.name, allowedAt: p.allowedAt, online: online.has(p.id) })),
    };
    this.o.onStatus?.(this.status);
  }

  /** The allowed phones from the repository, keeping only those this PC trusts as well. */
  private readTrusted(): Map<string, PhoneRecord> {
    this.allowedAnywhere = new Map(readPhones().map((p) => [p.id, p]));
    const mine = new Set(this.trust.trusted);
    const gone = new Set(this.trust.removed);
    return new Map([...this.allowedAnywhere].filter(([id]) => mine.has(id) && !gone.has(id)));
  }

  /** A phone's request on GitHub: fetched at most every 15 s; in between, the copy the last fetch brought. */
  private async request(id: string): Promise<{ key?: string; name?: string } | null> {
    if ((this.noRequestUntil.get(id) ?? 0) > Date.now()) return null;
    let req: { key?: string; name?: string } | null;
    if (Date.now() - this.lastRequestFetch < 15_000) req = readJson(path.join(devicesDir(), "requests", `${id}.json`));
    else {
      this.lastRequestFetch = Date.now();
      req = await readRequestFresh(id);
    }
    if (!req) this.noRequestUntil.set(id, Date.now() + 20_000);
    return req;
  }

  /** Re-reads the allowed phones (after a sync brought changes). */
  refresh() {
    const next = this.readTrusted();
    for (const id of this.phones.keys()) if (!next.has(id)) {
      this.listening.delete(id);
      this.link?.forget(id);
    }
    this.phones = next;
    const cfg = readRelayConfig();
    if (this.link && cfg && (cfg.url !== this.config?.url || cfg.room !== this.config?.room)) {
      log("phone link: the relay's address or room changed; connecting again");
      this.stop();
      void this.start();
      return;
    }
    this.emit();
  }

  /** Whether to keep this PC awake for phones (applied by main.ts while plugged in). */
  keepAwake(): boolean {
    return this.settings.keepAwake;
  }

  private setKeepAwake(on: boolean) {
    this.settings = { ...this.settings, keepAwake: on };
    fs.writeFileSync(settingsPath(), JSON.stringify(this.settings, null, 2));
    this.o.onKeepAwake?.(on);
  }

  async start() {
    this.o.onKeepAwake?.(this.settings.keepAwake);
    try {
      this.me = await identity();
      const pc = thisPc();
      let cfg = readRelayConfig();
      const writes: { path: string; value: unknown }[] = [];
      if (!cfg) {
        const url = this.o.relayUrl();
        if (!url) return this.emit("off", "no relay address");
        cfg = { url, room: b64u(globalThis.crypto.getRandomValues(new Uint8Array(18))) };
        writes.push({ path: "relay.json", value: cfg });
      }
      if (pc.slug) {
        const mine = readJson<{ key?: string }>(path.join(devicesDir(), "keys", `${pc.slug}.json`));
        if (mine?.key !== this.me.publicKey) writes.push({ path: `keys/${pc.slug}.json`, value: { name: pc.name, key: this.me.publicKey, device: this.me.id } });
      }
      if (writes.length) {
        const w = await writeDevices(writes, `Devices: phone link for ${pc.name}`);
        if (!w.ok) log(`couldn't save ${writes.map((x) => x.path).join(", ")} (${w.err}); trying again at the next start`);
        // Another PC may have made the room first: use the one GitHub has.
        cfg = readRelayConfig() ?? cfg;
      }
      this.config = cfg;
      this.phones = this.readTrusted();
      this.link = new RelayLink({
        url: cfg.url,
        room: cfg.room,
        me: this.me,
        kind: "pc",
        name: pc.name,
        acceptIntroductions: true,
        keyFor: (d) => this.phones.get(d)?.key ?? null,
        onMessage: (from, body, introduced) => void this.message(from, body, introduced),
        onPeers: (peers) => {
          this.peers = peers;
          for (const id of this.listening) if (!peers.some((p) => p.device === id)) this.listening.delete(id);
          this.emit();
        },
        onState: (s) => this.emit(s),
        log: (m) => log(`${m}`),
      });
      this.link.start();
      log(`connecting to ${cfg.url} as ${this.me.id}`);
    } catch (e) {
      log(`couldn't start (${(e as Error).message})`);
      this.emit("off", (e as Error).message);
    }
  }

  stop() {
    this.link?.stop();
    this.link = null;
    this.listening.clear();
    this.emit("off", "stopped");
  }

  /** Something the window hears: phones that are listening hear it too. */
  broadcast(event: string, payload: unknown) {
    if (!this.link || !REMOTE_EVENTS.has(event)) return;
    for (const id of this.listening) void this.link.send(id, { k: "event", ev: event, payload });
  }

  /** Takes a phone off the allowed list, on every PC. */
  async removePhone(id: string): Promise<{ ok: boolean; err?: string }> {
    const p = this.phones.get(id);
    if (!p) return { ok: true };
    // Refused here for good, even if it writes itself back into the repository.
    this.trust = { trusted: this.trust.trusted.filter((x) => x !== id), removed: [...new Set([...this.trust.removed, id])] };
    saveTrust(this.trust);
    const r = await writeDevices([{ path: `phones/${id}.json`, value: null }], `Devices: removed ${p.name}`);
    this.refresh();
    return r;
  }

  private async message(from: string, body: unknown, introduced: string | null) {
    const link = this.link;
    if (!link || !body || typeof body !== "object") return;
    const m = body as { k?: string; id?: string; ch?: string; args?: unknown[]; name?: string };
    if (introduced) {
      // A phone that isn't allowed can only ask to be.
      if (m.k === "pair") await this.pair(from, introduced, cleanName(m.name));
      return;
    }
    if (m.k === "pair") {
      // Already allowed (another PC said yes, or a second ask).
      await link.send(from, { k: "pair-result", ok: true });
    } else if (m.k === "hello") {
      this.listening.add(from);
      const session = b64u(globalThis.crypto.getRandomValues(new Uint8Array(12)));
      this.sessions.set(from, session);
      await link.send(from, { k: "welcome", pc: thisPc().name, session });
    } else if (m.k === "bye") {
      this.listening.delete(from);
      this.sessions.delete(from);
    } else if (m.k === "pc" && typeof m.id === "string" && this.sessions.has(from) && (m as { s?: unknown }).s === this.sessions.get(from)) {
      // The phone's settings for this PC (M12): keep awake, and taking the phone off.
      const op = (m as { op?: unknown }).op;
      const reply = (r: { ok: boolean; value?: unknown; err?: string }) => link.send(from, { k: "ret", id: m.id, ...r });
      if (op === "status") return void reply({ ok: true, value: { keepAwake: this.settings.keepAwake, onBattery: this.o.onBattery?.() ?? false } });
      if (op === "keep-awake") {
        this.setKeepAwake((m as { on?: unknown }).on === true);
        return void reply({ ok: true, value: { keepAwake: this.settings.keepAwake } });
      }
      if (op === "forget-me") {
        // The phone took itself off: gone from the repository and from this PC's trusted list (it may ask again).
        const p = this.phones.get(from);
        this.trust = { trusted: this.trust.trusted.filter((x) => x !== from), removed: this.trust.removed };
        saveTrust(this.trust);
        this.listening.delete(from);
        this.sessions.delete(from);
        await reply({ ok: true });
        if (p) await writeDevices([{ path: `phones/${from}.json`, value: null }], `Devices: ${p.name} took itself off`);
        this.refresh();
        return;
      }
      return void reply({ ok: false, err: "unknown" });
    } else if (m.k === "call" && typeof m.id === "string" && typeof m.ch === "string") {
      const reply = (r: { ok: boolean; value?: unknown; err?: string }) => link.send(from, { k: "ret", id: m.id, ...r });
      if (!this.sessions.has(from) || (m as { s?: unknown }).s !== this.sessions.get(from)) return void reply({ ok: false, err: "stale-session" });
      const fn = REMOTE_CHANNELS.has(m.ch) ? this.o.handlers.get(m.ch) : undefined;
      if (!fn) return void reply({ ok: false, err: `"${m.ch}" can't be used from a phone` });
      const args = Array.isArray(m.args) ? m.args : [];
      const refused = remoteRefusal(m.ch, args);
      if (refused) return void reply({ ok: false, err: refused });
      try {
        const value = await fn(...args);
        await reply({ ok: true, value: value === undefined ? null : value });
      } catch (e) {
        await reply({ ok: false, err: (e as Error).message || String(e) });
      }
    }
  }

  private async pair(from: string, key: string, name: string) {
    const cfg = this.config;
    const link = this.link;
    if (!cfg || !link) return;
    if (this.trust.removed.includes(from)) return void link.send(from, { k: "pair-result", ok: false, err: "Removed on this PC" }, { theirKey: key });
    let pending = this.asking.get(from);
    if (!pending) {
      if (this.dialogOpen) return void link.send(from, { k: "pair-result", ok: false, pending: true, err: "busy" }, { theirKey: key });
      this.dialogOpen = true;
      pending = (async () => {
        try {
          // Allowed on another PC (the repository says so, with this very key): asked here once too.
          // Otherwise only a phone that wrote its request into the chat repository (which the relay can't)
          // is asked about, and only with the key it wrote there: a relay can't swap in a key of its own.
          const elsewhere = readPhones().find((p) => p.id === from);
          const known = elsewhere?.key === key ? elsewhere : null;
          if (!known) {
            const req = await this.request(from);
            if (!req || req.key !== key) {
              log(`a phone asked to be allowed with no matching request on GitHub; not asked`);
              return "no-request" as const;
            }
          }
          const code = await pairingCode(key, cfg.room);
          log(`"${name}" asks to be allowed (code ${code})${known ? `, allowed already on ${known.allowedBy}` : ""}`);
          if (!(await this.o.askAllow({ name, code, allowedOn: known ? cleanName(known.allowedBy) : null }))) return false;
          const pc = thisPc();
          const rec: PhoneRecord = known ?? { id: from, key, name, allowedBy: pc.name, allowedAt: new Date().toISOString() };
          if (!known) {
            const w = await writeDevices([{ path: `phones/${from}.json`, value: rec }, { path: `requests/${from}.json`, value: null }], `Devices: ${pc.name} allowed ${name}`);
            if (!w.ok) {
              log(`couldn't save the allowed phone (${w.err})`);
              return false;
            }
          }
          this.trust = { trusted: [...new Set([...this.trust.trusted, from])], removed: this.trust.removed };
          saveTrust(this.trust);
          this.allowedAnywhere.set(from, rec);
          this.phones.set(from, rec);
          this.emit();
          return true;
        } finally {
          this.dialogOpen = false;
        }
      })().finally(() => setTimeout(() => this.asking.delete(from), 2000)) as Promise<boolean>;
      this.asking.set(from, pending);
    }
    const ok = (await pending) as boolean | "no-request";
    await link.send(
      from,
      ok === true ? { k: "pair-result", ok: true } : ok === "no-request" ? { k: "pair-result", ok: false, pending: true, err: "no-request" } : { k: "pair-result", ok: false, err: "Not allowed on the PC" },
      { theirKey: key },
    );
  }
}
