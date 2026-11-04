// The "Report a problem" link (shared/links.ts): a new issue on the app's own repository, from
// its problem form, with the version and the kind of computer filled in, and nothing else.
import { describe, expect, it } from "vitest";
import { reportProblemUrl } from "../src/shared/links";

describe("the report-a-problem link", () => {
  it("opens the problem form on the app's repository with the version and the computer filled in", () => {
    const url = new URL(reportProblemUrl("0.5.27", "Mac"));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/Samprogrammer143/conversations-app/issues/new");
    expect([...url.searchParams.keys()]).toEqual(["template", "title"]);
    expect(url.searchParams.get("template")).toBe("problem.md");
    expect(url.searchParams.get("title")).toBe("Problem in Conversations 0.5.27 on Mac");
  });
});
