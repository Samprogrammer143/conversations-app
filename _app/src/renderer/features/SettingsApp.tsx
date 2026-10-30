import { useEffect, useState, type ReactNode } from "react";
import type { AppInfo, Settings, SidebarData, SyncStatus } from "../../shared/types";
import { Icon } from "../components/Icon";
import { Button, Segmented, Toggle } from "../components/controls";
import { api } from "../lib/api";
import { bytes, plural } from "../lib/format";

type Section = "general" | "appearance" | "sync" | "folders" | "claude" | "shortcuts";
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "appearance", label: "Appearance", icon: "sun-moon" },
  { id: "sync", label: "Sync", icon: "refresh-cw" },
  { id: "folders", label: "Folders", icon: "folder" },
  { id: "claude", label: "Claude Code", icon: "square-terminal" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
];

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="s-group">
      {title && <div className="s-group-title">{title}</div>}
      <div className="s-card">{children}</div>
    </section>
  );
}

function Row({ label, detail, children }: { label: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="s-row">
      <div className="s-text">
        <div className="s-label">{label}</div>
        {detail && <div className="s-detail">{detail}</div>}
      </div>
      {children}
    </div>
  );
}

function Value({ children, chevron = "right", title }: { children: ReactNode; chevron?: "right" | "down" | null; title?: string }) {
  return (
    <span className="s-value" title={title}>
      <span>{children}</span>
      {chevron && <Icon name={chevron === "right" ? "chevron-right" : "chevron-down"} size={12} />}
    </span>
  );
}

/** A row that opens to explain itself: the chevron turns down while it is open. */
function Disclosure({ label, value, detail, children }: { label: string; value: ReactNode; detail?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="s-row s-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div className="s-text">
          <div className="s-label">{label}</div>
          {detail && <div className="s-detail">{detail}</div>}
        </div>
        <Value chevron={open ? "down" : "right"}>{value}</Value>
      </button>
      {open && <div className="s-row s-more">{children}</div>}
    </>
  );
}

/** "you/work-conversations" or a local path -> "work-conversations". */
const repoName = (repo: string | null) => (repo ? repo.split(/[\\/]/).filter(Boolean).pop()!.replace(/\.git$/, "") : null);

function MachineName({ name }: { name: string }) {
  return (
    <Disclosure label="Name" value={name}>
      <div className="s-text">
        <div className="s-detail">Set when sync was installed on this PC. Every PC labels its conversations and its sync status with this name, so it stays the same once chosen.</div>
      </div>
    </Disclosure>
  );
}

export function SettingsApp() {
  const initial = (location.hash.split("/")[2] as Section) || "general";
  const [section, setSection] = useState<Section>(SECTIONS.some((s) => s.id === initial) ? initial : "general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [sidebar, setSidebar] = useState<SidebarData | null>(null);

  useEffect(() => {
    void api.settings.get().then(setSettings);
    void api.app.info().then(setInfo);
    void api.sync.status().then(setSync);
    void api.list.sidebar().then(setSidebar);
    const a = api.on("settings-changed", setSettings);
    const b = api.on("sync-status", setSync);
    return () => {
      a();
      b();
    };
  }, []);

  const set = (patch: Partial<Settings>) => void api.settings.set(patch).then(setSettings);
  if (!settings || !info) return <div className="settings" />;
  const mapped = sidebar?.projects.filter((p) => p.folder || settings.folders[p.id]).length ?? Object.keys(settings.folders).length;

  return (
    <div className="settings">
      <nav className="s-nav" aria-label="Settings sections">
        <div className="s-nav-title drag">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="sb-item" aria-current={section === s.id} onClick={() => setSection(s.id)}>
            <Icon name={s.icon} className="lead-glyph" />
            <span className="sb-label">{s.label}</span>
          </button>
        ))}
      </nav>
      <main className="s-main scroll">
        <header className="s-head drag">{SECTIONS.find((s) => s.id === section)?.label}</header>
        <div className="s-body">
          {section === "general" && (
            <>
              <Group>
                <Row label="Start at login" detail="Keeps sync running in the notification area, so the window opens instantly.">
                  <Toggle label="Start at login" checked={settings.startAtLogin} onChange={(v) => set({ startAtLogin: v })} />
                </Row>
                <Row label="Show archived conversations" detail="Archived conversations stay synced; they are only hidden from the list.">
                  <Toggle label="Show archived conversations" checked={settings.showArchived} onChange={(v) => set({ showArchived: v })} />
                </Row>
              </Group>
              <Group title="This PC">
                <MachineName name={info.machine} />
                <Row label="Version">
                  <Value chevron={null}>Conversations {info.version}</Value>
                </Row>
              </Group>
            </>
          )}
          {section === "appearance" && (
            <Group>
              <Row label="Appearance">
                <Segmented label="Appearance" value={settings.theme} onChange={(v) => set({ theme: v })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
              </Row>
              <Row label="Sidebar material" detail="Mica lets the desktop colour show through the sidebar. Takes effect next time the window opens.">
                <Segmented label="Sidebar material" value={settings.windowMaterial} onChange={(v) => set({ windowMaterial: v })} options={[{ value: "mica", label: "Mica" }, { value: "solid", label: "Solid" }]} />
              </Row>
            </Group>
          )}
          {section === "sync" && (
            <>
              <Group>
                <Row label="Sync automatically" detail={`Checks GitHub every ${settings.checkWhileOpenSeconds} s while the window is open and every ${Math.round(settings.checkFromTraySeconds / 60)} min from the tray.`}>
                  <Toggle label="Sync automatically" checked={settings.syncAutomatically} onChange={(v) => void api.sync.setPaused(!v)} />
                </Row>
                <Row label="Upload after a reply">
                  {sync?.uploadQuietSeconds != null ? (
                    <span className="s-value s-select">
                      <select
                        aria-label="Upload after a reply"
                        value={sync.uploadQuietSeconds}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          // On failure the list snaps back to what the engine reports.
                          void api.sync.setUploadQuiet(v).then((r) => {
                            if (!r.ok) void api.sync.status().then(setSync);
                          });
                        }}
                      >
                        <option value={60}>After 1 minute of quiet</option>
                        <option value={120}>After 2 minutes of quiet</option>
                        <option value={300}>After 5 minutes of quiet</option>
                      </select>
                      <Icon name="chevron-down" size={12} />
                    </span>
                  ) : (
                    <Value chevron={null}>After 2 minutes of quiet</Value>
                  )}
                </Row>
                <Row label="Keep Claude Code’s /resume up to date" detail="Writes downloaded conversations into each project folder on this PC.">
                  <Toggle label="Keep Claude Code’s /resume up to date" checked={settings.keepResumeUpToDate} onChange={(v) => set({ keepResumeUpToDate: v })} />
                </Row>
              </Group>
              <Group title="This PC">
                <MachineName name={info.machine} />
                <button type="button" className="s-row s-link" onClick={() => setSection("folders")}>
                  <div className="s-text">
                    <div className="s-label">Project folders</div>
                  </div>
                  <Value>{mapped} mapped</Value>
                </button>
              </Group>
              <Group title="Repository">
                <button type="button" className="s-row s-link" title={sync?.repoWebUrl ?? undefined} onClick={() => sync?.repoWebUrl && void api.app.openExternal(sync.repoWebUrl)}>
                  <div className="s-text">
                    <div className="s-label">GitHub repository</div>
                  </div>
                  <Value title={info.repo ?? undefined} chevron={sync?.repoWebUrl ? "right" : null}>
                    {info.repo ? `${repoName(info.repo)} (private)` : "Not set up"}
                  </Value>
                </button>
                <Disclosure label="Storage" detail="Optimising uploads only the new part of each conversation." value={bytes(sync?.repoSizeBytes ?? null) || "…"}>
                  <div className="s-text">
                    <div className="s-detail">
                      The repository keeps every version of every conversation, so it grows with each upload. Optimising starts a fresh history that stores conversations in parts and keeps the old history on an archive branch. It becomes available once every PC runs the new sync.
                    </div>
                  </div>
                </Disclosure>
              </Group>
              <div className="s-actions">
                <Button disabled title="Available once every PC runs the new sync">
                  Optimise storage…
                </Button>
                <Button kind="plain" onClick={() => void api.sync.openLog()}>
                  Open sync log
                </Button>
              </div>
            </>
          )}
          {section === "folders" && (
            <Group title="Where each project lives on this PC">
              {(sidebar?.projects ?? []).map((p) => (
                <Row key={p.id} label={p.label} detail={settings.folders[p.id] ?? p.folder ?? "Not on this PC yet. Open in CLI asks for the folder once."}>
                  <Value chevron={null}>{plural(p.count, "conversation")}</Value>
                </Row>
              ))}
            </Group>
          )}
          {section === "claude" && (
            <Group>
              <Row label="Claude Code" detail={info.claude.path ?? "Install it with npm install -g @anthropic-ai/claude-code"}>
                <Value chevron={null}>{info.claude.found ? `Version ${info.claude.version ?? "?"}` : "Not found"}</Value>
              </Row>
              <Row label="Signed in" detail="Chats in the app use your own Claude Code login on this PC.">
                <Value chevron={null}>{info.claude.signedIn ? "Yes" : info.claude.signedIn === false ? "No" : "Unknown"}</Value>
              </Row>
              <Row label="Ask before tools run" detail="New chats start in this mode. Bypassing permissions is not offered.">
                <Segmented
                  label="Default permission mode"
                  value={settings.defaultPermissionMode}
                  onChange={(v) => set({ defaultPermissionMode: v })}
                  options={[
                    { value: "default", label: "Ask first" },
                    { value: "acceptEdits", label: "Accept edits" },
                    { value: "auto", label: "Auto" },
                    { value: "plan", label: "Plan" },
                  ]}
                />
              </Row>
              <Row label="Windows Terminal" detail="Open in CLI uses it; without it, a command prompt opens instead.">
                <Value chevron={null}>{info.windowsTerminal ? "Found" : "Not found"}</Value>
              </Row>
            </Group>
          )}
          {section === "shortcuts" && (
            <Group>
              {[
                ["Search", "Ctrl+K"],
                ["New chat", "Ctrl+N"],
                ["Show or hide the sidebar", "Ctrl+B"],
                ["Focus mode: only the chat and usage", "Ctrl+F"],
                ["Switch model (in the message box)", "Up, Down"],
                ["Switch model (any time)", "Ctrl+M"],
                ["All · Updated · Live", "Ctrl+1 2 3"],
                ["Pin", "Ctrl+D"],
                ["Archive", "Ctrl+E"],
                ["Rename", "F2"],
                ["Copy the resume command", "Ctrl+Shift+C"],
                ["Delete from all PCs", "Del"],
                ["Open in CLI", "Ctrl+Shift+O"],
                ["Sync now", "Ctrl+Shift+S"],
                ["Settings", "Ctrl+,"],
                ["Show every shortcut", "Hold Ctrl"],
              ].map(([l, k]) => (
                <Row key={l} label={l}>
                  <span className="kbd">{k}</span>
                </Row>
              ))}
            </Group>
          )}
        </div>
      </main>
    </div>
  );
}
