// The one Windows notification the app raises: Claude is blocked on an approval
// and no window is open. Deny works straight from the notification; Allow only
// from the review card, so a destructive command is never approved blind.

import path from "node:path";
import { app, Notification } from "electron";
import type { PermissionRequest } from "../../shared/types";

export const PROTOCOL = "conversations";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function registerProtocol() {
  // Only the installed app registers the link (the installer does too). A development
  // run must not point the PC's conversations:// links at a build folder.
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else if (process.env.CONVERSATIONS_REGISTER_PROTOCOL === "1") app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? ".")]);
}

/** "conversations://deny/<id>" from a notification button, in a second instance's argv. */
export function parseProtocolArgs(argv: string[]): { action: "review" | "deny"; requestId: string } | null {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!url) return null;
  const m = url.match(/^conversations:\/\/(review|deny)\/([^/?#]+)/);
  return m ? { action: m[1] as "review" | "deny", requestId: decodeURIComponent(m[2]) } : null;
}

const shown = new Map<string, Notification>();

/**
 * `workspace`: the one this copy of the app is in. A button starts the app with the link,
 * and the link names the workspace, so it reaches the window where Claude is waiting.
 */
export function notifyApproval(p: PermissionRequest, conversationTitle: string, onClick: () => void, workspace = "main") {
  if (shown.has(p.requestId) || !Notification.isSupported()) return;
  const id = `${encodeURIComponent(p.requestId)}?ws=${encodeURIComponent(workspace)}`;
  const what = p.body ? ` (${p.body.split("\n")[0].slice(0, 80)})` : "";
  const body = `“${conversationTitle}” is waiting for you${what}.`;
  const n = new Notification({
    title: "Claude needs your approval",
    body,
    silent: false,
    toastXml:
      process.platform === "win32"
        ? `<toast launch="${PROTOCOL}://review/${id}" activationType="protocol">
  <visual><binding template="ToastGeneric"><text>Claude needs your approval</text><text>${xmlEscape(body)}</text></binding></visual>
  <actions>
    <action content="Review" activationType="protocol" arguments="${PROTOCOL}://review/${id}"/>
    <action content="Deny" activationType="protocol" arguments="${PROTOCOL}://deny/${id}"/>
  </actions>
</toast>`
        : undefined,
  });
  n.on("click", onClick);
  n.on("failed", () => {
    if (shown.get(p.requestId) === n) shown.delete(p.requestId);
  });
  n.show();
  // Kept while the request is waiting (so it is never raised twice); removed when
  // it is answered (clearApproval) or ends some other way (pruneApprovals).
  shown.set(p.requestId, n);
}

export function clearApproval(requestId: string) {
  const n = shown.get(requestId);
  if (n) {
    try {
      n.close();
    } catch {}
    shown.delete(requestId);
  }
}

/** Takes down the notifications of requests that are no longer waiting (the session ended, Claude moved on). */
export function pruneApprovals(waiting: Set<string>) {
  for (const id of [...shown.keys()]) if (!waiting.has(id)) clearApproval(id);
}
