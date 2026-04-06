import { describe, it, expect } from "vitest";
import {
  computeConvergenceScore,
  strategicDriftCheckInstructions,
  blunderHuntInstructions,
  randomExplorationInstructions,
  deSlopifyInstructions,
  landingChecklistInstructions,
  swarmMarchingOrders,
  beadQualityScoringPrompt,
  freshContextRefinementPrompt,
  researchInvestigatePrompt,
  researchDeepenPrompt,
  researchInversionPrompt,
  discoveryInstructions,
  planDocumentPrompt,
  planRefinementPrompt,
  freshPlanRefinementPrompt,
  planToBeadsPrompt,
  competingPlanAgentPrompt,
  planSynthesisPrompt,
  learningsExtractionPrompt,
  AI_SLOP_PATTERNS,
  SWARM_STAGGER_DELAY_MS,
  REFINEMENT_MODELS,
  pickRefinementModel,
  implementerInstructions,
} from "./prompts.js";
import type { Bead, BeadResult } from "./types.js";

// ─── Convergence Score ──────────────────────────────────────
describe("computeConvergenceScore", () => {
  it("returns 0 for fewer than 3 rounds", () => {
    expect(computeConvergenceScore([])).toBe(0);
    expect(computeConvergenceScore([5])).toBe(0);
    expect(computeConvergenceScore([5, 3])).toBe(0);
  });

  it("high score for decreasing changes ending in zeros", () => {
    expect(computeConvergenceScore([10, 5, 2, 0, 0])).toBeGreaterThanOrEqual(0.75);
  });

  it("low score for increasing changes", () => {
    expect(computeConvergenceScore([2, 5, 10])).toBeLessThan(0.5);
  });

  it("incorporates output sizes", () => {
    const score = computeConvergenceScore([10, 5, 2], [5000, 3000, 2800]);
    expect(score).toBeGreaterThan(0);
  });

  it("steady state with zeros gives high score", () => {
    expect(computeConvergenceScore([5, 0, 0, 0])).toBeGreaterThanOrEqual(0.85);
  });
});

// ─── Strategic Drift Check ──────────────────────────────────
describe("strategicDriftCheckInstructions", () => {
  const bead: Bead = {
    id: "test-1", title: "Test bead", description: "desc",
    status: "open", priority: 2, type: "task", labels: [],
  };
  const result: BeadResult = { beadId: "test-1", status: "success", summary: "done" };

  it("includes progress percentage", () => {
    const prompt = strategicDriftCheckInstructions("Build X", [bead], [result], 1, 2);
    expect(prompt).toContain("50%");
  });

  it("includes gap analysis questions", () => {
    const prompt = strategicDriftCheckInstructions("Build X", [bead], [], 0, 1);
    expect(prompt).toContain("Gap analysis");
    expect(prompt).toContain("Direction check");
  });

  it("includes drift/continue/stop outputs", () => {
    const prompt = strategicDriftCheckInstructions("Build X", [], [], 0, 0);
    expect(prompt).toContain("CONTINUE");
    expect(prompt).toContain("PAUSE_AND_REVISE");
    expect(prompt).toContain("STOP");
  });
});

// ─── Blunder Hunt ───────────────────────────────────────────
describe("blunderHuntInstructions", () => {
  it("includes pass number", () => {
    expect(blunderHuntInstructions("/tmp", 3)).toContain("Pass 3/5");
  });

  it("uses overshoot number (80)", () => {
    expect(blunderHuntInstructions("/tmp", 1)).toContain("at least 80");
  });

  it("includes the cwd", () => {
    expect(blunderHuntInstructions("/my/project", 1)).toContain("/my/project");
  });
});

// ─── Random Exploration ─────────────────────────────────────
describe("randomExplorationInstructions", () => {
  it("excludes listed changed files", () => {
    const prompt = randomExplorationInstructions("goal", ["src/a.ts", "src/b.ts"], "/tmp");
    expect(prompt).toContain("EXCLUDE");
    expect(prompt).toContain("src/a.ts");
  });

  it("no exclude section when no changed files", () => {
    const prompt = randomExplorationInstructions("goal", [], "/tmp");
    expect(prompt).not.toContain("EXCLUDE");
  });
});

// ─── De-Slopify ─────────────────────────────────────────────
describe("deSlopifyInstructions", () => {
  it("lists files to review", () => {
    const prompt = deSlopifyInstructions(["README.md", "docs/guide.md"]);
    expect(prompt).toContain("README.md");
    expect(prompt).toContain("docs/guide.md");
  });

  it("includes pattern catalogue", () => {
    const prompt = deSlopifyInstructions(["README.md"]);
    expect(prompt).toContain("emdash");
    expect(prompt).toContain("Let");
  });
});

describe("AI_SLOP_PATTERNS", () => {
  it("is an extensible array with at least 5 patterns", () => {
    expect(AI_SLOP_PATTERNS.length).toBeGreaterThanOrEqual(5);
    expect(AI_SLOP_PATTERNS[0]).toHaveProperty("pattern");
    expect(AI_SLOP_PATTERNS[0]).toHaveProperty("fix");
  });
});

// ─── Landing Checklist ──────────────────────────────────────
describe("landingChecklistInstructions", () => {
  it("includes all checklist items", () => {
    const prompt = landingChecklistInstructions("/tmp");
    expect(prompt).toContain("Remaining work");
    expect(prompt).toContain("Quality gates");
    expect(prompt).toContain("Bead status");
    expect(prompt).toContain("Sync beads");
    expect(prompt).toContain("Commit and push");
    expect(prompt).toContain("Verify");
    expect(prompt).toContain("Session resumability");
  });

  it("includes PASS/FAIL instruction", () => {
    const prompt = landingChecklistInstructions("/tmp");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("FAIL");
  });
});

// ─── Swarm Marching Orders ──────────────────────────────────
describe("swarmMarchingOrders", () => {
  it("includes AGENTS.md reference", () => {
    expect(swarmMarchingOrders("/tmp")).toContain("AGENTS.md");
  });

  it("includes bead ID when provided", () => {
    expect(swarmMarchingOrders("/tmp", "br-42")).toContain("br-42");
  });

  it("omits specific bead ID when not provided", () => {
    const prompt = swarmMarchingOrders("/tmp");
    expect(prompt).not.toContain("Your assigned bead: ");
  });
});

describe("SWARM_STAGGER_DELAY_MS", () => {
  it("is 30 seconds", () => {
    expect(SWARM_STAGGER_DELAY_MS).toBe(30_000);
  });
});

// ─── Bead Quality Scoring ───────────────────────────────────
describe("beadQualityScoringPrompt", () => {
  it("includes WHAT/WHY/HOW axes", () => {
    const prompt = beadQualityScoringPrompt("id-1", "Title", "Description");
    expect(prompt).toContain("WHAT");
    expect(prompt).toContain("WHY");
    expect(prompt).toContain("HOW");
  });

  it("includes JSON output format", () => {
    const prompt = beadQualityScoringPrompt("id-1", "Title", "Desc");
    expect(prompt).toContain('"what"');
    expect(prompt).toContain('"why"');
    expect(prompt).toContain('"how"');
  });
});

// ─── Fresh Context Refinement ───────────────────────────────
describe("freshContextRefinementPrompt", () => {
  it("includes round number and goal", () => {
    const prompt = freshContextRefinementPrompt("/tmp", "Build X", 2);
    expect(prompt).toContain("Round 3");
    expect(prompt).toContain("Build X");
  });

  it("emphasizes no prior context", () => {
    const prompt = freshContextRefinementPrompt("/tmp", "goal", 0);
    expect(prompt).toContain("NO prior context");
  });
});

// ─── Research & Reimagine ───────────────────────────────────
describe("researchInvestigatePrompt", () => {
  it("includes external URL and project name", () => {
    const prompt = researchInvestigatePrompt("https://github.com/foo/bar", "MyProject", "/tmp");
    expect(prompt).toContain("https://github.com/foo/bar");
    expect(prompt).toContain("MyProject");
  });
});

describe("researchDeepenPrompt", () => {
  it("pushes for deeper analysis", () => {
    expect(researchDeepenPrompt()).toContain("barely scratched the surface");
  });
});

describe("researchInversionPrompt", () => {
  it("frames the inversion correctly", () => {
    const prompt = researchInversionPrompt("Alpha", "Beta");
    expect(prompt).toContain("Alpha can do");
    expect(prompt).toContain("Beta simply could never do");
  });
});

// ─── discoveryInstructions (S1: unified wizard mode) ────────
describe("discoveryInstructions", () => {
  const profile = {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: [],
    structure: "",
    entrypoints: ["src/index.ts"],
    recentCommits: [],
    hasTests: true,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };

  it("contains all 5 scoring axes", () => {
    const prompt = discoveryInstructions(profile);
    expect(prompt).toContain("Useful");
    expect(prompt).toContain("Pragmatic");
    expect(prompt).toContain("Accretive");
    expect(prompt).toContain("Robust");
    expect(prompt).toContain("Ergonomic");
  });

  it("contains tier instructions", () => {
    const prompt = discoveryInstructions(profile);
    expect(prompt).toContain('"top"');
    expect(prompt).toContain('"honorable"');
    expect(prompt).toContain("5 top");
  });

  it("contains the 8-step process", () => {
    const prompt = discoveryInstructions(profile);
    expect(prompt).toContain("Ground yourself");
    expect(prompt).toContain("Generate broadly");
    expect(prompt).toContain("Score each candidate");
    expect(prompt).toContain("Cut");
    expect(prompt).toContain("Rank");
    expect(prompt).toContain("Merge overlaps");
    expect(prompt).toContain("Balance");
    expect(prompt).toContain("Tier");
  });

  it("includes repo context from profile", () => {
    const prompt = discoveryInstructions(profile);
    expect(prompt).toContain("test-repo");
    expect(prompt).toContain("TypeScript");
  });

  it("accepts only 2 params (no mode)", () => {
    // Verify function works with just profile
    const prompt = discoveryInstructions(profile);
    expect(prompt.length).toBeGreaterThan(100);
    // Also works with scanResult
    const prompt2 = discoveryInstructions(profile, undefined);
    expect(prompt2.length).toBeGreaterThan(100);
  });
});

// ─── Competing Plan Prompts ─────────────────────────────────
describe("competingPlanAgentPrompt", () => {
  const profile = {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: [],
    structure: "",
    entrypoints: ["src/index.ts"],
    recentCommits: [],
    hasTests: true,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };

  it("tailors instructions for each focus lens", () => {
    const correctness = competingPlanAgentPrompt("correctness", "Build feature X", profile);
    const robustness = competingPlanAgentPrompt("robustness", "Build feature X", profile);
    const ergonomics = competingPlanAgentPrompt("ergonomics", "Build feature X", profile);

    expect(correctness).toContain("architectural correctness");
    expect(robustness).toContain("failure modes");
    expect(ergonomics).toContain("agent ergonomics");
  });

  it("keeps the required shared plan sections", () => {
    const prompt = competingPlanAgentPrompt("correctness", "Build feature X", profile);
    expect(prompt).toContain("Architecture Overview");
    expect(prompt).toContain("Testing Strategy");
    expect(prompt).toContain("Edge Cases & Failure Modes");
    expect(prompt).toContain("Do not create beads");
  });
});

describe("planSynthesisPrompt", () => {
  it("includes all input plans and synthesis instructions", () => {
    const prompt = planSynthesisPrompt([
      { name: "correctness", model: "model-a", plan: "Plan A" },
      { name: "robustness", model: "model-b", plan: "Plan B" },
    ]);

    expect(prompt).toContain("2 independent plan documents");
    expect(prompt).toContain("correctness (model-a)");
    expect(prompt).toContain("robustness (model-b)");
    expect(prompt).toContain("Return ONLY the synthesized markdown plan.");
  });
});

// ─── Plan Document Prompt ───────────────────────────────────
describe("planDocumentPrompt", () => {
  const profile = {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: [],
    structure: "",
    entrypoints: ["src/index.ts"],
    recentCommits: [],
    hasTests: true,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };

  it("contains key plan sections", () => {
    const prompt = planDocumentPrompt("Build feature X", profile);
    expect(prompt).toContain("Architecture Overview");
    expect(prompt).toContain("User Workflows");
    expect(prompt).toContain("Testing Strategy");
    expect(prompt).toContain("Edge Cases");
    expect(prompt).toContain("File Structure");
    expect(prompt).toContain("Sequencing");
  });

  it("includes the goal", () => {
    const prompt = planDocumentPrompt("Build feature X", profile);
    expect(prompt).toContain("Build feature X");
  });

  it("mentions ultrathink", () => {
    const prompt = planDocumentPrompt("goal", profile);
    expect(prompt).toContain("ultrathink");
  });

  it("mentions write_artifact", () => {
    const prompt = planDocumentPrompt("goal", profile);
    expect(prompt).toContain("write_artifact");
  });
});

// ─── Plan Refinement Prompt ─────────────────────────────────
describe("planRefinementPrompt", () => {
  it("references the plan path", () => {
    const prompt = planRefinementPrompt("plans/my-plan.md", 2);
    expect(prompt).toContain("plans/my-plan.md");
  });

  it("references the round number", () => {
    const prompt = planRefinementPrompt("plans/my-plan.md", 3);
    expect(prompt).toContain("Round 3");
  });

  it("mentions ultrathink", () => {
    const prompt = planRefinementPrompt("plans/x.md", 1);
    expect(prompt).toContain("ultrathink");
  });

  it("mentions fresh conversation to prevent anchoring", () => {
    const prompt = planRefinementPrompt("plans/x.md", 1);
    expect(prompt).toContain("fresh");
    expect(prompt).toContain("anchoring");
  });
});

describe("freshPlanRefinementPrompt", () => {
  it("embeds the full plan text for sub-agent use", () => {
    const prompt = freshPlanRefinementPrompt(
      "# My Plan\nStep 1: do stuff",
      "plans/my-plan.md",
      2,
      "/tmp/repo"
    );
    expect(prompt).toContain("# My Plan");
    expect(prompt).toContain("Step 1: do stuff");
  });

  it("references the round number", () => {
    const prompt = freshPlanRefinementPrompt("plan", "plans/x.md", 3, "/tmp");
    expect(prompt).toContain("Round 3");
  });

  it("emphasizes zero prior context", () => {
    const prompt = freshPlanRefinementPrompt("plan", "plans/x.md", 1, "/tmp");
    expect(prompt).toContain("ZERO prior context");
    expect(prompt).toContain("never seen this plan");
  });

  it("includes the cwd", () => {
    const prompt = freshPlanRefinementPrompt("plan", "plans/x.md", 1, "/my/project");
    expect(prompt).toContain("/my/project");
  });
});

describe("pickRefinementModel", () => {
  it("rotates through available models", () => {
    const m0 = pickRefinementModel(0);
    const m1 = pickRefinementModel(1);
    const m2 = pickRefinementModel(2);
    const m3 = pickRefinementModel(3);
    expect(m0).not.toBe(m1);
    expect(m1).not.toBe(m2);
    // Round 3 wraps back to round 0's model
    expect(m3).toBe(m0);
  });

  it("returns valid model strings", () => {
    for (let i = 0; i < 5; i++) {
      const model = pickRefinementModel(i);
      expect(model).toContain("/");
      expect(REFINEMENT_MODELS).toContain(model);
    }
  });
});

describe("planToBeadsPrompt", () => {
  const profile = {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: ["Vitest"],
    structure: "",
    entrypoints: ["src/index.ts"],
    recentCommits: [],
    hasTests: true,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };

  it("references the approved plan artifact path", () => {
    const prompt = planToBeadsPrompt("plans/feature-x.md", "Build feature X", profile as any);
    expect(prompt).toContain("plans/feature-x.md");
    expect(prompt).toContain("Build feature X");
  });

  it("requires reading the plan artifact and embedding context", () => {
    const prompt = planToBeadsPrompt("plans/feature-x.md", "Build feature X", profile as any);
    expect(prompt).toContain("Read the plan artifact");
    expect(prompt).toContain("Embed the relevant context");
    expect(prompt).toContain("Each bead must stand on its own");
  });

  it("forbids see-the-plan shorthand references", () => {
    const prompt = planToBeadsPrompt("plans/feature-x.md", "Build feature X", profile as any);
    expect(prompt).toContain('see the plan');
    expect(prompt).toContain('refer to plan');
    expect(prompt).toContain('per approved plan');
  });
});

describe("implementerInstructions", () => {
  it("recommends bv --robot-next for picking next bead", () => {
    const bead = {
      id: "test-1",
      title: "Test bead",
      description: "Do something",
      status: "ready" as const,
      deps: [],
    };
    const profile = {
      languages: ["TypeScript"],
      frameworks: ["vitest"],
      testFramework: "vitest",
      buildCommand: "npm run build",
      testCommand: "npm test",
    };
    const output = implementerInstructions(bead as any, profile as any, []);
    expect(output).toContain("bv --robot-next");
    expect(output).toContain("br ready");
  });
});

describe("learningsExtractionPrompt", () => {
  it("includes the goal and bead ids", () => {
    const output = learningsExtractionPrompt("Ship prompt routing", ["pi-orchestrator-3wz", "pi-orchestrator-t8r"]);
    expect(output).toContain("Ship prompt routing");
    expect(output).toContain("pi-orchestrator-3wz");
    expect(output).toContain("pi-orchestrator-t8r");
  });

  it("includes structured reflection questions and cm add commands", () => {
    const output = learningsExtractionPrompt("Goal", ["bead-1"]);
    expect(output).toContain("What architectural decisions were made and why?");
    expect(output).toContain("What gotchas or surprises were encountered?");
    expect(output).toContain("What patterns worked well?");
    expect(output).toContain("What would you do differently next time?");
    expect(output).toContain("Were there any tool issues or workflow friction?");
    expect(output).toContain("cm add");
    expect(output).toContain("3-7 rules");
  });
});
