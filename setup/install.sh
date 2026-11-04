#!/bin/bash
# Sets up Conversations on a Mac: the tools it needs, the app, the app's own repository
# (code, public), and this Mac's conversations repository (yours, private).
# Safe to run again: every step skips what is already done.
#
#   curl -fsSL https://conversations.tidewaystudios.com/install.sh | bash
#
# Read it first if you like: https://github.com/Samprogrammer143/conversations-app/blob/release/setup/install.sh
# To only see what it would do:  bash install.sh --check
#
# The app isn't signed with a paid Apple account. Installed from Terminal it isn't held back
# by macOS (that check is for downloads from a browser); this script gives it a local
# signature of its own.

set -uo pipefail

# Everything is in functions, run at the very end: a download cut short runs nothing.
main() {
  # (The app's tests check, on GitHub's Macs, that GitHub's sign-in tool can be downloaded:
  # this prints its address for the Mac it runs on, and nothing else runs.)
  if [ "${CONVERSATIONS_PRINT_GH_URL:-}" = 1 ]; then gh_asset_url; exit; fi
  CHECK=0
  [ "${1:-}" = "--check" ] && CHECK=1
  # The app's own tests run the whole set-up on GitHub's Macs (_app/test/e2e/install-mac.sh):
  # answers come from a file there, nothing waits for a sign-in, and the app's code comes from
  # the copy being tested. None of this is used otherwise.
  TEST=0
  if [ "${CONVERSATIONS_TEST:-}" = 1 ]; then
    TEST=1
    exec 3< "${CONVERSATIONS_ANSWERS_FILE:?the test gives its answers in a file}"
  fi

  APP_REPO="${CONVERSATIONS_APP_REPO_URL:-https://github.com/Samprogrammer143/conversations-app.git}"
  # The Mac app's own release (mac-app), rebuilt from main once the app's tests pass there.
  # (The latest release is the Windows download.)
  MAC_DOWNLOADS="https://github.com/Samprogrammer143/conversations-app/releases/download/mac-app"
  SUPPORT="$HOME/Library/Application Support"
  APP_DIR="$SUPPORT/conversations-app"
  SYNC_HOME="${CLAUDE_SYNC_HOME:-$SUPPORT/claude-conversation-sync}"
  CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  STEPS=5

  bold "Conversations setup"
  [ $CHECK = 1 ] && grey "(check only: nothing is changed)"
  [ "$(uname -s)" = "Darwin" ] || stop "This is the Mac set-up. On Windows, use the download from conversations.tidewaystudios.com."

  tools
  the_app
  app_repo
  this_mac
  sign_in

  echo
  green "Conversations is set up. Open it from Applications, or with Spotlight (Cmd+Space, then Conversations)."
  [ $CHECK = 1 ] || [ "${CONVERSATIONS_NO_OPEN:-}" = 1 ] || open -a "$APP" 2>/dev/null || true
}

# ---------------------------------------------------------------- 1. tools

tools() {
  step 1 "Tools"
  # git comes with Apple's command line tools (free; macOS installs them in a window of its own,
  # and only an administrator may).
  if have_git; then
    done_ "git $(git --version | awk '{print $3}')"
  elif [ $CHECK = 1 ]; then
    if is_admin; then todo "would install Apple's command line tools (for git)"
    else todo "would stop: an administrator needs to install Apple's command line tools (for git)"; fi
  elif ! is_admin; then
    stop "This Mac needs Apple's command line tools (for git), and only an administrator can install them. Ask one to run xcode-select --install in Terminal, then run this again."
  else
    say "Installing Apple's command line tools, for git. Click Install in the window that opens."
    xcode-select --install >/dev/null 2>&1 || true
    local waited=0
    until have_git; do
      sleep 5
      waited=$((waited + 5))
      [ $waited -ge 1800 ] && stop "git still isn't there after 30 minutes. Finish installing Apple's command line tools, then run this again."
      [ $((waited % 60)) = 0 ] && say "Still waiting for Apple's command line tools ($((waited / 60)) min) ..."
    done
    done_ "git $(git --version | awk '{print $3}')"
  fi

  # Claude Code, with Anthropic's own installer (it puts claude in ~/.local/bin).
  find_claude
  if [ -n "$CLAUDE" ]; then
    done_ "Claude Code $("$CLAUDE" --version 2>/dev/null | awk '{print $1}')"
  elif [ $CHECK = 1 ]; then
    todo "would install Claude Code (claude.ai/install.sh)"
  else
    say "Installing Claude Code ..."
    curl -fsSL https://claude.ai/install.sh | bash || stop "Claude Code couldn't be installed. Install it yourself (claude.ai/code), then run this again."
    find_claude
    [ -n "$CLAUDE" ] || stop "Claude Code was installed but can't be found. Open a new Terminal window and run this again."
    done_ "Claude Code installed"
  fi
  local_bin_on_path
}

# Apple's command line tools are there (xcode-select -p never opens a window; git itself
# opens Apple's install window when they're missing, even just to say its version).
have_git() {
  local dev
  dev="$(xcode-select -p 2>/dev/null)" && [ -x "$dev/usr/bin/git" ]
}

is_admin() { id -Gn | tr ' ' '\n' | grep -qx admin; }

# Apple silicon or Intel. (uname -m says Intel in a Terminal running under Rosetta on Apple
# silicon; the Mac itself says what it is.)
mac_arch() {
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then echo arm64; else echo x64; fi
}

# The /push and /pull skills, and a workspace's claude-<id> command, run from ~/.local/bin,
# so Terminal needs it on its PATH. Claude Code's installer doesn't always see to that: when
# the shell's start-up files don't name it, one line is added (once).
local_bin_on_path() {
  local shell profile short f
  shell="$(basename "${SHELL:-/bin/zsh}")"
  if [ "$shell" = zsh ]; then
    local zdir="${ZDOTDIR:-$HOME}"
    grep -qs '\.local/bin' "$zdir/.zshenv" "$zdir/.zprofile" "$zdir/.zshrc" "$zdir/.zlogin" && { done_ "~/.local/bin is on Terminal's PATH"; return; }
    profile="$zdir/.zprofile"
  elif [ "$shell" = bash ]; then
    grep -qs '\.local/bin' "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile" "$HOME/.bashrc" && { done_ "~/.local/bin is on Terminal's PATH"; return; }
    # (A login bash reads only the first of these it finds, so the line goes in that one.)
    profile="$HOME/.bash_profile"
    for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      [ -f "$f" ] && { profile="$f"; break; }
    done
  else
    todo "(Put ~/.local/bin on your shell's PATH: /push, /pull and claude-<workspace> need it.)"
    return
  fi
  short="$profile"
  case "$profile" in "$HOME"/*) short="~${profile#"$HOME"}" ;; esac
  if [ $CHECK = 1 ]; then
    todo "would add ~/.local/bin to PATH in $short"
    return
  fi
  # (A blank line first when the file has lines of its own, ended properly.)
  if { if [ -s "$profile" ]; then [ -n "$(tail -c 1 "$profile")" ] && echo; echo; fi
    echo '# Added by Conversations: commands in ~/.local/bin (conversations-node, claude-<workspace>)'
    echo 'export PATH="$HOME/.local/bin:$PATH"'
  } 2>/dev/null >> "$profile"; then
    done_ "Added ~/.local/bin to PATH in $short (new Terminal windows have it)"
  else
    todo "(Couldn't add ~/.local/bin to PATH in $short. Add it yourself for /push and /pull in Terminal.)"
  fi
}

find_claude() {
  CLAUDE=""
  local c
  for c in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -n "$c" ] && [ -x "$c" ]; then CLAUDE="$c"; return; fi
  done
}

# ---------------------------------------------------------------- 2. the app

the_app() {
  step 2 "The app"
  # /Applications when this account may write there (admins can), else ~/Applications.
  local dir="/Applications"
  [ -w "$dir" ] || dir="$HOME/Applications"
  [ -n "${CONVERSATIONS_APPS_DIR:-}" ] && dir="$CONVERSATIONS_APPS_DIR"
  APP="$dir/Conversations.app"
  local have=""
  for a in "/Applications/Conversations.app" "$HOME/Applications/Conversations.app"; do
    [ -d "$a" ] && have="$a"
  done
  if [ -n "$have" ] && [ -z "${CONVERSATIONS_APP_ZIP:-}" ]; then
    APP="$have"
    done_ "Already installed in $(dirname "$APP") (it updates itself)"
  elif [ $CHECK = 1 ]; then
    todo "would install Conversations into $dir"
  else
    local arch zip tmp
    arch="$(mac_arch)"
    tmp="$(mktemp -d)"
    if [ -n "${CONVERSATIONS_APP_ZIP:-}" ]; then
      zip="$CONVERSATIONS_APP_ZIP"
    else
      zip="$tmp/Conversations-mac-$arch.zip"
      say "Downloading Conversations for $( [ $arch = arm64 ] && echo "Apple silicon" || echo "Intel" ) ..."
      curl -fL --progress-bar -o "$zip" "$MAC_DOWNLOADS/Conversations-mac-$arch.zip" || stop "The app couldn't be downloaded. Check this Mac is online, then run this again."
    fi
    ditto -x -k "$zip" "$tmp/unpacked" || stop "The download couldn't be unpacked. Run this again."
    [ -d "$tmp/unpacked/Conversations.app" ] || stop "The download doesn't hold the app. Run this again."
    # Signed before it goes anywhere: macOS won't start an app whose signature doesn't match,
    # and a copy left in Applications would stop a second run from trying again.
    xattr -dr com.apple.quarantine "$tmp/unpacked/Conversations.app" 2>/dev/null || true
    codesign --force --deep --sign - "$tmp/unpacked/Conversations.app" >/dev/null 2>&1 || stop "Conversations couldn't be signed for this Mac, so it wouldn't open. Run this again."
    # A copy that's running is closed first, and comes back after. (Only asked when one runs:
    # naming an app that isn't there makes macOS ask where it is.)
    if pgrep -xq Conversations; then
      osascript -e 'tell application id "com.samcan.conversations" to quit' >/dev/null 2>&1 || true
      local i
      for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq Conversations || break; sleep 1; done
    fi
    mkdir -p "$dir"
    rm -rf "$APP"
    mv "$tmp/unpacked/Conversations.app" "$APP" || stop "Conversations couldn't be put in $dir."
    rm -rf "$tmp"
    done_ "Installed in $dir"
  fi
  APP_EXE="$APP/Contents/MacOS/Conversations"
}

# The app's own Node runs the set-up's scripts: a Mac needs no Node of its own.
node_run() {
  if [ -x "${APP_EXE:-}" ]; then ELECTRON_RUN_AS_NODE=1 "$APP_EXE" "$@"; else node "$@"; fi
}

# ---------------------------------------------------------------- 3. the app's repository

app_repo() {
  step 3 "The app's code (public, kept up to date by itself)"
  if [ -d "$APP_DIR/.git" ]; then
    done_ "Already here: $APP_DIR"
  elif [ $CHECK = 1 ]; then
    todo "would copy $APP_REPO into $APP_DIR"
    return
  else
    mkdir -p "$SUPPORT"
    git -c core.longpaths=true clone --quiet "$APP_REPO" "$APP_DIR" || stop "The app's code couldn't be copied from GitHub. Check this Mac is online, then run this again."
    done_ "Copied into $APP_DIR"
  fi
  [ $CHECK = 1 ] && return
  # Claude's Agent SDK comes from npm's registry (its licence doesn't let the app carry it).
  say "Getting Claude's Agent SDK ..."
  local out
  out="$(node_run "$APP_DIR/_sync/sync.mjs" app --json 2>&1 | tail -1)"
  case "$out" in
    *'"runtime":{"ok":false'*) stop "Claude's Agent SDK couldn't be installed. Check this Mac is online, then run this again." ;;
    *'"ok":true'*) done_ "Ready" ;;
    *) stop "The app's code couldn't be set up: $out" ;;
  esac
}

# ---------------------------------------------------------------- 4. this Mac's conversations

this_mac() {
  step 4 "This Mac's conversations (your own private repository)"
  ACTIVE_CLAUDE="$CLAUDE_DIR"
  LAUNCHER=""
  if [ -f "$SYNC_HOME/config.json" ] && grep -q '"remote"' "$SYNC_HOME/config.json"; then
    done_ "Already set up: $(sed -n 's/.*"remote": *"\([^"]*\)".*/\1/p' "$SYNC_HOME/config.json" | head -1)"
    return
  fi
  # A workspace set up earlier with its own Claude folder ("keep them out" below).
  local own
  own="$( [ -x "${APP_EXE:-}" ] || command -v node >/dev/null 2>&1 && MODE=own registry_js 2>/dev/null)"
  if [ -n "$own" ]; then
    ACTIVE_CLAUDE="$CLAUDE_DIR-$own"
    LAUNCHER="claude-$own"
    done_ "Already set up, with its own Claude folder ($ACTIVE_CLAUDE)"
    return
  fi
  case "$(cd "$CLAUDE_DIR" 2>/dev/null && pwd -P)" in
    *"Mobile Documents"* | *CloudStorage*) stop "$CLAUDE_DIR is inside iCloud Drive or a cloud folder. Conversations keeps chats in step through GitHub; move it out first." ;;
  esac
  if [ $CHECK = 1 ]; then
    todo "would ask for this Mac's name and your private repository, then set up the sync"
    return
  fi

  local name remote
  name="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
  ask "What should this Mac be called in Conversations? [$name]" reply
  [ -n "$reply" ] && name="$reply"

  say "Your conversations go in a private GitHub repository of your own. Make a new empty one at"
  say "github.com/new (choose Private), then paste its address here."
  while true; do
    ask "Repository address (https://github.com/you/claude-conversations):" remote
    remote="$(printf '%s' "$remote" | tr -d '[:space:]')"
    # (file:/// as on Windows: a repository on this Mac or a shared drive.)
    if ! printf '%s' "$remote" | grep -Eq '^(https://[^/]+/.+|git@[^:]+:.+|file:///.+)$'; then
      say "That doesn't look like a repository address."
      continue
    fi
    case "$(github_visibility "$remote")" in
      public) say "That repository is public, so anyone could read your conversations in it. Make it private on github.com (its Settings, then Change visibility), or make a new private one." ; continue ;;
      unknown) say "(GitHub didn't say whether it's private, so it couldn't be checked. Make sure it is: anyone can read a public one.)" ;;
    esac
    break
  done

  local workspace=""
  while [ -z "$workspace" ]; do ask "What should Conversations call it? (e.g. Work)" workspace; done

  github_login "$remote"

  # Claude Code may have been used on this Mac before (another account, other work).
  local chats keep_out=0
  chats="$(find "$CLAUDE_DIR/projects" -name '*.jsonl' -not -path '*/subagents/*' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${chats:-0}" -gt 0 ]; then
    echo
    say "This Mac already has $chats Claude Code chats (in $CLAUDE_DIR)."
    say "  1  Bring them into $workspace: they upload to its repository."
    say "  2  Keep them out: $workspace gets a fresh Claude folder and its own sign-in. The"
    say "     old chats stay in Claude Code as they are, and Conversations doesn't show them."
    local pick=""
    while [ "$pick" != 1 ] && [ "$pick" != 2 ]; do ask "1 or 2:" pick; done
    [ "$pick" = 2 ] && keep_out=1
  fi

  say "Connecting ..."
  if [ $keep_out = 0 ]; then
    node_run "$APP_DIR/_sync/install.mjs" --remote "$remote" --machine "$name" || stop "Connecting the repository didn't work (the lines above say why). Check the address and that you can open it on github.com, then run this again."
    # The name the app shows for this workspace (only the first time).
    WS_NAME="$workspace" MODE=first registry_js
  else
    # A workspace of its own: its own Claude folder, sync folder and app data, as the app's
    # "Add workspace" makes them; the usual Claude folder is left out of Conversations here.
    local id
    id="$(WS_NAME="$workspace" MODE=id registry_js)"
    [ -n "$id" ] || stop "The workspace couldn't be named. Run this again."
    ACTIVE_CLAUDE="$CLAUDE_DIR-$id"
    mkdir -p "$ACTIVE_CLAUDE"
    CLAUDE_CONFIG_DIR="$ACTIVE_CLAUDE" CLAUDE_SYNC_HOME="$SYNC_HOME-$id" node_run "$APP_DIR/_sync/install.mjs" --remote "$remote" --machine "$name" || stop "Connecting the repository didn't work (the lines above say why). Check the address and that you can open it on github.com, then run this again."
    WS_ID="$id" WS_NAME="$workspace" WS_REMOTE="$remote" WS_CLAUDE="$ACTIVE_CLAUDE" WS_SYNC="$SYNC_HOME-$id" WS_EXE="${CLAUDE:-claude}" MODE=keep-out registry_js || stop "The workspace couldn't be recorded. Run this again."
    LAUNCHER="claude-$id"
    done_ "$workspace has its own Claude folder. In Terminal: $LAUNCHER (plain claude keeps the old chats)"
  fi
  done_ "This Mac is \"$name\" and $workspace syncs with $remote"
}

# The app's list of workspaces (workspaces.json in its data folder), read and written as the
# app does, by the app's own Node (JSON and quoting done properly, not by hand in shell):
#   MODE=own       print the id of a workspace set up with its own Claude folder, if any
#   MODE=first     name the first workspace, when there's no list yet
#   MODE=id        print a free id for WS_NAME ("Work" -> "work"), as the app makes one
#   MODE=keep-out  record WS_ID as the current workspace, leave the usual Claude folder out,
#                  and write its claude-<id> command in ~/.local/bin
registry_js() {
  REGISTRY="$SUPPORT/Conversations/workspaces.json" SYNC_HOME="$SYNC_HOME" node_run -e '
const fs = require("fs"), path = require("path"), os = require("os");
const e = process.env, f = e.REGISTRY;
let reg = null;
try { reg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
const extra = (reg && Array.isArray(reg.extra)) ? reg.extra : [];
const save = (v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
if (e.MODE === "own") {
  const w = extra.find((x) => fs.existsSync(path.join(`${e.SYNC_HOME}-${x.id}`, "repo", ".git")));
  if (w) console.log(w.id);
} else if (e.MODE === "first") {
  if (!reg) save({ current: "main", mainName: e.WS_NAME, extra: [] });
} else if (e.MODE === "id") {
  let base = e.WS_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.length > 30) base = base.slice(0, 30).replace(/-+$/g, "");
  if (!base) base = "workspace";
  const taken = ["main", ...extra.map((x) => x.id)];
  let id = base === "main" ? "main-2" : base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  console.log(id);
} else if (e.MODE === "keep-out") {
  const id = e.WS_ID;
  const off = [...new Set([...((reg && reg.disconnected) || []), "main"])].filter((x) => x !== id);
  save({ current: id, mainName: (reg && reg.mainName) || "Earlier Claude Code chats", extra: [...extra.filter((x) => x.id !== id), { id, name: e.WS_NAME, remote: e.WS_REMOTE }], disconnected: off });
  const sq = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const bin = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const exe = e.WS_EXE === "claude" ? "claude" : sq(e.WS_EXE);
  const body = ["#!/bin/sh", `# Claude Code in the ${e.WS_NAME.replace(/[\r\n]/g, " ")} workspace. Written by Conversations.`, `export CLAUDE_CONFIG_DIR=${sq(e.WS_CLAUDE)}`, `export CLAUDE_SYNC_HOME=${sq(e.WS_SYNC)}`, `exec ${exe} "$@"`, ""].join("\n");
  fs.writeFileSync(path.join(bin, `claude-${id}`), body, { mode: 0o755 });
  fs.chmodSync(path.join(bin, `claude-${id}`), 0o755);
}
'
}

# "public", "private" or "unknown", as the Windows set-up and the engine decide (a 404 is private).
github_visibility() {
  local owner_repo
  owner_repo="$(printf '%s' "$1" | sed -E 's#^(https://(www\.)?github\.com/|git@github\.com:)##; s#\.git/?$##; s#/$##')"
  if [ "$owner_repo" = "$1" ] || ! printf '%s' "$owner_repo" | grep -Eq '^[^/]+/[^/]+$'; then echo unknown; return; fi
  local body code
  body="$(curl -s -m 10 -w '\n%{http_code}' "https://api.github.com/repos/$owner_repo" 2>/dev/null)"
  code="$(printf '%s' "$body" | tail -1)"
  if [ "$code" = 404 ]; then echo private
  elif [ "$code" = 200 ] && printf '%s' "$body" | grep -q '"private": *false'; then echo public
  elif [ "$code" = 200 ]; then echo private
  else echo unknown; fi
}

# This Mac's git needs a GitHub sign-in to reach a private repository. GitHub's own command
# line tool signs in through the browser and hands git the login; if this Mac doesn't have
# it, it's fetched from GitHub (no admin password) into Conversations' own folder.
github_login() {
  if GIT_TERMINAL_PROMPT=0 git ls-remote "$1" >/dev/null 2>&1; then
    done_ "GitHub lets this Mac into it"
    return
  fi
  # (The sign-in below is for https addresses: an SSH one needs this Mac's SSH key instead.)
  case "$1" in
    git@*) stop "This Mac couldn't open $1 with its SSH key. Use the repository's https address instead (https://github.com/you/repo), then run this again." ;;
  esac
  local gh
  gh="$(command -v gh 2>/dev/null || true)"
  if [ -z "$gh" ]; then
    say "Getting GitHub's sign-in tool ..."
    local dir="$SUPPORT/Conversations/gh" tmp asset
    tmp="$(mktemp -d)"
    asset="$(gh_asset_url)"
    [ -n "$asset" ] || stop "GitHub's sign-in tool couldn't be found. Install it (cli.github.com), run 'gh auth login', then run this again."
    curl -fsSL -o "$tmp/gh.zip" "$asset" && ditto -x -k "$tmp/gh.zip" "$tmp/x" || stop "GitHub's sign-in tool couldn't be downloaded. Run this again."
    mkdir -p "$dir"
    cp "$(find "$tmp/x" -path '*/bin/gh' | head -1)" "$dir/gh" && chmod 755 "$dir/gh" || stop "GitHub's sign-in tool couldn't be set up."
    rm -rf "$tmp"
    gh="$dir/gh"
  fi
  say "Sign in to GitHub in the browser that opens (gh shows a code to type there)."
  "$gh" auth login --hostname github.com --git-protocol https --web < /dev/tty || stop "GitHub sign-in didn't finish. Run this again to try once more."
  "$gh" auth setup-git --hostname github.com >/dev/null 2>&1 || true
  GIT_TERMINAL_PROMPT=0 git ls-remote "$1" >/dev/null 2>&1 || stop "GitHub still doesn't let this Mac into $1. Check the address, and that you can open it on github.com while signed in."
  done_ "Signed in to GitHub"
}

# Where to download GitHub's sign-in tool (gh) for this Mac's processor: its latest release.
# GitHub's API lists the files; when it says no (it allows only a few calls an hour without a
# login), the latest release's own page gives the version, and the file is named from that.
gh_asset_url() {
  local arch=amd64 url="" tag
  [ "$(mac_arch)" = arm64 ] && arch=arm64
  url="$(curl -fsSL -m 30 https://api.github.com/repos/cli/cli/releases/latest 2>/dev/null | grep -Eo 'https://[^"]+_macOS_'"$arch"'\.zip' | head -1)"
  if [ -z "$url" ]; then
    tag="$(curl -fsSIL -m 30 -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest 2>/dev/null)"
    tag="${tag##*/tag/}"
    case "$tag" in v[0-9]*) url="https://github.com/cli/cli/releases/download/$tag/gh_${tag#v}_macOS_$arch.zip" ;; esac
  fi
  [ -n "$url" ] && printf '%s\n' "$url"
}

# ---------------------------------------------------------------- 5. Claude sign-in

sign_in() {
  step 5 "Claude"
  # (Claude Code keeps a Mac's login in the Keychain; its account record says it signed in.
  # The record is beside the usual Claude folder, and inside a workspace's own one.)
  local active="${ACTIVE_CLAUDE:-$CLAUDE_DIR}" record="$HOME/.claude.json"
  [ "$active" != "$CLAUDE_DIR" ] && record="$active/.claude.json"
  if grep -q '"oauthAccount"' "$record" 2>/dev/null || [ -f "$active/.credentials.json" ]; then
    done_ "Signed in"
  elif [ $CHECK = 1 ]; then
    todo "would start Claude Code so you can sign in"
  elif [ $TEST = 1 ]; then
    todo "(test: the Claude sign-in is left out)"
  else
    say "Sign in with your own Claude account: Claude Code starts now. Type /exit once you're in."
    if [ -n "${LAUNCHER:-}" ]; then "$HOME/.local/bin/$LAUNCHER" < /dev/tty || true; else "$CLAUDE" < /dev/tty || true; fi
  fi
}

# ---------------------------------------------------------------- output

step() { echo; printf '\033[36m[%s/%s] %s\033[0m\n' "$1" "$STEPS" "$2"; }
say() { printf '      %s\n' "$1"; }
done_() { printf '      \033[32m%s\033[0m\n' "$1"; }
todo() { printf '      \033[33m%s\033[0m\n' "$1"; }
grey() { printf '\033[90m%s\033[0m\n' "$1"; }
bold() { echo; printf '\033[1m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
stop() { echo; printf '\033[31m%s\033[0m\n' "$1"; echo; exit 1; }
# Read from the keyboard even when this script itself arrived through a pipe (curl | bash).
ask() {
  local answer=""
  printf '      %s ' "$1"
  if [ "${TEST:-0}" = 1 ]; then
    read -r answer <&3 || stop "(test: no answer left for \"$1\")"
    echo "$answer"
  else
    { read -r answer < /dev/tty; } 2>/dev/null || stop "This needs a few answers typed in Terminal. Run it in a Terminal window."
  fi
  printf -v "$2" '%s' "$answer"
}

main "$@"
