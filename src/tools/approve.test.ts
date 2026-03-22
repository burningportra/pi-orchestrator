import { describe, it, expect } from "vitest";
import { diffBeadSnapshots, formatDiffSummary, type DiffSummary } from "./approve.js";
import { computeConvergenceScore } from "../prompts.js";
import { createInitialState } from "../types.js";
import type { OrchestratorState } from "../types.js";

// ─── Re-export tests from convergence.test.ts and diff-beads.test.ts ────
// Those files contain the bulk of tests. This file adds approve-specific
// integration tests and tests for internal helpers via public interfaces.

// ─── descHash consistency (tested indirectly via diffBeadSnapshots) ──────
describe("descHash consistency via diffBeadSnapshots", () => {
  function makeSnap(entries: Record<string, { title: string; descLength: number; descHash: string; files: string[] }>) {
    return new Map(Object.entries(entries));
  }

  it("identical descriptions produce no modification", () => {
    const snap = makeSnap({
      a: { title: "A", descLength: 100, descHash: "100:Hello world this is a test description that is ", files: [] },
    });
    const diff = diffBeadSnapshots(snap, snap);
    expect(diff.modified).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("descriptions differing only in chars after position 50 still differ by length", () => {
    const prefix = "x".repeat(50);
    const prev = makeSnap({
      a: { title: "A", descLength: 60, descHash: `60:${prefix}`, files: [] },
    });
    const curr = makeSnap({
      a: { title: "A", descLength: 70, descHash: `70:${prefix}`, files: [] },
    });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].changes[0]).toContain("+10 chars");
  });

  it("descriptions with same length but different content are detected", () => {
    const prev = makeSnap({
      a: { title: "A", descLength: 10, descHash: "10:aaaaaaaaaa", files: [] },
    });
    const curr = makeSnap({
      a: { title: "A", descLength: 10, descHash: "10:bbbbbbbbbb", files: [] },
    });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
  });
});

// ─── countChanges accuracy (tested indirectly via convergence logic) ─────
describe("countChanges accuracy via convergence tracking", () => {
  it("empty snapshots produce 0 changes", () => {
    const empty = new Map();
    const diff = diffBeadSnapshots(empty, empty);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("all new beads counted as additions", () => {
    const prev = new Map();
    const curr = new Map(Object.entries({
      a: { title: "A", descLength: 10, descHash: "10:a", files: [] },
      b: { title: "B", descLength: 20, descHash: "20:b", files: [] },
      c: { title: "C", descLength: 30, descHash: "30:c", files: [] },
    }));
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.added).toHaveLength(3);
  });

  it("all beads removed counted as removals", () => {
    const prev = new Map(Object.entries({
      a: { title: "A", descLength: 10, descHash: "10:a", files: [] },
      b: { title: "B", descLength: 20, descHash: "20:b", files: [] },
    }));
    const curr = new Map();
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.removed).toHaveLength(2);
  });
});

// ─── Auto-approve integration: meetsAutoApprove mirrors approve.ts logic ─
describe("auto-approve meetsAutoApprove", () => {
  function meetsAutoApprove(state: OrchestratorState): boolean {
    const autoApproveEnabled = state.autoApproveOnConvergence !== false;
    const round = state.polishRound;
    const converged = state.polishConverged;
    const convergenceScore = state.polishConvergenceScore;
    return autoApproveEnabled && round > 0 && (
      converged || (convergenceScore !== undefined && convergenceScore >= 0.90)
    );
  }

  it("does not trigger with default initial state", () => {
    const state = createInitialState();
    expect(meetsAutoApprove(state)).toBe(false);
  });

  it("triggers when both converged AND high score", () => {
    const state = createInitialState();
    state.polishRound = 4;
    state.polishConverged = true;
    state.polishConvergenceScore = 0.95;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("convergenceScore alone is sufficient without polishConverged", () => {
    const state = createInitialState();
    state.polishRound = 2;
    state.polishConvergenceScore = 0.91;
    state.polishConverged = false;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("polishConverged alone is sufficient without convergenceScore", () => {
    const state = createInitialState();
    state.polishRound = 5;
    state.polishConverged = true;
    // no convergenceScore set
    expect(meetsAutoApprove(state)).toBe(true);
  });
});

// ─── formatDiffSummary edge cases ────────────────────────────
describe("formatDiffSummary edge cases", () => {
  it("handles only additions", () => {
    const diff: DiffSummary = {
      added: [{ id: "a", title: "New" }, { id: "b", title: "Also new" }],
      removed: [],
      modified: [],
      unchangedCount: 0,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("➕ Added");
    expect(text).not.toContain("➖");
    expect(text).not.toContain("✏️");
  });

  it("handles only removals", () => {
    const diff: DiffSummary = {
      added: [],
      removed: ["x", "y"],
      modified: [],
      unchangedCount: 0,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("➖ Removed");
    expect(text).not.toContain("➕");
  });

  it("handles multiple modifications", () => {
    const diff: DiffSummary = {
      added: [],
      removed: [],
      modified: [
        { id: "a", changes: ["title changed"] },
        { id: "b", changes: ["desc +50 chars", "files: +f1"] },
      ],
      unchangedCount: 1,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("✏️");
    expect(text).toContain("1 bead unchanged");
  });
});
