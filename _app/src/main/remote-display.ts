// The sync repository's address as the window shows it. A remote can carry a
// login (https://user:token@github.com/…); none of that ever reaches the window.

/** Removes "user:password@" (and a bare "token@") from every URL in a text, such as a git error message. */
export function stripUrlCredentials(text: string): string;
export function stripUrlCredentials(text: string | null | undefined): string | null;
export function stripUrlCredentials(text: string | null | undefined): string | null {
  if (text == null) return null;
  return String(text).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1");
}

/** "https://user:token@github.com/a/b.git" -> "a/b"; other hosts keep their name; no login, ever. */
export function displayRemote(remote: string | null | undefined): string | null {
  if (!remote || typeof remote !== "string") return null;
  const r = remote.trim();
  // A folder on this PC (the development sandbox's stand-in for GitHub): no login to hide.
  if (/^[a-z]:[\\/]/i.test(r) || /^(\\\\|\/|\.)/.test(r)) return r;
  let host: string;
  let repoPath: string;
  const scp = r.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/); // git@github.com:owner/repo.git
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const u = new URL(r);
      host = u.hostname;
      repoPath = decodeURIComponent(u.pathname);
    } catch {
      return stripUrlCredentials(r);
    }
  }
  repoPath = repoPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return host.toLowerCase() === "github.com" ? repoPath : `${host}/${repoPath}`;
}
