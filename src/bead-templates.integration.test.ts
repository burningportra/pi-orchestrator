import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatTemplatesForPrompt, expandTemplate } from "./bead-templates.js";
import { beadCreationPrompt, planToBeadsPrompt } from "./prompts.js";
import { validateBeads } from "./beads.js";
import type { Bead, RepoProfile } from "./types.js";

const CWD = "/fake/cwd";

const profile: RepoProfile = {
  name: "pi-orchestrator",
  languages: ["TypeScript"],
  frameworks: ["Vitest"],
  structure: "",
  entrypoints: ["src/index.ts"],
  recentCommits: [],
  hasTests: true,
  testFramework: "vitest",
  hasDocs: true,
  hasCI: true,
  todos: [],
  keyFiles: {},
};

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

function makeValidationPi(beads: Bead[]): ExtensionAPI {
  return {
    exec: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "which") throw new Error("not found");
      if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
        return { code: 0, stdout: "OK", stderr: "" };
      }
      if (cmd === "br" && args[0] === "list") {
        return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
      }
      if (cmd === "br" && args[0] === "dep" && args[1] === "list") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    }),
  } as unknown as ExtensionAPI;
}

describe("bead template workflow integration", () => {
  it("embeds the shared template library in both planning prompts", () => {
    const formatted = formatTemplatesForPrompt();
    const creationPrompt = beadCreationPrompt("Build feature X", "repo context", []);
    const planPrompt = planToBeadsPrompt("plans/feature-x.md", "Build feature X", profile);

    expect(formatted).toContain("add-api-endpoint");
    expect(formatted).toContain("refactor-module");
    expect(formatted).toContain("add-tests");
    expect(creationPrompt).toContain("## Template Library");
    expect(creationPrompt).toContain(formatted);
    expect(planPrompt).toContain("## Template Library");
    expect(planPrompt).toContain(formatted);
  });

  it("keeps prompt guidance about optional templates and pre-existing quality requirements", () => {
    const creationPrompt = beadCreationPrompt("Build feature X", "repo context", []);
    const planPrompt = planToBeadsPrompt("plans/feature-x.md", "Build feature X", profile);

    expect(creationPrompt).toContain("Templates are optional");
    expect(creationPrompt).toContain("### Files:");
    expect(creationPrompt).toContain("Acceptance criteria");
    expect(planPrompt).toContain("The plan is your primary source");
    expect(planPrompt).toContain("self-contained");
    expect(planPrompt).toContain("dependency edges");
  });

  it("warns against lazy template references in both prompts", () => {
    const creationPrompt = beadCreationPrompt("Build feature X", "repo context", []);
    const planPrompt = planToBeadsPrompt("plans/feature-x.md", "Build feature X", profile);

    expect(creationPrompt).toContain("[Use template: ...]");
    expect(creationPrompt).toContain("see template");
    expect(planPrompt).toContain("[Use template: ...]");
    expect(planPrompt).toContain("see template");
    expect(planPrompt).toContain("{{placeholderName}}");
  });

  it("expands real templates into br-create-ready descriptions", () => {
    const endpoint = expandTemplate("add-api-endpoint", {
      endpointPath: "/users",
      moduleName: "user-management",
      endpointPurpose: "return a filtered user list",
      httpMethod: "GET",
      implementationFile: "src/api/users.ts",
      testFile: "src/api/users.test.ts",
    });
    const refactor = expandTemplate("refactor-module", {
      moduleName: "auth",
      refactorGoal: "extract validation helpers",
      currentPain: "logic and rendering are tightly coupled",
      moduleFile: "src/auth.ts",
      testFile: "src/auth.test.ts",
    });
    const tests = expandTemplate("add-tests", {
      featureName: "prompt template guidance",
      riskArea: "lazy template references",
      implementationFile: "src/prompts.ts",
      testFile: "src/flywheel.test.ts",
    });

    for (const result of [endpoint, refactor, tests]) {
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.description).not.toContain("{{");
      expect(result.description).toContain("### Files:");
      expect(result.description).toContain("Acceptance criteria:");
    }
  });

  it("returns clear errors for invalid template expansion inputs", () => {
    const missingTemplate = expandTemplate("nonexistent-template", {});
    const missingPlaceholders = expandTemplate("add-api-endpoint", {});

    expect(missingTemplate).toEqual({
      success: false,
      error: "Unknown bead template: nonexistent-template",
    });
    expect(missingPlaceholders.success).toBe(false);
    if (!missingPlaceholders.success) {
      expect(missingPlaceholders.error).toContain("Missing required placeholders");
    }
  });

  it("catches template artifacts in open beads but not legitimate prose or closed beads", async () => {
    const beads = [
      makeBead({
        id: "open-bad-1",
        description: `Need endpoint work.\n[Use template: add-api-endpoint]\n### Files:\n- src/api/users.ts\n- src/api/users.test.ts\n- [ ] one\n- [ ] two`,
      }),
      makeBead({
        id: "open-bad-2",
        description: `See template for implementation details and fill {{endpointPath}} later.\n### Files:\n- src/api/users.ts\n- src/api/users.test.ts\n- [ ] one\n- [ ] two`,
      }),
      makeBead({
        id: "open-good",
        description: `This follows the singleton template pattern used by the parser.\n\n### Files:\n- src/parser.ts\n- src/parser.test.ts\n\n- [ ] explain the pattern\n- [ ] keep tests passing`,
      }),
      makeBead({
        id: "closed-draft",
        status: "closed",
        description: `[Use template: add-tests]\n{{featureName}}`,
      }),
    ];

    const validation = await validateBeads(makeValidationPi(beads), CWD);

    expect(validation.templateIssues.some((issue) => issue.beadId === "open-bad-1")).toBe(true);
    expect(validation.templateIssues.some((issue) => issue.beadId === "open-bad-2" && issue.issueType === "unresolved-placeholder")).toBe(true);
    expect(validation.templateIssues.some((issue) => issue.beadId === "open-good")).toBe(false);
    expect(validation.templateIssues.some((issue) => issue.beadId === "closed-draft")).toBe(false);
  });
});
