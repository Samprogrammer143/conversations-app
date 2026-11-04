// Where someone reports a problem with the app: a new issue on its public GitHub repository,
// from the form in .github/ISSUE_TEMPLATE/problem.md, from Settings and, on a Mac, the Help
// menu. The title carries the version and the kind of computer, so nobody has to look them
// up; nothing about the person or their conversations.

export const ISSUES_URL = "https://github.com/Samprogrammer143/conversations-app/issues";

export function reportProblemUrl(version: string, system: "Windows" | "Mac"): string {
  return `${ISSUES_URL}/new?${new URLSearchParams({ template: "problem.md", title: `Problem in Conversations ${version} on ${system}` }).toString()}`;
}
