// Checks a running relay (npm run dev, or RELAY_URL): presence, delivery, replacement, leaving.
//   node test.mjs [ws://127.0.0.1:8787]
const base = process.argv[2] || process.env.RELAY_URL || "ws://127.0.0.1:8787";
const room = "test" + crypto.randomUUID().replace(/-/g, "");
let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};

function join(device, kind, name) {
  const ws = new WebSocket(`${base}/room/${room}/ws?device=${device}&kind=${kind}&name=${encodeURIComponent(name)}`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const m = e.data === "pong" ? { t: "pong" } : JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const next = (pred = () => true, ms = 3000) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const w = { pred, resolve: (m) => (clearTimeout(t), resolve(m)) };
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`${device}: nothing arrived`));
      }, ms);
      waiters.push(w);
    });
  const closed = new Promise((r) => ws.addEventListener("close", (e) => r(e.code)));
  const open = new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", () => j(new Error(`${device}: couldn't connect`)));
  });
  return { ws, next, open, closed, send: (to, data) => ws.send(JSON.stringify({ t: "send", to, data, ref: "r1" })) };
}

const pc = join("pc-home-01", "pc", "Home PC");
await pc.open;
const p0 = await pc.next((m) => m.t === "presence");
ok(Array.isArray(p0.devices) && p0.devices.length === 0, "the first device finds an empty room");

const phone = join("phone-abc-1", "phone", "Nothing Phone (2)");
await phone.open;
const p1 = await phone.next((m) => m.t === "presence");
ok(p1.devices.length === 1 && p1.devices[0].device === "pc-home-01" && p1.devices[0].name === "Home PC", "the phone sees the PC");
const j = await pc.next((m) => m.t === "join");
ok(j.device === "phone-abc-1" && j.kind === "phone", "the PC hears the phone join");

phone.send("pc-home-01", "hello");
const got = await pc.next((m) => m.t === "msg");
ok(got.from === "phone-abc-1" && got.data === "hello", "a message reaches the PC, with who sent it");

phone.send("nobody-here", "x");
const u = await phone.next((m) => m.t === "undeliverable");
ok(u.to === "nobody-here" && u.ref === "r1", "a message to a device that isn't here comes back undeliverable");

phone.ws.send("ping");
ok((await phone.next((m) => m.t === "pong")).t === "pong", "ping gets pong");

const big = "y".repeat(900_000);
phone.send("pc-home-01", big);
ok((await pc.next((m) => m.t === "msg")).data.length === big.length, "a 900 KB message gets through");

// The phone reconnects (new network): the old connection is closed, nobody hears it leave.
const phone2 = join("phone-abc-1", "phone", "Nothing Phone (2)");
await phone2.open;
ok((await phone.closed) === 4000, "the older connection of the same device is closed");
await phone2.next((m) => m.t === "presence");
let leftEarly = false;
await pc.next((m) => m.t === "leave", 800).then(() => (leftEarly = true), () => {});
ok(!leftEarly, "replacing a connection isn't announced as leaving");

phone2.ws.close();
const l = await pc.next((m) => m.t === "leave");
ok(l.device === "phone-abc-1", "the PC hears the phone leave");

const bad = new WebSocket(`${base}/room/short/ws?device=pc-home-01&kind=pc`);
ok(await new Promise((r) => { bad.addEventListener("error", () => r(true)); bad.addEventListener("open", () => r(false)); }), "a malformed room id is refused");

pc.ws.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
