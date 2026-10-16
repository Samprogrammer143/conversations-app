# Conversations

Every Claude Code conversation from all your PCs, in one place and always in sync.
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
   your other PCs already sync with).
2. Put `setup/Set up Conversations.cmd`, `setup/setup.ps1` and the app's installer
   (`Conversations Setup x.y.z.exe`, built with `npm run dist` in `_app/`) in one folder
   on the PC, and double-click `Set up Conversations.cmd`.

It installs Git, Node and Claude Code when they are missing, copies this repository,
installs Claude's Agent SDK from npm, connects the conversations repository, installs
the app and opens Claude Code to sign in. Every step skips what is already done.

By hand, with Git and Node installed (PowerShell):

```
git clone https://github.com/Samprogrammer143/conversations-app "$env:LOCALAPPDATA\conversations-app"
node "$env:LOCALAPPDATA\conversations-app\_sync\sync.mjs" app
node "$env:LOCALAPPDATA\conversations-app\_sync\install.mjs" --remote <your conversations repository> --machine "Work Laptop"
```

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
  repository at most every ten minutes, only when it is a clean clone on `main`.
- The app's installer brings Electron and a small shell (`_app/src/shell/`). On each
  start the shell runs the newest `_app/dist` that is committed and unmodified in that
  copy, from a private staged copy; otherwise the copy it was installed with.
- Claude's Agent SDK is not part of this repository (its licence doesn't allow
  shipping it here). `_app/runtime/package.json` lists the version the app needs; each
  PC installs it from npm (`ensureRuntime`), and the installer brings a copy too. So
  the installer you build is for your own PCs: don't publish it.

## Licences

The app's bundles include open-source libraries, fonts and icons; their licences are
in `_app/dist/THIRD-PARTY-NOTICES.txt`, written by the build.

## Develop

See `_app/README.md`. Tests: `npx vitest run` in `_app/`, `node _sync/test.mjs`, and the
end-to-end suites in `_app/test/e2e/` (each file's first lines say how to run it).
Pushing to `main` ships to every PC that uses this repository.
