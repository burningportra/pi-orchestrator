import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ─── S3: Gate auto-advance structural tests ─────────────────
// These tests validate the gates.ts source structure to ensure:
// - Auto-advance gates (self-review, test coverage, de-slopify) skip prompting
// - Prompted gates (peer review, commit, ship, landing) show select
// - All 7 gates preserved, none removed
// - Gate order and auto flags are correct

const gatesSource = readFileSync(join(__dirname, "gates.ts"), "utf8");

describe("gates.ts — gate definitions", () => {
  it("has exactly 7 gates", () => {
    // Count gate objects in the array
    const gateMatches = gatesSource.match(/\{ emoji: "[^"]+", label: "[^"]+", desc: "[^"]+", auto: (true|false) \}/g);
    expect(gateMatches).not.toBeNull();
    expect(gateMatches!.length).toBe(7);
  });

  it("gate order is correct", () => {
    const labels = [...gatesSource.matchAll(/label: "([^"]+)"/g)].map(m => m[1]);
    // Filter to only the gate definition labels (first 7 occurrences)
    const gateLabels = labels.slice(0, 7);
    expect(gateLabels).toEqual([
      "Fresh self-review",
      "Peer review",
      "Test coverage",
      "De-slopify",
      "Commit",
      "Ship it",
      "Landing checklist",
    ]);
  });

  it("auto flags are correct", () => {
    const gates = [...gatesSource.matchAll(/label: "([^"]+)".*?auto: (true|false)/g)];
    const autoMap = Object.fromEntries(gates.map(m => [m[1], m[2] === "true"]));
    // Auto-advance gates (non-destructive, read/write):
    expect(autoMap["Fresh self-review"]).toBe(true);
    expect(autoMap["Test coverage"]).toBe(true);
    expect(autoMap["De-slopify"]).toBe(true);
    // User-prompted gates (expensive or destructive):
    expect(autoMap["Peer review"]).toBe(false);
    expect(autoMap["Commit"]).toBe(false);
    expect(autoMap["Ship it"]).toBe(false);
    expect(autoMap["Landing checklist"]).toBe(false);
  });
});

describe("gates.ts — auto-advance logic", () => {
  it("auto gates skip ctx.ui.select", () => {
    // The gate loop should check gate.auto and break immediately for auto gates
    expect(gatesSource).toContain("if (gate.auto)");
    // Inside the auto block, it should break without calling ctx.ui.select
    const autoBlock = gatesSource.slice(
      gatesSource.indexOf("if (gate.auto)"),
      gatesSource.indexOf("// User-prompted gate")
    );
    expect(autoBlock).not.toContain("ctx.ui.select");
    expect(autoBlock).toContain("break");
  });

  it("auto gates still advance currentGateIndex", () => {
    const autoBlock = gatesSource.slice(
      gatesSource.indexOf("if (gate.auto)"),
      gatesSource.indexOf("// User-prompted gate")
    );
    expect(autoBlock).toContain("currentGateIndex = i + 1");
    expect(autoBlock).toContain("persistState");
  });

  it("prompted gates use ctx.ui.select with execute/skip/done", () => {
    const promptBlock = gatesSource.slice(
      gatesSource.indexOf("// User-prompted gate")
    );
    expect(promptBlock).toContain("ctx.ui.select");
    expect(promptBlock).toContain("Skip");
    expect(promptBlock).toContain("Done");
  });

  it("de-slopify still auto-skips when no doc files", () => {
    // The de-slopify gate handler should check for doc files
    expect(gatesSource).toContain("docFiles");
    const deSlopSection = gatesSource.slice(gatesSource.indexOf('chosen.startsWith("✏️")'));
    expect(deSlopSection).toContain("docFiles.length === 0");
    expect(deSlopSection).toContain("skipping de-slopification");
  });

  it("'Done' triggers completion and CASS memory save", () => {
    const doneSection = gatesSource.slice(gatesSource.indexOf('chosen.startsWith("✅")'));
    expect(doneSection).toContain("complete");
    expect(doneSection).toContain("cm add");
  });
});
