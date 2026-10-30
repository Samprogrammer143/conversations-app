// Alert mode: when a chat stops needing Claude and starts needing you. A reply that has
// finished (or stopped with an error), and a question or an approval, as soon as it is asked.
// A finished reply is reported after a moment, since a queued follow-up can start right away.

import type { ChatState, ChatStatus } from "../shared/types";

export type AlertWhy = "finished" | "stopped" | "needs-you";

const WORKING = new Set<ChatState>(["thinking", "running-tool", "writing", "waiting-approval"]);
export const SETTLE_MS = 1500;

export class AlertWatcher {
  private states = new Map<string, ChatState>();
  private asked = new Map<string, string>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private fire: (id: string, why: AlertWhy) => void) {}

  note(st: Pick<ChatStatus, "conversationId" | "state" | "permission">) {
    const id = st.conversationId;
    if (!id) return;
    const before = this.states.get(id);
    this.states.set(id, st.state);
    const request = st.state === "waiting-approval" ? st.permission?.requestId : undefined;
    if (request && this.asked.get(id) !== request) {
      this.asked.set(id, request);
      this.cancel(id);
      this.fire(id, "needs-you");
      return;
    }
    if (WORKING.has(st.state)) {
      this.cancel(id);
    } else if ((st.state === "idle" && before && WORKING.has(before)) || (st.state === "error" && before && (WORKING.has(before) || before === "starting"))) {
      this.cancel(id);
      const why: AlertWhy = st.state === "error" ? "stopped" : "finished";
      const timer = setTimeout(() => {
        this.timers.delete(id);
        if (this.states.get(id) === st.state) this.fire(id, why);
      }, SETTLE_MS);
      timer.unref?.();
      this.timers.set(id, timer);
    }
  }

  private cancel(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }
}
