// Item 4: a refused edit never stays on screen.
import { describe, expect, it } from "vitest";
import { EditsOverlay } from "../src/main/edits-overlay";

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

describe("the optimistic overlay", () => {
  it("shows an edit at once, and takes it back if the engine refuses it", () => {
    const o = new EditsOverlay();
    const before = o.apply(ID, "pinned", true);
    expect(o.pending.get(ID)).toEqual({ pinned: true });
    o.rollback(ID, "pinned", before);
    expect(o.pending.has(ID)).toBe(false);
  });

  it("rolls back to the earlier value when the field was already overlaid", () => {
    const o = new EditsOverlay();
    o.apply(ID, "title", "First");
    const before = o.apply(ID, "title", "Second");
    o.rollback(ID, "title", before);
    expect(o.pending.get(ID)).toEqual({ title: "First" });
    // Other fields on the same conversation are untouched by one failure.
    const b2 = o.apply(ID, "archived", true);
    o.rollback(ID, "archived", b2);
    expect(o.pending.get(ID)).toEqual({ title: "First" });
  });

  it("is cleared once the index has read the change back", () => {
    const o = new EditsOverlay();
    o.apply(ID, "deleted", true);
    o.settle([ID, "other"]);
    expect(o.pending.size).toBe(0);
  });
});
