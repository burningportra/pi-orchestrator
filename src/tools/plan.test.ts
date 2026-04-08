import { describe, expect, it } from "vitest";
import {
  buildMultiModelPlanSubagentConfigs,
  multiModelPlanArtifactNames,
  singleModelPlanArtifactName,
  slugifyGoal,
} from "./plan.js";

const profile = {
  name: "demo",
  rootPath: "/repo",
  languages: ["TypeScript"],
  frameworks: ["Vitest"],
  packageManager: "pnpm",
  entrypoints: ["src/index.ts"],
  hasTests: true,
  testFramework: "vitest",
  hasDocs: true,
  hasCI: false,
  ciPlatform: undefined,
  todos: [],
  recentCommits: [],
  readme: "",
} as any;

describe("slugifyGoal", () => {
  it("creates stable kebab-case slugs for plan artifacts", () => {
    expect(slugifyGoal("Add end-to-end /orchestrate smoke tests")).toBe(
      "add-end-to-end-orchestrate-smoke-tests",
    );
  });
});

describe("singleModelPlanArtifactName", () => {
  it("creates deterministic single-model artifact names", () => {
    expect(singleModelPlanArtifactName("TopStepX API Rate Limiter Guard")).toBe(
      "plans/topstepx-api-rate-limiter-guard.md",
    );
  });
});

describe("multiModelPlanArtifactNames", () => {
  it("creates deterministic final and per-planner artifact names", () => {
    const artifacts = multiModelPlanArtifactNames("TopStepX API Rate Limiter Guard");
    expect(artifacts.final).toBe("plans/topstepx-api-rate-limiter-guard-multi-model.md");
    expect(artifacts.planners.correctness).toBe(
      "plans/topstepx-api-rate-limiter-guard-multi-model/correctness.md",
    );
    expect(artifacts.planners.robustness).toBe(
      "plans/topstepx-api-rate-limiter-guard-multi-model/robustness.md",
    );
    expect(artifacts.planners.ergonomics).toBe(
      "plans/topstepx-api-rate-limiter-guard-multi-model/ergonomics.md",
    );
  });
});

describe("plan workflow handoff", () => {
  it("tells the agent to continue into orch_approve_beads after writing the single-model plan", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "plan.ts"), "utf8");

    expect(source).toContain("After writing the artifact, immediately continue the workflow by calling");
    expect(source).toContain("orch_approve_beads");
    expect(source).toContain("oc.state.planDocument = artifactName");
  });

  it("keeps the multi-model path inside orch_approve_beads after synthesis", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "plan.ts"), "utf8");

    expect(source).toContain("review the synthesized plan in-menu");
    expect(source).toContain("Stay inside the orchestration workflow");
  });
});

describe("buildMultiModelPlanSubagentConfigs", () => {
  it("builds interactive planner subagent configs that persist artifacts", () => {
    const configs = buildMultiModelPlanSubagentConfigs(
      "/repo",
      "TopStepX API Rate Limiter Guard",
      profile,
      undefined,
    );

    expect(configs).toHaveLength(3);
    expect(configs.map((config) => config.name)).toEqual([
      "plan-correctness",
      "plan-robustness",
      "plan-ergonomics",
    ]);
    for (const config of configs) {
      expect(config.agent).toBe("planner");
      expect(config.cwd).toBe("/repo");
      expect(config.task).toContain("write_artifact");
      expect(config.task).toContain("Do not create beads");
    }
    expect(configs[0].task).toContain(
      "plans/topstepx-api-rate-limiter-guard-multi-model/correctness.md",
    );
  });
});
