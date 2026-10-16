# Conversations (Windows app)

Every Claude Code conversation from all your PCs, in one place and always in sync.
You can carry any of them on inside the app, or hand it to the terminal with **Open in CLI**.

This folder is the app; `../_sync` is the sync engine it shares with Claude Code's hooks.
See `../README.md` for how a PC is set up and how updates reach it.

## How it fits together

```
Claude Code (CLI or in-app) ──writes──> ~/.claude/projects/<folder>/<id>.jsonl
        │ hooks (Stop, SessionStart, SessionEnd)
        ▼
  _sync/sync.mjs ──> engine.mjs ──git──> GitHub (your private conversations repo) <──git── other PCs
        ▲
        │ spawned as a child process (Electron's own Node)
Conversations ──reads──> local index (SQLite + full-text) <── worker reads both transcript folders
```

- **One process.** It starts at login as a tray agent (`--hidden`) and keeps the index
  and sync current. The window is a view over the local index, so opening and searching
  never wait for the network. Closing the window keeps the tray agent running.
- **Index** (`src/main/index/`): `parse.ts` turns a transcript into what the window shows.
  It follows the branch Claude Code would show, bridges compaction boundaries and gaps,
  keeps both parts when two PCs continued at once, groups tool calls into plain-language
  chips with diffs, and hides commands, hooks and subagent traffic.
  - `indexer.ts` runs in a worker thread and re-reads only conversations whose files changed.
  - `queries.ts` serves the list, sidebar, detail, pages of items and search, including
    "Did you mean".
  - Typical timings on the Home PC: first index about 1 s for 22 conversations; rescan 6 ms;
    list, open and search 0 to 2 ms.
- **Sync** (`src/main/sync/`): the scheduler checks GitHub with one `ls-remote` every 30 s
  while the window is open and every 5 min from the tray, and downloads (`pull-all`) only
  when it moved. It uploads the app's own edits (pin, rename, archive, delete) and anything
  queued offline. `repo-read.ts` reads the working copy directly, with the engine's rules
  (tested against the engine).
- **Chat** (`src/main/chat/`): Claude Code through the Claude Agent SDK, using the
  `claude.exe` installed on the PC and its own login. The SDK is never bundled into
  `dist/` (its licence doesn't allow that in a public repository): `chat/sdk.ts` loads it
  from the PC (see `runtime/`), and the build fails if it ever ends up in the bundle. One session per conversation, in
  streaming-input mode, so follow-ups queue and Stop, model and permission mode apply live.
  - Permissions arrive through `canUseTool` and show as cards. Destructive commands open on
    **Deny** and never offer "Always allow".
  - With no window open, the request is pinned in the tray flyout, the tray icon gets a badge,
    and one Windows notification offers Review and Deny.
  - The app never writes while a terminal on this PC has the conversation open, and it
    fetches the newest copy before resuming.
- **Open in CLI** (`src/main/cli.ts`): brings the newest copy into the project's folder,
  ends the app's own session, then runs `wt -d <folder> claude --resume <id>`.
- **Window** (`src/renderer/`): React. The design tokens in `styles/tokens.css` are
  transcribed from the Figma variables and text styles. Mica sits behind the sidebar; the
  native caption buttons and Snap layouts come from `titleBarOverlay`.

## Updates ship through the app's repository

The installer brings Electron and a small shell (`src/shell/shell.ts`, `choose.ts`). On
each start the shell looks at `_app/dist` in this PC's copy of the app's repository
(`%LOCALAPPDATA%\conversations-app`). If that is a newer version, committed and
unmodified, the shell copies it to `%LOCALAPPDATA%\Conversations\app\<version>-<tree>`
and runs it. Otherwise it runs the copy it was installed with. A reinstall is only needed
when `app.json`'s `minShell` rises.

Installs from before the move (shell 1) still look in the conversations repository: there
they find `src/shell/forwarder.ts` (built into `dist-forwarder/`), which runs the app
from the app's repository instead.

## Data and privacy

- **Index, settings, logs:** `%LOCALAPPDATA%\Conversations`. Outside OneDrive and the repo.
- **Sync working copy:** `%LOCALAPPDATA%\claude-conversation-sync`. This is the engine's;
  the app never writes there except through the engine.
- **The app's code:** `%LOCALAPPDATA%\conversations-app` (read-only copy of this repository)
  and `%LOCALAPPDATA%\conversations-app-runtime` (Claude's Agent SDK, from npm).
- **No credentials** are stored by the app: git uses Git Credential Manager, and chat uses
  Claude Code's own login.
- **The window is sandboxed** (`contextIsolation`, no Node). Raw HTML in transcripts is shown
  as text, and links open in the browser.

## Develop

```
npm install
node scripts/dev-sandbox.mjs        # once: a private copy of the sync repo + separate app data
node scripts/build.mjs              # dist/ (app code) and dist-shell/ (installer shell)
npx tsc -p tsconfig.json --noEmit   # type check
npx vitest run                      # parser and index tests (includes a smoke test on real transcripts)
node scripts/shot.mjs <dir> [--dark] [--width 960]      # screenshots in the sandbox
node test/e2e/screens.e2e.mjs <dir>                     # every screen, for comparing with Figma
node test/e2e/chat.e2e.mjs <scratch dir> <shots dir>    # a real chat on the smallest model
npm run dist                        # release/Conversations Setup <version>.exe (per user, no admin)
```

The sandbox (`%LOCALAPPDATA%\Conversations-dev`) points the app at a local mirror of the sync
repository, so development never pushes anything to GitHub. The engine tests live in
`../_sync/test.mjs` (`node ../_sync/test.mjs`), and the app repository's own set-up, updates
and the move from the old layout in `../_sync/test-app.mjs`.

Chats started from the sandbox (the chat test, or by hand) still run on this PC's real
Claude Code, because it needs its own login and the sandbox never copies credentials. Their
transcripts therefore land in `~/.claude/projects`. Two things keep them out of the real sync:

- The sandbox environment sets `CLAUDE_SYNC_DISABLE=1`, so Claude Code's sync hooks skip those
  chats and never upload them.
- After a run, the chat test moves the project folders of conversations that ran in its scratch
  folder into `Conversations-dev\e2e-transcripts`. By hand:
  `node scripts/dev-sandbox.mjs --collect-e2e <scratch folder>`. Only a folder whose name contains
  "e2e" is accepted.

Unit tests (`npx vitest run`) never start Claude Code or write to `~/.claude` (the index smoke
test only reads real transcripts). Chat sessions, the session registry, the installer shell's
checks and the sandbox clean-up all run on stand-ins and temporary folders.
