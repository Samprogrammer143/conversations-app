import { useEffect, useRef, useState } from "react";
import type { Attachment, ChatStatus, ComposerPrefs, Effort, ModelChoice, PermissionRequest, SlashCommandInfo } from "../../shared/types";
import { Icon } from "../components/Icon";
import { Button, GlassCircle, IconButton, ToolbarButton } from "../components/controls";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { SEP, modelLabel } from "../lib/format";
import { Transcript } from "./Transcript";
import { McpPanel } from "./McpPanel";

const MODES: { value: string; label: string; icon: string; hint: string }[] = [
  { value: "default", label: "Ask first", icon: "shield-check", hint: "Asks before each tool runs" },
  { value: "acceptEdits", label: "Accept edits", icon: "pencil", hint: "Edits go ahead; commands still ask" },
  { value: "auto", label: "Auto", icon: "zap", hint: "Claude Code decides what is safe; you are asked otherwise" },
  { value: "plan", label: "Plan only", icon: "list-filter", hint: "Thinks and proposes; changes nothing" },
];

const EFFORTS: { value: Effort; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "Quickest answers, least thinking" },
  { value: "medium", label: "Medium", hint: "Balanced for everyday work" },
  { value: "high", label: "High", hint: "Thinks things through" },
  { value: "xhigh", label: "Extra high", hint: "Deeper thinking for hard problems" },
  { value: "max", label: "Max", hint: "As much as the model allows; this session only" },
];

/** The slash-command menu: shown while the message is "/" plus a partial name. */
function SlashMenu({ items, active, onPick, onHover }: { items: SlashCommandInfo[]; active: number; onPick: (c: SlashCommandInfo) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="slash-menu scroll" role="listbox" aria-label="Commands and skills" ref={ref}>
      {items.length === 0 ? (
        <div className="slash-empty">No command or skill by that name</div>
      ) : (
        items.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={i === active}
            data-active={i === active}
            className="slash-item"
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
          >
            <span className="slash-name">
              /{c.name}
              {c.argumentHint ? <span className="slash-args"> {c.argumentHint}</span> : null}
            </span>
            <span className="slash-desc ellipsis">{c.description}</span>
            {!c.builtin && <span className="slash-kind">Skill</span>}
          </button>
        ))
      )}
    </div>
  );
}

type Pending = { key: string; name: string; mediaType: Attachment["mediaType"]; data: string };

/** Images attached and not sent yet, per chat, while the app runs (too big to keep on disk). */
const pendingImages = new Map<string, Pending[]>();

/** Where the composer keeps a chat's draft and choices: the conversation, or the new chat's folder or project. */
export function composerKey(id: string | null, projectId: string | null, folder: string | null): string {
  return id ?? `new:${folder ?? projectId ?? "home"}`;
}
const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Reads an image file from a paste, a drop or the picker into an attachment. */
function readImage(file: File): Promise<Pending | null> {
  return new Promise((resolve) => {
    if (!IMAGE_MEDIA.has(file.type) || file.size > 5 * 1024 * 1024) return resolve(null);
    const r = new FileReader();
    r.onload = () => resolve({ key: `${Date.now()}-${Math.random()}`, name: file.name || "Pasted image", mediaType: file.type as Attachment["mediaType"], data: String(r.result).split(",")[1] ?? "" });
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

// Shown before a session has reported the models this account can use.
// Shown only until Claude Code has said which models this account has (a few seconds after the app starts).
const FALLBACK_MODELS: ModelChoice[] = [
  { value: "opus", label: "Opus", hint: "", current: true },
  { value: "sonnet", label: "Sonnet", hint: "", current: true },
  { value: "haiku", label: "Haiku", hint: "", current: true },
];

/** "1.2k" style token counts, as Claude Code shows them. */
const tokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

const BUSY = ["starting", "thinking", "running-tool", "writing", "waiting-approval"];

function useChatStatus(id: string | null) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!id) return;
    void api.chat.status(id).then(setStatus);
    return api.on("chat-status", (s) => {
      if (s.conversationId === id) setStatus(s);
    });
  }, [id]);
  return status;
}

/**
 * Moves focus to the card's default button, unless you are typing somewhere or
 * the card is out of sight: a key press must never answer a request you can't see.
 */
function focusCard(card: HTMLElement | null, destructive: boolean) {
  const typing = document.activeElement?.closest("textarea, input, [contenteditable]");
  if (!card || typing) return;
  const r = card.getBoundingClientRect();
  const composerTop = document.querySelector(".detail .composer-wrap")?.getBoundingClientRect().top ?? window.innerHeight;
  if (r.top < 0 || r.bottom > composerTop + 24) return;
  card.querySelector<HTMLButtonElement>(destructive ? "button[data-deny]" : "button[data-allow]")?.focus({ preventScroll: true });
}

function PermissionCard({ p }: { p: PermissionRequest }) {
  const ref = useRef<HTMLDivElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const allow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Destructive requests open on Deny, and nothing approves on a single stray
    // key. A card never takes focus from the composer while you type.
    focusCard(ref.current, p.destructive);
  }, [p.requestId, p.destructive]);
  const respond = (d: "allow" | "allow-always" | "deny") => void api.chat.respond(p.requestId, d);
  return (
    <div
      ref={ref}
      className={`permission${p.destructive ? " destructive" : ""}`}
      role="alertdialog"
      aria-label={p.title}
      onKeyDown={(e) => {
        if (e.key === "Escape") respond("deny");
        if (e.key === "Enter" && e.ctrlKey && p.destructive) {
          e.preventDefault();
          respond("allow");
        }
      }}
    >
      <div className="head">
        <span className="lead">
          <Icon name={p.destructive ? "triangle-alert" : "shield-check"} />
        </span>
        <div>
          <div className="title">{p.title}</div>
          <div className="context">{p.context.split("  ·  ").join(SEP)}</div>
        </div>
      </div>
      {p.body && <pre className="command">{p.body}</pre>}
      {p.consequence && <div className="reason">{p.consequence}</div>}
      <div className="actions">
        <span className="hint">{p.destructive ? `Enter to deny${SEP}Ctrl+Enter to allow` : `Enter to allow${SEP}Esc to deny`}</span>
        {p.allowAlways && !p.destructive && (
          <Button kind="plain" onClick={() => respond("allow-always")}>
            Always allow
          </Button>
        )}
        {p.destructive ? (
          <>
            <Button kind="danger" onClick={() => respond("allow")}>
              Allow once
            </Button>
            <button ref={deny} type="button" data-deny className="btn btn-primary" onClick={() => respond("deny")}>
              Deny
            </button>
          </>
        ) : (
          <>
            <button ref={deny} type="button" data-deny className="btn btn-secondary" onClick={() => respond("deny")}>
              Deny
            </button>
            <button ref={allow} type="button" data-allow className="btn btn-primary" onClick={() => respond("allow")}>
              Allow once
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Activity({ s }: { s: ChatStatus }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [s.state, s.activity]);
  if (s.state === "waiting-approval")
    return (
      <button
        type="button"
        className="activity link"
        role="status"
        title="Show the request"
        onClick={() => {
          // The card is the last thing in the conversation, just above the composer.
          const transcript = document.querySelector<HTMLElement>(".detail .transcript");
          if (transcript) transcript.scrollTop = transcript.scrollHeight;
          const tail = document.getElementById("transcript-tail");
          focusCard(tail?.querySelector<HTMLElement>(".permission") ?? null, !!s.permission?.destructive);
        }}
      >
        <Icon name="shield-alert" size={14} className="warn" />
        <span className="label">Waiting for your approval</span>
      </button>
    );
  if (!["thinking", "running-tool", "writing", "starting"].includes(s.state)) return null;
  return (
    <div className="activity" role="status">
      <Icon name={s.state === "running-tool" ? "terminal" : "x-sparkle-fill"} size={14} className={s.state === "running-tool" ? "" : "pulse"} />
      <span className="label">{s.activity ?? (s.state === "starting" ? "Starting Claude Code" : s.state === "writing" ? "Writing" : "Thinking")}</span>
      <span>{elapsed} s</span>
      {s.turnTokens ? <span className="tokens">↓ {tokens(s.turnTokens)} tokens</span> : null}
      <span>Esc to interrupt</span>
      {s.queued.length > 0 && <span>· {s.queued.length} queued</span>}
    </div>
  );
}

/** A pick-one menu above a composer chip: the model, or the permission mode. */
function ChoiceMenu({ items, value, onPick, onClose, anchor }: { items: { value: string; label: string; icon?: string; hint?: string; heading?: string }[]; value: string | null; onPick: (v: string) => void; onClose: () => void; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  // Opens upwards from the chip, and scrolls if it is taller than the room above it.
  const maxH = Math.max(160, anchor.top - 16);
  return (
    <div className="menu choice scroll" role="menu" ref={ref} style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 8, maxHeight: maxH }}>
      {items.map((m) => [
        m.heading ? (
          <div key={`h-${m.value}`} className="menu-heading">
            {m.heading}
          </div>
        ) : null,
        <button
          key={m.value}
          type="button"
          role="menuitemradio"
          aria-checked={m.value === value}
          className={`menu-item${m.hint ? " two-line" : ""}`}
          onClick={() => {
            onPick(m.value);
            onClose();
          }}
        >
          <Icon name={m.value === value ? "check" : m.icon ?? "sparkle"} />
          <span className="text">
            <span>{m.label}</span>
            {m.hint && <span className="hint">{m.hint}</span>}
          </span>
        </button>,
      ])}
    </div>
  );
}

/** The current models with what each is for, then the older versions on one line each. */
function ModelMenu({ models, value, onPick, onClose, anchor }: { models: ModelChoice[]; value: string | null; onPick: (v: string) => void; onClose: () => void; anchor: DOMRect }) {
  const current = models.filter((m) => m.current);
  const older = models.filter((m) => !m.current);
  const items = [...current.map((m) => ({ value: m.value, label: m.label, hint: m.hint })), ...older.map((m, i) => ({ value: m.value, label: m.label, heading: i === 0 ? "Older models" : undefined }))];
  return <ChoiceMenu items={items} value={value} onPick={onPick} onClose={onClose} anchor={anchor} />;
}

/** The models Claude Code offers, asked once per window and kept. */
let modelCache: ModelChoice[] | null = null;
function useModels(open: boolean) {
  const [models, setModels] = useState<ModelChoice[]>(modelCache ?? FALLBACK_MODELS);
  useEffect(() => {
    void api.chat.models().then((m) => {
      if (m.length) {
        modelCache = m;
        setModels(m);
      }
    });
  }, [open]);
  return models;
}

/** "38%" inside a small ring, like the context meter in the Claude app. */
function ContextRing({ percent }: { percent: number }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span className="context-ring" title={`${p}% of the context window used`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 8 8)" className={p >= 90 ? "hot" : p >= 70 ? "warm" : ""} />
      </svg>
      <span>{p}%</span>
    </span>
  );
}

function Composer({
  id,
  projectId,
  folder = null,
  status,
  disabledReason,
  onSent,
  lastModel,
  savedContextPercent = null,
  onNewChatHere,
}: {
  id: string | null;
  projectId?: string | null;
  /** A new chat in a folder you picked, rather than a known project. */
  folder?: string | null;
  status: ChatStatus | null;
  disabledReason: string | null;
  onSent?: (conversationId: string) => void;
  lastModel?: string | null;
  /** From the transcript, for a conversation that isn't running here. */
  savedContextPercent?: number | null;
  /** /clear: a fresh chat in this conversation's folder (the previous one stays in the list). */
  onNewChatHere?: (text: string) => void;
}) {
  // Everything below is kept per chat: the conversation, or the new chat's folder.
  const key = composerKey(id, projectId ?? null, folder);
  const [text, setTextState] = useState(() => useStore.getState().composer.drafts[key] ?? "");
  const defaultMode = useStore((s) => s.settings?.defaultPermissionMode ?? "default");
  const prefs = useStore((s) => s.composer.prefs[key]);
  const setPrefs = useStore((s) => s.setPrefs);
  const setDraft = useStore((s) => s.setDraft);
  const mode = prefs?.mode ?? null;
  const model = prefs?.model ?? null;
  const effort = prefs?.effort ?? null;
  const [menu, setMenu] = useState<{ kind: "model" | "mode" | "effort"; at: DOMRect } | null>(null);
  /** The chat (composer key) the /mcp panel was opened for: it never shows for another one. */
  const [mcpFor, setMcpFor] = useState<string | null>(null);
  /** Opens a composer chip's menu as if it was clicked (/model and /effort typed on their own). */
  const openChipMenu = (kind: "model" | "effort"): boolean => {
    const chip = ref.current?.closest(".composer")?.querySelector<HTMLElement>(kind === "model" ? 'button[aria-label="Model"]' : 'button[aria-label^="Effort"]');
    if (chip) setMenu({ kind, at: chip.getBoundingClientRect() });
    return !!chip;
  };
  const [commands, setCommands] = useState<SlashCommandInfo[] | null>(null);
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [sending, setSending] = useState(false);
  // A "!" command running for this chat, wherever it was started from.
  const shellRunning = useStore((s) => !!s.runningShells[key]);
  const setShellRunning = useStore((s) => s.setShellRunning);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useStore((s) => s.toast);
  const noteSent = useStore((s) => s.noteSent);
  const keyRef = useRef(key);
  const textRef = useRef(text);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  /** Changes the message and keeps it for this chat, so it is still there when you come back. */
  const setText = (next: string | ((prev: string) => string)) => {
    const value = typeof next === "function" ? next(textRef.current) : next;
    textRef.current = value;
    setTextState(value);
    setDraft(keyRef.current, value);
  };

  // Another chat: its own message and images come back, and this one's are kept.
  useEffect(() => {
    keyRef.current = key;
    const saved = useStore.getState().composer.drafts[key] ?? "";
    textRef.current = saved;
    setTextState(saved);
    setPending(pendingImages.get(key) ?? []);
    setMenu(null);
    setMcpFor(null);
    return () => {
      if (pendingRef.current.length) pendingImages.set(key, pendingRef.current);
      else pendingImages.delete(key);
    };
  }, [key]);

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files];
    const read = await Promise.all(list.map(readImage));
    const ok = read.filter((p): p is Pending => !!p);
    const skipped = list.length - ok.length;
    if (ok.length) setPending((prev) => [...prev, ...ok].slice(0, 10));
    if (skipped) toast({ text: skipped === list.length ? "Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached" : `${skipped} of them couldn't be attached (images up to 5 MB only)`, icon: "alert" });
  };
  const pick = async () => {
    const r = await api.app.pickFiles();
    if (r.images.length) setPending((prev) => [...prev, ...r.images.map((a) => ({ ...a, key: `${Date.now()}-${Math.random()}` }))].slice(0, 10));
    // Other files are handed to Claude by path, which it can read in the project.
    if (r.paths.length) setText((t) => `${t.trimEnd()}${t.trim() ? "\n\n" : ""}${r.paths.map((p) => `Attached file: ${p}`).join("\n")}\n`);
    ref.current?.focus();
  };
  const running = !!status && BUSY.includes(status.state);
  // While Claude Code starts for this conversation, nothing else is sent: a second
  // send could start a second process on the same transcript.
  const starting = status?.state === "starting";
  const offline = useStore((s) => s.sync?.phase === "offline");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  useEffect(() => {
    setCommands(null);
  }, [id, projectId, folder]);
  useEffect(() => {
    if (slashQuery !== null && commands === null) void api.chat.commands(id, projectId ?? null, folder).then(setCommands);
  }, [slashQuery !== null, commands, id, projectId, folder]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSlashActive(0);
    if (slashQuery === null) setSlashClosed(false);
  }, [slashQuery]);
  const slashItems = slashQuery === null || commands === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery.toLowerCase()) || (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(slashQuery.toLowerCase()))).sort((a, b) => Number(!a.name.toLowerCase().startsWith(slashQuery.toLowerCase())) - Number(!b.name.toLowerCase().startsWith(slashQuery.toLowerCase())));
  const slashOpen = slashQuery !== null && commands !== null && !slashClosed;
  const pickCommand = (c: SlashCommandInfo) => {
    setText(`/${c.name} `);
    ref.current?.focus();
  };
  useEffect(() => {
    const focus = () => ref.current?.focus();
    window.addEventListener("app:focus-composer", focus);
    return () => window.removeEventListener("app:focus-composer", focus);
  }, []);

  const send = async () => {
    let value = text.trim();
    const images = pending;
    if ((!value && !images.length) || sending) return;
    if (disabledReason) {
      toast({ text: disabledReason, icon: "alert" });
      return;
    }
    // Commands that are screens in the terminal get the app's own version here; the
    // rest go to Claude Code, which runs them and records what they print.
    const slash = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(value);
    if (slash) {
      const name = slash[1].toLowerCase();
      const arg = (slash[2] ?? "").trim();
      if (name === "mcp" && !arg) {
        setText("");
        setMenu(null);
        setMcpFor(key);
        return;
      }
      if ((name === "model" || name === "effort") && !arg) {
        setText("");
        if (!openChipMenu(name)) toast({ text: name === "effort" ? "This model has no effort levels to choose from" : "The model menu isn't available here", icon: "alert" });
        return;
      }
      if (name === "clear" || name === "reset" || name === "new") {
        setText("");
        if (id && onNewChatHere) {
          // Anything typed after it goes into the new chat's box, unsent.
          onNewChatHere(arg);
          toast({ text: "Started a new chat in the same folder. The previous one stays in your list.", icon: "check" });
        } else toast({ text: "This is already a new chat", icon: "check" });
        return;
      }
      // /model and /effort with a value also set this chat's chips, so they show what Claude
      // Code uses; only for a value it offers (a typo or a sentence is left to Claude Code).
      if ((name === "model" || name === "effort") && !images.length) {
        const a = arg.toLowerCase();
        const model = name === "model" ? (a === "default" ? null : models.find((m) => m.value.toLowerCase() === a || m.label.toLowerCase() === a) ?? undefined) : undefined;
        const level = name === "effort" ? (a === "auto" ? null : EFFORTS.find((e) => e.value === a)?.value) : undefined;
        const known = name === "model" ? model !== undefined : level !== undefined;
        if (known) {
          if (name === "model") setPrefs(key, { model: model ? model.value : undefined });
          // Typed by its menu name ("Opus 5.5"): Claude Code is given the name it knows.
          if (name === "model" && model && model.value.toLowerCase() !== a) value = `/model ${model.value}`;
          else setPrefs(key, { effort: level ?? undefined });
        }
        if (!id) {
          // A new chat: nothing to send yet; it starts with this choice.
          if (!known) {
            toast({ text: name === "model" ? `There's no model called “${arg}”. Pick one from the model menu.` : `“${arg}” isn't an effort level. Pick one from the effort menu.`, icon: "alert" });
            return;
          }
          setText("");
          toast({ text: name === "model" ? `This new chat will use ${model ? model.label : "the default model"}` : `This new chat will use ${level ? EFFORTS.find((e) => e.value === level)?.label.toLowerCase() : "the model's default"} effort`, icon: "check" });
          return;
        }
      }
    }
    // "!" runs the rest as a shell command in the chat's folder, as Claude Code's bash mode does.
    const shell = value.startsWith("!");
    const command = shell ? value.slice(1).trim() : "";
    if (shell && !command) {
      toast({ text: "Type a command after the !", icon: "alert" });
      return;
    }
    if (shell && images.length) {
      toast({ text: "Images can't go with a ! command. Remove them, or send them as a message.", icon: "alert" });
      return;
    }
    const sentKey = key;
    const shown = shell ? `! ${command}` : value || `(${images.length === 1 ? "image" : `${images.length} images`})`;
    setText("");
    setPending([]);
    if (id) noteSent(id, shown);
    // A new chat's composer waits for Claude Code; a command shows as running instead.
    setSending(!id && !shell);
    if (shell) setShellRunning(sentKey, true);
    let r: Awaited<ReturnType<typeof api.chat.send>>;
    try {
      r = await api.chat.send(id, shell ? command : value, { projectId, folder, permissionMode: mode ?? defaultMode, model, effort, shell, draftKey: id ? undefined : sentKey, attachments: images.map(({ name, mediaType, data }) => ({ name, mediaType, data })) });
    } catch (e) {
      r = { ok: false, err: (e as Error).message };
    }
    if (mounted.current) setSending(false);
    if (shell) setShellRunning(sentKey, false);
    if (!r.ok) {
      if (id) useStore.getState().clearSent(id, [shown]);
      if (r.ran) {
        // The command did run: it is never put back to be run again.
        toast({ text: r.err ?? "The command ran, but what it printed couldn't be added to the conversation", icon: "alert", durationMs: 12_000 });
        return;
      }
      // Back into the chat it came from, even if you have moved to another one,
      // without losing anything typed or attached there since.
      const there = useStore.getState().composer.drafts[sentKey] ?? "";
      const restored = there.trim() ? `${value}\n\n${there}` : value;
      setDraft(sentKey, restored);
      if (keyRef.current === sentKey && mounted.current) {
        textRef.current = restored;
        setTextState(restored);
        setPending((prev) => [...images, ...prev].slice(0, 10));
      } else if (images.length) pendingImages.set(sentKey, [...images, ...(pendingImages.get(sentKey) ?? [])].slice(0, 10));
      toast({ text: r.err ?? (shell ? "Couldn't run that command" : "Couldn't send"), icon: "alert" });
    } else if (!id && r.conversationId) {
      useStore.getState().adoptComposer(sentKey, r.conversationId);
      noteSent(r.conversationId, shown);
      // Opened only if you are still on that new chat.
      if (mounted.current && keyRef.current === sentKey) onSent?.(r.conversationId);
    }
  };

  // Your own choice shows at once; otherwise what the running session reports, or the setting.
  const modeValue = mode ?? status?.permissionMode ?? defaultMode;
  const modeInfo = MODES.find((m) => m.value === modeValue) ?? MODES[0];
  const models = useModels(menu?.kind === "model");
  const chosen = model ?? status?.model ?? lastModel;
  // The menu's own name for it ("Fable 5.1"); for a full id from a transcript, its short form.
  const shownModel = (chosen && models.find((m) => m.value === chosen)?.label) ?? modelLabel(chosen) ?? "Default model";
  // Effort levels this model takes; none for a model without them.
  const modelEfforts = (chosen && models.find((m) => m.value === chosen)?.efforts) ?? null;
  const effortChoices = modelEfforts ? EFFORTS.filter((e) => modelEfforts.includes(e.value)) : EFFORTS;
  const effortInfo = effort ? EFFORTS.find((e) => e.value === effort) : null;
  const placeholder = !id ? "Ask Claude… (/ for commands and skills, ! for the shell)" : running ? "Queue a follow-up…" : "Reply to Claude…";
  const contextPercent = status?.contextPercent ?? savedContextPercent;
  const canSend = (text.trim() || pending.length) && !offline && !sending;
  // "!" at the start: the message is a shell command for this chat's folder.
  const shellMode = text.trimStart().startsWith("!");
  return (
    <div
      className={`composer${dragging ? " dragging" : ""}${shellMode ? " shell-mode" : ""}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {pending.length > 0 && (
        <div className="attachments" aria-label="Attached images">
          {pending.map((p) => (
            <span className="attach-chip" key={p.key}>
              <img src={`data:${p.mediaType};base64,${p.data}`} alt="" />
              <span className="ellipsis">{p.name}</span>
              <button type="button" className="remove" aria-label={`Remove ${p.name}`} onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}>
                <Icon name="x" size={10} strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={shellRunning && !id ? "Running the command…" : sending || starting ? "Starting Claude Code…" : placeholder}
        aria-label="Message"
        disabled={sending || starting || (shellRunning && !id)}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          // Esc closes an open panel or menu first; it never also stops Claude.
          if (e.key === "Escape" && (mcpFor || menu)) {
            e.preventDefault();
            setMcpFor(null);
            setMenu(null);
            return;
          }
          if (slashOpen && slashItems.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSlashActive((i) => (i + (e.key === "ArrowDown" ? 1 : slashItems.length - 1)) % slashItems.length);
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
              const c = slashItems[slashActive];
              // Enter on a name already typed in full sends it; otherwise it completes the name.
              if (e.key === "Tab" || c.name !== slashQuery) {
                e.preventDefault();
                pickCommand(c);
                return;
              }
            }
          }
          if (slashOpen && e.key === "Escape") {
            e.preventDefault();
            setSlashClosed(true);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && running && id) void api.chat.stop(id);
          if (e.key === "Escape" && shellRunning && !id) void api.chat.stopShell(key);
        }}
      />
      <div className="composer-controls">
        <IconButton icon="plus" label="Attach an image or file" onClick={() => void pick()} />
        {shellMode ? (
          <span className="shell-hint" role="note">
            <Icon name="terminal" size={14} />
            Shell command
            <span className="sub">{`${SEP}runs in this chat’s folder; Claude sees the output with your next message`}</span>
          </span>
        ) : (
          <>
            <button type="button" className="chip" aria-label="Model" aria-haspopup="menu" aria-expanded={menu?.kind === "model"} onClick={(e) => setMenu({ kind: "model", at: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
              <Icon name="sparkle" size={14} />
              {shownModel}
              <Icon name="chevron-down" size={12} />
            </button>
            <button type="button" className="chip" aria-label={`Permission mode: ${modeInfo.label}`} aria-haspopup="menu" aria-expanded={menu?.kind === "mode"} onClick={(e) => setMenu({ kind: "mode", at: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
              <Icon name={modeInfo.icon} size={14} />
              {modeInfo.label}
              <Icon name="chevron-down" size={12} />
            </button>
          </>
        )}
        {!shellMode && (!modelEfforts || modelEfforts.length > 0) && (
          <button type="button" className="chip" aria-label={`Effort: ${effortInfo?.label ?? "model default"}`} aria-haspopup="menu" aria-expanded={menu?.kind === "effort"} onClick={(e) => setMenu({ kind: "effort", at: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
            <Icon name="gauge" size={14} />
            {effortInfo ? effortInfo.label : "Effort"}
            <Icon name="chevron-down" size={12} />
          </button>
        )}
        <span className="spacer" />
        {offline ? <span className="context">{`Offline${SEP}Send is off until you reconnect`}</span> : contextPercent != null ? <ContextRing percent={contextPercent} /> : null}
        {(running && id) || (shellRunning && !id) ? (
          <button type="button" className="send stop" aria-label="Stop (Esc)" title="Stop (Esc)" onClick={() => void (id ? api.chat.stop(id) : api.chat.stopShell(key))}>
            <Icon name="x-stop-fill" size={16} />
          </button>
        ) : (
          <button type="button" className={`send${canSend ? " ready" : ""}`} aria-label="Send (Enter)" title="Send (Enter)" disabled={!canSend} onClick={() => void send()}>
            <Icon name="arrow-up" size={16} strokeWidth={2} />
          </button>
        )}
      </div>
      {menu?.kind === "model" && (
        <ModelMenu
          models={models}
          value={model ?? status?.model ?? null}
          anchor={menu.at}
          onClose={() => setMenu(null)}
          onPick={(v) => {
            setPrefs(key, { model: v });
            // A live session switches now; otherwise the choice goes with the next message.
            if (id) void api.chat.setModel(id, v);
          }}
        />
      )}
      {slashOpen && <SlashMenu items={slashItems} active={slashActive} onPick={pickCommand} onHover={setSlashActive} />}
      {mcpFor === key && <McpPanel id={id} projectId={projectId ?? null} folder={folder} startWith={{ model, effort, permissionMode: mode ?? defaultMode }} onClose={() => setMcpFor(null)} />}
      {menu?.kind === "effort" && (
        <ChoiceMenu
          items={effortChoices}
          value={effort}
          anchor={menu.at}
          onClose={() => setMenu(null)}
          onPick={(v) => {
            setPrefs(key, { effort: v as Effort });
            // A live session changes now, as /effort does; otherwise it goes with the next message.
            if (id) void api.chat.setEffort(id, v as Effort);
          }}
        />
      )}
      {menu?.kind === "mode" && (
        <ChoiceMenu
          items={MODES}
          value={modeValue}
          anchor={menu.at}
          onClose={() => setMenu(null)}
          onPick={(v) => {
            setPrefs(key, { mode: v as ComposerPrefs["mode"] });
            if (id) void api.chat.setPermissionMode(id, v);
          }}
        />
      )}
    </div>
  );
}

/**
 * "opus" -> the newest Opus seen in any conversation ("claude-opus-5-5"), so the
 * new-chat composer names the model the same way every other one does.
 */
function resolveAlias(model: string | null): string | null {
  if (!model || model.includes("-")) return model;
  const family = model.replace(/\[.*\]$/, "").toLowerCase();
  const rows = useStore.getState().list?.rows ?? [];
  const seen = rows.filter((r) => r.model && r.model.toLowerCase().includes(`-${family}-`)).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return seen[0]?.model ?? model;
}

/** "New chat in a folder…": pick any folder on this PC and start a draft there. */
export async function chooseDraftFolder() {
  const folder = await api.app.pickFolder();
  if (folder) useStore.getState().startDraft(null, folder);
}

/** A new chat: no transcript yet, just where it will run and the composer. */
function Draft({ narrow }: { narrow: boolean }) {
  const draft = useStore((s) => s.draft)!;
  const info = useStore((s) => s.info);
  const select = useStore((s) => s.select);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);

  // The conversation appears in the index a moment after Claude Code creates it.
  useEffect(() => {
    if (!waitingFor) return;
    let tries = 0;
    const check = async () => {
      const d = await api.list.detail(waitingFor);
      if (d) void select(waitingFor);
      else if (tries++ < 60) timer = window.setTimeout(check, 250);
    };
    let timer = window.setTimeout(check, 150);
    return () => window.clearTimeout(timer);
  }, [waitingFor, select]);

  return (
    <section className="detail" aria-label="New chat">
      <div className="detail-toolbar drag">
        <div className="detail-title">
          <span className="t1 ellipsis">New chat</span>
          <span className="t2 ellipsis" title={draft.folder ?? undefined}>
            in {draft.label}
            {SEP}
            {info?.machine ?? "this PC"}
          </span>
        </div>
        <ToolbarButton icon="folder-open" title="Choose the folder this chat runs in" onClick={() => void chooseDraftFolder()}>
          {narrow ? "Folder" : "Change folder"}
        </ToolbarButton>
      </div>
      <div className="empty" style={{ paddingBottom: 140 }}>
        <span className="empty-tile" aria-hidden>
          <Icon name="square-pen" size={16} />
        </span>
        <div className="title">New chat in {draft.label}</div>
        <div className="line">{draft.folder ? `Claude Code runs in ${draft.folder}, with that folder’s CLAUDE.md, tools and MCP servers.` : "Claude Code runs in this project’s folder on this PC, with its CLAUDE.md, tools and MCP servers."}</div>
      </div>
      <div className="composer-wrap">
        {waitingFor ? (
          <div className="activity" role="status">
            <Icon name="x-sparkle-fill" size={14} className="pulse" />
            <span className="label">Starting Claude Code</span>
          </div>
        ) : null}
        <Composer id={null} projectId={draft.projectId} folder={draft.folder ?? null} status={null} disabledReason={!info?.claude.found ? "Chat needs Claude Code on this PC" : null} onSent={(cid) => setWaitingFor(cid)} lastModel={resolveAlias(info?.claude.defaultModel ?? null)} />
      </div>
    </section>
  );
}

export function Detail({ narrow, onBack }: { narrow: boolean; onBack?: () => void }) {
  const detail = useStore((s) => s.detail);
  const draft = useStore((s) => s.draft);
  const toast = useStore((s) => s.toast);
  const openMenu = useStore((s) => s.openMenu);
  const info = useStore((s) => s.info);
  const sent = useStore((s) => (detail ? s.sent[detail.row.id] : undefined));
  const [scroll, setScroll] = useState({ scrolled: false, atBottom: true });
  const [newCount, setNewCount] = useState(0);
  const footer = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(140);
  const status = useChatStatus(detail?.row.id ?? null);
  const scrollEdge = scroll.scrolled;

  useEffect(() => {
    const on = (e: Event) => setNewCount((e as CustomEvent<number>).detail);
    window.addEventListener("app:new-count", on);
    return () => window.removeEventListener("app:new-count", on);
  }, []);
  useEffect(() => {
    const el = footer.current;
    if (!el) return;
    // The last message sits 20 px above the composer (the wrap adds a 24 px fade on top).
    const ro = new ResizeObserver(() => setPad(el.offsetHeight - 24 + 20));
    ro.observe(el);
    return () => ro.disconnect();
  }, [detail?.row.id]);

  if (draft && !detail) return <Draft narrow={narrow} />;
  if (!detail)
    return (
      <section className="detail" aria-label="Conversation">
        <div className="detail-toolbar drag" />
        <div className="empty">
          <div className="title">No conversation selected</div>
          <div className="line">Pick one from the list, or press Ctrl+K.</div>
        </div>
      </section>
    );

  const row = detail.row;
  const openCli = async () => {
    const r = await api.cli.open(row.id);
    toast({ text: r.message, icon: r.ok ? "terminal" : "alert" });
  };
  const chatBlocked = !info?.claude.found ? "Chat needs Claude Code on this PC" : null;
  const running = !!status && BUSY.includes(status.state);
  // "Live on this PC · website · 6 prompts": the same words whether the
  // chat runs in this app or in a terminal here, with "Live" in medium weight.
  const parts = detail.subtitle.split("  ·  ");
  if (running && !parts[0].startsWith("Live")) parts[0] = "Live on this PC";
  const lead = parts[0];
  const rest = parts.slice(1).join(SEP);

  return (
    <section className="detail" aria-label={row.title}>
      <div className={`detail-toolbar drag${onBack ? " with-back" : ""}`}>
        {onBack && <IconButton icon="arrow-left" label="Back (Alt+Left)" onClick={onBack} />}
        <div className="detail-title">
          <span className="t1 ellipsis">
            <span className="title-text">{row.title}</span>
          </span>
          <span className="t2 ellipsis">
            {lead.startsWith("Live") ? (
              <>
                <span className="live-dot" aria-hidden />
                <span className="live-word">Live</span>
                {lead.slice(4)}
              </>
            ) : (
              lead
            )}
            {rest ? `${SEP}${rest}` : ""}
          </span>
        </div>
        {narrow ? (
          <GlassCircle icon="terminal" label="Open in CLI (Ctrl+Shift+O)" onClick={openCli} />
        ) : (
          <ToolbarButton icon="square-terminal" onClick={openCli} title="Open in CLI (Ctrl+Shift+O)">
            Open in CLI
          </ToolbarButton>
        )}
        <GlassCircle
          icon="ellipsis"
          label="More"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(row.id, r.right - 260, r.bottom + 6);
          }}
        />
      </div>
      <div className={`scroll-fade${scroll.scrolled ? " on" : ""}`} />
      <div className={`scroll-edge${scrollEdge ? " on" : ""}`} />
      <Transcript
        id={row.id}
        bottomPad={pad}
        onScrollState={setScroll}
        liveText={status?.streamingText ?? ""}
        sent={sent ?? []}
        running={running}
        tail={status?.permission ? <PermissionCard p={status.permission} /> : null}
        tailKey={status?.permission?.requestId ?? null}
      />
      <div className="composer-wrap" ref={footer}>
        {newCount > 0 && (
          <button type="button" className="glass new-pill" onClick={() => window.dispatchEvent(new Event("app:jump-bottom"))}>
            <Icon name="chevron-down" size={14} />
            {newCount} new{row.lastPc && row.lastPc !== info?.machine ? ` from ${row.lastPc}` : ""}
          </button>
        )}
        {detail.alsoOpenOn && !running && (
          <div className="banner accent">
            <Icon name="git-fork" />
            <div className="text">
              <span className="title">Also open on {detail.alsoOpenOn.pc}, updated just now</span>
              <span className="detail">Sending from this PC starts a branch. Both parts are kept.</span>
            </div>
          </div>
        )}
        {status?.error && status.state === "error" && (
          <div className="notice error">
            <span className="lead">
              <Icon name="triangle-alert" />
            </span>
            <div>
              <div className="title">{status.error.title}</div>
              <div className="body">{status.error.body}</div>
              <div className="actions">
                <Button kind="primary" icon="refresh-cw" onClick={() => void api.chat.send(row.id, "Please continue where you stopped.", {})}>
                  Retry
                </Button>
                <Button icon="square-terminal" onClick={openCli}>
                  Open in CLI
                </Button>
              </div>
            </div>
          </div>
        )}
        {status && <Activity s={status} />}
        <Composer
          id={row.id}
          projectId={row.projectId}
          status={status}
          disabledReason={chatBlocked}
          lastModel={row.model}
          savedContextPercent={detail.contextPercent}
          onNewChatHere={(carry) => {
            const folder = detail.folder ?? null;
            const pid = folder ? null : row.projectId;
            if (carry) useStore.getState().setDraft(composerKey(null, pid, folder), carry);
            useStore.getState().startDraft(pid, folder);
          }}
        />
      </div>
    </section>
  );
}
