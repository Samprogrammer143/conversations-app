// The phone's own pieces inside the window (Figma: Mobile (for review) › M3, M4, M7).
import { useState } from "react";
import { Icon } from "../renderer/components/Icon";
import type { ListHeaderProps } from "../renderer/lib/slots";
import { usePhone } from "./state";

const pcIcon = (name: string) => (/laptop|macbook/i.test(name) ? "laptop" : "monitor");

/** M3: the workspace, a chip per PC (on or off), and New chat. */
export function PhoneListHeader({ onNewChat }: ListHeaderProps) {
  const { session, state } = usePhone();
  return (
    <div className="phone-list-header">
      <div className="phone-appbar">
        <button className="ws-switch" onClick={() => window.dispatchEvent(new Event("app:toggle-sidebar"))} aria-label="Workspaces and projects">
          <span>{session?.ws.name ?? "Conversations"}</span>
          <Icon name="chevron-down" size={20} />
        </button>
      </div>
      <div className="pc-strip" role="list" aria-label="Your PCs">
        {state?.pcs.map((p) => (
          <span key={p.device} role="listitem" className={`pc-chip${p.online ? " on" : ""}`} title={p.online ? `${p.name} is on` : `${p.name} is off`}>
            <span className="dot" />
            {p.name}
          </span>
        ))}
        {state && state.link !== "open" && <span className="pc-chip warn">{state.link === "connecting" ? "Connecting…" : "Offline"}</span>}
      </div>
      {state && state.link === "open" && !state.pcs.some((p) => p.online) && (
        <div className="phone-banner">
          <Icon name="cloud-off" size={18} />
          <div>
            <b>All your PCs are off</b>
            <span>Turn one on to carry on a chat.</span>
          </div>
        </div>
      )}
      <button className="phone-fab" onClick={onNewChat}>
        <Icon name="square-pen" size={20} />
        New chat
      </button>
    </div>
  );
}

/** M4/M7: which PC a message goes to; tap to pick another that's on. */
export function SendsTo() {
  const { session, state } = usePhone();
  const [open, setOpen] = useState(false);
  if (!state || !session) return null;
  const cur = state.pcs.find((p) => p.device === state.current);
  return (
    <>
      <button type="button" className={`chip sends-to${cur ? "" : " off"}`} onClick={() => setOpen(true)} aria-label="Sends to">
        <Icon name={pcIcon(cur?.name ?? "")} size={14} />
        <span>{cur ? cur.name : "No PC on"}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="phone-sheet-scrim" onClick={() => setOpen(false)}>
          <div className="phone-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Send to">
            <div className="handle" />
            <h2>Send to</h2>
            <p>Messages go to this PC. Pick another one that's on to carry on there.</p>
            {state.pcs.map((p) => (
              <button
                key={p.device}
                className={`sheet-row${p.device === state.current ? " selected" : ""}`}
                disabled={!p.online}
                onClick={() => {
                  session.usePc(p.device);
                  setOpen(false);
                }}
              >
                <Icon name={pcIcon(p.name)} size={22} />
                <span className="text">
                  <span className="name">{p.name}</span>
                  <span className="detail">
                    <span className={`dot${p.online ? " on" : ""}`} />
                    {p.online ? "On" : "Off"}
                  </span>
                </span>
                {p.device === state.current && <Icon name="check" size={20} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
