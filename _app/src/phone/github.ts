// GitHub on the phone: signing in (GitHub's device flow, so the app keeps no secret) and
// finding the workspaces, which are the chat repositories with a _devices/relay.json.
//
// github.com's sign-in endpoints don't allow browser requests (CORS); in the Android app
// fetch goes through Capacitor's native HTTP (capacitor.config.ts), which isn't bound by it.

import type { WorkspaceLink } from "./session";

/** The Conversations OAuth app (device flow on, no secret; owned by Samprogrammer143). VITE_GITHUB_CLIENT_ID overrides it. */
export const GITHUB_CLIENT_ID: string = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_GITHUB_CLIENT_ID || "Ov23liiMg9KMRgLreQZV";

const STORE = "conversations.phone.github";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function savedToken(): string | null {
  return localStorage.getItem(STORE);
}

export function signOut() {
  localStorage.removeItem(STORE);
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  if (!GITHUB_CLIENT_ID) throw new Error("This build has no GitHub app set (VITE_GITHUB_CLIENT_ID)");
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "repo read:org" }).toString(),
  });
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
  return (await r.json()) as DeviceCode;
}

/** Waits until the code is entered on GitHub; resolves with the token. */
export async function waitForToken(code: DeviceCode, cancelled: () => boolean): Promise<string> {
  let interval = Math.max(5, code.interval) * 1000;
  const until = Date.now() + code.expires_in * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, interval));
    if (cancelled()) throw new Error("cancelled");
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).toString(),
    });
    const j = (await r.json()) as { access_token?: string; error?: string; interval?: number };
    if (j.access_token) {
      localStorage.setItem(STORE, j.access_token);
      return j.access_token;
    }
    if (j.error === "slow_down") interval = (j.interval ?? interval / 1000 + 5) * 1000;
    else if (j.error && j.error !== "authorization_pending") throw new Error(j.error === "access_denied" ? "Sign-in was cancelled on GitHub" : `GitHub: ${j.error}`);
  }
  throw new Error("The code ran out; start again");
}

async function gh<T>(token: string, url: string, raw = false): Promise<T | null> {
  const r = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (r.status === 404) return null;
  if (r.status === 401) throw new Error("signed-out");
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
  return (raw ? JSON.parse(await r.text()) : await r.json()) as T;
}

/** Writes this phone's request to be allowed into the workspace's chat repository (_devices/requests/<id>.json). */
export async function writeRequest(token: string, repo: string, req: { id: string; key: string; name: string }): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/contents/_devices/requests/${req.id}.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const have = await fetch(url, { headers });
  const sha = have.ok ? ((await have.json()) as { sha?: string }).sha : undefined;
  const content = btoa(unescape(encodeURIComponent(`${JSON.stringify({ id: req.id, key: req.key, name: req.name, at: new Date().toISOString() }, null, 2)}\n`)));
  const r = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ message: `Devices: ${req.name} asks to be allowed`, content, ...(sha ? { sha } : {}) }) });
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
}

export async function whoAmI(token: string): Promise<string> {
  return (await gh<{ login: string }>(token, "/user"))?.login ?? "";
}

interface Repo {
  full_name: string;
  name: string;
  owner: { login: string };
}

/** The chat repositories this account can see that have the phone link set up. */
export async function findWorkspaces(token: string): Promise<(WorkspaceLink & { repo: string })[]> {
  const repos: Repo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh<Repo[]>(token, `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    if (!batch?.length) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  // Chat repositories first (they're usually named so), then the rest, a few at a time.
  const likely = (r: Repo) => (/conversation/i.test(r.name) ? 0 : 1);
  repos.sort((a, b) => likely(a) - likely(b));
  const out: (WorkspaceLink & { repo: string })[] = [];
  for (let i = 0; i < repos.length; i += 8) {
    const found = await Promise.all(repos.slice(i, i + 8).map((r) => workspaceIn(token, r.full_name).catch(() => null)));
    for (const w of found) if (w) out.push(w);
    // Stop looking past the likely ones once something turned up.
    if (out.length && repos[i + 8] && likely(repos[i + 8]) === 1) break;
  }
  return out;
}

export async function workspaceIn(token: string, repo: string): Promise<(WorkspaceLink & { repo: string }) | null> {
  const relay = await gh<{ url: string; room: string; name?: string }>(token, `/repos/${repo}/contents/_devices/relay.json`, true);
  if (!relay?.url || !relay.room) return null;
  const list = (await gh<{ name: string; path: string }[]>(token, `/repos/${repo}/contents/_devices/keys`)) ?? [];
  const pcs = (
    await Promise.all(
      list
        .filter((f) => f.name.endsWith(".json"))
        .map(async (f) => {
          const k = await gh<{ name: string; key: string; device: string }>(token, `/repos/${repo}/contents/${f.path}`, true);
          return k?.key && k.device ? { slug: f.name.replace(/\.json$/, ""), name: k.name, key: k.key, device: k.device } : null;
        }),
    )
  ).filter((x): x is NonNullable<typeof x> => !!x);
  return { repo, name: relay.name || repo.split("/")[1], url: relay.url, room: relay.room, pcs };
}
