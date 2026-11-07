// The relay: passes messages between a workspace's PCs and phones. Every PC keeps one
// outgoing websocket to its workspace's room, and so does a phone, so nothing listens on
// a home network. The relay can't read what it passes: PCs and phones encrypt to each
// other (see _app/src/shared/relay-crypto.ts). It only knows who is in a room.
//
// A room is a Durable Object named by a random id that only the workspace's private chat
// repository holds (_devices/relay.json), so knowing the id is what lets you in.
//
//   GET /room/<room>/ws?device=<id>&kind=pc|phone&name=<name>   websocket upgrade
//
// Client to relay:  {t:"send", to, data}            data is opaque (encrypted) text
// Relay to client:  {t:"msg", from, data}
//                   {t:"presence", devices:[{device, kind, name, since}]}   on joining
//                   {t:"join", device, kind, name, since} / {t:"leave", device}
//                   {t:"undeliverable", to, ref}     the device isn't connected
// "ping" gets "pong" without waking the room (keeps phone connections alive cheaply).

export interface Env {
  ROOMS: DurableObjectNamespace;
}

const ROOM_ID = /^[A-Za-z0-9_-]{22,64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/;
/** Cloudflare's own limit is 1 MiB a message; clients split bigger payloads below this. */
const MAX_FRAME = 1_000_000;
const MAX_DEVICES = 32;

interface Who {
  device: string;
  kind: "pc" | "phone";
  name: string;
  since: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") return new Response("Conversations relay\n", { headers: { "content-type": "text/plain" } });
    const m = /^\/room\/([^/]+)\/ws$/.exec(url.pathname);
    if (!m) return new Response("Not found", { status: 404 });
    if (!ROOM_ID.test(m[1])) return new Response("Bad room", { status: 400 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a websocket", { status: 426 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(req);
  },
};

export class Room {
  constructor(private state: DurableObjectState) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private who(ws: WebSocket): Who | null {
    return (ws.deserializeAttachment() as Who | null) ?? null;
  }

  private sockets(): { ws: WebSocket; who: Who }[] {
    const out: { ws: WebSocket; who: Who }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const who = this.who(ws);
      if (who) out.push({ ws, who });
    }
    return out;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const device = url.searchParams.get("device") ?? "";
    const kind = url.searchParams.get("kind");
    const name = (url.searchParams.get("name") ?? "").slice(0, 80);
    if (!DEVICE_ID.test(device) || (kind !== "pc" && kind !== "phone")) return new Response("Bad device", { status: 400 });
    const present = this.sockets();
    if (present.length >= MAX_DEVICES) return new Response("Room full", { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    const who: Who = { device, kind, name, since: Date.now() };
    server.serializeAttachment(who);

    // The same device connecting again (a new connection after a network change) replaces the old one.
    for (const p of present) {
      if (p.who.device === device) {
        // Forgotten first, so its closing isn't taken for the device leaving, nor for it still being here.
        p.ws.serializeAttachment(null);
        try {
          p.ws.close(4000, "Replaced by a newer connection");
        } catch {}
      }
    }
    const others = present.filter((p) => p.who.device !== device);
    server.send(JSON.stringify({ t: "presence", devices: others.map((p) => p.who) }));
    for (const p of others) this.safeSend(p.ws, { t: "join", ...who });
    return new Response(null, { status: 101, webSocket: client });
  }

  private safeSend(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const from = this.who(ws);
    if (!from || typeof raw !== "string" || raw.length > MAX_FRAME + 1000) return;
    let msg: { t?: string; to?: string; data?: string; ref?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== "send" || typeof msg.to !== "string" || typeof msg.data !== "string") return;
    const targets = this.sockets().filter((p) => p.who.device === msg.to);
    if (!targets.length) {
      this.safeSend(ws, { t: "undeliverable", to: msg.to, ref: typeof msg.ref === "string" ? msg.ref : null });
      return;
    }
    for (const p of targets) this.safeSend(p.ws, { t: "msg", from: from.device, data: msg.data });
  }

  async webSocketClose(ws: WebSocket) {
    this.left(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  private left(ws: WebSocket) {
    const who = this.who(ws);
    if (!who) return;
    ws.serializeAttachment(null);
    // Only "left" when no newer connection of the same device is still here.
    const still = this.sockets().some((p) => p.ws !== ws && p.who.device === who.device);
    if (still) return;
    for (const p of this.sockets()) if (p.ws !== ws) this.safeSend(p.ws, { t: "leave", device: who.device });
  }
}
