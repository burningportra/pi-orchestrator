import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DashboardController } from "../controller.js";
import type { OrchestratorState, Bead } from "../../types.js";
import { createInitialState } from "../../types.js";
import type { DashboardSnapshot } from "../types.js";

function makeBead(id: string): Bead {
  return {
    id,
    title: `Bead ${id}`,
    description: "",
    status: "open",
    priority: 2,
    type: "task",
    labels: [],
  };
}

function createMockController(overrides: {
  state?: OrchestratorState;
  beads?: Bead[];
  unblockedIds?: string[];
  readBeadsFn?: () => Promise<Bead[]>;
  getUnblockedBeadsFn?: () => Promise<string[]>;
  activeIntervalMs?: number;
} = {}) {
  const state = overrides.state ?? { ...createInitialState(), phase: "implementing" as const };
  const beads = overrides.beads ?? [makeBead("pi-1")];
  const updates: DashboardSnapshot[] = [];

  const controller = new DashboardController({
    readBeadsFn: overrides.readBeadsFn ?? (() => Promise.resolve(beads)),
    getUnblockedBeadsFn: overrides.getUnblockedBeadsFn ?? (() => Promise.resolve(["pi-1"])),
    getState: () => state,
    getTenderSummary: () => undefined,
    onUpdate: (snap) => updates.push(snap),
    activeIntervalMs: overrides.activeIntervalMs ?? 3000,
  });

  return { controller, updates, state };
}

describe("DashboardController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() is idempotent — calling twice does not create duplicate timers", async () => {
    const { controller, updates } = createMockController();

    controller.start();
    controller.start(); // second call is no-op

    await vi.advanceTimersByTimeAsync(3000);
    expect(updates.length).toBe(1); // only one refresh, not two
    controller.dispose();
  });

  it("stop() clears timers and is safe to call repeatedly", async () => {
    const { controller, updates } = createMockController();

    controller.start();
    controller.stop();
    controller.stop(); // safe to call again

    await vi.advanceTimersByTimeAsync(10000);
    expect(updates).toHaveLength(0);
    controller.dispose();
  });

  it("refreshNow() triggers one immediate onUpdate call", async () => {
    const { controller, updates } = createMockController();

    await controller.refreshNow();
    expect(updates).toHaveLength(1);
    expect(updates[0].phase).toBe("implementing");
    controller.dispose();
  });

  it("reads beads and unblocked ids in parallel", async () => {
    let readBeadsCalled = false;
    let unblockedCalled = false;

    const { controller } = createMockController({
      readBeadsFn: async () => {
        readBeadsCalled = true;
        return [makeBead("pi-1")];
      },
      getUnblockedBeadsFn: async () => {
        unblockedCalled = true;
        return ["pi-1"];
      },
    });

    await controller.refreshNow();
    expect(readBeadsCalled).toBe(true);
    expect(unblockedCalled).toBe(true);
    controller.dispose();
  });

  it("in-flight guard prevents overlapping refreshes", async () => {
    vi.useRealTimers(); // This test needs real async behavior
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const { controller } = createMockController({
      readBeadsFn: async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 10));
        concurrentCount--;
        return [makeBead("pi-1")];
      },
    });

    // Fire two refreshes concurrently
    const p1 = controller.refreshNow();
    const p2 = controller.refreshNow();
    await Promise.all([p1, p2]);
    // Wait for any coalesced pending refresh
    await new Promise((r) => setTimeout(r, 50));

    // Max concurrent should be 1 (in-flight guard prevents overlap)
    expect(maxConcurrent).toBe(1);
    controller.dispose();
    vi.useFakeTimers(); // Restore for other tests
  });

  it("invalidate() schedules a near-immediate refresh", async () => {
    const { controller, updates } = createMockController();

    controller.invalidate();
    await vi.advanceTimersByTimeAsync(1);

    expect(updates.length).toBeGreaterThanOrEqual(1);
    controller.dispose();
  });

  it("idle phase stops scheduling", async () => {
    const state = { ...createInitialState(), phase: "idle" as const };
    const { controller, updates } = createMockController({ state });

    controller.start();
    await vi.advanceTimersByTimeAsync(30000);

    expect(updates).toHaveLength(0);
    controller.dispose();
  });

  it("complete phase stops scheduling", async () => {
    const state = { ...createInitialState(), phase: "complete" as const };
    const { controller, updates } = createMockController({ state });

    controller.start();
    await vi.advanceTimersByTimeAsync(30000);

    expect(updates).toHaveLength(0);
    controller.dispose();
  });

  it("implementing uses activeIntervalMs cadence", async () => {
    const state = { ...createInitialState(), phase: "implementing" as const };
    const { controller, updates } = createMockController({
      state,
      activeIntervalMs: 1000,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(3500);

    // At 1000ms interval: refreshes at ~1000, ~2000, ~3000
    expect(updates.length).toBe(3);
    controller.dispose();
  });

  it("non-active non-terminal phases use slower cadence (2x)", async () => {
    const state = { ...createInitialState(), phase: "planning" as const };
    const { controller, updates } = createMockController({
      state,
      activeIntervalMs: 1000,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(4500);

    // At 2000ms interval: refreshes at ~2000, ~4000
    expect(updates.length).toBe(2);
    controller.dispose();
  });

  it("three consecutive failures trigger 30s backoff", async () => {
    let callCount = 0;
    const { controller, updates } = createMockController({
      readBeadsFn: async () => {
        callCount++;
        throw new Error("br failed");
      },
      activeIntervalMs: 1000,
    });

    controller.start();

    // First 3 failures at 1s intervals
    await vi.advanceTimersByTimeAsync(3500);
    expect(callCount).toBe(3);

    // After 3 failures, should back off to 30s
    const countBefore = callCount;
    await vi.advanceTimersByTimeAsync(5000); // only 5s more
    expect(callCount).toBe(countBefore); // no new calls yet

    // After 30s total, should fire again
    await vi.advanceTimersByTimeAsync(25000);
    expect(callCount).toBeGreaterThan(countBefore);

    controller.dispose();
  });

  it("success after failure resets counter and normal cadence", async () => {
    let shouldFail = true;
    let callCount = 0;

    const { controller } = createMockController({
      readBeadsFn: async () => {
        callCount++;
        if (shouldFail) throw new Error("fail");
        return [makeBead("pi-1")];
      },
      activeIntervalMs: 1000,
    });

    controller.start();

    // 3 failures
    await vi.advanceTimersByTimeAsync(3500);
    expect(callCount).toBe(3);

    // Now succeed
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(30000); // wait for backoff timer
    const countAfterRecovery = callCount;

    // Should be back to 1s interval
    await vi.advanceTimersByTimeAsync(2500);
    expect(callCount).toBeGreaterThan(countAfterRecovery + 1);

    controller.dispose();
  });

  it("dispose() prevents future refreshes", async () => {
    const { controller, updates } = createMockController();

    controller.start();
    controller.dispose();

    await vi.advanceTimersByTimeAsync(30000);
    expect(updates).toHaveLength(0);

    // refreshNow after dispose is a no-op
    await controller.refreshNow();
    expect(updates).toHaveLength(0);
  });

  it("delivers stale snapshot when readBeadsFn fails", async () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      activeBeadIds: ["pi-1", "pi-2"],
    };

    const { controller, updates } = createMockController({
      state,
      readBeadsFn: async () => {
        throw new Error("br not found");
      },
    });

    await controller.refreshNow();

    expect(updates).toHaveLength(1);
    expect(updates[0].staleData).toBe(true);
    expect(updates[0].beads).toEqual([]);
    controller.dispose();
  });

  it("suppresses stale banner and stale alerts after the first occurrence", async () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      activeBeadIds: ["pi-1", "pi-2"],
    };

    const { controller, updates } = createMockController({
      state,
      readBeadsFn: async () => {
        throw new Error("br not found");
      },
    });

    await controller.refreshNow();
    await controller.refreshNow();
    await controller.refreshNow();

    expect(updates).toHaveLength(3);
    expect(updates[0].staleData).toBe(true);  // first: shown
    expect(updates[0].alerts).toHaveLength(0);
    expect(updates[1].staleData).toBe(false); // second: suppressed
    expect(updates[1].alerts).toHaveLength(0);
    expect(updates[2].staleData).toBe(false); // third: suppressed
    expect(updates[2].alerts).toHaveLength(0);
    controller.dispose();
  });

  it("re-shows stale banner after data recovers then goes stale again", async () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "implementing",
      activeBeadIds: ["pi-1", "pi-2"],
    };

    let shouldFail = true;
    const { controller, updates } = createMockController({
      state,
      readBeadsFn: async () => {
        if (shouldFail) throw new Error("br not found");
        return [{ id: "pi-1", title: "Test", status: "open" } as any];
      },
    });

    // First: stale (shown)
    await controller.refreshNow();
    expect(updates[0].staleData).toBe(true);

    // Second: stale (suppressed)
    await controller.refreshNow();
    expect(updates[1].staleData).toBe(false);

    // Recover
    shouldFail = false;
    await controller.refreshNow();
    expect(updates[2].staleData).toBe(false);

    // Stale again (shown because it recovered)
    shouldFail = true;
    await controller.refreshNow();
    expect(updates[3].staleData).toBe(true);

    controller.dispose();
  });

  it("reuses the last healthy bead snapshot during temporary read failures", async () => {
    const state: OrchestratorState = {
      ...createInitialState(),
      phase: "refining_beads",
      activeBeadIds: ["pi-1", "pi-2"],
    };

    let shouldFail = false;
    const { controller, updates } = createMockController({
      state,
      readBeadsFn: async () => {
        if (shouldFail) throw new Error("database is busy");
        return [makeBead("pi-1"), makeBead("pi-2")];
      },
      getUnblockedBeadsFn: async () => ["pi-2"],
    });

    await controller.refreshNow();
    shouldFail = true;
    await controller.refreshNow();

    expect(updates).toHaveLength(2);
    expect(updates[0].staleData).toBe(false);
    expect(updates[0].beads.map((b) => b.id)).toEqual(["pi-1", "pi-2"]);

    expect(updates[1].staleData).toBe(true);
    expect(updates[1].staleSnapshotAgeMs).toBeTypeOf("number");
    expect(updates[1].beads.map((b) => b.id)).toEqual(["pi-1", "pi-2"]);
    expect(updates[1].alerts).toEqual([]);

    controller.dispose();
  });
});
