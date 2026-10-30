// Open in CLI: hand a conversation from the app to Claude Code in a terminal so
// that exactly one writer remains, in the folder where --resume finds it.
//
// 1. A Claude Code terminal on this PC already has it open: say so, bring that
//    window forward, and start nothing.
// 2. The app stops its own session for it (and any start of one still in
//    flight), and waits until that Claude Code process has exited.
// 3. The newest copy is brought down. If the download finds the conversation in
//    use, that is respected: only a write by this app itself (just stopped) is not
//    a reason to stop.
// 4. Claude Code starts in the folder that maps to the transcript.
//
// Everything that touches the PC comes in through HandoverDeps, so the rules
// above are tested without starting anything.

export const OPEN_ON_THIS_PC = "It's open in Claude Code on this PC — switch to that window.";
export const WRITTEN_JUST_NOW = "It was written to on this PC in the last two minutes. If Claude Code has it open, switch to that window; otherwise try again in a moment.";
export const NOT_HERE = "That conversation isn't on this PC yet, and it couldn't be downloaded.";
export const NO_FOLDER = "This chat couldn't be moved to that folder. It may not have finished uploading from the other PC: try again in a few minutes.";
export const NEEDS_FOLDER = "This chat needs a folder to work in on this PC.";
export const CONTINUING = "Continuing in Windows Terminal";

/** What a pull of one conversation said. live: the engine left it alone because it is in use on this PC. */
export interface PullOutcome {
  ok: boolean;
  live?: boolean;
  /** The transcript on this PC after the pull. */
  dest?: string | null;
  err?: string | null;
}

export interface HandoverDeps {
  /** Claude Code terminals on this PC with it open; null when Claude Code keeps no registry. */
  terminals(id: string): Promise<{ pid: number }[] | null>;
  /** Any Claude Code process on this PC with it open (terminals, SDK runs); null when there is no registry. */
  processes(id: string): Promise<{ pid: number }[] | null>;
  /** Ends the app's own session for it, and any start of one that is in flight. */
  stopAppSession(id: string): Promise<void>;
  /** Brings the newest copy into cwd's Claude Code folder; null when this PC's sync engine can't (version 2). */
  pull(id: string, cwd: string): Promise<PullOutcome | null>;
  /** The folder you choose for a chat kept under one this PC doesn't use (null: you cancelled). */
  chooseFolder?(): Promise<string | null>;
  /** Moves this PC's copy to cwd's Claude Code folder. Only ever for a folder you chose. */
  pullInto?(id: string, cwd: string): Promise<PullOutcome | null>;
  localTranscript(id: string): string | null;
  /** When the app's own session last wrote it, or stopped (0 if never). */
  appLastWriteAt(id: string): number;
  mtimeOf(file: string): number | null;
  folderFor(transcript: string, candidates: (string | null)[]): string | null;
  launch(folder: string, id: string): void;
  focus(pid: number): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface HandoverResult {
  ok: boolean;
  message: string;
  folder?: string;
}

/** How long to wait for the app's own Claude Code process to exit after its session is stopped. */
const EXIT_WAIT_MS = 5000;
/** A write this long after the app's own last write isn't the app's. */
const OWN_WRITE_SLACK_MS = 15_000;

export async function handOver(id: string, where: { projectFolder: string | null; recordedCwd: string | null }, deps: HandoverDeps): Promise<HandoverResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const refuse = (procs: { pid: number }[]): HandoverResult => {
    deps.focus(procs[0].pid);
    return { ok: false, message: OPEN_ON_THIS_PC };
  };

  // 1. Already open in a terminal here: never a second one.
  const open = await deps.terminals(id);
  if (open?.length) return refuse(open);

  // 2. The app stops writing, and its Claude Code process is gone before anything else.
  await deps.stopAppSession(id);
  for (const t0 = now(); ; ) {
    const procs = await deps.processes(id);
    if (!procs?.length) break;
    if (now() - t0 >= EXIT_WAIT_MS) return refuse(procs);
    await sleep(150);
  }

  // 3. The newest copy, brought in where the conversation itself ran when that is on this PC.
  const preferred = where.recordedCwd ?? where.projectFolder;
  const pulled = preferred ? await deps.pull(id, preferred) : null;
  if (pulled?.live) {
    const procs = await deps.processes(id);
    if (procs?.length) return refuse(procs);
    // Nothing has it open; it was only written to in the last two minutes. That is
    // fine when the writer was this app, which has just stopped.
    const local = deps.localTranscript(id);
    const mtime = local ? deps.mtimeOf(local) : null;
    const ours = deps.appLastWriteAt(id);
    if (!(ours > 0 && mtime !== null && mtime <= ours + OWN_WRITE_SLACK_MS)) return { ok: false, message: WRITTEN_JUST_NOW };
  }
  const transcript = (pulled?.ok ? pulled.dest : null) ?? deps.localTranscript(id);
  if (!transcript) return { ok: false, message: pulled && !pulled.ok && !pulled.live && pulled.err ? `Couldn't bring it to this PC: ${pulled.err}` : NOT_HERE };

  // 4. Started where --resume finds it.
  let folder = deps.folderFor(transcript, [where.recordedCwd, where.projectFolder]);
  if (!folder && deps.chooseFolder && deps.pullInto) {
    const chosen = await deps.chooseFolder();
    if (!chosen) return { ok: false, message: NEEDS_FOLDER };
    const moved = await deps.pullInto(id, chosen);
    if (moved?.ok && moved.dest) folder = deps.folderFor(moved.dest, [chosen]);
  }
  if (!folder) return { ok: false, message: NO_FOLDER };
  deps.launch(folder, id);
  return { ok: true, message: CONTINUING, folder };
}
