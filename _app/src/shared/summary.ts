// Plain-language summaries of a group of tool calls. The index stores one per
// group; the window re-words a group while a live chat is still deciding on some
// of its calls. Each phrase says only what happened: a call with no result yet is
// something Claude asked to do, and a refused or interrupted call says so.

import type { ToolCall, ToolKind } from "./types";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortLabel = (c: ToolCall, max = 32) => (c.label.length <= max ? c.label : null);

/** "Read 3 files, searched code" — in the order things happened. */
export function summariseCalls(calls: ToolCall[]): string {
  const parts: string[] = [];
  const done = calls.filter((c) => !c.denied && !c.interrupted && !c.pending);
  if (done.length) parts.push(summariseDone(done));
  const stopped = calls.filter((c) => c.denied || c.interrupted);
  if (stopped.length === 1) parts.push(stoppedPhrase(stopped[0]));
  else if (stopped.length) parts.push(stopped.every((c) => c.denied) ? `didn't do ${stopped.length} things you said no to` : `stopped ${stopped.length} things before they finished`);
  const asked = calls.filter((c) => c.pending && !c.denied && !c.interrupted);
  if (asked.length) parts.push(askedPhrase(asked));
  return cap(parts.join(", "));
}

function stoppedPhrase(c: ToolCall): string {
  const label = shortLabel(c);
  if (c.interrupted) {
    switch (c.kind) {
      case "command":
        return label ? `stopped ${label}` : "stopped a command";
      case "edit":
        return `stopped editing ${c.label}`;
      case "write":
        return `stopped writing ${c.label}`;
      case "read":
        return `stopped reading ${c.label}`;
      case "mcp":
        return `stopped using ${c.server ?? c.label}`;
      default:
        return `stopped ${c.name}`;
    }
  }
  switch (c.kind) {
    case "command":
      return label ? `didn't run ${label}` : "didn't run a command";
    case "edit":
      return `didn't edit ${c.label}`;
    case "write":
      return `didn't write ${c.label}`;
    case "read":
      return `didn't read ${c.label}`;
    case "web":
      return "didn't open a web page";
    case "mcp":
      return `didn't use ${c.server ?? c.label}`;
    default:
      return `didn't use ${c.name}`;
  }
}

/** Calls with no result yet: Claude asked, nothing has happened. */
function askedPhrase(calls: ToolCall[]): string {
  const kinds = new Set(calls.map((c) => c.kind));
  const n = calls.length;
  if (kinds.size === 1) {
    const c = calls[0];
    const label = shortLabel(c);
    switch (c.kind) {
      case "command":
        return n === 1 ? (label ? `asked to run ${label}` : "asked to run a command") : `asked to run ${n} commands`;
      case "edit":
        return n === 1 ? `asked to edit ${c.label}` : `asked to edit ${n} files`;
      case "write":
        return n === 1 ? `asked to write ${c.label}` : `asked to write ${n} files`;
      case "read":
        return n === 1 ? `asked to read ${c.label}` : `asked to read ${n} files`;
      case "search":
        return "asked to search code";
      case "web":
        return plural(n, "asked to open a web page", "asked to open # web pages");
      case "mcp":
        return `asked to use ${c.server ?? c.label}`;
      case "agent":
        return plural(n, "asked an agent", "asked # agents");
      case "question":
        return "asked you a question";
      case "plan":
        return c.name === "ExitPlanMode" ? "proposed a plan" : "updated the to-do list";
      case "skill":
        return `asked to use the ${c.label} skill`;
      default:
        return `asked to use ${c.name}`;
    }
  }
  return `asked to use ${n} tools`;
}

function summariseDone(calls: ToolCall[]): string {
  const byKind = new Map<ToolKind, ToolCall[]>();
  for (const c of calls) {
    const list = byKind.get(c.kind) ?? [];
    list.push(c);
    byKind.set(c.kind, list);
  }
  const parts: string[] = [];
  for (const [kind, list] of byKind) {
    const n = list.length;
    const files = new Set(list.map((c) => c.label));
    switch (kind) {
      case "read":
        parts.push(files.size === 1 ? `read ${[...files][0]}` : `read ${files.size} files`);
        break;
      case "search":
        parts.push("searched code");
        break;
      case "edit":
        parts.push(files.size === 1 ? `edited ${[...files][0]}` : `edited ${files.size} files`);
        break;
      case "write": {
        // A Write over an existing file replaces it; only a new file was "created".
        const verb = list.every((c) => c.diff?.created !== false) ? "created" : "wrote";
        parts.push(files.size === 1 ? `${verb} ${[...files][0]}` : `${verb} ${files.size} files`);
        break;
      }
      case "command": {
        const short = list.length === 1 && list[0].label.length <= 28 ? list[0].label : null;
        parts.push(short ? `ran ${short}` : plural(n, "ran a command", "ran # commands"));
        break;
      }
      case "web": {
        const searches = list.filter((c) => c.name === "WebSearch").length;
        const pages = n - searches;
        if (searches) parts.push(plural(searches, "searched the web", "searched the web # times"));
        if (pages) parts.push(plural(pages, "read a web page", "read # web pages"));
        break;
      }
      case "mcp": {
        const servers = [...new Set(list.map((c) => c.server ?? c.label))];
        parts.push(servers.length === 1 ? (n === 1 ? `used ${servers[0]}` : `used ${servers[0]} ${n} times`) : `used ${servers.slice(0, 2).join(" and ")}${servers.length > 2 ? ` and ${servers.length - 2} more` : ""}`);
        break;
      }
      case "agent":
        parts.push(plural(list.filter((c) => c.name === "Agent" || c.name === "Task").length || n, "asked an agent", "asked # agents"));
        break;
      case "plan":
        parts.push(list.some((c) => c.name === "ExitPlanMode") ? "proposed a plan" : "updated the to-do list");
        break;
      case "skill":
        parts.push(files.size === 1 ? `used the ${[...files][0]} skill` : `used ${files.size} skills`);
        break;
      case "question":
        parts.push("asked you a question");
        break;
      default:
        parts.push(plural(n, `used ${list[0].name}`, "used # tools"));
    }
  }
  // Up to three phrases read in the order things happened; beyond that, lead with
  // what changed something (edits, commands) and count the rest.
  if (parts.length <= 3) return parts.join(", ");
  const kinds = [...byKind.keys()];
  const ranked = parts.map((p, i) => ({ p, rank: SIGNIFICANCE.indexOf(kinds[i]) })).sort((a, b) => a.rank - b.rank);
  return `${ranked[0].p}, ${ranked[1].p}, and ${parts.length - 2} more`;
}

const SIGNIFICANCE: ToolKind[] = ["edit", "write", "command", "question", "mcp", "web", "agent", "plan", "skill", "read", "search", "other"];
