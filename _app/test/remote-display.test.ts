// M4: the sync repository's address reaches the window without any login in it.
import { describe, expect, it } from "vitest";
import { displayRemote, stripUrlCredentials } from "../src/main/remote-display";

describe("the repository as Settings shows it", () => {
  it("is owner/repo for GitHub, whatever form the remote takes", () => {
    expect(displayRemote("https://github.com/AcmeDev/claude-conversations.git")).toBe("AcmeDev/claude-conversations");
    expect(displayRemote("https://alex:ghp_abc123SECRET@github.com/AcmeDev/claude-conversations.git")).toBe("AcmeDev/claude-conversations");
    expect(displayRemote("https://x-access-token:ghs_SECRET@github.com/a/b")).toBe("a/b");
    expect(displayRemote("git@github.com:a/b.git")).toBe("a/b");
    expect(displayRemote("ssh://git@github.com:22/a/b.git")).toBe("a/b");
  });

  it("keeps other hosts' names, never their logins", () => {
    expect(displayRemote("https://oauth2:glpat-SECRET@gitlab.example.com/group/sub/repo.git")).toBe("gitlab.example.com/group/sub/repo");
    expect(displayRemote("C:\\Users\\me\\AppData\\Local\\Conversations-dev\\github-standin.git")).toBe("C:\\Users\\me\\AppData\\Local\\Conversations-dev\\github-standin.git");
    expect(displayRemote(null)).toBeNull();
    for (const r of ["https://alex:ghp_abc123SECRET@github.com/a/b.git", "https://oauth2:glpat-SECRET@gitlab.example.com/x.git", "https://ghp_TOKENONLY@github.com/a/b"]) {
      expect(displayRemote(r), r).not.toMatch(/SECRET|TOKENONLY|ghp_|glpat/);
    }
  });

  it("takes logins out of git's messages and web addresses too", () => {
    expect(stripUrlCredentials("fatal: unable to access 'https://alex:ghp_SECRET@github.com/a/b.git/': Could not resolve host")).toBe("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host");
    expect(stripUrlCredentials("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(stripUrlCredentials(null)).toBeNull();
  });
});
