#!/bin/bash
# Sets up Conversations on a Mac: the tools it needs, the app, the app's own repository
# (code, public), and this Mac's conversations repository (yours, private).
# Safe to run again: every step skips what is already done.
#
#   curl -fsSL https://conversations.tidewaystudios.com/install.sh | bash
#
# Read it first if you like: https://github.com/Samprogrammer143/conversations-app/blob/main/setup/install.sh
# To only see what it would do:  bash install.sh --check
#
# The app isn't signed with a paid Apple account. Installed from Terminal it isn't held back
# by macOS (that check is for downloads from a browser); this script gives it a local
# signature of its own.

set -uo pipefail

# Everything is in functions, run at the very end: a download cut short runs nothing.
main() {
  CHECK=0
  [ "${1:-}" = "--check" ] && CHECK=1

  APP_REPO="https://github.com/Samprogrammer143/conversations-app.git"
  RELEASES="https://github.com/Samprogrammer143/conversations-app/releases/latest/download"
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
  [ $CHECK = 1 ] || open -a "$APP" 2>/dev/null || true
}

# ---------------------------------------------------------------- 1. tools

tools() {
  step 1 "Tools"
  # git comes with Apple's command line tools (free; macOS installs them in a window of its own).
  if git --version >/dev/null 2>&1; then
    done_ "git $(git --version | awk '{print $3}')"
  elif [ $CHECK = 1 ]; then
    todo "would install Apple's command line tools (for git)"
  else
    say "Installing Apple's command line tools, for git. Click Install in the window that opens."
    xcode-select --install >/dev/null 2>&1 || true
    local waited=0
    until git --version >/dev/null 2>&1; do
      sleep 5
      waited=$((waited + 5))
      [ $waited -ge 1800 ] && stop "git still isn't there after 30 minutes. Finish installing Apple's command line tools, then run this again."
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
    case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
    tmp="$(mktemp -d)"
    if [ -n "${CONVERSATIONS_APP_ZIP:-}" ]; then
      zip="$CONVERSATIONS_APP_ZIP"
    else
      zip="$tmp/Conversations-mac-$arch.zip"
      say "Downloading Conversations for $( [ $arch = arm64 ] && echo "Apple silicon" || echo "Intel" ) ..."
      curl -fL --progress-bar -o "$zip" "$RELEASES/Conversations-mac-$arch.zip" || stop "The app couldn't be downloaded. Check this Mac is online, then run this again."
    fi
    ditto -x -k "$zip" "$tmp/unpacked" || stop "The download couldn't be unpacked. Run this again."
    [ -d "$tmp/unpacked/Conversations.app" ] || stop "The download doesn't hold the app. Run this again."
    # A copy that's running is closed first, and comes back after.
    osascript -e 'tell application "Conversations" to quit' >/dev/null 2>&1 || true
    mkdir -p "$dir"
    rm -rf "$APP"
    mv "$tmp/unpacked/Conversations.app" "$APP" || stop "Conversations couldn't be put in $dir."
    rm -rf "$tmp"
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || todo "(couldn't give the app its local signature; it may still open)"
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
  if [ -f "$SYNC_HOME/config.json" ] && grep -q '"remote"' "$SYNC_HOME/config.json"; then
    done_ "Already set up: $(sed -n 's/.*"remote": *"\([^"]*\)".*/\1/p' "$SYNC_HOME/config.json" | head -1)"
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
    if ! printf '%s' "$remote" | grep -Eq '^(https://[^/]+/.+|git@[^:]+:.+)$'; then
      say "That doesn't look like a repository address."
      continue
    fi
    case "$(github_visibility "$remote")" in
      public) say "That repository is public, so anyone could read your conversations in it. Make it private on github.com (its Settings, then Change visibility), or make a new private one." ; continue ;;
      unknown) say "(GitHub didn't say whether it's private, so it couldn't be checked. Make sure it is: anyone can read a public one.)" ;;
    esac
    break
  done

  github_login "$remote"

  local chats
  chats="$(find "$CLAUDE_DIR/projects" -name '*.jsonl' -not -path '*/subagents/*' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${chats:-0}" -gt 0 ]; then
    say "This Mac has $chats Claude Code chats already. They'll be uploaded to that repository too."
    ask "Go ahead? [Y/n]" yn
    case "$yn" in
      [nN]*) stop "Nothing was set up. To keep those chats out, set this Mac up from the app instead: Add workspace, in the sidebar." ;;
    esac
  fi
  node_run "$APP_DIR/_sync/install.mjs" --remote "$remote" --machine "$name" || stop "The sync couldn't be set up (the lines above say why). Fix that, then run this again."
  done_ "Set up as $name"
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
  local gh
  gh="$(command -v gh 2>/dev/null || true)"
  if [ -z "$gh" ]; then
    say "Getting GitHub's sign-in tool ..."
    local dir="$SUPPORT/Conversations/gh" tmp asset
    tmp="$(mktemp -d)"
    asset="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -Eo 'https://[^"]+_macOS_universal\.zip' | head -1)"
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

# ---------------------------------------------------------------- 5. Claude sign-in

sign_in() {
  step 5 "Claude"
  # (Claude Code keeps a Mac's login in the Keychain; its account record says it signed in.)
  if grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null || [ -f "$CLAUDE_DIR/.credentials.json" ]; then
    done_ "Signed in"
  elif [ $CHECK = 1 ]; then
    todo "would start Claude Code so you can sign in"
  else
    say "Sign in with your own Claude account: Claude Code starts now. Type /exit once you're in."
    "$CLAUDE" < /dev/tty || true
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
  { read -r answer < /dev/tty; } 2>/dev/null || stop "This needs a few answers typed in Terminal. Run it in a Terminal window."
  printf -v "$2" '%s' "$answer"
}

main "$@"
