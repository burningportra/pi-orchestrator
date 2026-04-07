import { describe, expect, it } from "vitest";
import { buildMultiModelPlanSubagentConfigs, multiModelPlanArtifactNames } from "./plan.js";

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
