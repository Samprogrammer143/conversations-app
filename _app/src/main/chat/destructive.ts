// Which tool requests can destroy something for good, and what the approval card
// says about it. A destructive request opens on Deny, is never offered "Always
// allow", and its card names what would be lost: "Deletes hello.txt. It can't be
// undone." The command is read the way a shell would split it, so a delete is
// found inside a pipeline, a script block, powershell -Command "…" or wsl.

import path from "node:path";

export interface Verdict {
  destructive: boolean;
  /** True when what is lost is files or folders (the card's title says so). */
  deletesFiles: boolean;
  /** "Deletes a, b and 2 more. It can't be undone." */
  consequence: string | null;
}

export interface ClassifyOptions {
  /**
   * Whether a file exists on this PC. With it, writing over a file only counts
   * when the file is there to lose; without it, every overwrite counts.
   */
  exists?: (absolutePath: string) => boolean;
}

const SAFE: Verdict = { destructive: false, deletesFiles: false, consequence: null };

/** Server label for an MCP tool name: "mcp__figma__get_screenshot" -> "Figma". */
export function serverName(tool: string): string {
  const s = tool.split("__")[1] ?? tool;
  if (/figma/i.test(s)) return "Figma";
  if (/posthog/i.test(s)) return "PostHog";
  if (/google-ads/i.test(s)) return "Google Ads";
  if (/supabase/i.test(s)) return "Supabase";
  if (/chrome/i.test(s)) return "Chrome";
  if (/linear/i.test(s)) return "Linear";
  return s.replace(/^claude_ai_/, "").replace(/[-_]+/g, " ");
}

// ------------------------------------------------------------------ shell words

/**
 * Splits a command line into simple commands (on ; & | newlines and brackets,
 * outside quotes), each a list of words with the quotes removed. The & of a
 * redirection (2>&1, >&2, &>file) stays part of its word.
 */
export function splitCommands(line: string): string[][] {
  const out: string[][] = [];
  const chars = [...line];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "&" && (/[<>]$/.test(word) || chars[i + 1] === ">")) {
      word += ch;
      inWord = true;
    } else if (";&|\n\r(){}".includes(ch)) endCommand();
    else if (/\s/.test(ch)) endWord();
    else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

const commandName = (w: string) =>
  path.win32
    .basename(w)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, "");

// Words that come before the command itself.
const PREFIXES = new Set(["sudo", "time", "nohup", "exec", "command", "call", "start", "xargs", "env", "npx", "bunx", "pnpx", "!"]);
// Shell keywords: the command is somewhere after them.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "for", "foreach", "where-object", "foreach-object", "%", "?"]);
const KNOWN = new Set(["rm", "unlink", "shred", "rimraf", "del", "erase", "rd", "rmdir", "remove-item", "ri", "clear-content", "clc", "set-content", "out-file", "git", "find", "format", "format-volume", "dd", "robocopy", "reg", "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "wsl", "iex", "invoke-expression"]);
// Programs that run SQL: only a command line that uses one is read for SQL.
const SQL_CLIENTS = new Set(["psql", "pgcli", "sqlite3", "sqlite", "litecli", "sqlite-utils", "mysql", "mariadb", "mycli", "sqlcmd", "osql", "invoke-sqlcmd", "duckdb", "clickhouse", "clickhouse-client", "cockroach", "usql", "bq", "snowsql", "turso", "prisma", "wrangler"]);
// Cloud command lines whose delete-like subcommands lose data, and the service each one talks to.
const CLOUD_CLIS: Record<string, string> = { az: "Azure", aws: "AWS", gcloud: "Google Cloud", gsutil: "Google Cloud", vercel: "Vercel", netlify: "Netlify", fly: "Fly.io", flyctl: "Fly.io", heroku: "Heroku", firebase: "Firebase", doctl: "DigitalOcean", railway: "Railway", wrangler: "Cloudflare" };
const CLOUD_VERB = /^(delete|destroy|remove|rm|rb|purge|uninstall|wipe|drop|truncate)$|^(delete|remove|destroy)-|:(destroy|reset|delete|remove)$/;

/** Short, readable form of a path: its last two parts. */
export function shortTarget(t: string, cwd: string): string {
  const clean = t.replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "");
  if (["", ".", "*", "./*", ".\\*", "*.*"].includes(clean)) return `everything in ${path.win32.basename(cwd) || cwd}`;
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  const s = parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
  return s.length > 56 ? `${s.slice(0, 26)}…${s.slice(-26)}` : s;
}

/** "a", "a and b", "a, b and c", "a, b and 2 more". */
export function listOf(items: string[]): string {
  const u = [...new Set(items)];
  if (u.length <= 1) return u[0] ?? "";
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  if (u.length === 3) return `${u[0]}, ${u[1]} and ${u[2]}`;
  return `${u[0]}, ${u[1]} and ${u.length - 2} more`;
}

interface Effects {
  deletes: string[];
  /** A delete whose targets can't be read from the command (piped in, xargs). */
  deletesUnnamed: boolean;
  sentences: string[];
  /** At least one effect is certainly permanent. */
  permanent: boolean;
  /** At least one effect might be reversible (ALTER TABLE). */
  maybe: boolean;
}

const newEffects = (): Effects => ({ deletes: [], deletesUnnamed: false, sentences: [], permanent: false, maybe: false });

/** The context of one command line: where it runs, and whether a file is there to lose. */
interface Ctx {
  cwd: string;
  folder: string;
  /** Can a relative path be trusted to mean cwd? (Not after a cd.) */
  movesAround: boolean;
  exists?: (p: string) => boolean;
}

const isRedirect = (w: string) => /^(\d|\*|&)?[<>]/.test(w);

/** Arguments that are not flags or redirections (everything after "--" counts). */
function plainArgs(args: string[]): string[] {
  const out: string[] = [];
  let rest = false;
  for (const a of args) {
    if (!rest && a === "--") {
      rest = true;
      continue;
    }
    if (!rest && a.startsWith("-")) continue;
    if (isRedirect(a)) continue;
    out.push(a);
  }
  return out;
}

/** Remove-Item / Clear-Content arguments that name what is affected. */
function psTargets(args: string[]): string[] {
  const out: string[] = [];
  const list = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-(path|literalpath|lp|pspath)$/i.test(a)) {
      if (args[k + 1] !== undefined) out.push(...list(args[++k]));
      continue;
    }
    const inline = a.match(/^-(path|literalpath|lp):(.+)$/i);
    if (inline) {
      out.push(...list(inline[2]));
      continue;
    }
    if (/^-(include|exclude|filter|erroraction|ea|warningaction|wa|informationaction|ia|credential|stream|errorvariable|ev|outvariable|ov)$/i.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith("-") || isRedirect(a)) continue;
    out.push(...list(a));
  }
  return out;
}

/**
 * The file a Set-Content / Out-File writes: -Path, -LiteralPath, -FilePath, or the
 * first word that isn't a flag or a flag's value.
 */
function psFileArg(args: string[]): string | null {
  const takesValue = /^-(value|encoding|stream|filter|include|exclude|width|inputobject|erroraction|ea|warningaction|wa|outvariable|ov|errorvariable|ev)$/i;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-(path|literalpath|lp|pspath|filepath)$/i.test(a)) return args[k + 1] ?? null;
    const inline = a.match(/^-(path|literalpath|lp|filepath):(.+)$/i);
    if (inline) return inline[2];
    if (takesValue.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith("-") || isRedirect(a)) continue;
    return a;
  }
  return null;
}

/** cmd's del and rd: flags are /S /Q /F /A:x. */
const cmdTargets = (args: string[]) => args.filter((a) => !/^\/[a-z](:.*)?$/i.test(a) && !a.startsWith("-") && !isRedirect(a));

const NULL_DEVICES = /^(\$null|nul:?|\/dev\/null|\\\\\.\\nul)$/i;

/** Redirections in a simple command: the words without them, and the files a ">" (not ">>") writes over. */
function takeRedirects(words: string[]): { rest: string[]; overwrites: string[] } {
  const rest: string[] = [];
  const overwrites: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const m = words[k].match(/^(\d|\*|&)?(>>?|<)(.*)$/);
    if (!m) {
      rest.push(words[k]);
      continue;
    }
    let target = m[3];
    if (!target && k + 1 < words.length) target = words[++k];
    if (m[2] !== ">" || !target) continue; // ">>" appends; "<" reads
    if (target.startsWith("&") || NULL_DEVICES.test(target)) continue; // 2>&1, >$null, >NUL
    overwrites.push(target);
  }
  return { rest, overwrites };
}

/** Is there a file at this path to lose? True when it can't be told. */
function existsHere(target: string, ctx: Ctx): boolean {
  if (!ctx.exists) return true;
  const t = target.replace(/^["']|["']$/g, "");
  if (/^[$%~/]/.test(t) || /[*?]/.test(t)) return true;
  const absolute = /^[a-z]:[\\/]/i.test(t) || t.startsWith("\\\\");
  if (!absolute && ctx.movesAround) return true;
  try {
    return ctx.exists(absolute ? t : path.win32.resolve(ctx.cwd, t));
  } catch {
    return true;
  }
}

function decodePowerShell(b64: string): string {
  try {
    return Buffer.from(b64, "base64").toString("utf16le");
  } catch {
    return "";
  }
}

function say(fx: Effects, text: string, permanent = true) {
  if (!fx.sentences.includes(text)) fx.sentences.push(text);
  if (permanent) fx.permanent = true;
  else fx.maybe = true;
}

/** The words that aren't flags or redirections. */
const nonFlags = (args: string[]) => args.filter((a) => !a.startsWith("-") && !isRedirect(a));

function analyse(input: string[], ctx: Ctx, fx: Effects, depth: number) {
  const { rest: words, overwrites } = takeRedirects(input);
  for (const t of overwrites) if (existsHere(t, ctx)) say(fx, `Overwrites ${shortTarget(t, ctx.cwd)}.`);
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const n = commandName(w);
    if (PREFIXES.has(n)) {
      i++;
      while (i < words.length && words[i].startsWith("-")) i++;
      continue;
    }
    if (KEYWORDS.has(n)) {
      // The command is somewhere after the keyword: `if exist x rmdir /s /q x`.
      const j = words.findIndex((x, k) => k > i && KNOWN.has(commandName(x)));
      if (j < 0) return;
      i = j;
    }
    break;
  }
  if (i >= words.length) return;
  const cmd = commandName(words[i]);
  const args = words.slice(i + 1);
  const { cwd, folder } = ctx;
  const recurse = (text: string) => {
    if (depth < 4) for (const c of splitCommands(text)) analyse(c, ctx, fx, depth + 1);
  };
  const del = (targets: string[]) => {
    if (targets.length) fx.deletes.push(...targets.map((t) => shortTarget(t, cwd)));
    else fx.deletesUnnamed = true;
    fx.permanent = true;
  };
  const overwrite = (target: string | null, sentence: (t: string) => string) => {
    if (!target) return say(fx, sentence("a file"));
    if (existsHere(target, ctx)) say(fx, sentence(shortTarget(target, cwd)));
  };

  if (CLOUD_CLIS[cmd]) {
    const shown = nonFlags(args).slice(0, 4);
    if (shown.some((a) => CLOUD_VERB.test(a.toLowerCase()))) say(fx, `Runs "${[cmd, ...shown].join(" ")}", which deletes things in ${CLOUD_CLIS[cmd]}.`);
    if (cmd !== "wrangler") return;
  }

  switch (cmd) {
    case "powershell":
    case "pwsh": {
      const k = args.findIndex((a) => /^-(c|command|ec|encodedcommand|e)$/i.test(a));
      if (k < 0) return;
      if (/^-(ec|encodedcommand|e)$/i.test(args[k])) recurse(decodePowerShell(args[k + 1] ?? ""));
      else recurse(args.slice(k + 1).join(" "));
      return;
    }
    case "cmd": {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
      if (k >= 0) recurse(args.slice(k + 1).join(" "));
      return;
    }
    case "bash":
    case "sh":
    case "zsh":
    case "dash": {
      const k = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k >= 0 && args[k + 1]) recurse(args[k + 1]);
      return;
    }
    case "wsl": {
      // wsl [-d distro] [-u user] [--cd dir] [-e|--exec|--] command…
      let k = 0;
      while (k < args.length) {
        const a = args[k];
        if (/^(-d|--distribution|-u|--user|--cd|--shell-type)$/i.test(a)) k += 2;
        else if (/^(-e|--exec|--)$/.test(a)) {
          k++;
          break;
        } else if (a.startsWith("-")) k++;
        else break;
      }
      if (k < args.length && depth < 4) analyse(args.slice(k), ctx, fx, depth + 1);
      return;
    }
    case "iex":
    case "invoke-expression":
      recurse(args.join(" "));
      return;
    case "rm":
    case "unlink":
    case "shred":
    case "rimraf":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      // In PowerShell rm is Remove-Item (-Recurse, -Path x); elsewhere a plain rm.
      del(args.some((a) => /^-(recurse|force|path|literalpath)$/i.test(a)) ? psTargets(args) : plainArgs(args));
      return;
    case "del":
    case "erase":
    case "rd":
    case "rmdir":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      // In PowerShell these are Remove-Item; in cmd and bash they delete either way.
      del(args.some((a) => /^-(recurse|force|path|literalpath)$/i.test(a)) ? psTargets(args) : cmdTargets(args));
      return;
    case "remove-item":
    case "ri":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      del(psTargets(args));
      return;
    case "clear-content":
    case "clc": {
      const t = psTargets(args).map((x) => shortTarget(x, cwd));
      say(fx, t.length ? `Empties ${listOf(t)}.` : "Empties files.");
      return;
    }
    case "set-content":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      overwrite(psFileArg(args), (t) => `Replaces the contents of ${t}.`);
      return;
    case "out-file":
      if (args.some((a) => /^-(append|noclobber|whatif)$/i.test(a))) return;
      overwrite(psFileArg(args), (t) => `Overwrites ${t}.`);
      return;
    case "tee":
      if (args.some((a) => /^(-a|--append)$/.test(a))) return;
      for (const t of plainArgs(args)) overwrite(t, (x) => `Overwrites ${x}.`);
      return;
    case "tee-object":
      if (args.some((a) => /^-append$/i.test(a))) return;
      overwrite(psFileArg(args), (t) => `Overwrites ${t}.`);
      return;
    case "format":
      if (args[0] && /^[a-z]:$/i.test(args[0])) say(fx, `Erases the drive ${args[0].toUpperCase()}.`);
      return;
    case "format-volume": {
      const k = args.findIndex((a) => /^-driveletter$/i.test(a));
      const letter = (k >= 0 ? args[k + 1] : nonFlags(args)[0])?.replace(/[:\\]+$/, "");
      say(fx, letter && /^[a-z]$/i.test(letter) ? `Erases the drive ${letter.toUpperCase()}:.` : "Erases a drive.");
      return;
    }
    case "clear-disk":
    case "remove-partition":
    case "initialize-disk":
      say(fx, cmd === "remove-partition" ? "Deletes a disk partition and everything on it." : "Erases a disk.");
      return;
    case "dd": {
      const of = args.find((a) => a.startsWith("of="));
      if (of) say(fx, `Overwrites ${shortTarget(of.slice(3), cwd)}.`);
      return;
    }
    case "robocopy":
      if (args.some((a) => /^\/(mir|purge)$/i.test(a)) && args[0] && args[1]) say(fx, `Deletes files in ${shortTarget(args[1], cwd)} that aren't in ${shortTarget(args[0], cwd)}.`);
      return;
    case "reg": {
      if (args[0]?.toLowerCase() !== "delete") return;
      const key = args.slice(1).find((a) => !a.startsWith("/"));
      const v = args.findIndex((a) => /^\/v$/i.test(a));
      if (v >= 0 && args[v + 1]) say(fx, `Deletes the registry value ${args[v + 1]}${key ? ` in ${key}` : ""}.`);
      else if (args.some((a) => /^\/va$/i.test(a))) say(fx, `Deletes every value in the registry key ${key ?? ""}.`.replace(" .", "."));
      else say(fx, key ? `Deletes the registry key ${key} and everything in it.` : "Deletes a registry key.");
      return;
    }
    case "remove-itemproperty":
    case "rp": {
      const k = args.findIndex((a) => /^-name$/i.test(a));
      const name = k >= 0 ? args[k + 1] : nonFlags(args)[1];
      const where = psTargets(args.filter((_, j) => j !== k && j !== k + 1))[0];
      say(fx, `Deletes the ${name ? `value ${name}` : "values"}${where ? ` in ${where}` : ""}.`);
      return;
    }
    case "sc":
      if (args[0]?.toLowerCase() === "delete" && args[1]) say(fx, `Deletes the Windows service ${args[1]}.`);
      return;
    case "find": {
      const deletes = args.includes("-delete") || args.some((a, k) => /^-exec(dir)?$/.test(a) && /^(rm|del|unlink|shred)$/.test(commandName(args[k + 1] ?? "")));
      if (!deletes) return;
      const dir = args.find((a) => !a.startsWith("-") && a !== "!") ?? ".";
      say(fx, `Deletes the files find matches in ${dir === "." ? folder : shortTarget(dir, cwd)}.`);
      return;
    }
    case "git":
      gitEffects(args, folder, cwd, fx);
      return;
    case "gh":
      ghEffects(args, fx);
      return;
    case "curl": {
      const m = methodOf(args, /^(-X|--request)$/, /^(?:-X|--request=)(.+)$/);
      if (m === "DELETE") say(fx, `Sends a DELETE request to ${urlShown(args)}.`);
      return;
    }
    case "wget": {
      const m = methodOf(args, /^--method$/, /^--method=(.+)$/);
      if (m === "DELETE") say(fx, `Sends a DELETE request to ${urlShown(args)}.`);
      return;
    }
    case "invoke-webrequest":
    case "iwr":
    case "invoke-restmethod":
    case "irm": {
      const m = methodOf(args, /^-method$/i, /^-method:(.+)$/i);
      if (m === "DELETE") say(fx, `Sends a DELETE request to ${urlShown(args)}.`);
      return;
    }
    case "terraform":
    case "tofu":
    case "pulumi": {
      const sub = nonFlags(args)[0]?.toLowerCase();
      const destroy = sub === "destroy" || (sub === "apply" && args.some((a) => /^-{1,2}destroy$/.test(a))) || (cmd === "pulumi" && sub === "down");
      if (!destroy) return;
      const target = args.find((a) => /^-target=/.test(a))?.slice(8);
      const tool = cmd === "pulumi" ? "Pulumi" : cmd === "tofu" ? "OpenTofu" : "Terraform";
      say(fx, target ? `Destroys ${target}, managed by ${tool}.` : `Destroys everything ${tool} manages for ${folder}.`);
      return;
    }
    case "kubectl":
    case "oc": {
      const pos = nonFlags(args);
      if (pos[0]?.toLowerCase() !== "delete") return;
      const k = args.findIndex((a) => /^(-f|--filename)$/.test(a));
      const file = k >= 0 ? args[k + 1] : args.find((a) => /^--filename=/.test(a))?.slice(11);
      const what = file ? `what ${shortTarget(file, cwd)} describes` : pos.slice(1).join(" ") || "resources";
      say(fx, `Deletes ${what}${args.includes("--all") ? " (all of them)" : ""} from the Kubernetes cluster.`);
      return;
    }
    case "helm": {
      const pos = nonFlags(args);
      if (/^(uninstall|delete|del|un)$/i.test(pos[0] ?? "")) say(fx, `Uninstalls the Helm release${pos[1] ? ` ${pos[1]}` : ""} from the Kubernetes cluster.`);
      return;
    }
    case "supabase": {
      const pos = nonFlags(args).map((a) => a.toLowerCase());
      const where = args.includes("--linked") ? "the linked Supabase project's database" : args.some((a) => /^--db-url/.test(a)) ? "that database" : "the local Supabase database";
      if (pos[0] === "db" && pos[1] === "reset") say(fx, `Deletes all data in ${where} and rebuilds it from the migrations.`);
      else if (pos.some((a) => /^(delete|rm|remove|unset|drop)$/.test(a))) say(fx, `Runs "supabase ${pos.slice(0, 3).join(" ")}", which deletes things in Supabase.`);
      return;
    }
    case "docker":
    case "podman":
      dockerEffects(args, cmd, fx);
      return;
    case "docker-compose":
      dockerEffects(["compose", ...args], "docker", fx);
      return;
    default:
      if (cmd.startsWith("mkfs")) {
        const t = plainArgs(args).pop();
        say(fx, t ? `Formats ${t}.` : "Formats a drive.");
      }
  }
}

/** The HTTP method a command line asks for, upper case ("-X DELETE", "-XDELETE", "--request=DELETE"). */
function methodOf(args: string[], spaced: RegExp, joined: RegExp): string | null {
  for (let k = 0; k < args.length; k++) {
    if (spaced.test(args[k]) && args[k + 1]) return args[k + 1].toUpperCase();
    const m = args[k].match(joined);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** The address a request goes to, without its scheme, credentials or query. */
function urlShown(args: string[]): string {
  const k = args.findIndex((a) => /^-uri$/i.test(a));
  const u = (k >= 0 ? args[k + 1] : undefined) ?? args.find((a) => /^https?:\/\//i.test(a));
  if (!u) return "a web address";
  const s = u.replace(/^https?:\/\/([^@/]*@)?/i, "").replace(/\?.*$/, "");
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

function ghEffects(args: string[], fx: Effects) {
  const pos = nonFlags(args);
  const sub = pos[0]?.toLowerCase();
  if (sub === "api") {
    const m = methodOf(args, /^(-X|--method)$/, /^(?:-X|--method=)(.+)$/);
    if (m !== "DELETE") return;
    // The endpoint: the first word after "api" that isn't a flag or a flag's value.
    const takesValue = /^(-X|--method|-H|--header|-f|--raw-field|-F|--field|--input|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/;
    let endpoint: string | null = null;
    for (let k = args.findIndex((a) => a.toLowerCase() === "api") + 1; k > 0 && k < args.length; k++) {
      if (takesValue.test(args[k])) k++;
      else if (!args[k].startsWith("-")) {
        endpoint = args[k];
        break;
      }
    }
    say(fx, `Sends a DELETE request to GitHub: ${endpoint ?? "an API address"}.`);
    return;
  }
  const verb = pos[1]?.toLowerCase();
  if (sub === "repo" && verb === "delete") return say(fx, pos[2] ? `Deletes the GitHub repository ${pos[2]}.` : "Deletes this GitHub repository.");
  if (verb === "delete" || (sub === "extension" && verb === "remove")) say(fx, `Deletes the GitHub ${sub}${pos[2] ? ` ${pos[2]}` : ""}.`);
}

function dockerEffects(args: string[], cmd: string, fx: Effects) {
  const pos = nonFlags(args).map((a) => a.toLowerCase());
  const has = (re: RegExp) => args.some((a) => re.test(a));
  const names = (from: number) => nonFlags(args).slice(from);
  if (pos[0] === "volume" && (pos[1] === "rm" || pos[1] === "remove")) {
    const v = names(2);
    return say(fx, v.length ? `Deletes the ${cmd === "podman" ? "Podman" : "Docker"} volume${v.length > 1 ? "s" : ""} ${listOf(v)} and the data in ${v.length > 1 ? "them" : "it"}.` : "Deletes Docker volumes and their data.");
  }
  if (pos[0] === "volume" && pos[1] === "prune") return say(fx, `Deletes ${has(/^(-a|--all)$/) ? "all" : "unused"} Docker volumes and their data.`);
  if (pos[0] === "system" && pos[1] === "prune") return say(fx, `Deletes unused Docker containers, networks, images and build cache${has(/^--volumes$/) ? ", and unused volumes with their data" : ""}.`);
  if (pos[0] === "compose" && pos[1] === "down" && has(/^(-v|--volumes)$/)) return say(fx, "Deletes this Compose project's volumes and their data.");
}

function gitEffects(args: string[], folder: string, cwd: string, fx: Effects) {
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") k += 2;
    else if (a.startsWith("-")) k++;
    else break;
  }
  const sub = (args[k] ?? "").toLowerCase();
  const rest = args.slice(k + 1);
  const has = (re: RegExp) => rest.some((a) => re.test(a));
  const names = rest.filter((a) => !a.startsWith("-"));
  const changesTo = (paths: string[]) =>
    paths.length === 0 || paths.some((p) => [".", "./", ":/", "*"].includes(p)) ? `Discards uncommitted changes in ${folder}.` : `Discards uncommitted changes to ${listOf(paths.map((p) => shortTarget(p, cwd)))}.`;
  switch (sub) {
    case "push": {
      const remote = names[0] ?? "the remote";
      const refs = names.slice(1);
      const deleting = has(/^(--delete|-d)$/) || refs.some((r) => r.startsWith(":"));
      const forcing = has(/^(--force|-f|--force-with-lease(=.*)?|--force-if-includes)$/) || refs.some((r) => r.startsWith("+"));
      const shown = refs.map((r) => r.replace(/^[+:]/, "")).filter(Boolean);
      if (has(/^--mirror$/)) say(fx, `Makes ${remote} match this repository exactly, deleting anything else there.`);
      else if (deleting) say(fx, `Deletes ${shown.length ? listOf(shown) : "the branch"} on ${remote}.`);
      else if (forcing) say(fx, `Overwrites ${shown.length ? listOf(shown) : "the branch"} on ${remote}.`);
      return;
    }
    case "reset":
      if (has(/^--hard$/)) say(fx, `Discards uncommitted changes in ${folder}.`);
      return;
    case "clean":
      if (has(/^(--force|-[a-zA-Z]*f[a-zA-Z]*)$/) && !has(/^(--dry-run|-[a-zA-Z]*n[a-zA-Z]*)$/)) say(fx, `Deletes untracked files in ${folder}${has(/^-[a-zA-Z]*[xX][a-zA-Z]*$/) ? ", including ignored ones" : ""}.`);
      return;
    case "branch":
      if (has(/^-D$/) || (has(/^(-d|--delete)$/) && has(/^(-f|--force)$/))) say(fx, names.length ? `Deletes the branch${names.length > 1 ? "es" : ""} ${listOf(names)}, even if not merged.` : "Deletes a branch, even if not merged.");
      return;
    case "checkout": {
      const dd = rest.indexOf("--");
      if (dd >= 0) say(fx, changesTo(rest.slice(dd + 1)));
      else if (has(/^(-f|--force)$/) || names.includes(".")) say(fx, `Discards uncommitted changes in ${folder}.`);
      return;
    }
    case "restore": {
      const staged = has(/^(--staged|-S)$/);
      const worktree = has(/^(--worktree|-W)$/);
      if (staged && !worktree) return;
      const paths: string[] = [];
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === "-s" || a === "--source") j++;
        else if (!a.startsWith("-")) paths.push(a);
      }
      say(fx, changesTo(paths));
      return;
    }
    case "stash":
      if (names[0] === "drop") say(fx, "Deletes a stashed change.");
      else if (names[0] === "clear") say(fx, "Deletes every stashed change.");
      return;
    case "update-ref":
      if (has(/^-d$/)) say(fx, names[0] ? `Deletes the ref ${names[0]}.` : "Deletes a ref.");
      return;
    case "filter-branch":
    case "filter-repo":
      say(fx, "Rewrites this repository's history.");
      return;
  }
}

const SQL_KINDS = "TABLE|DATABASE|SCHEMA|MATERIALIZED\\s+VIEW|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|EXTENSION|POLICY|ROLE|USER|SEQUENCE";
const NAME = '([\\w."`\\[\\]-]+)';

/** Statements in SQL text that delete or change data for good. */
function sqlEffects(text: string, fx: Effects) {
  const name = (s: string) => s.replace(/["`[\]]/g, "");
  let m: RegExpExecArray | null;
  const dropCol = new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${NAME}\\s+DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}`, "gi");
  while ((m = dropCol.exec(text))) say(fx, `Deletes the column ${name(m[2])} from ${name(m[1])}.`);
  const drop = new RegExp(`\\bDROP\\s+(${SQL_KINDS})\\s+(?:IF\\s+EXISTS\\s+)?${NAME}`, "gi");
  while ((m = drop.exec(text))) {
    const kind = m[1].toLowerCase().replace(/\s+/g, " ");
    say(fx, kind === "table" ? `Deletes the table ${name(m[2])} and all its rows.` : `Deletes the ${kind} ${name(m[2])}.`);
  }
  const trunc = new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?${NAME}`, "gi");
  while ((m = trunc.exec(text))) say(fx, `Deletes every row in ${name(m[1])}.`);
  const delFrom = new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${NAME}`, "gi");
  while ((m = delFrom.exec(text))) say(fx, `Deletes rows from ${name(m[1])}.`);
  // UPDATE with no WHERE changes every row; one statement at a time.
  for (const stmt of text.split(";")) {
    const u = stmt.match(new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?${NAME}\\s+SET\\b`, "i"));
    if (u && !/\bWHERE\b/i.test(stmt)) say(fx, `Changes every row in ${name(u[1])}.`);
  }
  // The name must end where the name ends (no backtracking into it), and not be followed by DROP.
  const alter = new RegExp(`\\bALTER\\s+(TABLE|DATABASE|SCHEMA)\\s+(?:IF\\s+EXISTS\\s+)?${NAME}(?![\\w."\`\\[\\]-]|\\s+DROP\\b)`, "gi");
  while ((m = alter.exec(text))) say(fx, `Changes the ${m[1].toLowerCase()} ${name(m[2])}.`, false);
}

function sentenceOf(fx: Effects): string | null {
  const parts: string[] = [];
  if (fx.deletes.length) parts.push(`Deletes ${listOf(fx.deletes)}.`);
  else if (fx.deletesUnnamed && !fx.sentences.length) parts.push("Deletes the files the command finds.");
  parts.push(...fx.sentences);
  if (!parts.length) return null;
  const shown = parts.slice(0, 3);
  if (parts.length > 3) shown.push(`And ${parts.length - 3} more change${parts.length - 3 === 1 ? "" : "s"}.`);
  shown.push(fx.permanent || !fx.maybe ? "It can't be undone." : "It may not be possible to undo.");
  return shown.join(" ");
}

const MOVES = new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location"]);

/** What a shell command would destroy, if anything. */
export function classifyCommand(command: string, cwd: string, opts: ClassifyOptions = {}): Verdict {
  const fx = newEffects();
  const commands = splitCommands(command);
  const ctx: Ctx = { cwd, folder: path.win32.basename(cwd) || cwd, movesAround: commands.some((c) => MOVES.has(commandName(c[0] ?? ""))), exists: opts.exists };
  for (const words of commands) analyse(words, ctx, fx, 0);
  // SQL is only read when the line runs something that runs SQL (psql, sqlite3, …), so
  // "git commit -m 'update docs set'" is left alone.
  if (commands.some((c) => c.some((w) => SQL_CLIENTS.has(commandName(w))))) sqlEffects(command, fx);
  const destructive = fx.deletes.length > 0 || fx.deletesUnnamed || fx.sentences.length > 0;
  if (!destructive) return SAFE;
  return { destructive, deletesFiles: fx.deletes.length > 0 || fx.deletesUnnamed, consequence: sentenceOf(fx) };
}

const MCP_VERBS = new Set(["delete", "drop", "remove", "truncate", "destroy", "purge", "wipe", "erase", "reset"]);

/** "deleteFile" -> ["delete", "file"]; "drop-table", "delete_branch" alike. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function strings(v: unknown, out: string[] = [], depth = 0, key = ""): string[] {
  if (out.length > 60 || depth > 6) return out;
  if (typeof v === "string") out.push(v.slice(0, 20_000));
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1, key);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, out, depth + 1, k);
  return out;
}

/** SQL an MCP tool carries: every text of a database tool, or the text of a field named like SQL. */
function sqlInputs(toolName: string, input: Record<string, unknown>): string[] {
  if (/sql|query|migration|database|(^|[_\-.])db($|[_\-.])/i.test(toolName.split("__").slice(2).join("__"))) return strings(input);
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) if (/^(sql|query|statements?|migration)$/i.test(k)) strings(v, out);
  return out;
}

/** A tool request's verdict: shell commands are read word by word; MCP tools by name and by any SQL they carry. */
export function classifyTool(toolName: string, input: Record<string, unknown>, cwd: string, opts: ClassifyOptions = {}): Verdict {
  if (toolName === "Bash" || toolName === "PowerShell") return typeof input.command === "string" ? classifyCommand(input.command, cwd, opts) : SAFE;
  if (!toolName.startsWith("mcp__")) return SAFE;
  const fx = newEffects();
  for (const s of sqlInputs(toolName, input)) sqlEffects(s, fx);
  const words = nameWords(toolName.split("__").slice(2).join("__"));
  const at = words.findIndex((w) => MCP_VERBS.has(w));
  if (at >= 0) {
    fx.sentences.unshift(`Uses ${serverName(toolName)} to ${words.slice(at).join(" ")}.`);
    fx.permanent = true;
  }
  if (!fx.sentences.length) return SAFE;
  return { destructive: true, deletesFiles: false, consequence: sentenceOf(fx) };
}

/** For a request flagged destructive that the command can't explain: Claude's own words ("Delete the old build"). */
export function destructiveFallback(description: unknown): string {
  const d = typeof description === "string" ? description.trim().replace(/[.\s]+$/, "") : "";
  return d && /\s/.test(d) ? `${d.charAt(0).toUpperCase()}${d.slice(1)}. It can't be undone.` : "It can't be undone.";
}
