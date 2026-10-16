// Starting Claude Code in a window of its own: folder names are never parsed as commands.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodePowerShell, focusScript, psQuote, terminalCommand } from "../src/main/launch";

const decode = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");

/** What PowerShell itself makes of a quoted string (sent back as UTF-8 base64, so nothing is lost on the way). */
function powershellReads(quoted: string): string {
  const script = `[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${quoted})))`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
}

describe("Open in CLI's launch", () => {
  it("uses Windows Terminal with plain arguments", () => {
    expect(terminalCommand("C:\\a&b\\100%", "C:\\x\\claude.exe", ["--resume", "id"], true)).toEqual({ file: "wt.exe", args: ["-d", "C:\\a&b\\100%", "C:\\x\\claude.exe", "--resume", "id"] });
  });

  it("goes round wt when a folder has a ;, which wt reads as a new tab", () => {
    const c = terminalCommand("C:\\x;y", "C:\\x\\claude.exe", ["--resume", "id"], true);
    expect(c.file).toBe("powershell.exe");
    expect(decode(c.args)).toBe("Start-Process -FilePath 'C:\\x\\claude.exe' -WorkingDirectory 'C:\\x;y' -ArgumentList '--resume','id'");
  });

  it("quotes everything for PowerShell so nothing is expanded or run", () => {
    expect(psQuote("it's $(calc) & `x` %PATH%")).toBe("'it''s $(calc) & `x` %PATH%'");
    const c = terminalCommand("C:\\Sam's $HOME", "C:\\x\\claude.exe", [], false);
    expect(decode(c.args)).toBe("Start-Process -FilePath 'C:\\x\\claude.exe' -WorkingDirectory 'C:\\Sam''s $HOME'");
  });

  it("doubles the typographic quotes PowerShell also ends a string at", () => {
    expect(psQuote("a\u2019; calc; #")).toBe("'a\u2019\u2019; calc; #'");
    expect(psQuote("\u2018x\u201A\u201B")).toBe("'\u2018\u2018x\u201A\u201A\u201B\u201B'");
  });

  it.skipIf(process.platform !== "win32")("PowerShell reads every quoted name back exactly, and runs nothing in it", () => {
    for (const name of ["a\u2019; Write-Output INJECTED; #", "it's $(Get-Date) `n %PATH%", "\u2018\u2019\u201A\u201B'", "C:\\x;y\\ok", "plain"]) {
      expect(powershellReads(psQuote(name)), name).toBe(name);
    }
  }, 120_000);

  it("brings a window forward only for a real process id", () => {
    expect(focusScript(4242)).toContain("$id = 4242");
    expect(() => focusScript(0)).toThrow();
    expect(() => focusScript(1.5)).toThrow();
    expect(() => focusScript(Number("12; calc"))).toThrow();
  });
});
