// Windows hides the pointer while you type ("hide pointer while typing", on by default), and
// shows it again when the mouse next moves over the window you typed in. A question or folder
// picker that opens straight after typing (Enter on a chat that needs a folder, or on "New
// chat in a folder" in the search box) takes the mouse first, so the pointer stayed hidden
// over the whole app until it closed. Just before one opens, the pointer moves a pixel and
// back: to Windows that is the mouse moving, so it shows again. (Checked on 4 Nov 2026 with
// GetCursorInfo: hidden before, shown after.)

import { spawn } from "node:child_process";
import path from "node:path";
import { encodePowerShell } from "./launch";

// A pixel right, or left at the right edge of the screens (where the pointer can't go right),
// then back where it was.
const NUDGE = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$p = [System.Windows.Forms.Cursor]::Position",
  "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($p.X + 1), $p.Y)",
  "if ([System.Windows.Forms.Cursor]::Position.X -eq $p.X) { [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($p.X - 1), $p.Y) }",
  "[System.Windows.Forms.Cursor]::Position = $p",
].join("\n");

/** Windows' own PowerShell, by its full path (a bare name would be looked for in the current folder first). */
const powershell = () => path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * Makes sure the pointer shows before a dialog opens. Usually about 0.2 s; never waits longer
 * than `timeoutMs` (a slow first start after boot just leaves things as they were).
 */
export function showPointer(timeoutMs = 800, platform: NodeJS.Platform = process.platform, run: typeof spawn = spawn): Promise<void> {
  if (platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      // (Hidden: a console window would take the front from the app.)
      const child = run(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(NUDGE)], { windowsHide: true, stdio: "ignore" });
      child.on("error", finish);
      child.on("exit", finish);
    } catch {
      finish();
    }
  });
}
