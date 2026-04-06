import { describe, expect, it } from "vitest";
import { expandTemplate, listBeadTemplates } from "./bead-templates.js";

describe("verify template examples match expansion", () => {
  const cases: Array<{ id: string; values: Record<string, string> }> = [
    { id: "add-api-endpoint", values: { endpointPath: "/users", moduleName: "user-management", endpointPurpose: "return a filtered user list", httpMethod: "GET", implementationFile: "src/api/users.ts", testFile: "src/api/users.test.ts" } },
    { id: "refactor-module", values: { moduleName: "scan pipeline", refactorGoal: "separation of parsing from UI formatting", currentPain: "logic and rendering are tightly coupled", moduleFile: "src/scan.ts", testFile: "src/scan.test.ts" } },
    { id: "add-tests", values: { featureName: "plan-to-bead audit warnings", riskArea: "empty sections and weak mappings", implementationFile: "src/prompts.ts", testFile: "src/flywheel.test.ts" } },
  ];

  for (const t of cases) {
    it(`${t.id} example matches expansion with example values`, () => {
      const result = expandTemplate(t.id, t.values);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const templates = listBeadTemplates();
      const template = templates.find(tmpl => tmpl.id === t.id)!;
      expect(result.description).toBe(template.examples[0].description);
    });
  }
});
