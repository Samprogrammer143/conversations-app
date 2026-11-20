// Tags (Figma: "Tags (for review)", T1 and T2). A tag is a name and a colour; a chat can
// have several. Chats show theirs in the list, the sidebar lists every tag with a count
// and filters by one, a chat's menu opens the picker ("Tags…"), and a tag's own menu in
// the sidebar renames, recolours or deletes it. Everything is an edit, so it syncs to
// every PC (and the phone) as pins do.

import { useEffect, useMemo, useRef, useState } from "react";
import { TAG_COLORS, type ConversationRow, type TagColor, type TagInfo } from "../../shared/types";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { chipsFor, nextColor } from "../lib/tags";

const EMPTY: TagInfo[] = [];

/** Every tag, by name. */
export const useTags = () => useStore((s) => s.sidebar?.tags ?? EMPTY);

const rowTagsOf = (s: ReturnType<typeof useStore.getState>, id: string): string[] | null =>
  s.list?.rows.find((r) => r.id === id)?.tags ?? (s.detail?.row.id === id ? s.detail.row.tags : null);

/**
 * A chat's tags as set from this window while that edit is being saved: two quick changes
 * in a row build on each other, not on the list, which catches up a moment later. Dropped
 * once the save ends, so a change from another PC or the phone is never built over.
 */
const saving = new Map<string, { tags: string[]; n: number }>();
let saves = 0;

/** A chat's tags: being saved here, else the list's, else as they were when the picker opened. */
function tagsOf(id: string): string[] {
  const s = useStore.getState();
  return saving.get(id)?.tags ?? rowTagsOf(s, id) ?? (s.tagPicker?.chatId === id ? s.tagPicker.tags : []);
}

async function setTags(chatId: string, next: string[], what: string, made?: string) {
  // Only tags that still exist: a deleted one doesn't keep taking one of the 30 places.
  const live = new Set((useStore.getState().sidebar?.tags ?? []).map((t) => t.id));
  const n = ++saves;
  // (A tag made just now may not be in the sidebar's list yet.)
  const tags = next.filter((t) => live.has(t) || t === made);
  saving.set(chatId, { tags, n });
  const r = await api.edit.apply(chatId, "tags", tags.slice(0, 30));
  if (saving.get(chatId)?.n === n) saving.delete(chatId);
  failed(r, what);
}

export function TagChips({ row }: { row: ConversationRow }) {
  const tags = useTags();
  if (!row.tags.length || !tags.length) return null;
  const { shown, more } = chipsFor(row.tags, tags);
  if (!shown.length) return null;
  return (
    <span className="tag-chips">
      {shown.map((t) => (
        <span key={t.id} className={`tag-chip c-${t.color}`}>
          {t.name}
        </span>
      ))}
      {more > 0 && <span className="tag-chip more">+{more}</span>}
    </span>
  );
}

/** The dot before a tag's name in the sidebar and the picker. */
export const TagDot = ({ color }: { color: TagColor }) => <span className={`tag-dot c-${color}`} aria-hidden="true" />;

// ------------------------------------------------------------------ actions

function failed(r: { ok: boolean; err?: string }, what: string) {
  if (!r.ok) useStore.getState().toast({ text: r.err ?? what, icon: "alert" });
  return !r.ok;
}

/** Adds or removes one tag on a chat. */
export async function toggleTag(chatId: string, tagId: string) {
  const cur = tagsOf(chatId);
  if (!cur.includes(tagId) && cur.length >= 30) {
    useStore.getState().toast({ text: "A chat can have at most 30 tags", icon: "alert" });
    return;
  }
  await setTags(chatId, cur.includes(tagId) ? cur.filter((t) => t !== tagId) : [...cur, tagId], "Couldn't change the tags");
}

/** Makes a tag (with the next colour) and puts it on the chat. */
export async function createTag(chatId: string, name: string) {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!clean) return;
  const id = crypto.randomUUID();
  const color = nextColor(useStore.getState().sidebar?.tags ?? []);
  // The tag first; only once it is saved does the chat get it.
  if (tagsOf(chatId).length >= 30) {
    useStore.getState().toast({ text: "A chat can have at most 30 tags", icon: "alert" });
    return;
  }
  if (failed(await api.edit.apply(id, "tagName", clean, [{ field: "tagColor", value: color }]), "Couldn't make the tag")) return;
  await setTags(chatId, [...tagsOf(chatId), id], `Made the tag “${clean}” but couldn't add it to this chat`, id);
}

export async function renameTag(id: string, name: string) {
  useStore.setState({ renamingTag: null });
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  const tag = useStore.getState().sidebar?.tags.find((t) => t.id === id);
  if (!clean || !tag || clean === tag.name) return;
  failed(await api.edit.apply(id, "tagName", clean), "Couldn't rename the tag");
}

export async function recolorTag(id: string, color: TagColor) {
  failed(await api.edit.apply(id, "tagColor", color), "Couldn't change the colour");
}

/** Deletes a tag everywhere; its chats stay as they are. Undo brings it back. */
export async function deleteTag(id: string) {
  const s = useStore.getState();
  const tag = s.sidebar?.tags.find((t) => t.id === id);
  if (!tag) return;
  if (s.scope.kind === "tag" && s.scope.id === id) s.setScope({ kind: "all" });
  if (failed(await api.edit.apply(id, "tagDeleted", true), "Couldn't delete the tag")) return;
  s.toast({ text: `Deleted the tag “${tag.name}”`, icon: "check", actionLabel: "Undo", onAction: () => void api.edit.apply(id, "tagDeleted", false) });
}

// ------------------------------------------------------------------ the picker

/** Click-away, Escape and window blur close a floating panel. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", close);
    };
  }, [ref, open, close]);
}

type PickRow = { kind: "tag"; tag: TagInfo } | { kind: "create"; name: string };

/** Figma: Tag Picker. Find a tag to tick, or type a new name to make one. */
export function TagPicker() {
  const picker = useStore((s) => s.tagPicker);
  const tags = useTags();
  const listTags = useStore((s) => (s.tagPicker ? rowTagsOf(s, s.tagPicker.chatId) : null));
  // Re-drawn after each choice, so the ticks follow what was just set.
  const [, redraw] = useState(0);
  // The chat can leave the list while the picker is open (unticking the tag it is filtered by): it stays open.
  const rowTags = picker ? (saving.get(picker.chatId)?.tags ?? listTags ?? picker.tags) : null;
  const close = useMemo(() => () => useStore.setState({ tagPicker: null }), []);
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  useDismiss(ref, !!picker, close);
  useEffect(() => {
    setQuery("");
    setActive(-1);
  }, [picker?.chatId]);

  const q = query.replace(/\s+/g, " ").trim();
  const list: PickRow[] = useMemo(() => {
    const lower = q.toLowerCase();
    const matches = tags.filter((t) => !lower || t.name.toLowerCase().includes(lower));
    // Names that start with what was typed come first.
    if (lower) matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)));
    const exact = tags.some((t) => t.name.toLowerCase() === lower);
    return [...matches.map((tag) => ({ kind: "tag" as const, tag })), ...(q && !exact ? [{ kind: "create" as const, name: q.slice(0, 40) }] : [])];
  }, [tags, q]);
  useEffect(() => setActive(q ? 0 : -1), [q]);

  if (!picker || !rowTags) return null;
  const optionId = (i: number) => `tag-option-${i}`;
  const chatId = picker.chatId;
  const choose = (r: PickRow) => {
    if (r.kind === "tag") void toggleTag(chatId, r.tag.id);
    else {
      void createTag(chatId, r.name);
      setQuery("");
    }
    redraw((n) => n + 1);
  };
  const height = 46 + Math.min(list.length, 9) * 28 + 40;
  const x = Math.max(8, Math.min(picker.x, window.innerWidth - 248));
  const y = Math.max(8, Math.min(picker.y, window.innerHeight - height - 8));
  return (
    <div className="menu tag-picker" ref={ref} role="dialog" aria-label="Tags" style={{ left: x, top: y }}>
      <div className="tag-field">
        <Icon name="tag" size={16} />
        <input
          autoFocus
          value={query}
          placeholder="Find or create a tag"
          aria-label="Find or create a tag"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && list[active] ? optionId(active) : undefined}
          aria-controls="tag-options"
          spellCheck={false}
          maxLength={40}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              if (query) setQuery("");
              else close();
            } else if (e.key === "ArrowDown" && list.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % list.length);
            } else if (e.key === "ArrowUp" && list.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? list.length - 1 : a - 1));
            } else if (e.key === "Enter" && list[active]) {
              e.preventDefault();
              choose(list[active]);
            }
          }}
        />
      </div>
      <div className="menu-sep" role="separator" />
      <div className="tag-options scroll" id="tag-options" role="listbox" aria-multiselectable="true">
        {list.map((r, i) =>
          r.kind === "tag" ? (
            <button
              key={r.tag.id}
              id={optionId(i)}
              tabIndex={-1}
              type="button"
              role="option"
              aria-selected={rowTags.includes(r.tag.id)}
              className="menu-item tag-option"
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <TagDot color={r.tag.color} />
              <span className="ellipsis">{r.tag.name}</span>
              {rowTags.includes(r.tag.id) && <Icon name="check" className="tick" />}
            </button>
          ) : (
            <button key="create" id={optionId(i)} tabIndex={-1} type="button" role="option" aria-selected={false} className="menu-item tag-option" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(r)}>
              <Icon name="plus" />
              <span className="ellipsis">Create tag “{r.name}”</span>
            </button>
          ),
        )}
      </div>
      <div className="tag-foot">{list.length ? (q && list[list.length - 1]?.kind === "create" ? "Enter creates it and adds it to this chat." : "Tags show on all your PCs and the phone.") : "Type a name to make your first tag."}</div>
    </div>
  );
}

// ------------------------------------------------------------------ a tag's own menu

/** Figma: Context Menu / Tag. Rename, colour, delete. */
export function TagMenu() {
  const menu = useStore((s) => s.tagMenu);
  const tag = useTags().find((t) => t.id === menu?.id);
  const close = useMemo(() => () => useStore.setState({ tagMenu: null }), []);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  useDismiss(ref, !!menu, close);
  useEffect(() => {
    setActive(0);
    if (menu) ref.current?.focus();
  }, [menu]);
  if (!menu || !tag) return null;
  const rename = () => useStore.setState({ renamingTag: tag.id, tagMenu: null });
  const remove = () => {
    close();
    void deleteTag(tag.id);
  };
  const x = Math.min(menu.x, window.innerWidth - 296);
  const y = Math.min(menu.y, window.innerHeight - 120);
  return (
    <div
      className="menu context tag-menu"
      role="menu"
      ref={ref}
      tabIndex={-1}
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        // The menu's keys are its own: Delete or F2 here must never reach the selected chat.
        e.stopPropagation();
        const onSwatch = (e.target as HTMLElement).classList.contains("tag-swatch");
        if (e.key === "Escape") close();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") setActive((a) => (a === 0 ? 1 : 0));
        else if (e.key === "Enter" && !onSwatch) {
          e.preventDefault();
          (active === 0 ? rename : remove)();
        } else if (e.key === "F2") rename();
      }}
    >
      <button type="button" role="menuitem" className="menu-item" data-active={active === 0} onMouseEnter={() => setActive(0)} onClick={rename}>
        <Icon name="pencil" />
        Rename…
        <span className="shortcut">F2</span>
      </button>
      <div className="tag-colours" role="group" aria-label="Colour">
        <span>Colour</span>
        {TAG_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`tag-swatch c-${c}`}
            aria-label={c}
            aria-pressed={tag.color === c}
            onClick={() => {
              void recolorTag(tag.id, c);
              close();
            }}
          />
        ))}
      </div>
      <div className="menu-sep" role="separator" />
      <button type="button" role="menuitem" className="menu-item destructive" data-active={active === 1} onMouseEnter={() => setActive(1)} onClick={remove}>
        <Icon name="x" />
        Delete tag
      </button>
    </div>
  );
}

/** A tag's name in the sidebar while it is being renamed. */
export function TagRenameInput({ tag }: { tag: TagInfo }) {
  const [draft, setDraft] = useState(tag.name);
  return (
    <input
      className="rename-input"
      autoFocus
      value={draft}
      maxLength={40}
      aria-label="Tag name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") void renameTag(tag.id, draft);
        if (e.key === "Escape") useStore.setState({ renamingTag: null });
      }}
      onBlur={() => void renameTag(tag.id, draft)}
    />
  );
}
