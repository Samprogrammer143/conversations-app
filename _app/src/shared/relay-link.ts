// One device's connection to its workspace's room on the relay: reconnects by itself,
// keeps track of who else is there, encrypts to and from each of them, and splits
// messages too big for one relay frame. Runs in the app (Node 22+'s WebSocket) and on
// the phone.
//
// What goes through the relay (`data`):
//   s.<sealed>              sealed with the key the two devices share
//   p.<publicKey>.<sealed>  the same, from a device introducing its key (a phone asking to be allowed)
//   c.<mid>.<i>.<n>.<part>  one part of a bigger message of either kind

import { ReplayGuard, idOf, open, seal, sharedKey, type Identity } from "./relay-crypto";

export interface Peer {
  device: string;
  kind: "pc" | "phone";
  name: string;
  since: number;
}

export type LinkState = "connecting" | "open" | "closed";

export interface RelayLinkOptions {
  /** wss://… of the relay, without a path. */
  url: string;
  room: string;
  me: Identity;
  kind: "pc" | "phone";
  name: string;
  /** The public key a device is known by here, or null when it isn't known (not allowed). */
  keyFor(device: string): string | null | Promise<string | null>;
  /** A message that opened. `introduced`: the key it came with, when the sender wasn't known. */
  onMessage(from: string, body: unknown, introduced: string | null): void;
  onPeers?(peers: Peer[]): void;
  onState?(state: LinkState): void;
  /** Whether to open a message from a device that only introduces its key (a PC: yes, for pairing). */
  acceptIntroductions?: boolean;
  log?(msg: string): void;
}

/** Below the relay's 1 MiB a frame, with room for the envelope. */
const PART = 700_000;
/** Messages being put back together from parts: at most this many per sender, and this much in all. */
const MAX_PENDING_PER_PEER = 2;
const MAX_PENDING_BYTES = 24_000_000;
const MAX_KEYS = 64;
const PING_MS = 25_000;

export class RelayLink {
  private ws: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private keys = new Map<string, Promise<CryptoKey>>();
  private parts = new Map<string, { n: number; got: string[]; count: number; at: number }>();
  /** Seen nonces per known sender, so a flood from one can't push another's out; strangers share a small one. */
  private guards = new Map<string, ReplayGuard>();
  private strangers = new ReplayGuard(2000);
  private stopped = false;
  private retry = 0;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  state: LinkState = "closed";

  constructor(private o: RelayLinkOptions) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.cleanup();
    try {
      this.ws?.close(1000, "bye");
    } catch {}
    this.ws = null;
    this.setState("closed");
  }

  /** Who else is in the room now. */
  present(): Peer[] {
    return [...this.peers.values()];
  }

  /** Forgets a device's key (it was removed, or its key changed). */
  forget(device: string) {
    this.guards.delete(device);
    for (const k of this.keys.keys()) if (k.startsWith(`${device}|`)) this.keys.delete(k);
  }

  private setState(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    this.o.onState?.(s);
  }

  private cleanup() {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }

  private connect() {
    if (this.stopped) return;
    this.setState("connecting");
    const q = new URLSearchParams({ device: this.o.me.id, kind: this.o.kind, name: this.o.name });
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.o.url.replace(/\/+$/, "")}/room/${this.o.room}/ws?${q}`);
    } catch (e) {
      this.o.log?.(`relay: can't connect (${(e as Error).message})`);
      this.again();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.retry = 0;
      this.setState("open");
      this.cleanup();
      this.pinger = setInterval(() => {
        try {
          ws.send("ping");
        } catch {}
      }, PING_MS);
    });
    ws.addEventListener("message", (e) => void this.received(String(e.data)));
    ws.addEventListener("close", (e) => {
      if (this.ws !== ws) return;
      this.cleanup();
      this.ws = null;
      if (this.peers.size) {
        this.peers.clear();
        this.o.onPeers?.([]);
      }
      // 4000: this device connected again elsewhere (its newer connection carries on).
      // Tried again after a minute, not never: a connection that only claimed this device's id mustn't keep it off.
      if (e.code === 4000) {
        this.o.log?.("relay: replaced by a newer connection of this device; trying again in a minute");
        this.setState("connecting");
        this.retryTimer = setTimeout(() => this.connect(), 60_000);
        return;
      }
      this.again();
    });
    ws.addEventListener("error", () => {
      /* close follows */
    });
  }

  private again() {
    if (this.stopped) return;
    this.setState("connecting");
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private guardFor(device: string): ReplayGuard {
    let g = this.guards.get(device);
    if (!g) this.guards.set(device, (g = new ReplayGuard()));
    return g;
  }

  private key(device: string, publicKey: string): Promise<CryptoKey> {
    const id = `${device}|${publicKey}`;
    let k = this.keys.get(id);
    if (!k) {
      k = sharedKey(this.o.me, publicKey, this.o.room);
      if (this.keys.size >= MAX_KEYS) this.keys.delete(this.keys.keys().next().value!);
      this.keys.set(id, k);
    }
    return k;
  }

  private async received(raw: string) {
    if (raw === "pong") return;
    let m: { t: string; from?: string; data?: string; devices?: Peer[]; device?: string } & Partial<Peer>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === "presence" && Array.isArray(m.devices)) {
      this.peers = new Map(m.devices.map((d) => [d.device, d]));
      this.o.onPeers?.(this.present());
    } else if (m.t === "join" && m.device) {
      this.peers.set(m.device, { device: m.device, kind: m.kind as Peer["kind"], name: m.name ?? "", since: m.since ?? Date.now() });
      this.o.onPeers?.(this.present());
    } else if (m.t === "leave" && m.device) {
      this.peers.delete(m.device);
      this.o.onPeers?.(this.present());
    } else if (m.t === "msg" && m.from && typeof m.data === "string") {
      await this.data(m.from, m.data);
    }
  }

  private async data(from: string, data: string) {
    if (data.startsWith("c.")) {
      // Only a known device sends anything in parts (an introduction is one frame), so a stranger can't fill memory.
      if (!(await this.o.keyFor(from))) return;
      const [, mid, i, n, ...rest] = data.split(".");
      const part = rest.join(".");
      const total = Number(n);
      const idx = Number(i);
      if (!mid || !Number.isInteger(total) || total < 1 || total * PART > MAX_PENDING_BYTES || !Number.isInteger(idx) || idx < 0 || idx >= total || part.length > PART) return;
      const slot = `${from}|${mid}`;
      const now = Date.now();
      for (const [k, v] of this.parts) if (now - v.at > 120_000) this.parts.delete(k);
      let bytes = part.length;
      for (const v of this.parts.values()) for (const g of v.got) bytes += g?.length ?? 0;
      const mine = [...this.parts.keys()].filter((k) => k.startsWith(`${from}|`)).length;
      if (bytes > MAX_PENDING_BYTES || (!this.parts.has(slot) && mine >= MAX_PENDING_PER_PEER)) return this.o.log?.(`relay: too much in parts from ${from}; dropped`);
      const entry = this.parts.get(slot) ?? { n: total, got: new Array<string>(total), count: 0, at: now };
      if (entry.got[idx] === undefined) entry.count++;
      entry.got[idx] = part;
      this.parts.set(slot, entry);
      if (entry.count < entry.n) return;
      this.parts.delete(slot);
      data = entry.got.join("");
    }
    try {
      if (data.startsWith("s.")) {
        const pub = await this.o.keyFor(from);
        if (!pub) return this.o.log?.(`relay: a message from ${from}, who isn't known here`);
        const body = this.fromSender(from, await open(await this.key(from, pub), data.slice(2), this.guardFor(from)));
        this.o.onMessage(from, body, null);
      } else if (data.startsWith("p.")) {
        const dot = data.indexOf(".", 2);
        const pub = data.slice(2, dot);
        if ((await idOf(pub)) !== from) return this.o.log?.(`relay: ${from} introduced a key that isn't its own`);
        const known = await this.o.keyFor(from);
        if (!known && !this.o.acceptIntroductions) return;
        if (known && known !== pub) return this.o.log?.(`relay: ${from} introduced a different key from the one known here`);
        const body = this.fromSender(from, await open(await this.key(from, pub), data.slice(dot + 1), known ? this.guardFor(from) : this.strangers));
        this.o.onMessage(from, body, known ? null : pub);
      }
    } catch (e) {
      this.o.log?.(`relay: a message from ${from} didn't open (${(e as Error).message})`);
    }
  }

  /** What the sender sealed, which names the sender: both ends share one key, so a message can't be bounced back to who sent it. */
  private fromSender(from: string, sealed: unknown): unknown {
    const m = sealed as { f?: unknown; b?: unknown } | null;
    if (!m || m.f !== from) throw new Error("not from its sender");
    return m.b;
  }

  /**
   * Sends to one device. `theirKey`: its public key (else keyFor's). `introduce`: send this
   * device's key along, for one that doesn't know it yet. False when it couldn't go.
   */
  async send(to: string, body: unknown, opts: { theirKey?: string; introduce?: boolean } = {}): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const pub = opts.theirKey ?? (await this.o.keyFor(to));
    if (!pub) return false;
    const sealed = await seal(await this.key(to, pub), { f: this.o.me.id, b: body });
    const data = opts.introduce ? `p.${this.o.me.publicKey}.${sealed}` : `s.${sealed}`;
    try {
      if (data.length <= PART) ws.send(JSON.stringify({ t: "send", to, data }));
      else {
        const mid = Math.random().toString(36).slice(2, 10);
        const n = Math.ceil(data.length / PART);
        for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: "send", to, data: `c.${mid}.${i}.${n}.${data.slice(i * PART, (i + 1) * PART)}` }));
      }
      return true;
    } catch {
      return false;
    }
  }
}
