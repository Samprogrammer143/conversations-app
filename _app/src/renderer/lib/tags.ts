// Tags: the rules with no window in them (tested in test/tags.test.ts).

import { TAG_COLORS, type TagColor, type TagInfo } from "../../shared/types";

/** The colour a new tag gets: the one the fewest tags have, in the palette's order. */
export function nextColor(tags: TagInfo[]): TagColor {
  const used = new Map<TagColor, number>(TAG_COLORS.map((c) => [c, 0]));
  for (const t of tags) used.set(t.color, (used.get(t.color) ?? 0) + 1);
  return [...TAG_COLORS].sort((a, b) => used.get(a)! - used.get(b)! || TAG_COLORS.indexOf(a) - TAG_COLORS.indexOf(b))[0];
}

/** The tags a row shows: as many as fit in about 18 characters, the rest as "+N". */
export function chipsFor(ids: string[], tags: TagInfo[]): { shown: TagInfo[]; more: number } {
  const known = ids.map((id) => tags.find((t) => t.id === id)).filter((t): t is TagInfo => !!t);
  const shown: TagInfo[] = [];
  let room = 18;
  for (const t of known) {
    if (shown.length && t.name.length > room) break;
    shown.push(t);
    room -= t.name.length + 2;
    if (room <= 0) break;
  }
  return { shown, more: known.length - shown.length };
}
