---
name: pull
description: Download a Claude conversation for the current folder from this workspace's private conversations repository on GitHub by hand (this also happens automatically whenever Claude starts). Runs only when the user types /pull.
disable-model-invocation: true
argument-hint: "[list | <number> | <session id>]"
allowed-tools: Bash(node:*)
---

<!-- conversation-sync skill: installed by _sync/install.mjs; edit the copy in the repo, not this one -->

The download has already been run for this folder. Its output:

```
!`node "{{SYNC}}" pull --cwd "${CLAUDE_PROJECT_DIR}" --current "${CLAUDE_SESSION_ID}" $ARGUMENTS 2>&1 || true`
```

With no argument it lists this folder's synced conversations, newest first, and brings the newest one (other than the one open now) up to date on this PC. `/pull list` only lists. `/pull 2` or `/pull <session id>` takes a different one. Copies are merged, never overwritten.

Tell the user the outcome in a few plain sentences. Do not run anything else unless the user asks.

- **Downloaded, Updated or Already up to date**: name the conversation, and say which PC it was last updated from and when. Then give the way to open it from the output: type `/resume` and choose it, or exit and run `claude --resume <session id>`. You cannot switch this session to it yourself.
- **Several conversations listed**: say which one was taken and that `/pull <number>` takes another.
- **No synced conversations for this folder**: say so and name the projects that do exist, if listed.
- Mention once, briefly, that this normally happens by itself when Claude starts, so /pull is only needed for a conversation updated while this window was already open.
