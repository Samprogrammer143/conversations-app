// A conversation, rendered tail-first: the newest page arrives at once and older
// pages stream in above as you scroll up, keeping your place.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DiffBlock, ToolCall, ToolKind, TranscriptItem } from "../../shared/types";
import { summariseCalls } from "../../shared/summary";
import { Icon, ToolIcon } from "../components/Icon";
import { IconButton } from "../components/controls";
import { Markdown } from "../components/Markdown";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { SEP, dayLabel, modelLabel, time24 } from "../lib/format";

const PAGE = 150;

function copy(text: string) {
  void api.app.copyText(text);
  useStore.getState().toast({ text: "Copied", icon: "check" });
}

const Diff = memo(function Diff({ d }: { d: DiffBlock }) {
  const counts = [d.removals ? `${d.removals} removal${d.removals === 1 ? "" : "s"}` : "", d.additions ? `${d.additions} addition${d.additions === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="name">
          {d.path}
          {d.created ? `${SEP}new file` : counts ? `${SEP}${counts}` : ""}
        </span>
        <IconButton icon="copy" label="Copy the new text" onClick={() => copy(d.lines.filter((l) => l.kind !== "del").map((l) => l.text).join("\n"))} />
      </div>
      {/* Only removed and added lines are coloured: red always means removed. */}
      <div className="diff-body selectable">
        {d.lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.kind}`}>
            <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
            <span>{l.text}</span>
          </div>
        ))}
        {d.truncated && <div className="diff-more">More lines not shown</div>}
      </div>
    </div>
  );
});

function CallRow({ c }: { c: ToolCall }) {
  const state = c.denied ? "You said no" : c.interrupted ? "Stopped" : c.pending ? "No result yet" : null;
  return (
    <div className={`tool-call${c.isError && !c.denied ? " error" : ""}`}>
      <ToolIcon kind={c.kind} />
      <div className="what">
        <span className="name">{c.question ? "Asked you" : c.server ? `${c.server}` : c.name}</span>
        {state && <span className="state">{`${SEP}${state}`}</span>}
        {c.question ? (
          <div>
            {c.question.question}
            {c.question.answer && <div className="result">{c.question.answer}</div>}
          </div>
        ) : (
          <>
            {c.detail && <div className="detail-text">{c.detail}</div>}
            {c.resultPreview && <div className="result selectable">{c.resultPreview}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A group of tool calls. While a chat runs in this app, calls still waiting for
 * approval or running are left out: the approval card and the activity line
 * stand for them, and the chip only ever says what has happened.
 */
const Tools = memo(function Tools({ item, live }: { item: Extract<TranscriptItem, { kind: "tools" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const calls = live ? item.calls.filter((c) => !c.pending) : item.calls;
  if (!calls.length) return null;
  const filtered = calls.length !== item.calls.length;
  const summary = filtered ? summariseCalls(calls) : item.summary;
  const icons: ToolKind[] = filtered ? [...new Set(calls.map((c) => c.kind))].slice(0, 2) : item.icons;
  return (
    <>
      <div className={`tools${open ? " open" : ""}`}>
        <button type="button" className="tools-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="icons">
            {icons.map((k) => (
              <ToolIcon key={k} kind={k} />
            ))}
          </span>
          <span className="ellipsis">{summary}</span>
          <Icon name="chevron-right" size={12} className="chev" />
        </button>
        {open && calls.map((c) => <CallRow key={c.id} c={c} />)}
      </div>
      {item.diffs.map((d, i) => (
        <Diff key={i} d={d} />
      ))}
    </>
  );
});

function UserImages({ images }: { images: { key: string; mediaType: string }[] }) {
  const [srcs, setSrcs] = useState<(string | null)[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all(images.map((i) => api.list.image(i.key))).then((r) => alive && setSrcs(r));
    return () => {
      alive = false;
    };
  }, [images]);
  if (!images.length) return null;
  return (
    <div className="bubble-images">
      {srcs.map((s, i) => (s ? <img key={i} src={s} alt="Image you sent" /> : null))}
    </div>
  );
}

type Block = { kind: "you"; item: Extract<TranscriptItem, { kind: "user" }> } | { kind: "claude"; items: TranscriptItem[] } | { kind: "other"; item: TranscriptItem };

/** Groups items into turns: your prompt, then everything Claude did until the next prompt. */
function toBlocks(items: TranscriptItem[]): Block[] {
  const out: Block[] = [];
  let claude: TranscriptItem[] | null = null;
  for (const it of items) {
    if (it.kind === "user") {
      claude = null;
      out.push({ kind: "you", item: it });
    } else if (it.kind === "text" || it.kind === "tools" || it.kind === "meta" || it.kind === "thinking") {
      if (!claude) {
        claude = [];
        out.push({ kind: "claude", items: claude });
      }
      claude.push(it);
    } else {
      claude = null;
      out.push({ kind: "other", item: it });
    }
  }
  return out;
}

/**
 * Claude's turn. Its footer (copy, model, time, PC) stays under the newest
 * finished reply; on earlier ones it appears on hover, in the gap below, so
 * nothing moves. A turn that is still running has no footer yet.
 */
function ClaudeTurn({ items, last, running }: { items: TranscriptItem[]; last: boolean; running: boolean }) {
  const meta = items.find((i) => i.kind === "meta") as Extract<TranscriptItem, { kind: "meta" }> | undefined;
  const text = items.filter((i) => i.kind === "text").map((i) => (i as { markdown: string }).markdown).join("\n\n");
  const showMeta = !!meta && !!text && !(last && running);
  return (
    <div className={`claude${last && !running ? " last" : ""}`}>
      {items.map((it) => {
        if (it.kind === "text") return <Markdown key={it.seq} text={it.markdown} />;
        if (it.kind === "tools") return <Tools key={it.seq} item={it} live={running && last} />;
        return null;
      })}
      {showMeta && (
        <div className="turn-meta">
          <IconButton icon="copy" label="Copy reply" size={14} onClick={() => copy(text)} />
          <span>{[modelLabel(meta.model), time24(meta.ts), meta.pc].filter(Boolean).join(SEP)}</span>
        </div>
      )}
    </div>
  );
}

/** Output taller than this many lines starts folded. */
const SHELL_FOLD_LINES = 14;

/** A "!" command: what you typed on the right, what it printed below. */
const Shell = memo(function Shell({ item }: { item: Extract<TranscriptItem, { kind: "shell" }> }) {
  const [open, setOpen] = useState(false);
  const out = (item.stdout ?? "").replace(/\s+$/, "");
  const err = (item.stderr ?? "").replace(/\s+$/, "");
  const NL = "\n";
  const lines = (out ? out.split(NL).length : 0) + (err ? err.split(NL).length : 0);
  const folded = !open && lines > SHELL_FOLD_LINES;
  const finished = item.stdout !== null || item.stderr !== null;
  return (
    <div className="shell-run">
      <div className="you">
        <div className="bubble shell-command selectable">
          <span className="bang" aria-hidden>
            !
          </span>
          {item.command}
        </div>
      </div>
      {finished && (
        <div className={`code-block shell-output${folded ? " folded" : ""}`}>
          <div className="code-head">
            <span className="name">{[err && !out ? "Error output" : "Output", item.pc].filter(Boolean).join(SEP)}</span>
            <IconButton icon="copy" label="Copy the output" onClick={() => copy([out, err].filter(Boolean).join(NL))} />
          </div>
          {out || err ? (
            <pre className="code-body selectable">
              {out && <code>{out}</code>}
              {out && err ? NL : null}
              {err && <code className="stderr">{err}</code>}
            </pre>
          ) : (
            <div className="shell-empty">No output</div>
          )}
          {lines > SHELL_FOLD_LINES && (
            <button type="button" className="shell-more" onClick={() => setOpen(!open)}>
              {open ? "Show less" : `Show all ${lines} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** Output longer than this starts folded. */
const COMMAND_FOLD_CHARS = 1200;

/** A slash command or skill you ran: what you typed on the right, what Claude Code printed for it below. */
const Command = memo(function Command({ item }: { item: Extract<TranscriptItem, { kind: "command" }> }) {
  const [open, setOpen] = useState(false);
  const out = item.output ?? "";
  const long = out.length > COMMAND_FOLD_CHARS || out.split("\n").length > 18;
  return (
    <div className="command-run">
      <div className="you">
        <div className="bubble shell-command command-typed selectable">
          <span className="bang" aria-hidden>
            /
          </span>
          {item.name}
          {item.args ? ` ${item.args}` : ""}
        </div>
      </div>
      {out && (
        <div className="command-output">
          <div className={`command-body${long && !open ? " folded" : ""}`}>
            <Markdown text={out} />
          </div>
          {long && (
            <button type="button" className="shell-more" onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function Other({ item }: { item: TranscriptItem }) {
  if (item.kind === "shell") return <Shell item={item} />;
  if (item.kind === "command") return <Command item={item} />;
  if (item.kind === "day") return <div className="day-sep">{dayLabel(item.date)}</div>;
  if (item.kind === "compact") return <div className="compact-sep">Earlier messages were summarised to save context{item.ts ? `${SEP}${time24(item.ts)}` : ""}</div>;
  if (item.kind === "parts")
    return (
      <div className="parts-pill">
        <Icon name="git-fork" size={14} />
        {item.label.replace(/ · /g, SEP)}
      </div>
    );
  if (item.kind === "part") return <div className="part-label">{item.label.replace(/ · /g, SEP)}{item.ts ? `${SEP}${new Date(item.ts).toLocaleDateString("en-GB", { weekday: "short" })} ${time24(item.ts)}` : ""}</div>;
  if (item.kind === "notice")
    return item.tone === "error" ? (
      <div className="notice error">
        <span className="lead">
          <Icon name="triangle-alert" />
        </span>
        <div>
          <div className="title">{item.title}</div>
          {item.body && <div className="body selectable">{item.body}</div>}
        </div>
      </div>
    ) : (
      <div className="small-notice">{item.title}</div>
    );
  return null;
}

export function Transcript({
  id,
  bottomPad,
  onScrollState,
  liveText = "",
  sent = [],
  running = false,
  tail = null,
  tailKey = null,
}: {
  id: string;
  bottomPad: number;
  onScrollState: (s: { scrolled: boolean; atBottom: boolean }) => void;
  liveText?: string;
  sent?: string[];
  /** A chat is running in this app right now. */
  running?: boolean;
  /** Shown after the last turn: the approval card Claude is waiting on. */
  tail?: ReactNode;
  tailKey?: string | null;
}) {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [firstSeq, setFirstSeq] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const lastSeq = useRef(-1);

  const load = useCallback(
    async (reason: "open" | "update") => {
      const page = await api.list.items(id, null, PAGE);
      setItems((prev) => {
        if (reason === "update" && prev.length && page.items.length) {
          // Keep older pages already loaded; replace the tail with the fresh one.
          const keep = prev.filter((p) => p.seq < page.firstSeq);
          return [...keep, ...page.items];
        }
        return page.items;
      });
      if (reason === "open") setFirstSeq(page.firstSeq);
      else setFirstSeq((f) => Math.min(f, page.firstSeq));
      const newest = page.items.length ? page.items[page.items.length - 1].seq : -1;
      if (reason === "update" && !atBottom.current && newest > lastSeq.current) {
        setNewCount((n) => n + page.items.filter((i) => i.seq > lastSeq.current && (i.kind === "text" || i.kind === "user" || i.kind === "command" || i.kind === "shell")).length);
      }
      lastSeq.current = Math.max(lastSeq.current, newest);
      // What you sent waits as a bubble until it arrives: a "!" command as "! command",
      // a slash command as "/name args". Compared with spacing evened out (a command's
      // arguments are recorded trimmed).
      const flat = (s: string) => s.replace(/\s+/g, " ").trim();
      const arrived = page.items.flatMap((i) =>
        i.kind === "user" ? [{ text: flat(i.text), prefix: false }] : i.kind === "shell" ? [{ text: flat(`! ${i.command}`), prefix: true }] : i.kind === "command" ? [{ text: flat(`/${i.name} ${i.args}`), prefix: true }] : [],
      );
      const pendingTexts = useStore.getState().sent[id] ?? [];
      // A very long command is kept shortened (ending in "…"): it still counts as arrived.
      const same = (a: { text: string; prefix: boolean }, t: string) => a.text === t || (a.prefix && a.text.endsWith("…") && t.startsWith(a.text.slice(0, -1)));
      const landed = pendingTexts.filter((t) => arrived.some((a) => same(a, flat(t))));
      if (landed.length) useStore.getState().clearSent(id, landed);
    },
    [id],
  );

  useEffect(() => {
    atBottom.current = true;
    lastSeq.current = -1;
    setNewCount(0);
    setItems([]);
    void load("open");
    const off = api.on("index-changed", (ids) => {
      if (ids.includes(id)) void load("update");
    });
    return off;
  }, [id, load]);

  // Stay pinned to the bottom when you were there; otherwise keep your place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
      loadingOlder.current = false;
      return;
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, bottomPad, liveText, sent.length, tailKey]);

  // Fonts and images can grow the page after the first layout: stay at the bottom.
  useEffect(() => {
    const el = ref.current;
    const col = el?.firstElementChild;
    if (!el || !col) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && !anchor.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, [id]);

  const loadOlder = async () => {
    if (loadingOlder.current || firstSeq <= 0 || !items.length) return;
    loadingOlder.current = true;
    const page = await api.list.items(id, items[0].seq, PAGE);
    const el = ref.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setFirstSeq(page.items.length ? page.firstSeq : 0);
    setItems((prev) => [...page.items, ...prev]);
    if (!page.items.length) loadingOlder.current = false;
  };

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottom.current = bottom;
    if (bottom && newCount) setNewCount(0);
    onScrollState({ scrolled: el.scrollTop > 4, atBottom: bottom });
    if (el.scrollTop < 800) void loadOlder();
  };

  useEffect(() => {
    const jump = () => {
      const el = ref.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      setNewCount(0);
    };
    window.addEventListener("app:jump-bottom", jump);
    return () => window.removeEventListener("app:jump-bottom", jump);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("app:new-count", { detail: newCount }));
  }, [newCount]);

  const blocks = toBlocks(items);
  const lastClaude = blocks.map((b) => b.kind).lastIndexOf("claude");
  return (
    <div
      ref={ref}
      className="transcript scroll"
      onScroll={onScroll}
      onClick={(e) => {
        const btn = (e.target as HTMLElement).closest("[data-copy]");
        if (btn) {
          const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
          copy(code);
        }
      }}
    >
      <div className="column">
        {blocks.map((b, i) => {
          if (b.kind === "you")
            return (
              <div className="you" key={`u${b.item.seq}`}>
                <UserImages images={b.item.images} />
                {b.item.text && <div className="bubble selectable">{b.item.text}</div>}
              </div>
            );
          if (b.kind === "claude") return <ClaudeTurn key={`c${b.items[0].seq}`} items={b.items} last={i === lastClaude} running={running} />;
          return <Other key={`o${b.item.seq}`} item={b.item} />;
        })}
        {sent.map((t, i) => (
          <div className="you" key={`sent-${i}`}>
            {t.startsWith("! ") ? (
              <div className="bubble shell-command selectable">
                <span className="bang" aria-hidden>
                  !
                </span>
                {t.slice(2)}
              </div>
            ) : (
              <div className="bubble selectable">{t}</div>
            )}
          </div>
        ))}
        {liveText && (
          <div className="claude live">
            <Markdown text={liveText} />
          </div>
        )}
        {tail && (
          <div className="transcript-tail" id="transcript-tail">
            {tail}
          </div>
        )}
        <div className="bottom-pad" style={{ height: bottomPad }} />
      </div>
    </div>
  );
}
