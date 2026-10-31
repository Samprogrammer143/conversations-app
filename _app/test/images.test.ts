import { describe, expect, it } from "vitest";
import { fitSize, MAX_BASE64, SHRINK_STEPS } from "../src/renderer/lib/images";

describe("making a big image fit", () => {
  it("scales the longest side down, keeps the shape, and never enlarges", () => {
    expect(fitSize(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(fitSize(2160, 3840, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(fitSize(800, 600, Infinity)).toEqual({ width: 800, height: 600 });
    expect(fitSize(800, 600, 1400)).toEqual({ width: 800, height: 600 });
    expect(fitSize(10000, 1, 1000).height).toBe(1);
  });
  it("counts the limit as the API does, and tries the sharpest first", () => {
    expect(MAX_BASE64).toBe(5 * 1024 * 1024);
    expect(SHRINK_STEPS[0][0]).toBe(Infinity);
    const sizes = SHRINK_STEPS.map(([l]) => l);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });
});
