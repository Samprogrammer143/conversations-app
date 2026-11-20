// The optimistic overlay for edits (pin, rename, archive, delete): shown at once,
// kept until the index has read the change back from the sync repository, and
// taken back if the sync engine refuses it, so a failed edit never sticks.

import type { EditField, EditValue } from "../shared/api";

export type Overlay = Partial<Record<EditField, EditValue>>;

/** Values compared as saved: no tags is the same as none set, false the same as unset. */
const norm = (v: EditValue | undefined) => JSON.stringify(v === undefined || v === false || (Array.isArray(v) && !v.length) ? null : v);

export class EditsOverlay {
  readonly pending = new Map<string, Overlay>();
  /** Saves still running per id: its overlay can't settle yet (the index may hold the value from before them). */
  private saving = new Map<string, number>();

  begin(id: string) {
    this.saving.set(id, (this.saving.get(id) ?? 0) + 1);
  }

  end(id: string) {
    const n = (this.saving.get(id) ?? 1) - 1;
    if (n > 0) this.saving.set(id, n);
    else this.saving.delete(id);
  }

  /** Shows an edit at once. Returns what to put back if it fails. */
  apply(id: string, field: EditField, value: EditValue): { had: boolean; previous: EditValue | undefined } {
    const p = this.pending.get(id) ?? {};
    const had = field in p;
    const previous = p[field];
    p[field] = value;
    this.pending.set(id, p);
    return { had, previous };
  }

  /** The engine refused it: the overlay goes back to what it was before this edit. */
  rollback(id: string, field: EditField, before: { had: boolean; previous: EditValue | undefined }) {
    const p = this.pending.get(id);
    if (!p) return;
    if (before.had) p[field] = before.previous;
    else delete p[field];
    if (Object.keys(p).length === 0) this.pending.delete(id);
  }

  /**
   * Drops each overlaid field the index now holds the same value for (read back from
   * GitHub). Covers what settle() can't: a tag, which has no transcript, and a chat whose
   * transcript didn't change. A later change from another PC then shows.
   */
  settleMatching(stored: (id: string) => Overlay) {
    for (const [id, p] of this.pending) {
      if (this.saving.has(id)) continue;
      const s = stored(id);
      for (const f of Object.keys(p) as EditField[]) if (norm(p[f]) === norm(s[f])) delete p[f];
      if (Object.keys(p).length === 0) this.pending.delete(id);
    }
  }

  /** The index caught up with GitHub for these conversations: nothing left to overlay. */
  settle(ids: string[]) {
    // (Not one still being saved: a live chat's transcript changes before its edit is committed.)
    for (const id of ids) if (!this.saving.has(id)) this.pending.delete(id);
  }
}
