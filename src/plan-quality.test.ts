import { describe, it, expect } from "vitest";
import {
  planQualityScoringPrompt,
  parsePlanQualityScore,
  formatPlanQualityScore,
  type PlanQualityScore,
} from "./plan-quality.js";

// ─── planQualityScoringPrompt ───────────────────────────────

describe("planQualityScoringPrompt", () => {
  it("includes the goal", () => {
    const prompt = planQualityScoringPrompt("# Plan", "Build a CLI tool");
    expect(prompt).toContain("Build a CLI tool");
  });

  it("includes the plan text", () => {
    const prompt = planQualityScoringPrompt("# My Plan\n\nStep 1: do stuff", "Goal");
    expect(prompt).toContain("# My Plan");
    expect(prompt).toContain("Step 1: do stuff");
  });

  it("describes all 5 scoring dimensions", () => {
    const prompt = planQualityScoringPrompt("plan", "goal");
    expect(prompt).toContain("Workflow Completeness");
    expect(prompt).toContain("Edge Case Density");
    expect(prompt).toContain("Architectural Decision Coverage");
    expect(prompt).toContain("Type/API Specificity");
    expect(prompt).toContain("Testability");
  });

  it("specifies JSON output format", () => {
    const prompt = planQualityScoringPrompt("plan", "goal");
    expect(prompt).toContain("workflows");
    expect(prompt).toContain("edgeCases");
    expect(prompt).toContain("weakSections");
  });
});

// ─── parsePlanQualityScore ──────────────────────────────────

describe("parsePlanQualityScore", () => {
  it("parses valid JSON output", () => {
    const output = `{"workflows": 85, "edgeCases": 70, "architecture": 90, "specificity": 75, "testability": 60, "weakSections": ["Testing"]}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(85);
    expect(score!.edgeCases).toBe(70);
    expect(score!.architecture).toBe(90);
    expect(score!.specificity).toBe(75);
    expect(score!.testability).toBe(60);
    expect(score!.weakSections).toEqual(["Testing"]);
  });

  it("computes weighted overall score", () => {
    // workflows=80*0.25 + edgeCases=60*0.20 + architecture=80*0.20 + specificity=60*0.20 + testability=40*0.15
    // = 20 + 12 + 16 + 12 + 6 = 66
    const output = `{"workflows": 80, "edgeCases": 60, "architecture": 80, "specificity": 60, "testability": 40, "weakSections": []}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(66);
  });

  it("recommends 'block' when overall < 60", () => {
    const output = `{"workflows": 30, "edgeCases": 30, "architecture": 30, "specificity": 30, "testability": 30, "weakSections": []}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(30);
    expect(score!.recommendation).toBe("block");
  });

  it("recommends 'warn' when overall 60-79", () => {
    const output = `{"workflows": 70, "edgeCases": 70, "architecture": 70, "specificity": 70, "testability": 70, "weakSections": []}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(70);
    expect(score!.recommendation).toBe("warn");
  });

  it("recommends 'proceed' when overall >= 80", () => {
    const output = `{"workflows": 90, "edgeCases": 80, "architecture": 85, "specificity": 80, "testability": 75, "weakSections": []}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.recommendation).toBe("proceed");
  });

  it("handles JSON wrapped in markdown fences", () => {
    const output = "Here is the assessment:\n```json\n{\"workflows\": 80, \"edgeCases\": 70, \"architecture\": 75, \"specificity\": 65, \"testability\": 60, \"weakSections\": [\"Edge Cases\"]}\n```";
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(80);
  });

  it("handles JSON with surrounding text", () => {
    const output = "Based on my analysis, the scores are:\n{\"workflows\": 90, \"edgeCases\": 85, \"architecture\": 80, \"specificity\": 75, \"testability\": 70, \"weakSections\": []}\nThese indicate a strong plan.";
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(90);
  });

  it("clamps scores to 0-100", () => {
    const output = `{"workflows": 150, "edgeCases": -10, "architecture": 80, "specificity": 80, "testability": 80, "weakSections": []}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(100);
    expect(score!.edgeCases).toBe(0);
  });

  it("defaults non-numeric scores to 50", () => {
    const output = `{"workflows": "high", "edgeCases": null, "architecture": 80, "specificity": 80, "testability": 80, "weakSections": []}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(50);
    expect(score!.edgeCases).toBe(50);
  });

  it("returns null for unparseable output", () => {
    expect(parsePlanQualityScore("No JSON here")).toBeNull();
    expect(parsePlanQualityScore("")).toBeNull();
    expect(parsePlanQualityScore("{invalid json}")).toBeNull();
  });

  it("limits weakSections to 10 items", () => {
    const sections = Array.from({ length: 15 }, (_, i) => `Section ${i}`);
    const output = `{"workflows": 80, "edgeCases": 80, "architecture": 80, "specificity": 80, "testability": 80, "weakSections": ${JSON.stringify(sections)}}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.weakSections).toHaveLength(10);
  });

  it("filters non-string weakSections", () => {
    const output = `{"workflows": 80, "edgeCases": 80, "architecture": 80, "specificity": 80, "testability": 80, "weakSections": ["Valid", 42, null, "Also valid"]}`;
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.weakSections).toEqual(["Valid", "Also valid"]);
  });
});

// ─── formatPlanQualityScore ─────────────────────────────────

describe("formatPlanQualityScore", () => {
  const highScore: PlanQualityScore = {
    overall: 85,
    workflows: 90,
    edgeCases: 80,
    architecture: 85,
    specificity: 80,
    testability: 75,
    weakSections: [],
    recommendation: "proceed",
  };

  const lowScore: PlanQualityScore = {
    overall: 45,
    workflows: 40,
    edgeCases: 30,
    architecture: 50,
    specificity: 60,
    testability: 40,
    weakSections: ["Testing Strategy", "Error Handling"],
    recommendation: "block",
  };

  it("includes overall score", () => {
    expect(formatPlanQualityScore(highScore)).toContain("85/100");
  });

  it("includes all dimension scores", () => {
    const formatted = formatPlanQualityScore(highScore);
    expect(formatted).toContain("Workflows:");
    expect(formatted).toContain("90%");
    expect(formatted).toContain("Edge Cases:");
    expect(formatted).toContain("Architecture:");
    expect(formatted).toContain("Specificity:");
    expect(formatted).toContain("Testability:");
  });

  it("shows proceed emoji for high scores", () => {
    expect(formatPlanQualityScore(highScore)).toContain("✅");
  });

  it("shows block emoji and message for low scores", () => {
    const formatted = formatPlanQualityScore(lowScore);
    expect(formatted).toContain("⛔");
    expect(formatted).toContain("refine the plan");
  });

  it("lists weak sections when present", () => {
    const formatted = formatPlanQualityScore(lowScore);
    expect(formatted).toContain("Testing Strategy");
    expect(formatted).toContain("Error Handling");
  });

  it("omits weak sections line when empty", () => {
    const formatted = formatPlanQualityScore(highScore);
    expect(formatted).not.toContain("Weak spots");
  });

  it("shows warn emoji for mid-range scores", () => {
    const warnScore: PlanQualityScore = {
      ...highScore,
      overall: 70,
      recommendation: "warn",
    };
    const formatted = formatPlanQualityScore(warnScore);
    expect(formatted).toContain("⚠️");
    expect(formatted).toContain("another refinement round");
  });
});
