import { describe, it, expect, vi } from "vitest";
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
