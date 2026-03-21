import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  readBeads,
  readyBeads,
  getBeadById,
  beadDeps,
  extractArtifacts,
  updateBeadStatus,
  validateBeads,
  getBeadsSummary,
  detectBv,
  bvInsights,
  bvNext,
  resetBvCache,
} from "./beads.js";
import type { Bead } from "./types.js";

function makePi(impl: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return { exec: vi.fn(impl) } as unknown as ExtensionAPI;
}

const CWD = "/fake/cwd";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "bead-1",
    title: "Test bead",
    description: "",
    status: "open",
    priority: 1,
    type: "task",
    labels: [],
    ...overrides,
  };
}

// ─── readBeads ───────────────────────────────────────────────

describe("readBeads", () => {
  it("parses br list --json output", async () => {
    const beads = [makeBead({ id: "b1" }), makeBead({ id: "b2" })];
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify({ issues: beads }),
      stderr: "",
    }));

    const result = await readBeads(pi, CWD);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("b1");
  });

  it("returns [] on failure", async () => {
    const pi = makePi(async () => { throw new Error("br not found"); });
    const result = await readBeads(pi, CWD);
    expect(result).toEqual([]);
  });
});

// ─── readyBeads ──────────────────────────────────────────────

describe("readyBeads", () => {
  it("parses br ready --json output", async () => {
    const beads = [makeBead({ id: "ready-1" })];
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify({ issues: beads }),
      stderr: "",
    }));

    const result = await readyBeads(pi, CWD);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ready-1");
  });

  it("returns [] on empty output", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await readyBeads(pi, CWD);
    expect(result).toEqual([]);
  });
});

// ─── getBeadById ─────────────────────────────────────────────

describe("getBeadById", () => {
  it("returns bead from br show --json", async () => {
    const bead = makeBead({ id: "abc" });
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify(bead),
      stderr: "",
    }));

    const result = await getBeadById(pi, CWD, "abc");
    expect(result?.id).toBe("abc");
  });

  it("returns null on failure", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    const result = await getBeadById(pi, CWD, "nope");
    expect(result).toBeNull();
  });
});

// ─── beadDeps ────────────────────────────────────────────────

describe("beadDeps", () => {
  it("parses dep list output", async () => {
    const pi = makePi(async () => ({
      code: 0,
      stdout: "dep-1\ndep-2\n",
      stderr: "",
    }));

    const result = await beadDeps(pi, CWD, "bead-x");
    expect(result).toEqual(["dep-1", "dep-2"]);
  });

  it("returns [] on failure", async () => {
    const pi = makePi(async () => { throw new Error("fail"); });
    const result = await beadDeps(pi, CWD, "bead-x");
    expect(result).toEqual([]);
  });
});

// ─── extractArtifacts ────────────────────────────────────────

describe("extractArtifacts", () => {
  it("extracts paths from bullet lines", () => {
    const bead = makeBead({
      description: "Some text\n- src/foo.ts\n- src/bar.ts\nMore text",
    });
    expect(extractArtifacts(bead)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("extracts from ### Files: section", () => {
    const bead = makeBead({
      description: "Intro\n### Files:\n  src/a.ts\n  lib/b.ts\n\nDone",
    });
    const result = extractArtifacts(bead);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("lib/b.ts");
  });

  it("returns [] for empty description", () => {
    expect(extractArtifacts(makeBead())).toEqual([]);
  });
});

// ─── updateBeadStatus ────────────────────────────────────────

describe("updateBeadStatus", () => {
  it("calls br update with correct args", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));
    await updateBeadStatus(pi, CWD, "bead-123", "in_progress");
    expect((pi as any).exec.mock.calls[0]).toEqual([
      "br", ["update", "bead-123", "--status", "in_progress"], expect.any(Object),
    ]);
  });

  it("handles failure gracefully", async () => {
    const pi = makePi(async () => { throw new Error("br failed"); });
    await expect(updateBeadStatus(pi, CWD, "bead-789", "closed")).resolves.toBeUndefined();
  });
});

// ─── validateBeads ───────────────────────────────────────────

describe("validateBeads", () => {
  it("returns ok=true when no cycles", async () => {
    const pi = makePi(async () => ({
      code: 0,
      stdout: "All dependency checks passed.",
      stderr: "",
    }));
    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.cycles).toBe(false);
  });

  it("detects cycles", async () => {
    const pi = makePi(async () => ({
      code: 1,
      stdout: "Detected cycle: a → b → a",
      stderr: "",
    }));
    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(false);
    expect(result.cycles).toBe(true);
  });
});

// ─── getBeadsSummary ─────────────────────────────────────────

describe("getBeadsSummary", () => {
  it("summarizes bead statuses", () => {
    const beads = [
      makeBead({ status: "closed" }),
      makeBead({ status: "in_progress" }),
      makeBead({ status: "open" }),
      makeBead({ status: "open" }),
    ];
    const summary = getBeadsSummary(beads);
    expect(summary).toContain("1 closed");
    expect(summary).toContain("1 in-progress");
    expect(summary).toContain("2 open");
  });

  it("returns 'no beads tracked' for empty array", () => {
    expect(getBeadsSummary([])).toBe("no beads tracked");
  });
});

// ─── detectBv ────────────────────────────────────────────────

describe("detectBv", () => {
  beforeEach(() => resetBvCache());

  it("returns true when bv is found", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" }));
    expect(await detectBv(pi)).toBe(true);
  });

  it("returns false when bv is not found", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await detectBv(pi)).toBe(false);
  });

  it("caches the result", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" }));
    await detectBv(pi);
    await detectBv(pi);
    expect((pi as any).exec).toHaveBeenCalledTimes(1);
  });
});

// ─── bvInsights ──────────────────────────────────────────────

describe("bvInsights", () => {
  beforeEach(() => resetBvCache());

  it("parses bv --robot-insights output", async () => {
    const insightsData = {
      Bottlenecks: [{ ID: "bead-x", Value: 8.5 }],
      Cycles: null,
      Orphans: [],
      Articulation: ["bead-y"],
      Slack: [{ ID: "bead-z", Value: 2 }],
    };
    const pi = makePi(async (_cmd, args) => {
      if (args[0] === "bv") return { code: 0, stdout: "/usr/local/bin/bv", stderr: "" };
      return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
    });
    // Mock: which bv → found, bv --robot-insights → JSON
    const pi2 = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await bvInsights(pi2, CWD);
    expect(result).not.toBeNull();
    expect(result!.Bottlenecks).toHaveLength(1);
    expect(result!.Bottlenecks[0].ID).toBe("bead-x");
    expect(result!.Articulation).toEqual(["bead-y"]);
  });

  it("returns null when bv is unavailable", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await bvInsights(pi, CWD)).toBeNull();
  });
});

// ─── bvNext ──────────────────────────────────────────────────

describe("bvNext", () => {
  beforeEach(() => resetBvCache());

  it("returns the optimal next bead pick", async () => {
    const pickData = {
      id: "bead-abc",
      title: "Do the thing",
      score: 0.85,
      reasons: ["high unblock potential"],
      unblocks: ["bead-def"],
    };
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify(pickData), stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await bvNext(pi, CWD);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("bead-abc");
    expect(result!.score).toBe(0.85);
    expect(result!.unblocks).toEqual(["bead-def"]);
  });

  it("returns null when no actionable items", async () => {
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    expect(await bvNext(pi, CWD)).toBeNull();
  });

  it("returns null when bv unavailable", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await bvNext(pi, CWD)).toBeNull();
  });
});

// ─── validateBeads with bv ───────────────────────────────────

describe("validateBeads with bv insights", () => {
  beforeEach(() => resetBvCache());

  it("uses bv insights for validation when available", async () => {
    const insightsData = {
      Bottlenecks: [{ ID: "bead-hot", Value: 10.2 }],
      Cycles: null,
      Orphans: [],
      Articulation: ["bead-critical"],
      Slack: [],
    };
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        if (cmd === "bv") return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.cycles).toBe(false);
    expect(result.warnings).toContain("bead bead-hot is a bottleneck (betweenness=10.2) — consider splitting");
    expect(result.warnings).toContain("bead bead-critical is a single point of failure in the dep graph");
  });

  it("detects cycles from bv insights", async () => {
    const insightsData = {
      Bottlenecks: [],
      Cycles: [["a", "b", "a"]],
      Orphans: ["orphan-1"],
      Articulation: [],
      Slack: [],
    };
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        if (cmd === "bv") return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(false);
    expect(result.cycles).toBe(true);
    expect(result.orphaned).toEqual(["orphan-1"]);
  });

  it("falls back to manual detection when bv unavailable", async () => {
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        // br dep cycles
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
          return { code: 0, stdout: "All dependency checks passed.", stderr: "" };
        }
        // br list --json
        return { code: 0, stdout: JSON.stringify([]), stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
