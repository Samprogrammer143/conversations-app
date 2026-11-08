// The phone's side of the link: its keys, its connection to the workspace's room, being
// allowed, and requests to the PC it works through. The window's code (the same React as
// the desktop) talks to it through window.conversations, as it would to Electron.

import { RelayLink, type LinkState, type Peer } from "../shared/relay-link";
import { loadIdentity, newIdentity, pairingCode, type Identity, type StoredIdentity } from "../shared/relay-crypto";

/** A workspace as the phone knows it: where its relay is, and its PCs' keys (from GitHub). */
export interface WorkspaceLink {
  name: string;
  url: string;
  room: string;
  pcs: { slug: string; name: string; key: string; device: string }[];
}

export type Pairing = "unknown" | "asking" | "allowed" | "denied";

export interface PhoneState {
  link: LinkState;
  pairing: Pairing;
  code: string;
  /** PCs of the workspace, with whether each is on (in the room now) and has let this phone in. */
  pcs: { device: string; name: string; online: boolean; allowed: boolean }[];
  /** The PC requests go to. */
  current: string | null;
  error: string | null;
}

const STORE = "conversations.phone.";

async function phoneIdentity(): Promise<Identity> {
  let s: StoredIdentity | null = null;
  try {
    s = JSON.parse(localStorage.getItem(`${STORE}key`) ?? "null");
  } catch {}
  if (!s || s.v !== 1) {
    s = await newIdentity();
    localStorage.setItem(`${STORE}key`, JSON.stringify(s));
  }
  return loadIdentity(s);
}

export function phoneName(): string {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  return m?.[1]?.trim() || "Phone";
}

const CALL_TIMEOUT_MS = 90_000;

export class PhoneSession {
  me!: Identity;
  private link: RelayLink | null = null;
  private peers: Peer[] = [];
  private calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private stateListeners = new Set<(s: PhoneState) => void>();
  /** Calls waiting for a PC to be ready (on, and said hello back). */
  private readyWaiters: (() => void)[] = [];
  private welcomed = new Set<string>();
  state: PhoneState = { link: "closed", pairing: "unknown", code: "", pcs: [], current: null, error: null };

  /** Each PC's session (from its "welcome"), sent with every call to it. */
  private sessions = new Map<string, string>();
  private everWelcomed = new Set<string>();
  /** PCs that said this phone is allowed (each PC asks once). */
  private allowedBy = new Set<string>();
  private asked = false;
  private retryAsk: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;

  /**
   * `beforeAsk`: writes this phone's request to be allowed into the chat repository (GitHub), which
   * a PC checks before it asks you: the relay can't write there, so it can't pass off a key of its own.
   */
  constructor(
    public ws: WorkspaceLink,
    private beforeAsk: (req: { id: string; key: string; name: string }) => Promise<void>,
  ) {}

  async start() {
    this.me = await phoneIdentity();
    const code = await pairingCode(this.me.publicKey, this.ws.room);
    const allowed = localStorage.getItem(`${STORE}allowed.${this.ws.room}`) === "1";
    this.set({ code, pairing: allowed ? "allowed" : "unknown", pcs: this.ws.pcs.map((p) => ({ device: p.device, name: p.name, online: false, allowed: false })) });
    this.link = new RelayLink({
      url: this.ws.url,
      room: this.ws.room,
      me: this.me,
      kind: "phone",
      name: phoneName(),
      keyFor: (d) => this.ws.pcs.find((p) => p.device === d)?.key ?? null,
      onMessage: (from, body) => this.message(from, body),
      onPeers: (peers) => {
        const was = new Set(this.peers.map((p) => p.device));
        this.peers = peers;
        for (const d of [...this.allowedBy]) if (!peers.some((p) => p.device === d)) {
          this.welcomed.delete(d);
          this.sessions.delete(d);
          this.allowedBy.delete(d);
        }
        this.refreshPcs();
        // A PC that just came on: ask it (it answers at once when this phone is already allowed).
        for (const p of peers) if (p.kind === "pc" && !was.has(p.device)) void this.ask(p.device);
      },
      onState: (s) => this.set({ link: s }),
    });
    this.link.start();
  }

  /** The app came back to the front, or the network came back: reconnect now rather than at the next try. */
  nudge() {
    this.link?.nudge();
  }

  /** Whether requests can go now: a PC that's on, has let this phone in and said hello back. */
  ready(): boolean {
    const pc = this.state.current;
    return !!pc && this.sessions.has(pc);
  }

  /** Resolves when ready (see ready()), or rejects after `ms`. */
  whenReady(ms: number): Promise<void> {
    if (this.ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        reject(new Error(this.state.pcs.some((p) => p.online) ? "Your PC didn't answer; try again" : "None of your PCs is on"));
      }, ms);
      this.readyWaiters.push(done);
    });
  }

  stop() {
    for (const d of this.welcomed) void this.link?.send(d, { k: "bye" });
    this.link?.stop();
  }

  private set(patch: Partial<PhoneState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.stateListeners) l(this.state);
  }

  onState(cb: (s: PhoneState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private refreshPcs() {
    const on = new Set(this.peers.filter((p) => p.kind === "pc").map((p) => p.device));
    const pcs = this.ws.pcs.map((p) => ({ device: p.device, name: p.name, online: on.has(p.device), allowed: this.allowedBy.has(p.device) }));
    // Requests go to a PC that's on and has let this phone in: the one picked last, else the first.
    const usable = (d: string | null) => !!d && on.has(d) && this.allowedBy.has(d);
    let current = this.state.current;
    if (!usable(current)) {
      const last = localStorage.getItem(`${STORE}pc.${this.ws.room}`);
      current = usable(last) ? last : (pcs.find((p) => p.online && p.allowed)?.device ?? null);
    }
    if (current !== this.state.current && this.state.current && current) {
      // Requests go to another PC now: the window shows what that one has.
      queueMicrotask(() => {
        for (const cb of this.listeners.get("index-changed") ?? []) cb([]);
      });
    }
    this.set({ pcs, current });
    // Every PC that let it in hears from it (settings for each PC; events only count from the current one).
    for (const d of this.allowedBy) if (on.has(d) && !this.welcomed.has(d)) void this.hello(d);
  }

  /** Asks a PC to allow this phone (or, when it already has, to say so). */
  private async ask(device: string) {
    if (this.state.pairing === "denied") return;
    if (this.state.pairing !== "allowed") {
      this.set({ pairing: "asking" });
      if (!this.asked) {
        try {
          await this.beforeAsk({ id: this.me.id, key: this.me.publicKey, name: phoneName() });
          this.asked = true;
        } catch (e) {
          this.set({ error: `Couldn't ask on GitHub: ${(e as Error).message}` });
          return;
        }
      }
    }
    await this.link?.send(device, { k: "pair", name: phoneName() }, { introduce: true });
  }

  /** Asks the PCs that are on again in a few seconds (the request hadn't reached GitHub yet, or a PC was busy). */
  private askAgainSoon() {
    if (this.retryAsk) return;
    // 4, 8, 16, 32, 64 s, then it stops and says so (a request that never reached the PC's repository).
    if (this.retries >= 5) {
      this.set({ error: "Your PC didn't see this phone's request on GitHub. Check the PC is signed in to GitHub and syncing, then open the app again." });
      return;
    }
    const wait = 4000 * 2 ** this.retries++;
    this.retryAsk = setTimeout(() => {
      this.retryAsk = null;
      if (this.state.pairing === "allowed" || this.state.pairing === "denied") return;
      for (const p of this.peers) if (p.kind === "pc") void this.ask(p.device);
    }, wait);
  }

  private async hello(device: string) {
    this.welcomed.add(device);
    const sent = await this.link?.send(device, { k: "hello" });
    if (!sent) this.welcomed.delete(device);
  }

  /** Sends requests to another PC from now on. */
  usePc(device: string) {
    localStorage.setItem(`${STORE}pc.${this.ws.room}`, device);
    this.set({ current: device });
    if (!this.welcomed.has(device)) void this.hello(device);
  }

  private message(from: string, body: unknown) {
    if (!body || typeof body !== "object") return;
    const m = body as { k: string; ok?: boolean; err?: string; id?: string; value?: unknown; ev?: string; payload?: unknown };
    if (m.k === "pair-result") {
      if (m.ok) {
        localStorage.setItem(`${STORE}allowed.${this.ws.room}`, "1");
        this.allowedBy.add(from);
        this.set({ pairing: "allowed", error: null });
        this.refreshPcs();
      } else if ((m as { pending?: boolean }).pending) this.askAgainSoon();
      else if (this.state.pairing !== "allowed") this.set({ pairing: "denied", error: m.err ?? "Not allowed" });
    } else if (m.k === "welcome") {
      const session = (m as { session?: unknown }).session;
      if (typeof session === "string") {
        const again = this.everWelcomed.has(from);
        this.everWelcomed.add(from);
        this.sessions.set(from, session);
        if (from === this.state.current) {
          for (const w of this.readyWaiters.splice(0)) w();
          // Back after a drop (or the PC restarted): the window catches up on what it missed.
          if (again) for (const cb of this.listeners.get("index-changed") ?? []) cb([]);
        }
        this.set({});
      }
    } else if (m.k === "ret" && m.id) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      clearTimeout(c.timer);
      if (m.ok) c.resolve(m.value);
      else {
        // The PC started again since: say hello again (a new session) for the next call.
        if (m.err === "stale-session") {
          this.welcomed.delete(from);
          this.sessions.delete(from);
          void this.hello(from);
        }
        c.reject(new Error(m.err === "stale-session" ? "The PC restarted; try again" : (m.err ?? "The PC couldn't do that")));
      }
    } else if (m.k === "event" && m.ev) {
      // Only the PC requests go to speaks for the app (another PC's events are its own).
      if (from !== this.state.current) return;
      for (const cb of this.listeners.get(m.ev) ?? []) cb(m.payload);
    }
  }

  /** A request to the current PC, like ipcRenderer.invoke: waits a while for one to be ready; tried again once after the PC restarted. */
  async call(channel: string, args: unknown[]): Promise<unknown> {
    await this.whenReady(45_000);
    try {
      return await this.callNow(channel, args);
    } catch (e) {
      if ((e as Error).message !== "The PC restarted; try again") throw e;
      await this.whenReady(20_000);
      return this.callNow(channel, args);
    }
  }

  private callNow(channel: string, args: unknown[]): Promise<unknown> {
    const pc = this.state.current;
    if (!pc) return Promise.reject(new Error("None of your PCs is on"));
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("The PC didn't answer"));
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, { resolve, reject, timer });
      void this.link?.send(pc, { k: "call", id, ch: channel, args, s: this.sessions.get(pc) }).then((ok) => {
        if (ok) return;
        this.calls.delete(id);
        clearTimeout(timer);
        reject(new Error("Not connected"));
      });
    });
  }

  /** One PC's own phone settings (M12): "status", "keep-awake", "forget-me". */
  pcCall(device: string, op: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("The PC didn't answer"));
      }, 10_000);
      this.calls.set(id, { resolve, reject, timer });
      void this.link?.send(device, { k: "pc", id, op, s: this.sessions.get(device), ...extra }).then((ok) => {
        if (ok) return;
        this.calls.delete(id);
        clearTimeout(timer);
        reject(new Error("Not connected"));
      });
    });
  }

  /** Takes this phone off every PC that's on, and forgets its keys here. The PCs that are off drop it from GitHub too. */
  async forgetMe(): Promise<void> {
    for (const d of this.allowedBy) await this.pcCall(d, "forget-me").catch(() => undefined);
    for (const k of Object.keys(localStorage)) if (k.startsWith(STORE)) localStorage.removeItem(k);
  }

  on(event: string, cb: (p: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }
}
