import { describe, it, expect } from "vitest";
import { computeConvergenceScore } from "./prompts.js";
import type { OrchestratorState } from "./types.js";
import { createInitialState } from "./types.js";

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

describe("auto-approve trigger conditions", () => {
  /** Helper to evaluate auto-approve eligibility matching approve.ts logic */
  function meetsAutoApprove(state: OrchestratorState): boolean {
    const autoApproveEnabled = state.autoApproveOnConvergence !== false;
    const round = state.polishRound;
    const converged = state.polishConverged;
    const convergenceScore = state.polishConvergenceScore;
    return autoApproveEnabled && round > 0 && (
      converged || (convergenceScore !== undefined && convergenceScore >= 0.90)
    );
  }

  it("triggers when polishConverged is true", () => {
    const state = createInitialState();
    state.polishRound = 3;
    state.polishConverged = true;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("triggers when convergenceScore >= 0.90", () => {
    const state = createInitialState();
    state.polishRound = 3;
    state.polishConvergenceScore = 0.92;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("does not trigger on round 0", () => {
    const state = createInitialState();
    state.polishRound = 0;
    state.polishConverged = true;
    expect(meetsAutoApprove(state)).toBe(false);
  });

  it("does not trigger when convergence is low", () => {
    const state = createInitialState();
    state.polishRound = 2;
    state.polishConvergenceScore = 0.60;
    expect(meetsAutoApprove(state)).toBe(false);
  });

  it("does not trigger when autoApproveOnConvergence is false", () => {
    const state = createInitialState();
    state.polishRound = 3;
    state.polishConverged = true;
    state.autoApproveOnConvergence = false;
    expect(meetsAutoApprove(state)).toBe(false);
  });

  it("defaults to enabled (autoApproveOnConvergence undefined)", () => {
    const state = createInitialState();
    state.polishRound = 3;
    state.polishConvergenceScore = 0.95;
    expect(state.autoApproveOnConvergence).toBeUndefined();
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("triggers at exactly 0.90 threshold", () => {
    const state = createInitialState();
    state.polishRound = 2;
    state.polishConvergenceScore = 0.90;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("does not trigger at 0.89", () => {
    const state = createInitialState();
    state.polishRound = 2;
    state.polishConvergenceScore = 0.89;
    expect(meetsAutoApprove(state)).toBe(false);
  });
});
