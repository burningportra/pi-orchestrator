import { describe, it, expect } from "vitest";
import { buildDashboardSnapshot, renderDashboardLines, DashboardController } from "../index.js";
import { createInitialState } from "../../types.js";
import type { OrchestratorState, Bead } from "../../types.js";
import type { DashboardSnapshot } from "../types.js";

/** Mock theme with identity functions. */
const mockTheme = {
  primary: (t: string) => t,
  muted: (t: string) => t,
  success: (t: string) => t,
  warning: (t: string) => t,
  error: (t: string) => t,
};

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

describe("dashboard integration", () => {
  it("builds snapshot and renders lines end-to-end (happy path)", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      repoProfile: { name: "my-repo" } as any,
      scanResult: { source: "ccc" } as any,
      selectedGoal: "Add a monitoring dashboard",
      activeBeadIds: ["pi-1", "pi-2", "pi-3"],
      beadResults: {
        "pi-1": { beadId: "pi-1", status: "success", summary: "done" },
      },
    };

    const beads = [
      makeBead({ id: "pi-1", title: "Types", status: "closed" }),
      makeBead({ id: "pi-2", title: "Render", status: "in_progress" }),
      makeBead({ id: "pi-3", title: "Controller", status: "open" }),
    ];

    const unblocked = new Set(["pi-2", "pi-3"]);
    const snapshot = buildDashboardSnapshot(state, beads, unblocked, "2 active");

    const lines = renderDashboardLines(snapshot, mockTheme, 80);

    expect(lines.length).toBeGreaterThanOrEqual(5);
    const output = lines.join("\n");
    expect(output).toContain("Implementing");
    expect(output).toContain("my-repo");
    expect(output).toContain("monitoring dashboard");
    expect(output).toContain("1/3");
    expect(output).toContain("pi-1");
    expect(output).toContain("pi-2");
    expect(output).toContain("pi-3");
    expect(output).toContain("2 active");
  });

  it("stale snapshot produces stale banner in rendered output", () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      activeBeadIds: ["pi-1", "pi-2"],
    };

    // Empty beads with activeBeadIds → stale
    const snapshot = buildDashboardSnapshot(state, [], new Set());
    expect(snapshot.staleData).toBe(true);

    const lines = renderDashboardLines(snapshot, mockTheme, 80);
    const output = lines.join("\n");
    expect(output).toContain("stale");
  });

  it("fallback widget preserves the old simple fields", () => {
    // This tests the renderFallbackWidget logic by verifying
    // the original widget contract through buildDashboardSnapshot + render
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "reviewing",
      repoProfile: { name: "test-repo" } as any,
      scanResult: { source: "builtin" } as any,
      selectedGoal: "Improve test coverage across the module",
      activeBeadIds: ["b-1", "b-2", "b-3", "b-4"],
      beadResults: {
        "b-1": { beadId: "b-1", status: "success", summary: "" },
        "b-2": { beadId: "b-2", status: "success", summary: "" },
      },
    };

    const beads = [
      makeBead({ id: "b-1", status: "closed" }),
      makeBead({ id: "b-2", status: "closed" }),
      makeBead({ id: "b-3", status: "in_progress" }),
      makeBead({ id: "b-4", status: "open" }),
    ];

    const snapshot = buildDashboardSnapshot(state, beads, new Set(["b-3", "b-4"]), "1 idle");
    const lines = renderDashboardLines(snapshot, mockTheme, 80);
    const output = lines.join("\n");

    // Verify all fields that the old updateWidget showed
    expect(output).toContain("Reviewing");       // phase
    expect(output).toContain("test-repo");        // repo name
    expect(output).toContain("builtin");          // scan source
    expect(output).toContain("test coverage");    // goal (partial match)
    expect(output).toContain("2/4");              // progress
    expect(output).toContain("1 idle");           // tender summary
  });

  it("DashboardController triggers onUpdate with renderable snapshot", async () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      repoProfile: { name: "ctrl-repo" } as any,
      selectedGoal: "Wire up dashboard",
      activeBeadIds: ["pi-x"],
      beadResults: {},
    };

    const beads = [makeBead({ id: "pi-x", title: "Controller bead", status: "in_progress" })];
    const snapshots: DashboardSnapshot[] = [];

    const controller = new DashboardController({
      readBeadsFn: () => Promise.resolve(beads),
      getUnblockedBeadsFn: () => Promise.resolve(["pi-x"]),
      getState: () => state,
      getTenderSummary: () => undefined,
      onUpdate: (snap) => snapshots.push(snap),
    });

    await controller.refreshNow();
    controller.dispose();

    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0];
    expect(snap.phase).toBe("implementing");
    expect(snap.beads).toHaveLength(1);
    expect(snap.beads[0].id).toBe("pi-x");

    // Verify the snapshot is renderable
    const lines = renderDashboardLines(snap, mockTheme, 80);
    expect(lines.join("\n")).toContain("Controller bead");
  });

  it("barrel re-exports work correctly", async () => {
    // Verify all expected exports are available from the barrel
    const barrel = await import("../index.js");
    expect(barrel.buildDashboardSnapshot).toBeTypeOf("function");
    expect(barrel.renderDashboardLines).toBeTypeOf("function");
    expect(barrel.DashboardController).toBeTypeOf("function");
    expect(barrel.PHASE_EMOJI).toBeDefined();
    expect(barrel.renderProgressBar).toBeTypeOf("function");
    expect(barrel.renderBeadTable).toBeTypeOf("function");
    expect(barrel.renderStaleFooterNote).toBeTypeOf("function");
  });
});
