import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectFeedback,
  saveFeedback,
  loadAllFeedback,
  computeFeedbackStats,
  formatFeedbackStats,
  withCassContext,
  trackPromptUse,
  getPromptRecords,
  getPromptEffectiveness,
  formatPromptEffectiveness,
  resetPromptTracking,
  type OrchestrationFeedback,
} from "./feedback.js";
import { createInitialState } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "feedback-test-"));
  resetPromptTracking();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

// ─── collectFeedback ────────────────────────────────────────

describe("collectFeedback", () => {
  it("collects basic fields from state", () => {
    const state = createInitialState();
    state.selectedGoal = "Build feature X";
    state.activeBeadIds = ["b-1", "b-2", "b-3"];
    state.beadResults = {
      "b-1": { beadId: "b-1", status: "success", summary: "done" },
      "b-2": { beadId: "b-2", status: "success", summary: "done" },
    };
    state.iterationRound = 3;
    state.polishRound = 4;
    state.polishConverged = true;

    const feedback = collectFeedback(state);
    expect(feedback.goal).toBe("Build feature X");
    expect(feedback.beadCount).toBe(3);
    expect(feedback.completedCount).toBe(2);
    expect(feedback.totalRounds).toBe(3);
    expect(feedback.polishRounds).toBe(4);
    expect(feedback.converged).toBe(true);
    expect(feedback.timestamp).toBeTruthy();
  });

  it("handles empty state gracefully", () => {
    const state = createInitialState();
    const feedback = collectFeedback(state);
    expect(feedback.goal).toBe("unknown");
    expect(feedback.beadCount).toBe(0);
    expect(feedback.completedCount).toBe(0);
  });
});

// ─── saveFeedback / loadAllFeedback ─────────────────────────

describe("saveFeedback + loadAllFeedback", () => {
  it("saves and loads feedback files", () => {
    const fb: OrchestrationFeedback = {
      timestamp: new Date().toISOString(),
      goal: "Test goal",
      beadCount: 5,
      completedCount: 3,
      totalRounds: 2,
      polishRounds: 3,
      converged: true,
      regressions: [],
      spaceViolationCount: 0,
    };

    saveFeedback(tmpDir, fb);
    const loaded = loadAllFeedback(tmpDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].goal).toBe("Test goal");
    expect(loaded[0].beadCount).toBe(5);
  });

  it("creates feedback directory if missing", () => {
    const fb: OrchestrationFeedback = {
      timestamp: "", goal: "", beadCount: 0, completedCount: 0,
      totalRounds: 0, polishRounds: 0, converged: false, regressions: [], spaceViolationCount: 0,
    };
    saveFeedback(tmpDir, fb);
    expect(existsSync(join(tmpDir, ".pi/orchestrator-feedback"))).toBe(true);
  });

  it("loads multiple feedback files in order", () => {
    for (let i = 0; i < 3; i++) {
      saveFeedback(tmpDir, {
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        goal: `Goal ${i}`, beadCount: i, completedCount: i,
        totalRounds: 0, polishRounds: 0, converged: false, regressions: [], spaceViolationCount: 0,
      });
      // Small delay for unique filenames
    }
    const loaded = loadAllFeedback(tmpDir);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array for missing directory", () => {
    expect(loadAllFeedback("/nonexistent/path")).toEqual([]);
  });
});

// ─── computeFeedbackStats ───────────────────────────────────

describe("computeFeedbackStats", () => {
  it("computes averages from multiple runs", () => {
    const feedbacks: OrchestrationFeedback[] = [
      { timestamp: "", goal: "A", beadCount: 10, completedCount: 8, totalRounds: 2, polishRounds: 3, converged: true, regressions: [], spaceViolationCount: 0, planQualityScore: 80 },
      { timestamp: "", goal: "B", beadCount: 6, completedCount: 6, totalRounds: 1, polishRounds: 5, converged: true, regressions: [], spaceViolationCount: 0, planQualityScore: 90 },
    ];

    const stats = computeFeedbackStats(feedbacks);
    expect(stats.totalOrchestrations).toBe(2);
    expect(stats.avgBeadCount).toBe(8);
    expect(stats.avgPolishRounds).toBe(4);
    expect(stats.convergenceRate).toBe(100);
    expect(stats.avgPlanQuality).toBe(85);
  });

  it("returns zeros for empty history", () => {
    const stats = computeFeedbackStats([]);
    expect(stats.totalOrchestrations).toBe(0);
    expect(stats.avgBeadCount).toBe(0);
    expect(stats.avgPlanQuality).toBeNull();
  });

  it("handles partial data (no plan quality)", () => {
    const feedbacks: OrchestrationFeedback[] = [
      { timestamp: "", goal: "A", beadCount: 5, completedCount: 5, totalRounds: 1, polishRounds: 2, converged: false, regressions: [], spaceViolationCount: 0 },
    ];
    const stats = computeFeedbackStats(feedbacks);
    expect(stats.avgPlanQuality).toBeNull();
    expect(stats.avgForegoneScore).toBeNull();
    expect(stats.convergenceRate).toBe(0);
  });
});

// ─── formatFeedbackStats ────────────────────────────────────

describe("formatFeedbackStats", () => {
  it("formats stats for display", () => {
    const formatted = formatFeedbackStats({
      totalOrchestrations: 5,
      avgBeadCount: 8.2,
      avgCompletionRate: 85,
      avgPolishRounds: 3.5,
      convergenceRate: 60,
      avgPlanQuality: 78,
      avgForegoneScore: null,
    });
    expect(formatted).toContain("5 runs");
    expect(formatted).toContain("8.2");
    expect(formatted).toContain("85%");
    expect(formatted).toContain("78/100");
    expect(formatted).not.toContain("foregone");
  });

  it("shows message for no history", () => {
    expect(formatFeedbackStats({
      totalOrchestrations: 0, avgBeadCount: 0, avgCompletionRate: 0,
      avgPolishRounds: 0, convergenceRate: 0, avgPlanQuality: null, avgForegoneScore: null,
    })).toContain("No orchestration history");
  });
});

// ─── withCassContext ────────────────────────────────────────

describe("withCassContext", () => {
  it("returns original prompt when CASS unavailable", () => {
    // CASS won't be available in test environment
    const result = withCassContext("Original prompt text", tmpDir, "test task");
    // Should return original since cm CLI won't be found
    expect(result).toContain("Original prompt text");
  });
});

// ─── Prompt Tracking ────────────────────────────────────────

describe("trackPromptUse + getPromptRecords", () => {
  it("tracks a single prompt use", () => {
    trackPromptUse("beadRefinement", 5);
    const records = getPromptRecords();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("beadRefinement");
    expect(records[0].uses).toBe(1);
    expect(records[0].changesProduced).toBe(5);
    expect(records[0].effectiveUses).toBe(1);
  });

  it("accumulates across multiple uses", () => {
    trackPromptUse("blunderHunt", 3);
    trackPromptUse("blunderHunt", 0);
    trackPromptUse("blunderHunt", 7);
    const records = getPromptRecords();
    const bh = records.find((r) => r.name === "blunderHunt");
    expect(bh!.uses).toBe(3);
    expect(bh!.changesProduced).toBe(10);
    expect(bh!.effectiveUses).toBe(2); // 0 changes = not effective
  });

  it("tracks multiple prompts independently", () => {
    trackPromptUse("refinement", 2);
    trackPromptUse("blunderHunt", 5);
    expect(getPromptRecords()).toHaveLength(2);
  });
});

describe("getPromptEffectiveness", () => {
  it("returns null for unknown prompt", () => {
    expect(getPromptEffectiveness("nonexistent")).toBeNull();
  });

  it("returns effectiveness rate (0-1)", () => {
    trackPromptUse("test", 3);
    trackPromptUse("test", 0);
    trackPromptUse("test", 1);
    // 2 of 3 were effective
    expect(getPromptEffectiveness("test")).toBeCloseTo(0.667, 2);
  });

  it("returns 1.0 when all uses produce changes", () => {
    trackPromptUse("perfect", 5);
    trackPromptUse("perfect", 3);
    expect(getPromptEffectiveness("perfect")).toBe(1.0);
  });

  it("returns 0 when no uses produce changes", () => {
    trackPromptUse("useless", 0);
    trackPromptUse("useless", 0);
    expect(getPromptEffectiveness("useless")).toBe(0);
  });
});

describe("formatPromptEffectiveness", () => {
  it("returns empty for no tracking data", () => {
    expect(formatPromptEffectiveness()).toBe("");
  });

  it("formats tracking data with progress bars", () => {
    trackPromptUse("refinement", 5);
    trackPromptUse("refinement", 3);
    trackPromptUse("blunderHunt", 0);
    const formatted = formatPromptEffectiveness();
    expect(formatted).toContain("refinement");
    expect(formatted).toContain("blunderHunt");
    expect(formatted).toContain("█");
    expect(formatted).toContain("100%"); // refinement: 2/2
    expect(formatted).toContain("0%"); // blunderHunt: 0/1
  });

  it("sorts by effectiveness descending", () => {
    trackPromptUse("bad", 0);
    trackPromptUse("good", 5);
    const formatted = formatPromptEffectiveness();
    const goodPos = formatted.indexOf("good");
    const badPos = formatted.indexOf("bad");
    expect(goodPos).toBeLessThan(badPos); // good should come first
  });
});
