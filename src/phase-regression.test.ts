import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Phase Regression structural tests ─────────────────────
// These tests validate the review.ts source structure to ensure
// regression sentinels are properly defined and handle state correctly.

const __dir = dirname(fileURLToPath(import.meta.url));
const reviewSource = readFileSync(join(__dir, "tools/review.ts"), "utf8");
const gatesSource = readFileSync(join(__dir, "gates.ts"), "utf8");

describe("review.ts — regression sentinel definitions", () => {
  it("handles __regress_to_plan__ sentinel", () => {
    expect(reviewSource).toContain('params.beadId === "__regress_to_plan__"');
  });

  it("handles __regress_to_beads__ sentinel", () => {
    expect(reviewSource).toContain('params.beadId === "__regress_to_beads__"');
  });

  it("handles __regress_to_implement__ sentinel", () => {
    expect(reviewSource).toContain('params.beadId === "__regress_to_implement__"');
  });

  it("documents regression sentinels in beadId parameter description", () => {
    expect(reviewSource).toContain("__regress_to_plan__");
    expect(reviewSource).toContain("__regress_to_beads__");
    expect(reviewSource).toContain("__regress_to_implement__");
    expect(reviewSource).toContain("phase regression");
  });
});

describe("review.ts — __regress_to_plan__ state transitions", () => {
  // Extract the regress_to_plan block
  const blockStart = reviewSource.indexOf('params.beadId === "__regress_to_plan__"');
  const blockEnd = reviewSource.indexOf('params.beadId === "__regress_to_beads__"');
  const block = reviewSource.slice(blockStart, blockEnd);

  it("resets activeBeadIds", () => {
    expect(block).toContain("activeBeadIds = undefined");
  });

  it("resets beadResults", () => {
    expect(block).toContain("beadResults = {}");
  });

  it("resets beadReviews", () => {
    expect(block).toContain("beadReviews = {}");
  });

  it("resets gate state", () => {
    expect(block).toContain("currentGateIndex = 0");
    expect(block).toContain("iterationRound = 0");
  });

  it("resets polish state", () => {
    expect(block).toContain("polishRound = 0");
    expect(block).toContain("polishChanges = []");
    expect(block).toContain("polishConverged = false");
  });

  it("clears plan readiness score", () => {
    expect(block).toContain("planReadinessScore = undefined");
  });

  it("sets phase to planning", () => {
    expect(block).toContain('"planning"');
  });

  it("returns regression details", () => {
    expect(block).toContain("regression: true");
    expect(block).toContain('targetPhase: "planning"');
  });
});

describe("review.ts — __regress_to_beads__ state transitions", () => {
  const blockStart = reviewSource.indexOf('params.beadId === "__regress_to_beads__"');
  const blockEnd = reviewSource.indexOf('params.beadId === "__regress_to_implement__"');
  const block = reviewSource.slice(blockStart, blockEnd);

  it("resets gate state but NOT bead results", () => {
    expect(block).toContain("currentGateIndex = 0");
    expect(block).toContain("iterationRound = 0");
    // Should NOT reset beadResults — preserve completed work
    expect(block).not.toContain("beadResults = {}");
  });

  it("sets phase to creating_beads", () => {
    expect(block).toContain('"creating_beads"');
  });

  it("returns regression details", () => {
    expect(block).toContain("regression: true");
    expect(block).toContain('targetPhase: "creating_beads"');
  });

  it("tells user to call orch_approve_beads", () => {
    expect(block).toContain("orch_approve_beads");
  });
});

describe("review.ts — __regress_to_implement__ state transitions", () => {
  const blockStart = reviewSource.indexOf('params.beadId === "__regress_to_implement__"');
  // Find the next sentinel or end of function
  const blockEnd = reviewSource.indexOf("const bead = await getBeadById", blockStart);
  const block = reviewSource.slice(blockStart, blockEnd);

  it("resets gate state", () => {
    expect(block).toContain("currentGateIndex = 0");
    expect(block).toContain("iterationRound = 0");
  });

  it("sets phase to implementing", () => {
    expect(block).toContain('"implementing"');
  });

  it("re-opens partial beads", () => {
    expect(block).toContain('"partial"');
    expect(block).toContain('"open"');
    expect(block).toContain("reopened");
  });

  it("returns regression details with reopened list", () => {
    expect(block).toContain("regression: true");
    expect(block).toContain('targetPhase: "implementing"');
    expect(block).toContain("reopened");
  });
});

describe("gates.ts — regression hint integration", () => {
  it("defines regressionHint with all three sentinels", () => {
    expect(gatesSource).toContain("regressionHint");
    expect(gatesSource).toContain("__regress_to_beads__");
    expect(gatesSource).toContain("__regress_to_plan__");
    expect(gatesSource).toContain("__regress_to_implement__");
  });

  it("regressionHint explains what each sentinel does", () => {
    // Extract the regressionHint definition
    const hintStart = gatesSource.indexOf("const regressionHint");
    const hintEnd = gatesSource.indexOf(";", hintStart);
    const hint = gatesSource.slice(hintStart, hintEnd);
    expect(hint).toContain("bead creation");
    expect(hint).toContain("plan refinement");
    expect(hint).toContain("implementation");
  });
});
