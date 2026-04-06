import { describe, expect, it } from "vitest";
import {
  expandTemplate,
  formatTemplatesForPrompt,
  getTemplateById,
  listBeadTemplates,
} from "./bead-templates.js";

describe("bead templates", () => {
  it("returns the built-in catalog in deterministic order", () => {
    const first = listBeadTemplates();
    const second = listBeadTemplates();

    expect(first.map((template) => template.id)).toEqual([
      "add-api-endpoint",
      "refactor-module",
      "add-tests",
    ]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("defines the required shape for every built-in template", () => {
    const templates = listBeadTemplates();

    for (const template of templates) {
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.summary.length).toBeGreaterThan(0);
      expect(template.descriptionTemplate).toContain("### Files:");
      expect(template.placeholders.length).toBeGreaterThanOrEqual(2);
      expect(template.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
      expect(template.filePatterns.length).toBeGreaterThanOrEqual(2);
      expect(template.examples.length).toBeGreaterThanOrEqual(1);
      for (const placeholder of template.placeholders) {
        expect(placeholder.name.length).toBeGreaterThan(0);
        expect(placeholder.description.length).toBeGreaterThan(0);
        expect(placeholder.example.length).toBeGreaterThan(0);
        expect(typeof placeholder.required).toBe("boolean");
      }
    }
  });

  it("looks up templates by id", () => {
    expect(getTemplateById("add-api-endpoint")?.label).toBe("Add API endpoint");
    expect(getTemplateById("refactor-module")?.label).toBe("Refactor module");
    expect(getTemplateById("add-tests")?.label).toBe("Add tests");
    expect(getTemplateById("missing-template")).toBeUndefined();
  });

  it("formats a compact prompt listing", () => {
    const formatted = formatTemplatesForPrompt();

    expect(formatted).toContain("- add-api-endpoint:");
    expect(formatted).toContain("- refactor-module:");
    expect(formatted).toContain("- add-tests:");
    expect(formatted).toContain("Placeholders:");
    expect(formatted.match(/add-api-endpoint/g)).toHaveLength(1);
    expect(formatted.match(/refactor-module/g)).toHaveLength(1);
    expect(formatted.match(/add-tests/g)).toHaveLength(1);
  });

  it("expands the add-api-endpoint template", () => {
    const result = expandTemplate("add-api-endpoint", {
      endpointPath: "/users",
      moduleName: "user-management",
      endpointPurpose: "return a filtered user list",
      httpMethod: "GET",
      implementationFile: "src/api/users.ts",
      testFile: "src/api/users.test.ts",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.description).toContain("GET /users");
      expect(result.description).toContain("src/api/users.ts");
      expect(result.description).toContain("src/api/users.test.ts");
      expect(result.description).not.toContain("{{");
      expect(result.description).toContain("### Files:");
    }
  });

  it("expands the refactor-module template", () => {
    const result = expandTemplate("refactor-module", {
      moduleName: "scan pipeline",
      refactorGoal: "separation of parsing from UI formatting",
      currentPain: "logic and rendering are tightly coupled",
      moduleFile: "src/scan.ts",
      testFile: "src/scan.test.ts",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.description).toContain("scan pipeline");
      expect(result.description).toContain("src/scan.ts");
      expect(result.description).not.toContain("{{");
    }
  });

  it("expands the add-tests template", () => {
    const result = expandTemplate("add-tests", {
      featureName: "plan-to-bead audit warnings",
      riskArea: "empty sections and weak mappings",
      implementationFile: "src/prompts.ts",
      testFile: "src/flywheel.test.ts",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.description).toContain("plan-to-bead audit warnings");
      expect(result.description).toContain("src/flywheel.test.ts");
      expect(result.description).not.toContain("{{");
    }
  });

  it("returns an error when the template id is unknown", () => {
    expect(expandTemplate("unknown", {})).toEqual({
      success: false,
      error: "Unknown bead template: unknown",
    });
  });

  it("returns an error when required placeholders are missing", () => {
    const result = expandTemplate("add-api-endpoint", {
      endpointPath: "/users",
      moduleName: "user-management",
      implementationFile: "src/api/users.ts",
      testFile: "src/api/users.test.ts",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Missing required placeholders");
      expect(result.error).toContain("endpointPurpose");
      expect(result.error).toContain("httpMethod");
    }
  });

  it("returns an error when placeholder values contain invalid characters", () => {
    const result = expandTemplate("add-tests", {
      featureName: "bad\rvalue",
      riskArea: "edge cases",
      implementationFile: "src/prompts.ts",
      testFile: "src/flywheel.test.ts",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid placeholder value");
      expect(result.error).toContain("featureName");
    }
  });

  it("rejects null bytes in placeholder values", () => {
    const result = expandTemplate("add-tests", {
      featureName: "has\0null",
      riskArea: "edge cases",
      implementationFile: "src/prompts.ts",
      testFile: "src/flywheel.test.ts",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid placeholder value");
    }
  });

  it("treats whitespace-only required placeholders as missing", () => {
    const result = expandTemplate("add-tests", {
      featureName: "   ",
      riskArea: "edge cases",
      implementationFile: "src/prompts.ts",
      testFile: "src/flywheel.test.ts",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Missing required placeholders");
      expect(result.error).toContain("featureName");
    }
  });

  it("hints about typos when required placeholders are missing with unrecognized keys", () => {
    const result = expandTemplate("add-tests", {
      featurName: "typo key",  // missing 'e'
      riskArea: "edge cases",
      implementationFile: "src/prompts.ts",
      testFile: "src/flywheel.test.ts",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("featureName");
      expect(result.error).toContain("unrecognized keys");
      expect(result.error).toContain("featurName");
    }
  });
});
