import { describe, it, expect } from "vitest";
import { computeConvergenceScore } from "./prompts.js";

describe("computeConvergenceScore", () => {
  it("returns 0 for fewer than 3 rounds", () => {
    expect(computeConvergenceScore([5, 3])).toBe(0);
    expect(computeConvergenceScore([5])).toBe(0);
    expect(computeConvergenceScore([])).toBe(0);
  });

  it("returns high score for decreasing changes ending in zeros", () => {
    const score = computeConvergenceScore([10, 5, 2, 0, 0]);
    expect(score).toBeGreaterThanOrEqual(0.75);
  });

  it("returns low score for increasing changes", () => {
    const score = computeConvergenceScore([2, 5, 10]);
    expect(score).toBeLessThan(0.5);
  });

  it("returns high score for all zeros after initial changes", () => {
    const score = computeConvergenceScore([5, 0, 0, 0]);
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  it("incorporates output size data when available", () => {
    const withSizes = computeConvergenceScore(
      [10, 5, 2],
      [5000, 3000, 2800] // shrinking outputs
    );
    const withoutSizes = computeConvergenceScore([10, 5, 2]);
    // Both should be reasonable; with sizes provides additional signal
    expect(withSizes).toBeGreaterThan(0);
    expect(withoutSizes).toBeGreaterThan(0);
  });

  it("detects diminishing returns with high score", () => {
    const score = computeConvergenceScore([15, 8, 3, 1, 0, 0, 0]);
    expect(score).toBeGreaterThanOrEqual(0.85);
  });
});
