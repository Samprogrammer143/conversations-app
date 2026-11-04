#!/bin/bash
# The Mac set-up from start to finish, on a Mac with no Node on PATH (as most have), run as a
# new user would, with the answers given from a file:
#   1. Earlier Claude Code chats brought in: the app (from the zip CI just built) goes into
#      Applications with a whole signature and opens; Claude Code is installed with
#      Anthropic's own installer if it isn't there; the app's code is copied; Claude's Agent
#      SDK is fetched without npm; the sync is set up; the hooks run through
#      conversations-node, which runs the app's own Node.
#   2. Earlier chats kept out, in a second home folder: a workspace of its own, its own Claude
#      folder, the app's list of workspaces, and its claude-<id> command.
# A local repository stands in for the private one on GitHub; the sign-ins (GitHub's in the
# browser, Claude's) need a person and aren't part of it.
#   bash _app/test/e2e/install-mac.sh <out folder>     (on a Mac; CI runs it)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:-$ROOT/_app/test-results/install-mac}"
mkdir -p "$OUT"
[ "$(uname -s)" = Darwin ] || { echo "This test is for a Mac."; exit 1; }
arch=x64
[ "$(uname -m)" = arm64 ] && arch=arm64
ZIP="$ROOT/_app/release-public/Conversations-mac-$arch.zip"
[ -f "$ZIP" ] || { echo "No $ZIP: build it first (npm run dist:mac)."; exit 1; }

WORK="$(mktemp -d)"
FAILED=0
check() {
  if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; FAILED=$((FAILED + 1)); fi
}
# A Mac as most are: the system's folders and Claude Code's, no Node.
BARE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# A Claude Code chat from before, in a home folder's usual Claude folder.
earlier_chat() {
  local dir="$1/.claude/projects/-Users-someone-site"
  mkdir -p "$dir"
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"hello from before"},"sessionId":"aaaaaaaa-0000-4000-8000-000000000001","cwd":"/Users/someone/site","timestamp":"2026-11-01T10:00:00.000Z"}' > "$dir/aaaaaaaa-0000-4000-8000-000000000001.jsonl"
}

# The private repository: an empty one on this Mac stands in for GitHub.
git init -q --bare "$WORK/chats.git"
git init -q --bare "$WORK/work.git"

# ------------------------------------------------------------------ 1. bring earlier chats in
echo "== 1. a new Mac user, earlier chats brought in"
earlier_chat "$HOME"
printf '%s\n' "CI Mac" "file://$WORK/chats.git" "Everything" "1" > "$WORK/answers1"
env PATH="$BARE_PATH" CONVERSATIONS_TEST=1 CONVERSATIONS_ANSWERS_FILE="$WORK/answers1" \
  CONVERSATIONS_APP_ZIP="$ZIP" CONVERSATIONS_APP_REPO_URL="$ROOT" \
  bash "$ROOT/setup/install.sh" 2>&1 | tee "$OUT/install-1.txt"
code=${PIPESTATUS[0]}
check "the set-up finished" '[ $code = 0 ]'

APP=/Applications/Conversations.app
[ -d "$APP" ] || APP="$HOME/Applications/Conversations.app"
SUP="$HOME/Library/Application Support"
check "the app is in Applications" '[ -x "$APP/Contents/MacOS/Conversations" ]'
check "...with a whole, valid signature" 'codesign --verify --deep --strict "$APP"'
check "...and nothing marks it as downloaded" '! xattr -r "$APP" | grep -q com.apple.quarantine'
check "Claude Code is installed (Anthropic's installer, no Node)" '[ -x "$HOME/.local/bin/claude" ] || command -v claude'
check "the app's code is copied" '[ -d "$SUP/conversations-app/.git" ]'
check "Claude's Agent SDK was fetched, without npm" 'ls "$SUP"/conversations-app-runtime/*/.ready && ls "$SUP"/conversations-app-runtime/*/node_modules/@anthropic-ai/claude-agent-sdk/package.json'
check "this Mac's sync is set up with the repository" 'grep -q "chats.git" "$SUP/claude-conversation-sync/config.json"'
check "...under the name given" 'grep -q "CI Mac" "$SUP/claude-conversation-sync/config.json"'
check "the app's list names the workspace" 'grep -q "Everything" "$SUP/Conversations/workspaces.json"'
check "Claude Code's hooks run through conversations-node" 'grep -q "conversations-node" "$HOME/.claude/settings.json"'
check "...and so do the /push and /pull skills" 'grep -q "Bash(conversations-node:\*)" "$HOME/.claude/skills/push/SKILL.md"'
NODE_VER="$(env -i HOME="$HOME" PATH="$BARE_PATH" "$HOME/.local/bin/conversations-node" -e 'process.stdout.write(process.versions.electron || "")' 2>/dev/null)"
check "conversations-node runs the app's own Node (Electron $NODE_VER)" '[ -n "$NODE_VER" ]'
check "the sync engine runs that way, with no Node on PATH" 'env -i HOME="$HOME" PATH="$BARE_PATH" "$HOME/.local/bin/conversations-node" "$SUP/conversations-app/_sync/sync.mjs" status --json'
# A Stop hook, as Claude Code runs it: its command in a shell, the event on its input.
STOP_CMD="$(env -i HOME="$HOME" PATH="$BARE_PATH" "$HOME/.local/bin/conversations-node" -e 'const s=require(process.env.HOME+"/.claude/settings.json"); process.stdout.write(s.hooks.Stop[s.hooks.Stop.length-1].hooks[0].command)' 2>/dev/null)"
check "a Stop hook runs as Claude Code would run it" 'echo "{\"session_id\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"cwd\":\"/Users/someone/site\"}" | env -i HOME="$HOME" PATH="$BARE_PATH" /bin/sh -c "$STOP_CMD"'

# The set-up opened the app at the end (as launchd does: the system's PATH only).
for i in $(seq 1 45); do grep -q "starting" "$SUP/Conversations/app.log" 2>/dev/null && break; sleep 2; done
check "the installed app opens and starts" 'grep -q "starting" "$SUP/Conversations/app.log"'
check "...and is still running" 'pgrep -f "Conversations.app/Contents/MacOS/Conversations"'
sleep 3
screencapture -x "$OUT/installed-app.png" 2>/dev/null || true
cp "$SUP/Conversations/app.log" "$OUT/app.log" 2>/dev/null || true
osascript -e 'tell application id "com.samcan.conversations" to quit' >/dev/null 2>&1 || true
sleep 3
pkill -f "Conversations.app/Contents/MacOS/Conversations" 2>/dev/null || true

# ------------------------------------------------------------------ 2. keep earlier chats out
echo "== 2. another new user, earlier chats kept out"
H2="$WORK/home2"
mkdir -p "$H2"
earlier_chat "$H2"
printf '%s\n' "CI Mac 2" "file://$WORK/work.git" "Work" "2" > "$WORK/answers2"
# (The app is in Applications already; Claude Code is found on PATH.)
env HOME="$H2" PATH="$BARE_PATH:$HOME/.local/bin" CONVERSATIONS_TEST=1 CONVERSATIONS_NO_OPEN=1 CONVERSATIONS_ANSWERS_FILE="$WORK/answers2" \
  CONVERSATIONS_APP_REPO_URL="$ROOT" GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.invalid GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.invalid \
  bash "$ROOT/setup/install.sh" 2>&1 | tee "$OUT/install-2.txt"
code=${PIPESTATUS[0]}
SUP2="$H2/Library/Application Support"
check "the set-up finished" '[ $code = 0 ]'
check "the workspace has its own Claude folder" '[ -d "$H2/.claude-work" ] && grep -q "conversations-node" "$H2/.claude-work/settings.json"'
check "...and its own sync, with its repository" 'grep -q "work.git" "$SUP2/claude-conversation-sync-work/config.json"'
check "the earlier chats' folder is left as it was" '[ ! -f "$SUP2/claude-conversation-sync/config.json" ] && ! grep -q conversations-node "$H2/.claude/settings.json"'
check "the app's list makes it current and leaves the earlier chats out" 'grep -q "\"current\": \"work\"" "$SUP2/Conversations/workspaces.json" && grep -A2 "\"disconnected\"" "$SUP2/Conversations/workspaces.json" | grep -q "\"main\""'
check "claude-work starts Claude Code in it" '[ -x "$H2/.local/bin/claude-work" ] && grep -q "CLAUDE_CONFIG_DIR=.*\.claude-work" "$H2/.local/bin/claude-work"'
check "claude-work runs" 'env -i HOME="$H2" PATH="$BARE_PATH" "$H2/.local/bin/claude-work" --version'

rm -rf "$WORK"
echo
[ $FAILED = 0 ] && echo "all passed" || echo "$FAILED failed"
exit $FAILED
