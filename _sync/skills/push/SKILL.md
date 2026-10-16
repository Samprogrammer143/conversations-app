---
name: push
description: Upload the current Claude conversation to this workspace's private conversations repository on GitHub right now (it also uploads automatically after replies). Runs only when the user types /push.
disable-model-invocation: true
argument-hint: "[--dry-run]"
allowed-tools: Bash(node:*)
---

<!-- conversation-sync skill: installed by _sync/install.mjs; edit the copy in the repo, not this one -->

The upload for this conversation has already been run. Its output:

```
!`node "{{SYNC}}" push --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" $ARGUMENTS 2>&1 || true`
```

Tell the user the outcome in one or two plain sentences, with the GitHub link. Do not run anything else unless the user asks.

- **Uploaded, Updated or Already up to date**: confirm and give the link. If the output lists redactions, say in one sentence that those credential-looking strings were masked in the uploaded copy only.
- **GitHub also has newer entries from another PC**: both versions are kept and merged on GitHub. Relay how to see them here (exit, reopen Claude in this folder, /resume).
- **Dry run**: report what would happen, including any redactions.
- **Not set up, or could not reach GitHub**: say what failed and give the fix from the output.
