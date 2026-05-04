import { describe, it, expect } from "vitest";
import {
  computeForegoneScore,
  computeGraphHealthScore,
  formatForegoneScore,
  type ForegoneInputs,
  type ForegoneScore,
} from "./foregone.js";
import type { BvInsights } from "./types.js";
import type { PlanQualityScore } from "./plan-quality.js";
import type { PlanCoverageResult } from "./plan-coverage.js";

// ─── Helper factories ───────────────────────────────────────

function makeHighQualityInputs(): ForegoneInputs {
  return {
    planQuality: {
      overall: 85, workflows: 90, edgeCases: 80, architecture: 85,
      specificity: 80, testability: 75, weakSections: [], recommendation: "proceed",
    },
    convergenceScore: 0.92,
    beadQualityPassRate: { passed: 10, total: 10 },
    graphInsights: {
      Bottlenecks: [], Cycles: null, Orphans: [], Articulation: [],
      Slack: [],
    },
    planCoverage: {
      overall: 90, sections: [], gaps: [], totalSections: 5, coveredSections: 5,
    },
  };
}

function makeLowQualityInputs(): ForegoneInputs {
  return {
    planQuality: {
      overall: 40, workflows: 30, edgeCases: 40, architecture: 50,
      specificity: 40, testability: 30, weakSections: ["Testing"], recommendation: "block",
    },
    convergenceScore: 0.3,
    beadQualityPassRate: { passed: 3, total: 10 },
    graphInsights: {
      Bottlenecks: [{ ID: "b-1", Value: 0.8 }],
      Cycles: [["b-1", "b-2"]],
      Orphans: ["b-5", "b-6"],
      Articulation: ["b-3"],
      Slack: [],
    },
    planCoverage: {
      overall: 35, sections: [], gaps: [
        { heading: "Testing", preview: "...", score: 10, matchedBeadIds: [], uncovered: true },
      ], totalSections: 5, coveredSections: 2,
    },
  };
}

// ─── computeForegoneScore ───────────────────────────────────

describe("computeForegoneScore", () => {
  it("returns 'foregone' for high-quality inputs", () => {
    const score = computeForegoneScore(makeHighQualityInputs());
    expect(score.overall).toBeGreaterThanOrEqual(80);
    expect(score.recommendation).toBe("foregone");
    expect(score.isForegonable).toBe(true);
    expect(score.blockers).toHaveLength(0);
  });

  it("returns 'not_ready' for low-quality inputs", () => {
    const score = computeForegoneScore(makeLowQualityInputs());
    expect(score.overall).toBeLessThan(60);
    expect(score.recommendation).toBe("not_ready");
    expect(score.isForegonable).toBe(false);
    expect(score.blockers.length).toBeGreaterThan(0);
  });

  it("returns 'almost' for mid-range inputs", () => {
    const inputs = makeHighQualityInputs();
    inputs.planQuality!.overall = 65;
    inputs.convergenceScore = 0.6;
    const score = computeForegoneScore(inputs);
    expect(score.recommendation).toBe("almost");
  });

  it("defaults missing signals to 50 (neutral)", () => {
    const score = computeForegoneScore({
      planQuality: null,
      convergenceScore: null,
      beadQualityPassRate: null,
      graphInsights: null,
      planCoverage: null,
    });
    expect(score.planReady).toBe(50);
    expect(score.beadConvergence).toBe(50);
    expect(score.beadQuality).toBe(50);
    expect(score.graphHealth).toBe(50);
    expect(score.planCoverage).toBe(50);
    expect(score.overall).toBe(50);
    // No blockers since nothing was measured
    expect(score.blockers).toHaveLength(0);
  });

  it("generates plan quality blocker when score < 70", () => {
    const inputs = makeHighQualityInputs();
    inputs.planQuality = {
      overall: 55, workflows: 50, edgeCases: 50, architecture: 60,
      specificity: 55, testability: 50, weakSections: [], recommendation: "block",
    };
    const score = computeForegoneScore(inputs);
    expect(score.blockers.some(b => b.includes("Plan quality"))).toBe(true);
  });

  it("generates convergence blocker when < 70%", () => {
    const inputs = makeHighQualityInputs();
    inputs.convergenceScore = 0.4;
    const score = computeForegoneScore(inputs);
    expect(score.blockers.some(b => b.includes("converged"))).toBe(true);
  });

  it("generates bead quality blocker when pass rate < 70%", () => {
    const inputs = makeHighQualityInputs();
    inputs.beadQualityPassRate = { passed: 5, total: 10 };
    const score = computeForegoneScore(inputs);
    expect(score.blockers.some(b => b.includes("quality issues"))).toBe(true);
  });

  it("uses structural check pass rate when provided so partial fixes move the score", () => {
    const inputs = makeHighQualityInputs();
    inputs.beadQualityPassRate = {
      passed: 8,
      total: 10,
      passedChecks: 52,
      totalChecks: 60,
      failuresByCheck: { "has-acceptance-criteria": 4, "template-hygiene": 4 },
    };
    const score = computeForegoneScore(inputs);
    expect(score.beadQuality).toBe(87);
    expect(score.blockers.some((b) => b.includes("structural quality check"))).toBe(false);

    inputs.beadQualityPassRate = {
      passed: 8,
      total: 10,
      passedChecks: 36,
      totalChecks: 60,
      failuresByCheck: { "has-acceptance-criteria": 12, "template-hygiene": 12 },
    };
    const lower = computeForegoneScore(inputs);
    expect(lower.beadQuality).toBe(60);
    expect(lower.blockers.some((b) => b.includes("structural quality check"))).toBe(true);
  });

  it("generates graph health blocker for cycles", () => {
    const inputs = makeHighQualityInputs();
    inputs.graphInsights = {
      Bottlenecks: [], Cycles: [["a", "b"]], Orphans: [], Articulation: [], Slack: [],
    };
    const score = computeForegoneScore(inputs);
    expect(score.blockers.some(b => b.includes("Graph issues"))).toBe(true);
    expect(score.blockers.some(b => b.includes("cycle"))).toBe(true);
  });

  it("generates coverage blocker when < 70%", () => {
    const inputs = makeHighQualityInputs();
    inputs.planCoverage = {
      overall: 50, sections: [], gaps: [
        { heading: "X", preview: "", score: 20, matchedBeadIds: [], uncovered: true },
        { heading: "Y", preview: "", score: 30, matchedBeadIds: [], uncovered: true },
      ], totalSections: 4, coveredSections: 2,
    };
    const score = computeForegoneScore(inputs);
    expect(score.blockers.some(b => b.includes("coverage"))).toBe(true);
  });

  it("is not foregonable when blockers exist even if overall >= 70", () => {
    const inputs = makeHighQualityInputs();
    // High scores everywhere except one dimension
    inputs.planQuality!.overall = 50;
    const score = computeForegoneScore(inputs);
    // Overall might still be >= 70 from other dimensions, but blockers exist
    expect(score.isForegonable).toBe(false);
  });

  it("weights dimensions correctly", () => {
    // All dimensions at 100 should give 100
    const perfect = computeForegoneScore({
      planQuality: { overall: 100, workflows: 100, edgeCases: 100, architecture: 100, specificity: 100, testability: 100, weakSections: [], recommendation: "proceed" },
      convergenceScore: 1.0,
      beadQualityPassRate: { passed: 10, total: 10 },
      graphInsights: { Bottlenecks: [], Cycles: null, Orphans: [], Articulation: [], Slack: [] },
      planCoverage: { overall: 100, sections: [], gaps: [], totalSections: 1, coveredSections: 1 },
    });
    expect(perfect.overall).toBe(100);

    // All at 0 should give 0
    const zero = computeForegoneScore({
      planQuality: { overall: 0, workflows: 0, edgeCases: 0, architecture: 0, specificity: 0, testability: 0, weakSections: [], recommendation: "block" },
      convergenceScore: 0,
      beadQualityPassRate: { passed: 0, total: 10 },
      graphInsights: { Bottlenecks: [], Cycles: [["a", "b"]], Orphans: ["c", "d", "e"], Articulation: ["f", "g"], Slack: [] },
      planCoverage: { overall: 0, sections: [], gaps: [], totalSections: 1, coveredSections: 0 },
    });
    expect(zero.overall).toBeLessThanOrEqual(10);
  });
});

// ─── computeGraphHealthScore ────────────────────────────────

describe("computeGraphHealthScore", () => {
  it("returns 100 for a healthy graph", () => {
    expect(computeGraphHealthScore({
      Bottlenecks: [], Cycles: null, Orphans: [], Articulation: [], Slack: [],
    })).toBe(100);
  });

  it("deducts 40 for cycles", () => {
    expect(computeGraphHealthScore({
      Bottlenecks: [], Cycles: [["a", "b"]], Orphans: [], Articulation: [], Slack: [],
    })).toBe(60);
  });

  it("deducts 10 per orphan (max 30)", () => {
    expect(computeGraphHealthScore({
      Bottlenecks: [], Cycles: null, Orphans: ["a"], Articulation: [], Slack: [],
    })).toBe(90);

    expect(computeGraphHealthScore({
      Bottlenecks: [], Cycles: null, Orphans: ["a", "b", "c", "d", "e"], Articulation: [], Slack: [],
    })).toBe(70); // capped at -30
  });

  it("deducts 10 per articulation point (max 20)", () => {
    expect(computeGraphHealthScore({
      Bottlenecks: [], Cycles: null, Orphans: [], Articulation: ["a", "b", "c"], Slack: [],
    })).toBe(80); // capped at -20
  });

  it("stacks deductions", () => {
    expect(computeGraphHealthScore({
      Bottlenecks: [], Cycles: [["a", "b"]], Orphans: ["c"], Articulation: ["d"], Slack: [],
    })).toBe(40); // 100 - 40 - 10 - 10
  });

  it("never goes below 0", () => {
    expect(computeGraphHealthScore({
      Bottlenecks: [],
      Cycles: [["a", "b"]],
      Orphans: ["c", "d", "e", "f", "g"],
      Articulation: ["h", "i", "j"],
      Slack: [],
    })).toBe(10); // 100 - 40 - 30 - 20 = 10
  });
});

// ─── formatForegoneScore ────────────────────────────────────

describe("formatForegoneScore", () => {
  it("shows 🎯 for foregone conclusion", () => {
    const score = computeForegoneScore(makeHighQualityInputs());
    const formatted = formatForegoneScore(score);
    expect(formatted).toContain("🎯");
    expect(formatted).toContain("Foregone Conclusion");
  });

  it("shows ⛔ for not ready", () => {
    const score = computeForegoneScore(makeLowQualityInputs());
    const formatted = formatForegoneScore(score);
    expect(formatted).toContain("⛔");
    expect(formatted).toContain("Not ready");
  });

  it("includes all 5 dimension bars", () => {
    const score = computeForegoneScore(makeHighQualityInputs());
    const formatted = formatForegoneScore(score);
    expect(formatted).toContain("Plan Quality:");
    expect(formatted).toContain("Bead Convergence:");
    expect(formatted).toContain("Bead Quality:");
    expect(formatted).toContain("Graph Health:");
    expect(formatted).toContain("Plan Coverage:");
  });

  it("lists blockers when present", () => {
    const score = computeForegoneScore(makeLowQualityInputs());
    const formatted = formatForegoneScore(score);
    expect(formatted).toContain("Blockers");
    expect(formatted).toContain("Plan quality");
  });

  it("omits blockers section when none", () => {
    const score = computeForegoneScore(makeHighQualityInputs());
    const formatted = formatForegoneScore(score);
    expect(formatted).not.toContain("Blockers");
  });

  it("shows progress bars with █ and ░", () => {
    const score = computeForegoneScore(makeHighQualityInputs());
    const formatted = formatForegoneScore(score);
    expect(formatted).toContain("█");
    expect(formatted).toContain("░");
  });
});
