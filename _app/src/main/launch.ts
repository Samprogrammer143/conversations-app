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
