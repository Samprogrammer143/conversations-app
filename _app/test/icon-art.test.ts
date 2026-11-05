// The app icon's one drawing (scripts/icon-art.mjs), which the icon files, the window's own
// badge and the website are all made from.
import { describe, expect, it } from "vitest";
import { iconSvg, squirclePath, trayIconSvg, trayTemplateSvg } from "../scripts/icon-art.mjs";

describe("the app icon's drawing", () => {
  it("draws the tile with continuous corners, closed, within its square", () => {
    const d = squirclePath(100, 100, 824, 185);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    expect(nums.every((n) => Number.isFinite(n))).toBe(true);
    // Every point the path reaches (following its relative moves) stays inside the square.
    const tokens = d.split(" ");
    let x = 0, y = 0;
    const seen: [number, number][] = [];
    for (let i = 0; i < tokens.length; ) {
      const t = tokens[i++];
      const n = () => Number(tokens[i++]);
      if (t === "M" || t === "L") { x = n(); y = n(); seen.push([x, y]); }
      else if (t === "c") { n(); n(); n(); n(); x += n(); y += n(); seen.push([x, y]); }
      else if (t === "a") { n(); n(); n(); n(); n(); x += n(); y += n(); seen.push([x, y]); }
    }
    expect(seen.length).toBeGreaterThan(8);
    for (const [px, py] of seen) {
      expect(px).toBeGreaterThanOrEqual(100 - 0.01);
      expect(px).toBeLessThanOrEqual(924 + 0.01);
      expect(py).toBeGreaterThanOrEqual(100 - 0.01);
      expect(py).toBeLessThanOrEqual(924 + 0.01);
    }
    // And it comes back round to the top edge it began on (Z draws the rest of that edge).
    expect(Math.abs(y - seen[0][1])).toBeLessThan(0.05);
    expect(x).toBeLessThan(seen[0][0]);
  });

  it("has the prompt and the cursor when large, the prompt alone when small", () => {
    const big = iconSvg({ size: 256 });
    const small = iconSvg({ size: 16, small: true });
    expect(big).toContain("M 522 572 H 632");
    expect(small).not.toContain("M 522 572 H 632");
    expect(small).toContain("M 466 452 L 546 512 L 466 572");
    expect(small).not.toContain("glow)");
  });

  it("keeps each copy's gradients to itself", () => {
    const a = iconSvg({ ids: "one" });
    const b = iconSvg({ ids: "two" });
    expect(a).toContain('id="one-tile"');
    expect(a).not.toContain("two-");
    expect(b).toContain('url(#two-chat)');
  });

  it("only the Mac's drawing has the grid's margin and shadow", () => {
    expect(iconSvg({ grid: "mac" })).toContain("tshadow");
    expect(iconSvg({ grid: "full" })).not.toContain("tshadow");
  });

  it("menu bar icons are black on clear, so macOS can draw them light or dark", () => {
    for (const badge of [false, true]) {
      const svg = trayTemplateSvg(18, badge);
      const colours = new Set((svg.match(/(fill|stroke)="(#[0-9a-fA-F]{3,6})"/g) ?? []).map((m) => m.split('"')[1].toLowerCase()));
      // (White only inside the mask, which cuts the prompt out.)
      expect([...colours].every((c) => c === "#000" || c === "#fff")).toBe(true);
    }
    expect(trayTemplateSvg(36, true)).toContain('cx="19.6"');
  });

  it("the Windows tray icon gets an orange dot when Claude is waiting", () => {
    expect(trayIconSvg(16, true)).toContain("#ff9500");
    expect(trayIconSvg(16, false)).not.toContain("#ff9500");
  });
});
