import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ─── S5: Structural tests for select.ts ─────────────────────
// These tests validate the code structure of select.ts to ensure:
// - System-generated ideas skip the refinement questionnaire
// - Custom goals still use refinement
// - All paths remain intact
//
// We test the source code structure rather than mocking the full tool
// because the tool requires ExtensionAPI, ExtensionContext, and UI mocks
// that are tightly coupled to the pi runtime. The structural tests catch
// regressions if someone re-adds the refine dialog.

const selectSource = readFileSync(join(__dirname, "select.ts"), "utf8");

describe("select.ts — S5: skip refinement for system ideas", () => {
  it("does NOT contain refineChoice for system-generated ideas", () => {
    // The refineChoice variable was used to ask "Use as-is / Refine?"
    // after selecting a system-generated idea. It should be removed.
    expect(selectSource).not.toContain("refineChoice");
    expect(selectSource).not.toContain("Would you like to refine");
    expect(selectSource).not.toContain("Continue — use as-is");
  });

  it("still imports runGoalRefinement for custom goal path", () => {
    expect(selectSource).toContain("runGoalRefinement");
  });

  it("still imports extractConstraints for custom goal path", () => {
    expect(selectSource).toContain("extractConstraints");
  });

  it("still calls runGoalRefinement in the custom goal branch", () => {
    // The custom goal branch (✏️ Enter a custom goal) should still call refinement
    const customGoalSection = selectSource.slice(
      selectSource.indexOf("✏️")
    );
    expect(customGoalSection).toContain("runGoalRefinement");
  });

  it("still has constraints input for all paths", () => {
    // The constraints input dialog should appear regardless of path
    expect(selectSource).toContain("Any constraints?");
    expect(selectSource).toContain("constraintInput");
  });

  it("sets goal from idea title and description for system ideas", () => {
    // The system idea branch should set goal = `${idea.title}: ${idea.description}`
    expect(selectSource).toContain("idea.title");
    expect(selectSource).toContain("idea.description");
  });

  it("tier header selection stops orchestration", () => {
    // Selecting a tier header ("──") should stop orchestration
    expect(selectSource).toContain('choice.startsWith("──")');
    expect(selectSource).toContain("No idea selected");
  });
});
