// Where Claude Code has to start for `--resume <id>` to find a conversation.
//
// Claude Code keeps a folder's transcripts in ~/.claude/projects/<the folder's
// full path, with every character that isn't a letter or digit turned into "-">,
// and --resume only looks there. So a conversation is continued in the folder that
// maps to its transcript's folder: the folder the conversation itself ran in, when
// that is on this PC; else the project's folder, when that maps; else any folder
// the transcript records that is on this PC. A folder Claude moved into during the
// chat (a subfolder) counts through the folders above it, since the chat started in one.

import fs from "node:fs";
import path from "node:path";

/** Claude Code's name for a folder's transcript directory. */
export function encodeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Does Claude Code keep this folder's transcripts in the directory with this name? (Long names are cut at 200 characters.) */
export function cwdMatchesFolder(cwd: string, folderName: string): boolean {
  const enc = encodeCwd(cwd).toLowerCase();
  const name = folderName.toLowerCase();
  return enc === name || (enc.length > 200 && name.startsWith(enc.slice(0, 200)));
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folders a transcript records (its "cwd" fields), in order of first use: from its
 * first and its last 256 KB. A long chat carried on from another PC records this PC's
 * folders only near its end.
 */
export function recordedCwds(transcript: string, bytes = 256 * 1024): string[] {
  let text = "";
  try {
    const fd = fs.openSync(transcript, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const head = Buffer.alloc(Math.min(bytes, size));
      text = head.toString("utf8", 0, fs.readSync(fd, head, 0, head.length, 0));
      if (size > bytes) {
        const tail = Buffer.alloc(Math.min(bytes, size - head.length));
        text += "\n" + tail.toString("utf8", 0, fs.readSync(fd, tail, 0, tail.length, size - tail.length));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const c = JSON.parse(`"${m[1]}"`);
      if (typeof c === "string" && c && !out.includes(c)) out.push(c);
    } catch {}
  }
  return out;
}

/**
 * The folder to start Claude Code in so that --resume finds this transcript: the
 * first candidate that is a folder on this PC and maps to the transcript's
 * directory, else such a folder recorded in the transcript itself, else a folder
 * above one of those (a subfolder Claude moved into during the chat). null when no
 * folder on this PC maps to it. The transcript is only read when the candidates
 * don't settle it.
 */
export function folderForTranscript(transcript: string, candidates: (string | null | undefined)[], exists: (p: string) => boolean = isDir): string | null {
  const name = path.basename(path.dirname(transcript));
  const fits = (c: string | null | undefined): c is string => !!c && cwdMatchesFolder(c, name) && exists(c);
  for (const c of candidates) if (fits(c)) return c;
  const all = [...candidates, ...recordedCwds(transcript)];
  for (const c of all) if (fits(c)) return c;
  // A subfolder the chat moved into: the folder above it that it started in.
  for (const c of all) for (const up of ancestors(c)) if (fits(up)) return up;
  return null;
}

/** The folders above `p`, nearest first, without the drive root (none for a relative or empty path). */
function ancestors(p: string | null | undefined): string[] {
  if (!p || !path.isAbsolute(p)) return [];
  const out: string[] = [];
  for (let dir = path.dirname(path.resolve(p)); dir !== path.dirname(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}
