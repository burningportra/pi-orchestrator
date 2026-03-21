import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBeadsFromPlan,
  updateBeadStatus,
  validateBeads,
} from "./beads.js";
import type { PlanStep } from "./types.js";

function makePi(impl: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return { exec: vi.fn(impl) } as unknown as ExtensionAPI;
}

const CWD = "/fake/cwd";

// ─── createBeadsFromPlan ─────────────────────────────────────

describe("createBeadsFromPlan", () => {
  it("creates beads and returns beadIds map", async () => {
    const pi = makePi(async (cmd, args) => {
      if (cmd === "br" && args[0] === "create") {
        return { code: 0, stdout: "✓ Created pi-orchestrator-abc: Step 1: Do something", stderr: "" };
      }
      // dep add + sync
      return { code: 0, stdout: "", stderr: "" };
    });

    const steps: PlanStep[] = [
      { index: 1, description: "Do something", acceptanceCriteria: ["It works"], artifacts: [] },
    ];

    const result = await createBeadsFromPlan(pi, CWD, steps);
    expect(result[1]).toBe("pi-orchestrator-abc");
  });

  it("creates multiple beads with dependency edges", async () => {
    const ids = ["bead-aaa", "bead-bbb"];
    let createCount = 0;

    const pi = makePi(async (cmd, args) => {
      if (cmd === "br" && args[0] === "create") {
        const id = ids[createCount++];
        return { code: 0, stdout: `✓ Created ${id}: Step title`, stderr: "" };
      }
      if (cmd === "br" && args[0] === "dep" && args[1] === "add") {
        return { code: 0, stdout: "dep added", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const steps: PlanStep[] = [
      { index: 1, description: "First step", acceptanceCriteria: [], artifacts: [] },
      { index: 2, description: "Second step", acceptanceCriteria: [], artifacts: [], dependsOn: [1] },
    ];

    const result = await createBeadsFromPlan(pi, CWD, steps);
    expect(result[1]).toBe("bead-aaa");
    expect(result[2]).toBe("bead-bbb");

    // Verify dep add was called with correct args
    const depCall = (pi as any).exec.mock.calls.find(
      ([cmd, args]: [string, string[]]) => cmd === "br" && args[0] === "dep" && args[1] === "add"
    );
    expect(depCall).toBeTruthy();
    expect(depCall[1]).toEqual(["dep", "add", "bead-bbb", "bead-aaa"]);
  });

  it("handles br create failure gracefully (non-fatal)", async () => {
    const pi = makePi(async (cmd, args) => {
      if (cmd === "br" && args[0] === "create") {
        throw new Error("br not found");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const steps: PlanStep[] = [
      { index: 1, description: "Step", acceptanceCriteria: [], artifacts: [] },
    ];

    // Should not throw
    const result = await createBeadsFromPlan(pi, CWD, steps);
    expect(result[1]).toBeUndefined();
  });

  it("calls sync at the end", async () => {
    const pi = makePi(async (cmd, args) => {
      if (cmd === "br" && args[0] === "create") {
        return { code: 0, stdout: "✓ Created bead-xyz: Step", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const steps: PlanStep[] = [
      { index: 1, description: "Step", acceptanceCriteria: [], artifacts: [] },
    ];

    await createBeadsFromPlan(pi, CWD, steps);

    const syncCall = (pi as any).exec.mock.calls.find(
      ([cmd, args]: [string, string[]]) => cmd === "br" && args[0] === "sync"
    );
    expect(syncCall).toBeTruthy();
    expect(syncCall[1]).toContain("--flush-only");
  });
});

// ─── updateBeadStatus ────────────────────────────────────────

describe("updateBeadStatus", () => {
  it("calls br update with in_progress status", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));
    await updateBeadStatus(pi, CWD, "bead-123", "in_progress");

    const calls = (pi as any).exec.mock.calls;
    expect(calls[0]).toEqual(["br", ["update", "bead-123", "--status", "in_progress"], expect.any(Object)]);
  });

  it("calls br update with closed status", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));
    await updateBeadStatus(pi, CWD, "bead-456", "closed");

    const calls = (pi as any).exec.mock.calls;
    expect(calls[0]).toEqual(["br", ["update", "bead-456", "--status", "closed"], expect.any(Object)]);
  });

  it("handles failure gracefully (non-fatal)", async () => {
    const pi = makePi(async () => { throw new Error("br failed"); });
    // Should not throw
    await expect(updateBeadStatus(pi, CWD, "bead-789", "closed")).resolves.toBeUndefined();
  });
});

// ─── validateBeads ───────────────────────────────────────────

describe("validateBeads", () => {
  it("returns ok=true when no cycles detected", async () => {
    const pi = makePi(async (cmd, args) => {
      if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
        return { code: 0, stdout: "All dependency checks passed. Nothing to report.", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.cycles).toBe(false);
    expect(result.orphaned).toEqual([]);
  });

  it("returns ok=false and cycles=true when cycle info present", async () => {
    const pi = makePi(async (cmd, args) => {
      if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
        return { code: 1, stdout: "Detected cycle: bead-a → bead-b → bead-a", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(false);
    expect(result.cycles).toBe(true);
  });

  it("handles br dep cycles failure gracefully", async () => {
    const pi = makePi(async () => { throw new Error("br failed"); });

    const result = await validateBeads(pi, CWD);
    // Non-fatal — should still return a result
    expect(result.cycles).toBe(false);
  });
});
