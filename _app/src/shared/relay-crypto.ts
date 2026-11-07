// End-to-end encryption for the phone link. The relay passes text it can't read: every PC
// and phone has its own key pair (ECDH P-256), and each PC–phone pair shares an AES-GCM key
// derived from the two. Nobody else can derive it, so a message that opens came from the
// other end. Plain WebCrypto, so the same code runs in the app (Node) and on the phone.
//
// Ids are made from keys (a hash of the public key), so a device can't take another's id
// without its private key.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A device's keys as stored: the private key as JWK, the public key as base64url (raw point). */
export interface StoredIdentity {
  v: 1;
  privateJwk: JsonWebKey;
  publicKey: string;
}

export interface Identity {
  id: string;
  publicKey: string;
  privateKey: CryptoKey;
}

const ALG = { name: "ECDH", namedCurve: "P-256" } as const;

export async function newIdentity(): Promise<StoredIdentity> {
  const pair = (await subtle().generateKey(ALG, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return { v: 1, privateJwk: await subtle().exportKey("jwk", pair.privateKey), publicKey: b64u(raw) };
}

export async function loadIdentity(s: StoredIdentity): Promise<Identity> {
  const privateKey = await subtle().importKey("jwk", s.privateJwk, ALG, false, ["deriveBits"]);
  return { id: await idOf(s.publicKey), publicKey: s.publicKey, privateKey };
}

/** A device's id on the relay: 22 characters of the hash of its public key. */
export async function idOf(publicKey: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", unb64u(publicKey) as BufferSource));
  return b64u(h).slice(0, 22);
}

/**
 * The four digits a phone shows while it waits to be allowed, and a PC shows when asked. They
 * only match when the PC got the phone's real key (not one the relay swapped in).
 */
export async function pairingCode(phonePublicKey: string, room: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", enc.encode(`conversations pairing|${room}|${phonePublicKey}`)));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(n % 10000).padStart(4, "0");
}

/** The key two devices share in a room. */
export async function sharedKey(me: Identity, theirPublicKey: string, room: string): Promise<CryptoKey> {
  const theirs = await subtle().importKey("raw", unb64u(theirPublicKey) as BufferSource, ALG, false, []);
  const bits = await subtle().deriveBits({ name: "ECDH", public: theirs }, me.privateKey, 256);
  const base = await subtle().importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const ids = [me.id, await idOf(theirPublicKey)].sort().join("|");
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(`conversations relay|${room}`), info: enc.encode(`v1|${ids}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** How far a message's clock may be from ours: older ones are refused (replays). */
export const MAX_SKEW_MS = 5 * 60_000;

export async function seal(key: CryptoKey, body: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify({ ts: Date.now(), n: b64u(globalThis.crypto.getRandomValues(new Uint8Array(9))), body }));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, plain));
  return `${b64u(iv)}.${b64u(ct)}`;
}

/** Opens a sealed message; throws when it doesn't open, is too old, or was seen before. */
export async function open(key: CryptoKey, text: string, seen?: ReplayGuard): Promise<unknown> {
  const [iv, ct] = text.split(".");
  if (!iv || !ct) throw new Error("not a sealed message");
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: unb64u(iv) as BufferSource }, key, unb64u(ct) as BufferSource);
  const msg = JSON.parse(dec.decode(plain)) as { ts: number; n: string; body: unknown };
  if (typeof msg.ts !== "number" || Math.abs(Date.now() - msg.ts) > MAX_SKEW_MS) throw new Error("message too old");
  if (seen && !seen.fresh(msg.n, msg.ts)) throw new Error("message seen before");
  return msg.body;
}

/** Remembers the nonces of recent messages, so one can't be played again. */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private max = 20_000) {}
  fresh(n: string, ts: number): boolean {
    if (typeof n !== "string" || this.seen.has(n)) return false;
    if (this.seen.size >= this.max) {
      const cut = Date.now() - MAX_SKEW_MS;
      for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k);
      // Still full of fresh ones (a flood): new messages are refused, never an old nonce forgotten
      // (forgetting one would let that message be played again).
      if (this.seen.size >= this.max) return false;
    }
    this.seen.set(n, ts);
    return true;
  }
}
