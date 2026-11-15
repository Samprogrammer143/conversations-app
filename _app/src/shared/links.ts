// Where someone reports a problem with the app: a new issue on its public GitHub repository,
// from the form in .github/ISSUE_TEMPLATE/problem.md, from Settings and, on a Mac, the Help
// menu. The title carries the version and the kind of computer, so nobody has to look them
// up; nothing about the person or their conversations.

export const ISSUES_URL = "https://github.com/Samprogrammer143/conversations-app/issues";

export function reportProblemUrl(version: string, system: "Windows" | "Mac"): string {
  return `${ISSUES_URL}/new?${new URLSearchParams({ template: "problem.md", title: `Problem in Conversations ${version} on ${system}` }).toString()}`;
}

/** What Copy chat link copies: pasted into another chat's message, the app gives Claude that chat to read. */
export function chatLink(id: string, title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t ? `chat:${id} ("${t}")` : `chat:${id}`;
}

/** How the app's note on a message's chat links starts (main/chat/refs.ts): hidden from the chat, the search and the title. The sync engine's LINK_NOTE_HEAD is the same text. */
export const NOTE_HEAD = "<referenced-chats>\nThe user's message links to other conversations of theirs.";
