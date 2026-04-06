import { describe, it, expect } from "vitest";
import {
  detectSpaceViolations,
  extractBeadFiles,
  countUncertaintySignals,
  formatSpaceViolations,
} from "./space-detector.js";
import type { Bead } from "./types.js";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "test-1",
    title: "Test bead",
    description: "### Files: src/foo.ts, src/bar.ts",
    status: "open",
    priority: 2,
    type: "task",
    labels: [],
    ...overrides,
  };
}

// ─── extractBeadFiles ───────────────────────────────────────

describe("extractBeadFiles", () => {
  it("extracts files from ### Files: section (comma-separated)", () => {
    const bead = makeBead({ description: "Do stuff\n### Files: src/foo.ts, src/bar.ts\n\nMore text" });
    expect(extractBeadFiles(bead)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("extracts files from ### Files: section (newline-separated)", () => {
    const bead = makeBead({
      description: "Do stuff\n### Files:\n- src/foo.ts\n- src/bar.ts\n\n### Other",
    });
    expect(extractBeadFiles(bead)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("extracts inline backtick file references", () => {
    const bead = makeBead({
      description: "Modify `src/index.ts` and `src/utils.ts` for this feature",
    });
    expect(extractBeadFiles(bead)).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("deduplicates files from both sources", () => {
    const bead = makeBead({
      description: "### Files: src/foo.ts\n\nAlso modify `src/foo.ts`",
    });
    const files = extractBeadFiles(bead);
    expect(files.filter((f) => f === "src/foo.ts")).toHaveLength(1);
  });

  it("returns empty array for bead with no files", () => {
    const bead = makeBead({ description: "Just a description with no file references" });
    expect(extractBeadFiles(bead)).toEqual([]);
  });

  it("handles lib/ and test/ prefixes in inline refs", () => {
    const bead = makeBead({
      description: "Update `lib/core.ts` and `tests/core.test.ts`",
    });
    expect(extractBeadFiles(bead)).toEqual(["lib/core.ts", "tests/core.test.ts"]);
  });
});

// ─── countUncertaintySignals ────────────────────────────────

describe("countUncertaintySignals", () => {
  it("returns 0 for confident text", () => {
    expect(countUncertaintySignals("Implemented the feature. All tests pass. Clean and working.")).toBe(0);
  });

  it("detects common hedging patterns", () => {
    expect(countUncertaintySignals("I think this might need some changes, not sure if it works")).toBeGreaterThanOrEqual(3);
  });

  it("detects workaround language", () => {
    expect(countUncertaintySignals("Added a hacky workaround for the issue")).toBeGreaterThanOrEqual(2);
  });

  it("is case-insensitive", () => {
    expect(countUncertaintySignals("I THINK this MIGHT NEED changes")).toBeGreaterThanOrEqual(2);
  });

  it("counts distinct patterns, not occurrences", () => {
    // "probably" appears twice but should only count once
    expect(countUncertaintySignals("probably works, probably fine")).toBe(1);
  });
});

// ─── detectSpaceViolations ──────────────────────────────────

describe("detectSpaceViolations", () => {
  it("returns empty array when no violations detected", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts, src/bar.ts" });
    const violations = detectSpaceViolations(
      bead,
      "Implemented the feature cleanly.",
      "All acceptance criteria met.",
      ["src/foo.ts", "src/bar.ts"]
    );
    expect(violations).toEqual([]);
  });

  it("returns empty array when bead has no file list", () => {
    const bead = makeBead({ description: "Do something" });
    const violations = detectSpaceViolations(
      bead,
      "Done",
      "Looks good",
      ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]
    );
    expect(violations).toEqual([]);
  });

  it("detects architecture invention (many unexpected files)", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts, src/bar.ts" });
    const violations = detectSpaceViolations(
      bead,
      "Implemented the feature.",
      "All good.",
      ["src/foo.ts", "src/bar.ts", "src/new-module.ts", "src/types.ts", "src/utils.ts"]
    );
    const archViolation = violations.find((v) => v.type === "architecture_invention");
    expect(archViolation).toBeDefined();
    expect(archViolation!.severity).toBe("warning");
    expect(archViolation!.evidence).toContain("3 files modified outside bead scope");
  });

  it("detects critical architecture invention (way more unexpected files)", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts" });
    const unexpectedFiles = Array.from({ length: 6 }, (_, i) => `src/unexpected-${i}.ts`);
    const violations = detectSpaceViolations(
      bead,
      "Had to refactor a lot.",
      "Done.",
      ["src/foo.ts", ...unexpectedFiles]
    );
    const archViolation = violations.find((v) => v.type === "architecture_invention");
    expect(archViolation).toBeDefined();
    expect(archViolation!.severity).toBe("critical");
  });

  it("detects scope creep (files changed >> bead file list)", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts" });
    const manyFiles = Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`);
    const violations = detectSpaceViolations(
      bead,
      "Implemented.",
      "OK.",
      ["src/foo.ts", ...manyFiles]
    );
    const creepViolation = violations.find((v) => v.type === "scope_creep");
    expect(creepViolation).toBeDefined();
    expect(creepViolation!.evidence).toContain("9 were changed");
  });

  it("detects uncertainty language", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts" });
    const violations = detectSpaceViolations(
      bead,
      "I think this might need changes. Not sure if the approach is right. Probably works but needs further investigation.",
      "This is a guess at best.",
      ["src/foo.ts"]
    );
    const uncertaintyViolation = violations.find((v) => v.type === "uncertainty");
    expect(uncertaintyViolation).toBeDefined();
    expect(uncertaintyViolation!.evidence).toContain("uncertainty signals");
  });

  it("does not flag uncertainty for confident summaries", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts" });
    const violations = detectSpaceViolations(
      bead,
      "Implemented the feature. All tests pass.",
      "Clean implementation, meets all criteria.",
      ["src/foo.ts"]
    );
    expect(violations.filter((v) => v.type === "uncertainty")).toHaveLength(0);
  });

  it("handles fuzzy file matching (basename match)", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts" });
    // Changed file has a different path prefix but same basename
    const violations = detectSpaceViolations(
      bead,
      "Done.",
      "OK.",
      ["packages/core/src/foo.ts"]
    );
    // Should not flag as architecture invention since basename matches
    expect(violations.filter((v) => v.type === "architecture_invention")).toHaveLength(0);
  });

  it("can detect multiple violation types simultaneously", () => {
    const bead = makeBead({ description: "### Files: src/foo.ts" });
    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/extra-${i}.ts`);
    const violations = detectSpaceViolations(
      bead,
      "I think this might need changes, not sure if it works, probably a hacky workaround, needs further investigation",
      "This is a guess",
      ["src/foo.ts", ...manyFiles]
    );
    const types = violations.map((v) => v.type);
    expect(types).toContain("architecture_invention");
    expect(types).toContain("scope_creep");
    expect(types).toContain("uncertainty");
  });
});

// ─── formatSpaceViolations ──────────────────────────────────

describe("formatSpaceViolations", () => {
  it("returns empty string for no violations", () => {
    expect(formatSpaceViolations([])).toBe("");
  });

  it("includes header and violation details", () => {
    const formatted = formatSpaceViolations([
      {
        type: "architecture_invention",
        severity: "warning",
        evidence: "5 unexpected files",
        suggestion: "Create new beads",
      },
    ]);
    expect(formatted).toContain("Space Violation Detected");
    expect(formatted).toContain("Architecture Invention");
    expect(formatted).toContain("5 unexpected files");
    expect(formatted).toContain("Create new beads");
  });

  it("uses correct emoji for severity", () => {
    const warning = formatSpaceViolations([
      { type: "scope_creep", severity: "warning", evidence: "e", suggestion: "s" },
    ]);
    expect(warning).toContain("⚠️");

    const critical = formatSpaceViolations([
      { type: "scope_creep", severity: "critical", evidence: "e", suggestion: "s" },
    ]);
    expect(critical).toContain("🔴");
  });

  it("formats multiple violations", () => {
    const formatted = formatSpaceViolations([
      { type: "architecture_invention", severity: "warning", evidence: "e1", suggestion: "s1" },
      { type: "uncertainty", severity: "warning", evidence: "e2", suggestion: "s2" },
    ]);
    expect(formatted).toContain("Architecture Invention");
    expect(formatted).toContain("Uncertainty Detected");
  });
});
