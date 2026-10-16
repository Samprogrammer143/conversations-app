// The optimistic overlay for edits (pin, rename, archive, delete): shown at once,
// kept until the index has read the change back from the sync repository, and
// taken back if the sync engine refuses it, so a failed edit never sticks.

import type { EditField } from "../shared/api";

export type Overlay = Partial<Record<EditField, boolean | string | null>>;

export class EditsOverlay {
  readonly pending = new Map<string, Overlay>();

  /** Shows an edit at once. Returns what to put back if it fails. */
  apply(id: string, field: EditField, value: boolean | string | null): { had: boolean; previous: boolean | string | null | undefined } {
    const p = this.pending.get(id) ?? {};
    const had = field in p;
    const previous = p[field];
    p[field] = value;
    this.pending.set(id, p);
    return { had, previous };
  }

  /** The engine refused it: the overlay goes back to what it was before this edit. */
  rollback(id: string, field: EditField, before: { had: boolean; previous: boolean | string | null | undefined }) {
    const p = this.pending.get(id);
    if (!p) return;
    if (before.had) p[field] = before.previous;
    else delete p[field];
    if (Object.keys(p).length === 0) this.pending.delete(id);
  }

  /** The index caught up with GitHub for these conversations: nothing left to overlay. */
  settle(ids: string[]) {
    for (const id of ids) this.pending.delete(id);
  }
}
