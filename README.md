# Conversations

Every Claude Code conversation from all your PCs, in one place and kept in sync.
A Windows app (`_app/`) and the sync engine behind it (`_sync/`), which Claude Code's
hooks also run.

This repository holds **code only**. Your conversations live in a private repository
of your own, one per workspace (for example one per Claude account). Each PC keeps:

- a read-only copy of this repository, in `%LOCALAPPDATA%\conversations-app`, which
  brings the app's and the engine's updates;
- a working copy of its conversations repository, in
  `%LOCALAPPDATA%\claude-conversation-sync\repo` (another workspace:
  `claude-conversation-sync-<id>`).

## Set up a PC

1. Make an empty, private repository on GitHub for the conversations (or use the one
   your other PCs already sync with). The set-up refuses one GitHub says is public.
2. Download `Conversations-Setup.zip` from the latest release
   (https://github.com/Samprogrammer143/conversations-app/releases/latest), unzip it, and
   double-click `Set up Conversations.cmd`. (Or build the same zip yourself:
   `npm run dist:public` in `_app/` puts it in `_app/release-public/`.)

It installs Git, Node and Claude Code when they are missing, copies this repository,
installs Claude's Agent SDK from npm, connects the conversations repository, installs
the app and opens Claude Code to sign in. Every step skips what is already done. On
first start the app asks you to accept the licence and your Claude plan's terms.

Windows may warn that the installer is from an unknown publisher (it isn't signed):
choose More info, then Run anyway.

By hand, with Git and Node installed (PowerShell):

```
git clone https://github.com/Samprogrammer143/conversations-app "$env:LOCALAPPDATA\conversations-app"
node "$env:LOCALAPPDATA\conversations-app\_sync\sync.mjs" app
node "$env:LOCALAPPDATA\conversations-app\_sync\install.mjs" --remote <your conversations repository> --machine "Work Laptop"
```

The chats Claude Code already has on the PC upload to that repository straight away, so
Claude Code's clean-up of chats unused for 30 days can't take them first. Add
`--no-upload-existing` to leave each one until it is next carried on.

## Upgrade a PC that already has it

Nothing to do: the engine keeps its copy of this repository current, and the app loads
a newer version at its next start. A PC set up before the code moved here (when it was
inside the conversations repository) moves over by itself at its next sync. To do it
now:

```
node "$env:LOCALAPPDATA\claude-conversation-sync\repo\_sync\install.mjs"
```

## How updates reach a PC

- The engine (`_sync/engine.mjs`, `refreshApp`) fast-forwards the PC's copy of this
  repository at most every ten minutes, only when it is a clean clone on `main`, to the
  `release` branch: `main` as far as the newest commit every test passed on. GitHub's
  workflow (`.github/workflows/mac.yml`, the `release` job) moves it there once the Mac and
  Windows tests pass, never back, so a push to `main` reaches nobody untested. A copy just
  made from `main` starts at `release`. If `release` is ever gone from GitHub, a copy that
  has followed it waits for it to come back rather than taking `main`. To take a change
  back, revert it on `main`.
- The app's installer brings Electron and a small shell (`_app/src/shell/`). On each
  start the shell runs the newest `_app/dist` that is committed and unmodified in that
  copy, from a private staged copy; otherwise the copy it was installed with.
- Claude's Agent SDK is not part of this repository (its licence doesn't allow
  shipping it here). `_app/runtime/package.json` lists the version the app needs; each
  PC installs it from npm (`ensureRuntime`). The installer `npm run dist` builds brings
  a copy too, so it is for your own PCs only: don't publish it. `npm run dist:public`
  builds one without it, the one to publish.

## Licences

The code in this repository is under the MIT licence (`LICENSE`), except the
third-party parts the app's bundles include (open-source libraries, fonts and icons),
which keep their own licences, listed in `_app/dist/THIRD-PARTY-NOTICES.txt` by the
build. Claude's Agent SDK and Claude Code are Anthropic's: they aren't part of this
repository, and come from Anthropic under Anthropic's terms.

## Develop

See `_app/README.md`. Tests: `npx vitest run` in `_app/`, `node _sync/test.mjs`, and the
end-to-end suites in `_app/test/e2e/` (each file's first lines say how to run it).
Pushing to `main` ships to every PC that uses this repository.
