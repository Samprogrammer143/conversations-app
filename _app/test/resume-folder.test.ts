// The folder Claude Code has to start in for --resume to find a transcript, on real folders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cwdMatchesFolder, encodeCwd, folderForTranscript, recordedCwds } from "../src/main/resume-folder";

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
let base: string;
let site: string;
let clone: string;
let projects: string;

/** A transcript in the Claude Code folder for `cwd`, recording `recorded` as where it ran. */
function transcriptFor(cwd: string, recorded: string): string {
  const dir = path.join(projects, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", cwd: recorded, sessionId: ID })}\n`);
  return file;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "resume-folder-"));
  site = path.join(base, "Web Development", "site");
  clone = path.join(base, "Web Development", "site-seo");
  projects = path.join(base, ".claude", "projects");
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(clone, { recursive: true });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("Claude Code's transcript folders", () => {
  it("are named after the folder, every other character a dash", () => {
    expect(encodeCwd("C:\\Users\\alex\\My Projects\\Web Development\\website")).toBe("C--Users-alex-My-Projects-Web-Development-website");
    expect(cwdMatchesFolder("C:\\Users\\me\\site", "c--users-me-site")).toBe(true);
    expect(cwdMatchesFolder("C:\\Users\\me\\site", "C--Users-me-site-seo")).toBe(false);
    const long = `C:\\${"x".repeat(240)}`;
    expect(cwdMatchesFolder(long, `${encodeCwd(long).slice(0, 200)}-abc123`)).toBe(true);
  });
});

describe("the folder to resume in", () => {
  it("is the second clone when the transcript is kept there, even though the project folder was chosen", () => {
    const t = transcriptFor(clone, clone);
    expect(folderForTranscript(t, [site, clone])).toBe(clone);
    expect(folderForTranscript(t, [null, site])).toBe(clone); // found from the transcript itself
  });

  it("is the project folder when the copy is kept there", () => {
    const t = transcriptFor(site, "C:\\Users\\jordan\\Documents\\site");
    expect(folderForTranscript(t, [clone, site])).toBe(site);
    expect(recordedCwds(t)).toEqual(["C:\\Users\\jordan\\Documents\\site"]);
  });

  it("is nothing when no folder on this PC maps to the transcript", () => {
    const gone = path.join(base, "Web Development", "deleted-clone");
    const t = transcriptFor(gone, gone);
    expect(folderForTranscript(t, [site, clone])).toBeNull();
  });
});
