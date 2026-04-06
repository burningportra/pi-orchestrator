import { describe, it, expect } from "vitest";
import {
  researchBlunderHuntPrompt,
  researchFeedbackPrompt,
  researchSynthesisPrompt,
  extractProjectName,
} from "./research-pipeline.js";
import type { DeepPlanResult } from "./deep-plan.js";

// ─── researchBlunderHuntPrompt ──────────────────────────────

describe("researchBlunderHuntPrompt", () => {
  it("includes the proposal text", () => {
    const prompt = researchBlunderHuntPrompt("# My Proposal\nIntegrate X with Y", 1);
    expect(prompt).toContain("# My Proposal");
    expect(prompt).toContain("Integrate X with Y");
  });

  it("includes the pass number", () => {
    expect(researchBlunderHuntPrompt("proposal", 3)).toContain("Pass 3/5");
  });

  it("uses overshoot mismatch technique", () => {
    const prompt = researchBlunderHuntPrompt("proposal", 1);
    expect(prompt).toContain("at least 50");
  });

  it("covers all 10 check categories", () => {
    const prompt = researchBlunderHuntPrompt("proposal", 1);
    expect(prompt).toContain("Architectural flaws");
    expect(prompt).toContain("Missing edge cases");
    expect(prompt).toContain("Unrealistic assumptions");
    expect(prompt).toContain("Contradictions");
    expect(prompt).toContain("Shallow reimagining");
    expect(prompt).toContain("Over-engineering");
  });

  it("asks for full revised proposal output", () => {
    const prompt = researchBlunderHuntPrompt("proposal", 1);
    expect(prompt).toContain("FULL revised proposal");
    expect(prompt).toContain("NO_CHANGES");
  });
});

// ─── researchFeedbackPrompt ─────────────────────────────────

describe("researchFeedbackPrompt", () => {
  it("includes the proposal text", () => {
    const prompt = researchFeedbackPrompt("# Proposal\nDo X");
    expect(prompt).toContain("# Proposal");
    expect(prompt).toContain("Do X");
  });

  it("asks for feedback on 5 dimensions", () => {
    const prompt = researchFeedbackPrompt("proposal");
    expect(prompt).toContain("Architectural soundness");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Feasibility");
    expect(prompt).toContain("Innovation quality");
    expect(prompt).toContain("Risk assessment");
  });

  it("asks for numbered actionable suggestions", () => {
    const prompt = researchFeedbackPrompt("proposal");
    expect(prompt).toContain("numbered list");
    expect(prompt).toContain("actionable");
  });
});

// ─── researchSynthesisPrompt ────────────────────────────────

describe("researchSynthesisPrompt", () => {
  const feedback: DeepPlanResult[] = [
    { name: "fb-1", model: "claude", plan: "Suggestion A", exitCode: 0, elapsed: 10 },
    { name: "fb-2", model: "gpt", plan: "Suggestion B", exitCode: 0, elapsed: 12 },
    { name: "fb-3", model: "gemini", plan: "", exitCode: 1, elapsed: 5, error: "failed" },
  ];

  it("includes the original proposal", () => {
    const prompt = researchSynthesisPrompt("# Original Proposal", feedback);
    expect(prompt).toContain("# Original Proposal");
  });

  it("includes successful feedback only", () => {
    const prompt = researchSynthesisPrompt("proposal", feedback);
    expect(prompt).toContain("Suggestion A");
    expect(prompt).toContain("Suggestion B");
    // Failed feedback (empty plan) should be filtered
    expect(prompt).not.toContain("Feedback 3");
  });

  it("labels feedback by model", () => {
    const prompt = researchSynthesisPrompt("proposal", feedback);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("gpt");
  });

  it("asks for 'best of all worlds' synthesis", () => {
    const prompt = researchSynthesisPrompt("proposal", feedback);
    expect(prompt).toContain("best of all worlds");
    expect(prompt).toContain("FULL revised proposal");
  });

  it("handles all feedback failing", () => {
    const allFailed: DeepPlanResult[] = [
      { name: "fb-1", model: "claude", plan: "", exitCode: 1, elapsed: 5 },
    ];
    const prompt = researchSynthesisPrompt("proposal", allFailed);
    // Should still include the original proposal
    expect(prompt).toContain("proposal");
  });
});

// ─── extractProjectName ─────────────────────────────────────

describe("extractProjectName", () => {
  it("extracts repo name from GitHub URL", () => {
    expect(extractProjectName("https://github.com/user/repo")).toBe("repo");
  });

  it("handles .git suffix", () => {
    expect(extractProjectName("https://github.com/user/repo.git")).toBe("repo");
  });

  it("handles trailing slash", () => {
    expect(extractProjectName("https://github.com/user/repo/")).toBe("repo");
  });

  it("handles non-GitHub URLs", () => {
    const name = extractProjectName("https://example.com/some/path/project");
    expect(name).toBe("project");
  });

  it("handles bare repo name", () => {
    expect(extractProjectName("my-project")).toBe("my-project");
  });

  it("handles complex GitHub URLs with sub-paths", () => {
    expect(extractProjectName("https://github.com/org-name/my-cool-repo/tree/main")).toBe("my-cool-repo");
  });
});
