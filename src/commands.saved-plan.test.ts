import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("saved plan workflow continuity", () => {
  const source = readFileSync(join(__dirname, "commands.ts"), "utf8");

  it("routes loaded saved plans back through awaiting_plan_approval", () => {
    expect(source).toContain('oc.setPhase("awaiting_plan_approval", ctx)');
  });

  it("tells the agent to call orch_approve_beads after loading a saved plan", () => {
    expect(source).toContain("review this plan inside the orchestration workflow");
    expect(source).toContain("Do not skip directly to bead creation");
    expect(source).toContain("Artifact: \\`${selectedPlan.artifactName}\\`");
  });

  it("makes the startup-only opening ceremony hook explicit before any startup UI", () => {
    expect(source).toContain("const runOrchestrateStartupFlow = async () => {");
    expect(source).toContain("Opening ceremony hook:");
    expect(source).toContain("await runOrchestrateStartupFlow();");
    expect(source).toContain("Existing orchestration detected");
    expect(source).toContain("Start the orchestrator workflow for this repo. Begin by calling `orch_profile` to scan the repository.");

    expect(source).toMatch(/Opening ceremony hook:[\s\S]*await runOrchestrateStartupFlow\(\);/);
  });
});
