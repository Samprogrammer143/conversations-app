import { describe, expect, it } from "vitest";
import { classifyCommand, classifyTool, destructiveFallback, listOf, shortTarget, splitCommands } from "../src/main/chat/destructive";

const CWD = "C:\\Users\\alex\\Projects\\website";
const said = (cmd: string) => classifyCommand(cmd, CWD).consequence;

describe("reading a command line", () => {
  it("splits on separators and keeps quoted words whole", () => {
    expect(splitCommands(`cd out && rm -rf "my build"; echo 'a | b'`)).toEqual([["cd", "out"], ["rm", "-rf", "my build"], ["echo", "a | b"]]);
    expect(splitCommands("Get-ChildItem *.tmp | Remove-Item -Force")).toEqual([["Get-ChildItem", "*.tmp"], ["Remove-Item", "-Force"]]);
  });

  it("lists targets the way the card reads them", () => {
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b"])).toBe("a and b");
    expect(listOf(["a", "b", "c"])).toBe("a, b and c");
    expect(listOf(["a", "b", "c", "d"])).toBe("a, b and 2 more");
    expect(shortTarget("$env:OneDrive\\.claude\\conversation-sync", CWD)).toBe(".claude/conversation-sync");
    expect(shortTarget(".", CWD)).toBe("everything in website");
  });
});

describe("deletes", () => {
  it("names what Remove-Item deletes", () => {
    expect(classifyCommand("Remove-Item -Force hello.txt", CWD)).toEqual({ destructive: true, deletesFiles: true, consequence: "Deletes hello.txt. It can't be undone." });
    expect(said('Remove-Item -Recurse -Force "$env:OneDrive\\.claude\\conversation-sync"; Remove-Item -Force "$env:OneDrive\\.claude\\settings-LAPTOP-TEST01.json"')).toBe(
      "Deletes .claude/conversation-sync and .claude/settings-LAPTOP-TEST01.json. It can't be undone.",
    );
    expect(said("Remove-Item -LiteralPath a.txt, b.txt -ErrorAction SilentlyContinue")).toBe("Deletes a.txt and b.txt. It can't be undone.");
    expect(said("rm a b c d")).toBe("Deletes a, b and 2 more. It can't be undone.");
  });

  it("catches plain deletes too, not only forced ones", () => {
    for (const cmd of ["rm notes.txt", "Remove-Item notes.txt", "del notes.txt", "erase notes.txt", "rd /s /q out", "rmdir out", "unlink notes.txt"]) {
      expect(classifyCommand(cmd, CWD).destructive, cmd).toBe(true);
    }
    expect(said("del /s /q build")).toBe("Deletes build. It can't be undone.");
    expect(said("rm -rf build dist")).toBe("Deletes build and dist. It can't be undone.");
  });

  it("finds deletes inside other commands", () => {
    expect(said('cmd /c "rmdir /s /q out"')).toBe("Deletes out. It can't be undone.");
    expect(said('powershell -NoProfile -Command "Remove-Item -Recurse x"')).toBe("Deletes x. It can't be undone.");
    expect(said("if exist out rmdir /s /q out")).toBe("Deletes out. It can't be undone.");
    expect(said('bash -c "rm -rf tmp"')).toBe("Deletes tmp. It can't be undone.");
    const encoded = Buffer.from("Remove-Item -Force secret.txt", "utf16le").toString("base64");
    expect(said(`powershell -EncodedCommand ${encoded}`)).toBe("Deletes secret.txt. It can't be undone.");
    expect(said("Get-ChildItem *.tmp | Remove-Item -Force")).toBe("Deletes the files the command finds. It can't be undone.");
    expect(said('find . -name "*.log" -delete')).toBe("Deletes the files find matches in website. It can't be undone.");
    expect(said("find build -exec rm {} +")).toBe("Deletes the files find matches in build. It can't be undone.");
  });

  it("leaves a dry run alone", () => {
    expect(classifyCommand("Remove-Item x -WhatIf", CWD).destructive).toBe(false);
    expect(classifyCommand("git clean -n", CWD).destructive).toBe(false);
  });
});

describe("git", () => {
  it("says what each destructive git command loses", () => {
    expect(said("git reset --hard")).toBe("Discards uncommitted changes in website. It can't be undone.");
    expect(said("git push --force origin main")).toBe("Overwrites main on origin. It can't be undone.");
    expect(said("git push origin +main")).toBe("Overwrites main on origin. It can't be undone.");
    expect(said("git push origin :old-branch")).toBe("Deletes old-branch on origin. It can't be undone.");
    expect(said("git clean -fdx")).toBe("Deletes untracked files in website, including ignored ones. It can't be undone.");
    expect(said("git branch -D feature")).toBe("Deletes the branch feature, even if not merged. It can't be undone.");
    expect(said("git checkout -- src/a.ts")).toBe("Discards uncommitted changes to src/a.ts. It can't be undone.");
    expect(said("git checkout .")).toBe("Discards uncommitted changes in website. It can't be undone.");
    expect(said("git restore lib/x.ts")).toBe("Discards uncommitted changes to lib/x.ts. It can't be undone.");
    expect(said("git stash drop")).toBe("Deletes a stashed change. It can't be undone.");
    expect(said("git -C repo stash clear")).toBe("Deletes every stashed change. It can't be undone.");
    expect(classifyCommand("git reset --hard", CWD).deletesFiles).toBe(false);
  });

  it("leaves ordinary git alone", () => {
    for (const cmd of ["git status", "git checkout main", "git restore --staged a.ts", "git push origin main", "git commit -m \"remove old files\"", "git branch -d merged", "git rm --cached x"]) {
      expect(classifyCommand(cmd, CWD).destructive, cmd).toBe(false);
    }
  });
});

describe("SQL", () => {
  it("reads destructive statements wherever they are", () => {
    expect(said('psql -c "DROP TABLE leads"')).toBe("Deletes the table leads and all its rows. It can't be undone.");
    expect(said('sqlite3 db.sqlite "DELETE FROM sessions WHERE id = 3"')).toBe("Deletes rows from sessions. It can't be undone.");
    expect(said('psql -c "TRUNCATE leads"')).toBe("Deletes every row in leads. It can't be undone.");
  });
});

describe("the verification review's gaps", () => {
  it("GitHub", () => {
    expect(said("gh repo delete alex/old-site --yes")).toBe("Deletes the GitHub repository alex/old-site. It can't be undone.");
    expect(said("gh api -X DELETE /repos/alex/x/releases/5")).toBe("Sends a DELETE request to GitHub: /repos/alex/x/releases/5. It can't be undone.");
    expect(said("gh api --method=DELETE repos/x/y")).toBe("Sends a DELETE request to GitHub: repos/x/y. It can't be undone.");
    expect(said("gh release delete v1.2")).toBe("Deletes the GitHub release v1.2. It can't be undone.");
    expect(classifyCommand("gh api repos/x/y", CWD).destructive).toBe(false);
    expect(classifyCommand("gh repo view", CWD).destructive).toBe(false);
  });

  it("DELETE requests", () => {
    expect(said("curl -X DELETE https://api.example.com/items/3")).toBe("Sends a DELETE request to api.example.com/items/3. It can't be undone.");
    expect(said("curl --request DELETE https://user:secret@api.example.com/x?y=1")).toBe("Sends a DELETE request to api.example.com/x. It can't be undone.");
    expect(said("curl -XDELETE https://a.io/b")).toBe("Sends a DELETE request to a.io/b. It can't be undone.");
    expect(said("Invoke-RestMethod -Method Delete -Uri https://a.io/b")).toBe("Sends a DELETE request to a.io/b. It can't be undone.");
    expect(classifyCommand("curl -X POST https://a.io/b", CWD).destructive).toBe(false);
  });

  it("infrastructure", () => {
    expect(said("terraform destroy -auto-approve")).toBe("Destroys everything Terraform manages for website. It can't be undone.");
    expect(said("terraform apply -destroy")).toBe("Destroys everything Terraform manages for website. It can't be undone.");
    expect(said("kubectl delete pod web-1")).toBe("Deletes pod web-1 from the Kubernetes cluster. It can't be undone.");
    expect(said("kubectl delete -f deploy/app.yaml")).toBe("Deletes what deploy/app.yaml describes from the Kubernetes cluster. It can't be undone.");
    expect(said("npx supabase db reset")).toBe("Deletes all data in the local Supabase database and rebuilds it from the migrations. It can't be undone.");
    expect(said("supabase db reset --linked")).toBe("Deletes all data in the linked Supabase project's database and rebuilds it from the migrations. It can't be undone.");
    expect(said("docker volume rm pgdata")).toBe("Deletes the Docker volume pgdata and the data in it. It can't be undone.");
    expect(said("docker system prune -af --volumes")).toBe("Deletes unused Docker containers, networks, images and build cache, and unused volumes with their data. It can't be undone.");
    expect(said("docker compose down -v")).toBe("Deletes this Compose project's volumes and their data. It can't be undone.");
    expect(said("az group delete --name rg1 --yes")).toBe('Runs "az group delete rg1", which deletes things in Azure. It can\'t be undone.');
    for (const ok of ["terraform plan", "kubectl get pods", "supabase db push", "docker volume ls", "docker compose down", "az group list"]) expect(classifyCommand(ok, CWD).destructive, ok).toBe(false);
  });

  it("Windows", () => {
    expect(said("Format-Volume -DriveLetter E")).toBe("Erases the drive E:. It can't be undone.");
    expect(said("reg delete HKCU\\Software\\Old /f")).toBe("Deletes the registry key HKCU\\Software\\Old and everything in it. It can't be undone.");
    expect(said("reg delete HKCU\\Software\\X /v Setting /f")).toBe("Deletes the registry value Setting in HKCU\\Software\\X. It can't be undone.");
    expect(said('wsl rm -rf ~/projects/old')).toBe("Deletes projects/old. It can't be undone.");
    expect(said("wsl -d Ubuntu -- rm -rf /tmp/x")).toBe("Deletes tmp/x. It can't be undone.");
    expect(classifyCommand("reg query HKCU\\Software", CWD).destructive).toBe(false);
  });

  it("writing over files", () => {
    expect(said("npm test > results.txt")).toBe("Overwrites results.txt. It can't be undone.");
    expect(said("echo hi 1> notes.md")).toBe("Overwrites notes.md. It can't be undone.");
    expect(said('Set-Content -Path config.json -Value "{}"')).toBe("Replaces the contents of config.json. It can't be undone.");
    expect(said("Set-Content notes.txt 'hello world'")).toBe("Replaces the contents of notes.txt. It can't be undone.");
    expect(said("Get-Date | Out-File log.txt")).toBe("Overwrites log.txt. It can't be undone.");
    for (const ok of ["npm test >> results.txt", "npm test 2>&1 | Select-String fail", "npm test > $null", "npm test >NUL", "npm test 2> /dev/null", "Get-Date | Out-File log.txt -Append", "npm test &>/dev/null"]) {
      expect(classifyCommand(ok, CWD).destructive, ok).toBe(false);
    }
    // 2>&1 stays one word: what follows it is not a new command.
    expect(splitCommands("npm test 2>&1 | Select-String fail")).toEqual([["npm", "test", "2>&1"], ["Select-String", "fail"]]);
  });

  it("only counts an overwrite when there is a file to lose", () => {
    const exists = (p: string) => p.toLowerCase().endsWith("\\website\\existing.txt");
    expect(classifyCommand("npm test > new.txt", CWD, { exists }).destructive).toBe(false);
    expect(classifyCommand("npm test > existing.txt", CWD, { exists }).consequence).toBe("Overwrites existing.txt. It can't be undone.");
    expect(classifyCommand("Set-Content new.txt x", CWD, { exists }).destructive).toBe(false);
    // After a cd, a relative path can't be checked: it counts.
    expect(classifyCommand("cd ..; npm test > new.txt", CWD, { exists }).destructive).toBe(true);
  });

  it("UPDATE without WHERE", () => {
    expect(said("psql -c \"UPDATE leads SET status = 'lost'\"")).toBe("Changes every row in leads. It can't be undone.");
    expect(classifyCommand("psql -c \"UPDATE leads SET status = 'lost' WHERE id = 3\"", CWD).destructive).toBe(false);
    expect(classifyCommand('git commit -m "Update docs set up and delete from cache"', CWD).destructive).toBe(false);
    expect(classifyTool("mcp__supabase-crm__execute_sql", { query: "update leads set owner = null" }, CWD).consequence).toBe("Changes every row in leads. It can't be undone.");
  });

  it("MCP tool names in any case style", () => {
    expect(classifyTool("mcp__files__deleteFile", { path: "a.txt" }, CWD).consequence).toBe("Uses files to delete file. It can't be undone.");
    expect(classifyTool("mcp__db__drop-table", { name: "x" }, CWD).consequence).toBe("Uses db to drop table. It can't be undone.");
    expect(classifyTool("mcp__crm__purgeDeletedContacts", {}, CWD).consequence).toBe("Uses crm to purge deleted contacts. It can't be undone.");
    expect(classifyTool("mcp__crm__getDeletedItems", {}, CWD).destructive).toBe(false);
    expect(classifyTool("mcp__claude_ai_Gmail__send_message", { body: "please delete from the list" }, CWD).destructive).toBe(false);
  });
});

describe("harmless commands", () => {
  it("are not destructive", () => {
    for (const cmd of ["npm run build", "npm run format", "ls -la", 'grep -rn "rm -rf" .', "echo del", "node scripts/build.mjs", "Get-ChildItem -Recurse", "npx vitest run", "git log --format=%H"]) {
      expect(classifyCommand(cmd, CWD), cmd).toEqual({ destructive: false, deletesFiles: false, consequence: null });
    }
  });
});

describe("tools", () => {
  it("reads MCP tools by name and by the SQL they carry", () => {
    expect(classifyTool("mcp__supabase-crm__execute_sql", { query: "DELETE FROM leads WHERE id = 3" }, CWD).consequence).toBe("Deletes rows from leads. It can't be undone.");
    expect(classifyTool("mcp__supabase-crm__execute_sql", { query: "select * from leads" }, CWD).destructive).toBe(false);
    expect(classifyTool("mcp__supabase-crm__delete_branch", { branch_id: "b1" }, CWD).consequence).toBe("Uses Supabase to delete branch. It can't be undone.");
    expect(classifyTool("mcp__google-ads__edits_remove_criteria", {}, CWD).consequence).toBe("Uses Google Ads to remove criteria. It can't be undone.");
    expect(classifyTool("mcp__claude_ai_Gmail__trash_message", { id: "x" }, CWD).destructive).toBe(false);
    expect(classifyTool("mcp__supabase-crm__apply_migration", { query: "ALTER TABLE leads ADD COLUMN source text" }, CWD).consequence).toBe("Changes the table leads. It may not be possible to undo.");
    expect(classifyTool("mcp__supabase-crm__apply_migration", { query: "ALTER TABLE leads DROP COLUMN notes" }, CWD).consequence).toBe("Deletes the column notes from leads. It can't be undone.");
  });

  it("only reads shell tools' commands; file tools are never destructive", () => {
    expect(classifyTool("Bash", { command: "rm -rf build" }, CWD).destructive).toBe(true);
    expect(classifyTool("PowerShell", { command: "Remove-Item x" }, CWD).destructive).toBe(true);
    expect(classifyTool("Write", { file_path: "a.txt", content: "rm -rf /" }, CWD).destructive).toBe(false);
    expect(classifyTool("Read", { file_path: "DROP TABLE.txt" }, CWD).destructive).toBe(false);
  });

  it("falls back to Claude's own description", () => {
    expect(destructiveFallback("Delete the old build")).toBe("Delete the old build. It can't be undone.");
    expect(destructiveFallback(undefined)).toBe("It can't be undone.");
    expect(destructiveFallback("x")).toBe("It can't be undone.");
  });
});
