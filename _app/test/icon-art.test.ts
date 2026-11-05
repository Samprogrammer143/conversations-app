// The app icon's one drawing (scripts/icon-art.mjs), which the icon files, the window's own
// badge and the website are all made from.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS, iconSvg, markSvg, squirclePath, trayIconSvg, trayTemplateSvg } from "../scripts/icon-art.mjs";

type Pt = [number, number];
// The chat alone's prompt and cursor as drawn: their points, the stroke and the placing transform.
function strokes(svg: string) {
  const [tx, ty, s] = svg.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/)!.slice(1).map(Number);
  const paths = [...svg.matchAll(/<path d="(M [^"]+)" fill="none" stroke="#fff" stroke-width="(\d+)"/g)];
  const points = (d: string) => {
    const t = d.split(" ");
    const pts: Pt[] = [];
    for (let i = 0; i < t.length; ) {
      const c = t[i++];
      if (c === "M" || c === "L") pts.push([Number(t[i++]), Number(t[i++])]);
      else if (c === "H") pts.push([Number(t[i++]), pts[pts.length - 1][1]]);
    }
    return pts;
  };
  return { tx, ty, s, sw: Number(paths[0][2]), prompt: points(paths[0][1]), cursor: points(paths[1][1]) };
}
// Closely spaced points along a line through these points.
function along(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [a, b] = [pts[k], pts[k + 1]];
    for (let j = 0; j <= 40; j++) out.push([a[0] + ((b[0] - a[0]) * j) / 40, a[1] + ((b[1] - a[1]) * j) / 40]);
  }
  return out;
}
const nearest = (a: Pt[], b: Pt[]) => Math.min(...a.flatMap((p) => b.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));

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

  it("the Windows tray icon gets an orange dot when Claude is waiting, in a gap cut out of the chat", () => {
    const svg = trayIconSvg(16, true);
    const circle = (fill: string) => svg.match(new RegExp(`<circle cx="([\\d.]+)" cy="([\\d.]+)" r="([\\d.]+)" fill="${fill}"/>`))!.slice(1).map(Number);
    const [gx, gy, gr] = circle("#000");
    const [dx, dy, dr] = circle("#ff9500");
    expect([gx, gy]).toEqual([dx, dy]);
    // A clear ring round the dot, and the dot wholly inside the icon.
    expect(gr - dr).toBeGreaterThanOrEqual(40);
    expect(Math.min(dx - dr, dy - dr)).toBeGreaterThanOrEqual(0);
    expect(Math.max(dx + dr, dy + dr)).toBeLessThanOrEqual(1024);
    // The gap cuts only the chat's corner, never the prompt or the cursor.
    const { tx, ty, s, sw, prompt, cursor } = strokes(svg);
    const drawn = [...along(prompt), ...along(cursor)].map(([x, y]) => Math.hypot(tx + x * s - gx, ty + y * s - gy));
    expect(Math.min(...drawn) - (sw / 2) * s).toBeGreaterThan(gr);
    expect(svg).toContain('mask="url(#tb-gap)"');
    const plain = trayIconSvg(16, false);
    expect(plain).not.toContain("#ff9500");
    expect(plain).not.toContain("<mask");
  });

  it("Windows' icon is the chat alone: no tile, the prompt and cursor at every size, bolder when small", () => {
    for (const svg of [markSvg({ size: 256 }), markSvg({ size: 16, small: true })]) expect(svg).not.toContain("-tile");
    const big = strokes(markSvg({ size: 256 }));
    const small = strokes(markSvg({ size: 16, small: true }));
    for (const x of [big, small]) {
      expect(x.prompt).toHaveLength(3);
      expect(x.cursor).toHaveLength(2);
    }
    expect(small.sw).toBeGreaterThan(big.sw);
  });

  it("keeps the prompt and the cursor apart, even at 16 px", () => {
    // (Edge to edge, in pixels: at 16 px a bolder stroke once ran the two into one blob.)
    for (const [small, px] of [[true, 16], [false, 40]] as const) {
      const { s, sw, prompt, cursor } = strokes(markSvg({ small }));
      const clear = (nearest(along(prompt), along(cursor)) - sw) * s;
      expect((clear / 1024) * px).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("each copy's mask and gradient follow its ids", () => {
    const svg = markSvg({ ids: "a", gap: { x: 800, y: 200, r: 100 } });
    expect(svg).toContain('id="a-gap"');
    expect(svg).toContain('mask="url(#a-gap)"');
    expect(svg).toContain("url(#a-chat)");
    expect(svg).not.toContain("mk-");
  });

  it("the Mac's tile is a mid graphite, not near-black", () => {
    const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
    expect(lum(COLORS.tileTop)).toBeGreaterThan(80);
    expect(lum(COLORS.tileBottom)).toBeGreaterThan(35);
    expect(iconSvg({ grid: "mac" })).toContain(COLORS.tileTop);
  });

  it("the workspace letter badge is on the same tile colours", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "..", "src", "renderer", "styles", "layout.css"), "utf8").toLowerCase();
    expect(css).toContain(`linear-gradient(180deg, ${COLORS.tileTop.toLowerCase()}, ${COLORS.tileBottom.toLowerCase()})`);
  });
});
