import { describe, it, expect } from "vitest";
import { buildDashboardSnapshot, PHASE_EMOJI } from "../model.js";
import { renderDashboardLines } from "../render.js";
import type { OrchestratorPhase, OrchestratorState, Bead } from "../../types.js";
import { createInitialState } from "../../types.js";
import type { DashboardSnapshot, BeadSnapshot } from "../types.js";

const ALL_PHASES = Object.keys(PHASE_EMOJI) as OrchestratorPhase[];

// Log random seed so fuzz failures are reproducible.
const FUZZ_SEED = Math.floor(Math.random() * 2 ** 32);
console.log(`[fuzz] seed=${FUZZ_SEED}`);

// Simple seeded PRNG (mulberry32) for reproducible fuzz runs.
function makePrng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makePrng(FUZZ_SEED);
const BEAD_STATUSES: Bead["status"][] = ["open", "in_progress", "closed", "deferred"];

const mockTheme = {
  primary: (t: string) => t,
  muted: (t: string) => t,
  success: (t: string) => t,
  warning: (t: string) => t,
  error: (t: string) => t,
};

function randomString(maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789🔧📊✅日本語 ";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(rand() * chars.length)];
  }
  return s;
}

function randomPhase(): OrchestratorPhase {
  return ALL_PHASES[Math.floor(rand() * ALL_PHASES.length)];
}

function randomBead(): Bead {
  return {
    id: `pi-${randomString(5)}`,
    title: randomString(200),
    description: randomString(300),
    status: BEAD_STATUSES[Math.floor(rand() * BEAD_STATUSES.length)],
    priority: Math.floor(rand() * 10) - 3, // can be negative
    type: "task",
    labels: [],
  };
}

function randomState(): OrchestratorState {
  const base = createInitialState();
  base.phase = randomPhase();

  if (rand() > 0.3) {
    base.repoProfile = { name: randomString(50) } as any;
  }
  if (rand() > 0.3) {
    base.scanResult = { source: rand() > 0.5 ? "ccc" : "builtin" } as any;
  }
  if (rand() > 0.3) {
    base.selectedGoal = randomString(200);
  }
  if (rand() > 0.3) {
    const ids = Array.from({ length: Math.floor(rand() * 10) }, () => `pi-${randomString(3)}`);
    base.activeBeadIds = ids;
  }
  if (rand() > 0.5) {
    base.beadResults = {};
    const count = Math.floor(rand() * 5);
    for (let i = 0; i < count; i++) {
      const id = `pi-${randomString(3)}`;
      base.beadResults[id] = {
        beadId: id,
        status: rand() > 0.5 ? "success" : "partial",
        summary: randomString(50),
      };
    }
  }
  if (rand() > 0.5) {
    base.beadReviews = {};
    const count = Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const id = `pi-${randomString(3)}`;
      base.beadReviews[id] = [{
        beadId: id,
        passed: rand() > 0.5,
        feedback: randomString(50),
      }];
    }
  }
  if (rand() > 0.5) {
    base.beadReviewPassCounts = {};
    const count = Math.floor(rand() * 5);
    for (let i = 0; i < count; i++) {
      base.beadReviewPassCounts[`pi-${randomString(3)}`] = Math.floor(rand() * 5);
    }
  }
  return base;
}

function randomSnapshot(): DashboardSnapshot {
  const beadCount = Math.floor(rand() * 10);
  const beads: BeadSnapshot[] = Array.from({ length: beadCount }, () => ({
    id: `pi-${randomString(5)}`,
    title: randomString(200),
    status: BEAD_STATUSES[Math.floor(rand() * BEAD_STATUSES.length)],
    priority: Math.floor(rand() * 5),
    unblocked: rand() > 0.5,
    reviewPasses: Math.floor(rand() * 3),
    lastReviewVerdict: rand() > 0.5 ? true : rand() > 0.5 ? false : undefined,
  }));

  return {
    phase: randomPhase(),
    phaseLabel: randomString(20),
    phaseEmoji: PHASE_EMOJI[randomPhase()],
    repoName: randomString(40),
    scanSource: rand() > 0.5 ? "ccc" : "unknown",
    goal: randomString(150),
    beads,
    completedCount: Math.floor(rand() * beadCount),
    totalCount: beadCount,
    tenderSummary: Math.random() > 0.5 ? randomString(50) : undefined,
    lastRefreshMs: Date.now(),
    staleData: rand() > 0.7,
    alerts: rand() > 0.5
      ? [{ level: "warning" as const, message: randomString(100) }]
      : [],
  };
}

describe("fuzz: buildDashboardSnapshot", () => {
  it("never throws on 100 random inputs and returns valid shapes", () => {
    for (let i = 0; i < 100; i++) {
      const state = randomState();
      const beadCount = Math.floor(Math.random() * 8);
      const beads = Array.from({ length: beadCount }, randomBead);
      const unblockedIds = new Set(
        beads.filter(() => rand() > 0.5).map((b) => b.id),
      );
      const tenderSummary = rand() > 0.5 ? randomString(30) : undefined;

      const snap = buildDashboardSnapshot(state, beads, unblockedIds, tenderSummary);

      // Shape assertions
      expect(Array.isArray(snap.beads)).toBe(true);
      expect(Array.isArray(snap.alerts)).toBe(true);
      expect(typeof snap.phase).toBe("string");
      expect(typeof snap.phaseEmoji).toBe("string");
      expect(typeof snap.completedCount).toBe("number");
      expect(typeof snap.totalCount).toBe("number");
      expect(typeof snap.staleData).toBe("boolean");
      expect(typeof snap.lastRefreshMs).toBe("number");
    }
  });
});

describe("fuzz: renderDashboardLines", () => {
  const WIDTHS = [0, 1, 5, 20, 40, 80, 200];

  it("never throws on 100 random snapshots across multiple widths", () => {
    for (let i = 0; i < 100; i++) {
      const snapshot = randomSnapshot();

      for (const width of WIDTHS) {
        const lines = renderDashboardLines(snapshot, mockTheme, width);

        // Shape assertions
        expect(Array.isArray(lines)).toBe(true);
        for (const line of lines) {
          expect(typeof line).toBe("string");
        }
      }
    }
  });
});
