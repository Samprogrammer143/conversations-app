// A chat's agents: a thin bar on the message box while any are running or have just ended,
// and the panel it opens beside the chat, with what each one is doing and what it found.

import { useEffect, useRef, useState } from "react";
import type { AgentDetail, AgentRun, AgentStep } from "../../shared/types";
import { Icon, ToolIcon } from "../components/Icon";
import { Button, IconButton, Spinner } from "../components/controls";
import { Markdown } from "../components/Markdown";
import { agentBarText, agentCounts, agentTime, endedWord, orderAgents } from "../lib/agents";
import { api } from "../lib/api";
import { SEP, plural } from "../lib/format";
import { useStore } from "../lib/store";

/** The steps shown until you ask for the earlier ones. */
const RECENT_STEPS = 15;
const READ_EVERY_MS = 1500;

/** Keeps the times moving while something runs. */
function useTicking(on: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [on]);
}

function Glyph({ status, size = 14 }: { status: AgentRun["status"]; size?: number }) {
  if (status === "running") return <Spinner size={size} />;
  if (status === "finished") return <Icon name="circle-check" size={size} className="agent-ok" />;
  return <Icon name="triangle-alert" size={size} className="agent-warn" />;
}

export function AgentBar({ agents, onOpen, onDismiss }: { agents: AgentRun[]; onOpen: () => void; onDismiss: () => void }) {
  const seen = useStore((s) => s.seenAgents);
  useTicking(agents.some((a) => a.status === "running"));
  const bar = agentBarText(agents, seen, Date.now());
  if (!bar) return null;
  return (
    <div className="agent-bar">
      <button type="button" className="agent-bar-open" aria-label={`See agents: ${bar.title}. ${bar.line}`} onClick={onOpen}>
        <Glyph status={bar.kind === "running" ? "running" : bar.kind === "finished" ? "finished" : "stopped"} />
        <span className="name ellipsis">{bar.title}</span>
        <span className="line ellipsis">{bar.line}</span>
        {bar.time && <span className="when">{bar.time}</span>}
        <Icon name="chevron-right" size={12} className="chev" />
      </button>
      {bar.kind !== "running" && (
        <button type="button" className="agent-bar-close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

function Step({ s, live }: { s: AgentStep; live: boolean }) {
  const working = live && s.pending;
  return (
    <div className={`agent-step${s.error ? " error" : ""}`}>
      {working ? <Spinner size={14} /> : <ToolIcon kind={s.kind} />}
      <span className="verb">{working ? s.verbNow : s.verb}</span>
      <span className="what ellipsis" title={s.what}>
        {s.what}
      </span>
      <span className="took">{working ? "now" : s.seconds !== null ? `${s.seconds} s` : ""}</span>
    </div>
  );
}

function AgentView({ conversationId, a, onClose }: { conversationId: string; a: AgentRun; onClose?: () => void }) {
  const toast = useStore((s) => s.toast);
  const running = a.status === "running";
  const [data, setData] = useState<AgentDetail | null>(null);
  const [looked, setLooked] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const [stopping, setStopping] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useTicking(running);

  useEffect(() => {
    let alive = true;
    let reading = false;
    const read = () => {
      if (reading) return; // the last read isn't back yet
      reading = true;
      void api.chat
        .agent(conversationId, a.id)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setLooked(true);
        })
        .catch(() => {})
        .finally(() => (reading = false));
    };
    read();
    // Ended: read once more, for what reached its log last.
    const t = running ? setInterval(read, READ_EVERY_MS) : setTimeout(read, READ_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [conversationId, a.id, running]);

  // The newest step stays in view, unless you've scrolled up to read.
  useEffect(() => {
    const el = body.current;
    if (el && running && following.current) el.scrollTop = el.scrollHeight;
  }, [data, running]);

  // A stop that never lands gives the button back.
  useEffect(() => {
    if (!stopping) return;
    const t = setTimeout(() => setStopping(false), 20_000);
    return () => clearTimeout(t);
  }, [stopping]);

  const stop = async () => {
    setStopping(true);
    const ok = await api.chat.stopAgent(conversationId, a.id).catch(() => false);
    if (!ok) {
      setStopping(false);
      toast({ text: "That agent couldn't be stopped", icon: "alert" });
    }
  };

  const report = running ? null : (data?.report ?? null);
  const steps = data?.steps ?? [];
  const shown = allSteps || (!running && stepsOpen) ? steps : steps.slice(-RECENT_STEPS);
  // Counted from its log once read (Claude Code's own count includes its housekeeping).
  const total = data ? data.total : a.steps;
  const earlier = (data?.total ?? 0) - shown.length;
  const showSteps = running || stepsOpen;
  const stats = [running ? null : endedWord(a).split(":")[0], total ? plural(total, "step") : null, agentTime((a.endedAt ?? Date.now()) - a.startedAt)].filter(Boolean).join(SEP);
  const line = running ? a.line : a.status === "failed" ? a.line : null;

  return (
    <>
      <div className="agent-head">
        {onClose && <Glyph status={a.status} size={16} />}
        <div className="agent-names">
          <div className="name">{a.description}</div>
          <div className="stats">{stats}</div>
        </div>
        {running && (
          <Button icon="circle-stop" disabled={stopping} onClick={() => void stop()}>
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
        {report && (
          <IconButton
            icon="copy"
            label="Copy the report"
            onClick={() => {
              void api.app.copyText(report);
              toast({ text: "Copied", icon: "check" });
            }}
          />
        )}
        {onClose && <IconButton icon="x" label="Close (Esc)" onClick={onClose} />}
      </div>
      <div
        className="agent-body scroll"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {line && <div className="agent-line selectable">{line}</div>}
        <div className="agent-chips">
          {!running && steps.length > 0 && (
            <button type="button" className="chip" aria-expanded={stepsOpen} onClick={() => setStepsOpen(!stepsOpen)}>
              <Icon name="terminal" size={14} />
              {plural(total, "step")}
              <Icon name={stepsOpen ? "chevron-up" : "chevron-down"} size={12} />
            </button>
          )}
          {data?.brief && (
            <button type="button" className="chip" aria-expanded={briefOpen} onClick={() => setBriefOpen(!briefOpen)}>
              <Icon name="file-text" size={14} />
              The brief Claude gave it
              <Icon name={briefOpen ? "chevron-up" : "chevron-down"} size={12} />
            </button>
          )}
        </div>
        {briefOpen && data?.brief && <div className="agent-brief selectable">{data.brief}</div>}
        {showSteps && (
          <div className="agent-steps">
            {earlier > 0 &&
              (steps.length > shown.length ? (
                <button type="button" className="agent-earlier" onClick={() => setAllSteps(true)}>
                  <Icon name="chevron-up" size={12} />
                  {plural(earlier, "earlier step")}
                </button>
              ) : (
                <div className="agent-earlier">{plural(earlier, "earlier step")}</div>
              ))}
            {shown.map((s) => (
              <Step key={s.id} s={s} live={running} />
            ))}
            {running && !steps.length && <div className="agent-earlier">Starting…</div>}
          </div>
        )}
        {report && (
          <div
            className="agent-report selectable"
            onClick={(e) => {
              // A code block's own Copy button, as in the chat.
              const btn = (e.target as HTMLElement).closest("[data-copy]");
              if (!btn) return;
              void api.app.copyText(btn.closest(".code-block")?.querySelector("code")?.textContent ?? "");
              toast({ text: "Copied", icon: "check" });
            }}
          >
            <Markdown text={report} />
          </div>
        )}
        {!running && !report && looked && <div className="agent-line quiet">{a.status === "finished" ? "It finished without writing a report." : "It ended before writing a report."}</div>}
      </div>
    </>
  );
}

export function AgentPanel({ conversationId, agents, selected, onSelect, onClose }: { conversationId: string; agents: AgentRun[]; selected: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const list = orderAgents(agents);
  const current = list.find((a) => a.id === selected) ?? list[0] ?? null;
  const root = useRef<HTMLElement>(null);
  useTicking(agents.some((a) => a.status === "running"));
  // Esc closes it from here; in the message box, Esc still belongs to Claude.
  useEffect(() => {
    root.current?.focus();
  }, []);
  return (
    <aside
      className="agent-panel"
      aria-label="Agents"
      tabIndex={-1}
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {list.length > 1 && (
        <>
          <div className="agent-panel-head">
            <span className="title">Agents</span>
            <span className="counts ellipsis">{agentCounts(list)}</span>
            <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
          </div>
          <div className="agent-rows scroll">
            {list.map((a) => (
              <button key={a.id} type="button" className={`agent-row${a.id === current?.id ? " selected" : ""}`} aria-current={a.id === current?.id} onClick={() => onSelect(a.id)}>
                <Glyph status={a.status} size={16} />
                <span className="text">
                  <span className="name ellipsis">{a.description}</span>
                  <span className="sub ellipsis">{a.status === "running" ? (a.line ?? "Starting") : endedWord(a)}</span>
                </span>
                <span className="when">{agentTime((a.endedAt ?? Date.now()) - a.startedAt)}</span>
              </button>
            ))}
          </div>
          <div className="agent-divider" />
        </>
      )}
      {current && <AgentView key={current.id} conversationId={conversationId} a={current} onClose={list.length > 1 ? undefined : onClose} />}
    </aside>
  );
}
