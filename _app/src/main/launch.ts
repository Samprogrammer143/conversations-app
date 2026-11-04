// How Claude Code is started in a window of its own. Nothing goes through a shell
// command line: the folder and arguments are passed as arguments, so a folder
// named "a&b", "50%" or "it's" stays a folder name and never becomes a command.

// PowerShell ends a single-quoted string at any of these, not only at ': the
// typographic quotes ‘ ’ ‚ ‛ count too. Inside the string, each is written twice.
const PS_SINGLE_QUOTES = /['‘’‚‛]/g;

/** PowerShell single-quoted string: nothing inside is expanded, and no quote ends it early. */
export const psQuote = (s: string) => `'${s.replace(PS_SINGLE_QUOTES, (q) => q + q)}'`;

/** A PowerShell script as -EncodedCommand takes it (UTF-16LE, base64). */
export const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** POSIX shell single-quoted string: nothing inside is expanded, and a ' is closed, escaped and reopened. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A Mac: a new window of the Terminal app, running Claude Code in the folder. The command
 * line goes to AppleScript as an argument (argv), never inside the script's own text.
 */
export function macTerminalCommand(folder: string, exe: string, args: string[]): { file: string; args: string[] } {
  return macTerminalLine(`cd ${shQuote(folder)} && exec ${[exe, ...args].map(shQuote).join(" ")}`);
}

/** A Mac: a new Terminal window running this shell line (already quoted by the caller). */
export function macTerminalLine(line: string): { file: string; args: string[] } {
  const script = ["on run argv", 'tell application "Terminal"', "activate", "do script (item 1 of argv)", "end tell", "end run"];
  return { file: "/usr/bin/osascript", args: [...script.flatMap((l) => ["-e", l]), line] };
}

/**
 * A Mac: the Terminal window and tab running on this terminal device (ps's tty, "ttys003")
 * comes to the front. Other terminal apps are left as they are.
 */
export function macFocusCommand(tty: string): { file: string; args: string[] } | null {
  if (!/^ttys\d+$/.test(tty)) return null;
  const script = [
    "on run argv",
    'tell application "Terminal"',
    "repeat with w in windows",
    "repeat with t in tabs of w",
    "if tty of t is (item 1 of argv) then",
    "set selected of t to true",
    "set index of w to 1",
    "activate",
    "return",
    "end if",
    "end repeat",
    "end repeat",
    "end tell",
    "end run",
  ];
  return { file: "/usr/bin/osascript", args: [...script.flatMap((l) => ["-e", l]), `/dev/${tty}`] };
}

/** Windows Terminal when it is there; otherwise a plain console window through Start-Process. */
export function terminalCommand(folder: string, exe: string, args: string[], useWt: boolean): { file: string; args: string[] } {
  // wt reads ";" as "new tab": use it only when nothing passed to it has one.
  if (useWt && ![folder, exe, ...args].some((a) => a.includes(";"))) return { file: "wt.exe", args: ["-d", folder, exe, ...args] };
  const script = `Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(folder)}${args.length ? ` -ArgumentList ${args.map(psQuote).join(",")}` : ""}`;
  return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)] };
}

/**
 * A script that brings a running program's window to the front: the window of
 * the process or of the nearest parent that has one (a console window, or the
 * Windows Terminal window hosting it).
 */
export function focusScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("not a process id");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -Namespace ConvFocus -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);'",
    `$id = ${pid}`,
    "for ($i = 0; $i -lt 8 -and $id; $i++) {",
    "  $p = Get-Process -Id $id",
    "  if ($p -and $p.MainWindowHandle -ne 0) {",
    "    $h = $p.MainWindowHandle",
    "    if ([ConvFocus.W]::IsIconic($h)) { [void][ConvFocus.W]::ShowWindowAsync($h, 9) }",
    "    [void][ConvFocus.W]::SetForegroundWindow($h)",
    "    break",
    "  }",
    '  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId',
    "}",
  ].join("\n");
}
