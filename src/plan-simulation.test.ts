import { describe, it, expect } from "vitest";
import {
  computeExecutionOrder,
  computeParallelGroups,
  detectFileConflicts,
  detectMissingFiles,
  simulateExecutionPaths,
  formatSimulationReport,
  beadsToSimulated,
  type SimulatedBead,
} from "./plan-simulation.js";
import type { Bead } from "./types.js";

function sim(id: string, deps: string[] = [], files: string[] = []): SimulatedBead {
  return { id, title: `Bead ${id}`, deps, files };
}

// ─── computeExecutionOrder ─────────────────────────────────────

describe("computeExecutionOrder", () => {
  it("returns empty array for empty input", () => {
    expect(computeExecutionOrder([])).toEqual([]);
  });

  it("returns single bead for single input", () => {
    expect(computeExecutionOrder([sim("A")])).toEqual(["A"]);
  });

  it("orders linear chain correctly (deps first)", () => {
    const beads = [sim("A", ["B"]), sim("B", ["C"]), sim("C")];
    const order = computeExecutionOrder(beads);
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
  });

  it("handles diamond DAG", () => {
    const beads = [
      sim("A", ["B", "C"]),
      sim("B", ["D"]),
      sim("C", ["D"]),
      sim("D"),
    ];
    const order = computeExecutionOrder(beads);
    expect(order.indexOf("D")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("D")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("A"));
  });

  it("handles independent beads (any order valid)", () => {
    const beads = [sim("A"), sim("B"), sim("C")];
    const order = computeExecutionOrder(beads);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C"]));
  });

  it("throws on cyclic dependencies", () => {
    const beads = [sim("A", ["B"]), sim("B", ["A"])];
    expect(() => computeExecutionOrder(beads)).toThrow(/[Cc]ycle/);
  });

  it("skips external deps not in bead set", () => {
    const beads = [sim("A", ["external-dep"]), sim("B")];
    const order = computeExecutionOrder(beads);
    expect(order).toHaveLength(2);
  });
});

// ���── computeParallelGroups ─────────────────────────────────────

describe("computeParallelGroups", () => {
  it("returns empty for empty input", () => {
    expect(computeParallelGroups([])).toEqual([]);
  });

  it("puts independent beads in same group at level 0", () => {
    const groups = computeParallelGroups([sim("A"), sim("B"), sim("C")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(["A", "B", "C"]);
  });

  it("linear chain: each bead at increasing depth", () => {
    const beads = [sim("A", ["B"]), sim("B", ["C"]), sim("C")];
    const groups = computeParallelGroups(beads);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toContain("C");
    expect(groups[1]).toContain("B");
    expect(groups[2]).toContain("A");
  });

  it("diamond: D at 0, B+C at 1, A at 2", () => {
    const beads = [
      sim("A", ["B", "C"]),
      sim("B", ["D"]),
      sim("C", ["D"]),
      sim("D"),
    ];
    const groups = computeParallelGroups(beads);
    expect(groups[0]).toContain("D");
    expect(groups[1].sort()).toEqual(["B", "C"]);
    expect(groups[2]).toContain("A");
  });
});

// ─── detectFileConflicts ─────────���─────────────────────────────

describe("detectFileConflicts", () => {
  it("no conflict for beads in different groups touching same file", () => {
    const beads = [
      sim("A", ["B"], ["src/shared.ts"]),
      sim("B", [], ["src/shared.ts"]),
    ];
    const groups = [["B"], ["A"]]; // sequential
    expect(detectFileConflicts(beads, groups)).toEqual([]);
  });

  it("detects conflict for parallel beads touching same file", () => {
    const beads = [
      sim("A", [], ["src/shared.ts"]),
      sim("B", [], ["src/shared.ts"]),
    ];
    const groups = [["A", "B"]]; // parallel
    const conflicts = detectFileConflicts(beads, groups);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe("src/shared.ts");
    expect(conflicts[0].beadIds.sort()).toEqual(["A", "B"]);
  });

  it("no conflict for beads touching different files", () => {
    const beads = [
      sim("A", [], ["src/a.ts"]),
      sim("B", [], ["src/b.ts"]),
    ];
    const groups = [["A", "B"]];
    expect(detectFileConflicts(beads, groups)).toEqual([]);
  });

  it("partial conflict: 3 parallel beads, 2 share a file", () => {
    const beads = [
      sim("A", [], ["src/shared.ts"]),
      sim("B", [], ["src/shared.ts"]),
      sim("C", [], ["src/other.ts"]),
    ];
    const groups = [["A", "B", "C"]];
    const conflicts = detectFileConflicts(beads, groups);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].beadIds.sort()).toEqual(["A", "B"]);
  });
});

// ─── detectMissingFiles ────────────────────────────────────────

describe("detectMissingFiles", () => {
  it("no missing when all files exist", () => {
    const beads = [sim("A", [], ["src/a.ts", "src/b.ts"])];
    const repoFiles = new Set(["src/a.ts", "src/b.ts"]);
    expect(detectMissingFiles(beads, repoFiles)).toEqual([]);
  });

  it("reports missing files", () => {
    const beads = [sim("A", [], ["src/a.ts", "src/missing.ts"])];
    const repoFiles = new Set(["src/a.ts"]);
    const missing = detectMissingFiles(beads, repoFiles);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toEqual({ beadId: "A", file: "src/missing.ts" });
  });

  it("handles bead with no files", () => {
    const beads = [sim("A", [], [])];
    expect(detectMissingFiles(beads, new Set())).toEqual([]);
  });
});

// ─── simulateExecutionPaths ──────────���─────────────────────────

describe("simulateExecutionPaths", () => {
  it("valid graph with all files present", () => {
    const beads = [
      sim("A", ["B"], ["src/a.ts"]),
      sim("B", [], ["src/b.ts"]),
    ];
    const repoFiles = new Set(["src/a.ts", "src/b.ts"]);
    const result = simulateExecutionPaths(beads, repoFiles);
    expect(result.valid).toBe(true);
    expect(result.executionOrder).toHaveLength(2);
    expect(result.fileConflicts).toEqual([]);
    expect(result.missingFiles).toEqual([]);
  });

  it("invalid when parallel beads have file conflicts", () => {
    const beads = [
      sim("A", [], ["src/shared.ts"]),
      sim("B", [], ["src/shared.ts"]),
    ];
    const result = simulateExecutionPaths(beads, new Set(["src/shared.ts"]));
    expect(result.valid).toBe(false);
    expect(result.fileConflicts.length).toBeGreaterThan(0);
  });

  it("invalid when files are missing", () => {
    const beads = [sim("A", [], ["src/missing.ts"])];
    const result = simulateExecutionPaths(beads, new Set());
    expect(result.valid).toBe(false);
    expect(result.missingFiles.length).toBeGreaterThan(0);
  });

  it("handles cycles gracefully", () => {
    const beads = [sim("A", ["B"]), sim("B", ["A"])];
    const result = simulateExecutionPaths(beads, new Set());
    expect(result.valid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/[Cc]ycle/);
  });
});

// ���── formatSimulationReport ────────────────────────────────────

describe("formatSimulationReport", () => {
  it("clean result shows success", () => {
    const report = formatSimulationReport({
      valid: true,
      executionOrder: ["A", "B"],
      parallelGroups: [["A"], ["B"]],
      fileConflicts: [],
      missingFiles: [],
      warnings: [],
    });
    expect(report).toContain("✅");
    expect(report).toContain("passed");
  });

  it("issues result shows warnings", () => {
    const report = formatSimulationReport({
      valid: false,
      executionOrder: ["A", "B"],
      parallelGroups: [["A", "B"]],
      fileConflicts: [{ file: "src/x.ts", beadIds: ["A", "B"] }],
      missingFiles: [{ beadId: "A", file: "src/gone.ts" }],
      warnings: ["1 file conflict(s)", "1 missing file(s)"],
    });
    expect(report).toContain("⚠️");
    expect(report).toContain("src/x.ts");
    expect(report).toContain("src/gone.ts");
    expect(report).toContain("File Conflicts");
    expect(report).toContain("Missing Files");
  });
});

// ─── beadsToSimulated ──────────────────────────────────────────

describe("beadsToSimulated", () => {
  it("converts Bead[] with extractArtifacts", () => {
    const beads: Bead[] = [
      {
        id: "pi-1",
        title: "Add types",
        description: "### Files:\n- src/types.ts\n- src/utils.ts",
        status: "open",
        priority: 2,
        type: "task",
        labels: [],
      },
    ];
    const depMap = new Map([["pi-1", ["pi-2"]]]);
    const result = beadsToSimulated(beads, depMap);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("pi-1");
    expect(result[0].deps).toEqual(["pi-2"]);
    expect(result[0].files).toContain("src/types.ts");
    expect(result[0].files).toContain("src/utils.ts");
  });

  it("handles beads with no files section", () => {
    const beads: Bead[] = [
      {
        id: "pi-1",
        title: "Abstract bead",
        description: "No files listed here",
        status: "open",
        priority: 2,
        type: "task",
        labels: [],
      },
    ];
    const result = beadsToSimulated(beads, new Map());
    expect(result[0].files).toEqual([]);
    expect(result[0].deps).toEqual([]);
  });
});
