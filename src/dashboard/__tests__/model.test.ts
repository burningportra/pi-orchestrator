import { describe, it, expect } from "vitest";
import { buildDashboardSnapshot, PHASE_EMOJI } from "../model.js";
import type { OrchestratorState, Bead } from "../../types.js";
import { createInitialState } from "../../types.js";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "pi-abc",
    title: "Test bead",
    description: "A test bead",
    status: "open",
    priority: 2,
    type: "task",
    labels: [],
    ...overrides,
  };
}

describe("buildDashboardSnapshot", () => {
  it("returns a valid snapshot for idle state with no data", () => {
    const state = createInitialState();
    const snap = buildDashboardSnapshot(state, [], new Set());

    expect(snap.phase).toBe("idle");
    expect(snap.phaseEmoji).toBe("⏸");
    expect(snap.repoName).toBe("Unknown repo");
    expect(snap.scanSource).toBe("unknown");
    expect(snap.goal).toBe("");
    expect(snap.beads).toEqual([]);
    expect(snap.completedCount).toBe(0);
    expect(snap.totalCount).toBe(0);
    expect(snap.staleData).toBe(false);
    expect(snap.alerts).toEqual([]);
    expect(snap.tenderSummary).toBeUndefined();
    expect(snap.lastRefreshMs).toBeGreaterThan(0);
  });

  it("populates snapshot from active state with beads", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      repoProfile: { name: "my-repo" } as any,
      scanResult: { source: "ccc" } as any,
      selectedGoal: "Add dashboard",
      activeBeadIds: ["pi-1", "pi-2", "pi-3"],
      beadResults: {
        "pi-1": { beadId: "pi-1", status: "success", summary: "done" },
      },
    };

    const beads = [
      makeBead({ id: "pi-1", title: "First", status: "closed" }),
      makeBead({ id: "pi-2", title: "Second", status: "in_progress" }),
      makeBead({ id: "pi-3", title: "Third", status: "open" }),
    ];

    const unblocked = new Set(["pi-2", "pi-3"]);
    const snap = buildDashboardSnapshot(state, beads, unblocked, "2 active");

    expect(snap.phase).toBe("implementing");
    expect(snap.phaseEmoji).toBe("🔨");
    expect(snap.repoName).toBe("my-repo");
    expect(snap.scanSource).toBe("ccc");
    expect(snap.goal).toBe("Add dashboard");
    expect(snap.totalCount).toBe(3); // from activeBeadIds
    expect(snap.completedCount).toBe(1);
    expect(snap.tenderSummary).toBe("2 active");
    expect(snap.beads).toHaveLength(3);
    expect(snap.beads[0].unblocked).toBe(false);
    expect(snap.beads[1].unblocked).toBe(true);
    expect(snap.beads[2].unblocked).toBe(true);
  });

  it("resolves reviewPasses from beadReviewPassCounts", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "reviewing",
      beadReviewPassCounts: { "pi-1": 3 },
    };

    const beads = [makeBead({ id: "pi-1" }), makeBead({ id: "pi-2" })];
    const snap = buildDashboardSnapshot(state, beads, new Set());

    expect(snap.beads[0].reviewPasses).toBe(3);
    expect(snap.beads[1].reviewPasses).toBe(0);
  });

  it("resolves lastReviewVerdict from the last review entry", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "reviewing",
      beadReviews: {
        "pi-1": [
          { beadId: "pi-1", passed: false, feedback: "nope" },
          { beadId: "pi-1", passed: true, feedback: "ok" },
        ],
        "pi-2": [{ beadId: "pi-2", passed: false, feedback: "fail" }],
      },
    };

    const beads = [
      makeBead({ id: "pi-1" }),
      makeBead({ id: "pi-2" }),
      makeBead({ id: "pi-3" }),
    ];
    const snap = buildDashboardSnapshot(state, beads, new Set());

    expect(snap.beads[0].lastReviewVerdict).toBe(true);
    expect(snap.beads[1].lastReviewVerdict).toBe(false);
    expect(snap.beads[2].lastReviewVerdict).toBeUndefined();
  });

  it("uses beadResults for completedCount", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      beadResults: {
        "pi-1": { beadId: "pi-1", status: "success", summary: "" },
        "pi-2": { beadId: "pi-2", status: "partial", summary: "" },
        "pi-3": { beadId: "pi-3", status: "success", summary: "" },
      },
    };
    const snap = buildDashboardSnapshot(state, [], new Set());
    expect(snap.completedCount).toBe(2);
  });

  it("prefers activeBeadIds.length for totalCount over beads.length", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      activeBeadIds: ["a", "b", "c", "d"],
    };
    const beads = [makeBead({ id: "a" }), makeBead({ id: "b" })];
    const snap = buildDashboardSnapshot(state, beads, new Set());

    expect(snap.totalCount).toBe(4); // activeBeadIds length
  });

  it("falls back to beads.length when activeBeadIds is missing", () => {
    const state = createInitialState();
    const beads = [makeBead({ id: "a" }), makeBead({ id: "b" })];
    const snap = buildDashboardSnapshot(state, beads, new Set());

    expect(snap.totalCount).toBe(2); // beads length
  });

  it("detects stale data when activeBeadIds exist but beads is empty", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      activeBeadIds: ["pi-1", "pi-2"],
    };
    const snap = buildDashboardSnapshot(state, [], new Set());

    expect(snap.staleData).toBe(true);
    expect(snap.alerts).toHaveLength(1);
    expect(snap.alerts[0].level).toBe("warning");
    expect(snap.alerts[0].message).toContain("stale");
  });

  it("defaults safely when tender summary and scan result are missing", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "profiling",
    };
    const snap = buildDashboardSnapshot(state, [], new Set());

    expect(snap.tenderSummary).toBeUndefined();
    expect(snap.scanSource).toBe("unknown");
    expect(snap.repoName).toBe("Unknown repo");
  });

  it("preserves very long bead titles unmodified", () => {
    const longTitle = "A".repeat(500);
    const beads = [makeBead({ id: "pi-1", title: longTitle })];
    const snap = buildDashboardSnapshot(
      createInitialState(),
      beads,
      new Set(),
    );

    expect(snap.beads[0].title).toBe(longTitle);
    expect(snap.beads[0].title).toHaveLength(500);
  });

  it("maps every OrchestratorPhase to a non-empty emoji", () => {
    const phases = Object.keys(PHASE_EMOJI) as Array<
      keyof typeof PHASE_EMOJI
    >;
    expect(phases.length).toBeGreaterThanOrEqual(13);
    for (const phase of phases) {
      expect(PHASE_EMOJI[phase]).toBeTruthy();
      expect(PHASE_EMOJI[phase].length).toBeGreaterThan(0);
    }
  });

  it("returns a degraded stale snapshot on malformed input instead of throwing", () => {
    // Pass completely broken state
    const snap = buildDashboardSnapshot(
      null as any,
      null as any,
      null as any,
    );

    expect(snap.staleData).toBe(true);
    expect(snap.alerts.length).toBeGreaterThanOrEqual(1);
    expect(snap.alerts[0].level).toBe("error");
    expect(snap.beads).toEqual([]);
    expect(snap.completedCount).toBe(0);
    expect(snap.totalCount).toBe(0);
  });

  it("preserves bead order from input", () => {
    const beads = [
      makeBead({ id: "pi-c", title: "Charlie" }),
      makeBead({ id: "pi-a", title: "Alpha" }),
      makeBead({ id: "pi-b", title: "Bravo" }),
    ];
    const snap = buildDashboardSnapshot(
      createInitialState(),
      beads,
      new Set(),
    );

    expect(snap.beads.map((b) => b.id)).toEqual(["pi-c", "pi-a", "pi-b"]);
  });
});
