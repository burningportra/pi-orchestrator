import { describe, it, expect } from "vitest";
import {
  synthesizeGoal,
  parseQuestionsJSON,
  extractConstraints,
  type RefinementAnswer,
  type RefinementQuestion,
} from "./goal-refinement.js";
import { goalRefinementPrompt } from "./prompts.js";
import type { RepoProfile } from "./types.js";

// ─── Test Fixtures ──────────────────────────────────────────

const mockProfile: RepoProfile = {
  name: "test-repo",
  languages: ["TypeScript"],
  frameworks: ["Express"],
  packageManager: "npm",
  entrypoints: ["src/index.ts"],
  hasTests: false,
  hasDocs: true,
  hasCI: false,
  todos: [],
  recentCommits: [
    { hash: "abc123", message: "feat: add auth", date: "2026-03-20", author: "dev" },
  ],
  readme: "A test repo for API services",
  structure: "src/\nsrc/index.ts\nsrc/routes/",
  keyFiles: {},
};

function makeAnswer(id: string, label: string, value?: string): RefinementAnswer {
  return { id, value: value ?? id, label, wasCustom: false };
}

// ─── parseQuestionsJSON ─────────────────────────────────────

describe("parseQuestionsJSON", () => {
  it("parses valid JSON array of questions", () => {
    const input = JSON.stringify([
      {
        id: "scope",
        label: "Scope",
        prompt: "What scope?",
        options: [
          { value: "api", label: "API only" },
          { value: "cli", label: "CLI only" },
        ],
        allowOther: true,
      },
    ]);

    const result = parseQuestionsJSON(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("scope");
    expect(result[0].label).toBe("Scope");
    expect(result[0].prompt).toBe("What scope?");
    expect(result[0].options).toHaveLength(2);
    expect(result[0].allowOther).toBe(true);
  });

  it("handles markdown-fenced JSON", () => {
    const input = `Here are some questions:\n\n\`\`\`json\n[{"id":"scope","label":"Scope","prompt":"What?","options":[{"value":"a","label":"A"}],"allowOther":false}]\n\`\`\`\n\nLet me know!`;

    const result = parseQuestionsJSON(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("scope");
    expect(result[0].allowOther).toBe(false);
  });

  it("falls back to generic question on invalid JSON", () => {
    const result = parseQuestionsJSON("this is not json at all");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("approach");
    expect(result[0].options.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back on non-array JSON", () => {
    const result = parseQuestionsJSON('{"not": "an array"}');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("approach");
  });

  it("filters out malformed questions (missing required fields)", () => {
    const input = JSON.stringify([
      { id: "good", prompt: "Valid?", options: [{ value: "a", label: "A" }] },
      { id: "bad-no-prompt", options: [{ value: "a", label: "A" }] },
      { id: "bad-no-options", prompt: "No opts?" },
      { id: "bad-empty-options", prompt: "Empty?", options: [] },
    ]);

    const result = parseQuestionsJSON(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("good");
  });

  it("defaults label to id when label is missing", () => {
    const input = JSON.stringify([
      { id: "my-question", prompt: "What?", options: [{ value: "a", label: "A" }] },
    ]);

    const result = parseQuestionsJSON(input);
    expect(result[0].label).toBe("my-question");
  });

  it("defaults allowOther to true when not specified", () => {
    const input = JSON.stringify([
      { id: "q", prompt: "?", options: [{ value: "a", label: "A" }] },
    ]);

    const result = parseQuestionsJSON(input);
    expect(result[0].allowOther).toBe(true);
  });

  it("filters out malformed options within a question", () => {
    const input = JSON.stringify([
      {
        id: "q",
        prompt: "?",
        options: [
          { value: "good", label: "Good" },
          { value: 123, label: "Bad value type" },
          { label: "Missing value" },
          { value: "also-good", label: "Also Good" },
        ],
      },
    ]);

    const result = parseQuestionsJSON(input);
    expect(result[0].options).toHaveLength(2);
    expect(result[0].options[0].value).toBe("good");
    expect(result[0].options[1].value).toBe("also-good");
  });
});

// ─── synthesizeGoal ─────────────────────────────────────────

describe("synthesizeGoal", () => {
  it("includes raw goal as the Goal section", () => {
    const result = synthesizeGoal("Add rate limiting", []);
    expect(result).toContain("## Goal\nAdd rate limiting");
  });

  it("omits empty sections", () => {
    const result = synthesizeGoal("My goal", []);
    expect(result).not.toContain("## Scope");
    expect(result).not.toContain("## Constraints");
    expect(result).not.toContain("## Non-Goals");
    expect(result).not.toContain("## Success Criteria");
    expect(result).not.toContain("## Implementation Notes");
  });

  it("categorizes scope answers", () => {
    const answers = [makeAnswer("target-scope", "API layer only")];
    const result = synthesizeGoal("My goal", answers);
    expect(result).toContain("## Scope");
    expect(result).toContain("- API layer only");
  });

  it("categorizes constraint answers", () => {
    const answers = [makeAnswer("constraints", "No breaking changes")];
    const result = synthesizeGoal("My goal", answers);
    expect(result).toContain("## Constraints");
    expect(result).toContain("- No breaking changes");
  });

  it("categorizes non-goal answers by id", () => {
    const answers = [makeAnswer("non-goal-refactor", "Don't refactor tests")];
    const result = synthesizeGoal("My goal", answers);
    expect(result).toContain("## Non-Goals");
    expect(result).toContain("- Don't refactor tests");
  });

  it("categorizes non-goal answers by value prefix", () => {
    const answers = [makeAnswer("approach", "Avoid touching auth", "avoid-auth")];
    const result = synthesizeGoal("My goal", answers);
    expect(result).toContain("## Non-Goals");
  });

  it("categorizes success criteria answers", () => {
    const answers = [makeAnswer("success-criteria", "All tests pass")];
    const result = synthesizeGoal("My goal", answers);
    expect(result).toContain("## Success Criteria");
    expect(result).toContain("- All tests pass");
  });

  it("puts uncategorized answers in Implementation Notes", () => {
    const answers = [makeAnswer("framework-choice", "Use Express middleware")];
    const result = synthesizeGoal("My goal", answers);
    expect(result).toContain("## Implementation Notes");
    expect(result).toContain("- **framework-choice**: Use Express middleware");
  });

  it("handles multiple sections together", () => {
    const answers = [
      makeAnswer("target-scope", "API only"),
      makeAnswer("constraints", "No new deps"),
      makeAnswer("success-criteria", "Tests pass"),
      makeAnswer("approach", "Use middleware"),
    ];
    const result = synthesizeGoal("Add rate limiting", answers);

    expect(result).toContain("## Goal\nAdd rate limiting");
    expect(result).toContain("## Scope\n- API only");
    expect(result).toContain("## Constraints\n- No new deps");
    expect(result).toContain("## Success Criteria\n- Tests pass");
    expect(result).toContain("## Implementation Notes");
  });

  it("preserves raw goal text verbatim", () => {
    const weirdGoal = "Add API rate-limiting with Redis & special chars <> \"quotes\"";
    const result = synthesizeGoal(weirdGoal, []);
    expect(result).toContain(weirdGoal);
  });
});

// ─── extractConstraints ─────────────────────────────────────

describe("extractConstraints", () => {
  it("extracts constraint answers by id", () => {
    const answers = [
      makeAnswer("constraints", "No breaking changes"),
      makeAnswer("scope", "API only"),
    ];
    const result = extractConstraints(answers);
    expect(result).toEqual(["No breaking changes"]);
  });

  it("extracts non-goal answers", () => {
    const answers = [makeAnswer("non-goal-tests", "Don't touch tests")];
    const result = extractConstraints(answers);
    expect(result).toEqual(["Don't touch tests"]);
  });

  it("extracts avoid answers", () => {
    const answers = [makeAnswer("avoid-refactor", "No refactoring")];
    const result = extractConstraints(answers);
    expect(result).toEqual(["No refactoring"]);
  });

  it("extracts exclude answers", () => {
    const answers = [makeAnswer("exclude-legacy", "Skip legacy module")];
    const result = extractConstraints(answers);
    expect(result).toEqual(["Skip legacy module"]);
  });

  it("returns empty array when no constraint answers", () => {
    const answers = [
      makeAnswer("scope", "Everything"),
      makeAnswer("approach", "Standard"),
    ];
    const result = extractConstraints(answers);
    expect(result).toEqual([]);
  });

  it("filters out empty labels", () => {
    const answers = [makeAnswer("constraints", "")];
    const result = extractConstraints(answers);
    expect(result).toEqual([]);
  });
});

// ─── goalRefinementPrompt ───────────────────────────────────

describe("goalRefinementPrompt", () => {
  it("includes the goal text", () => {
    const prompt = goalRefinementPrompt("Add rate limiting", mockProfile);
    expect(prompt).toContain("Add rate limiting");
  });

  it("includes repo profile information", () => {
    const prompt = goalRefinementPrompt("Add auth", mockProfile);
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("test-repo");
  });

  it("includes JSON schema specification", () => {
    const prompt = goalRefinementPrompt("My goal", mockProfile);
    expect(prompt).toContain('"id"');
    expect(prompt).toContain('"prompt"');
    expect(prompt).toContain('"options"');
    expect(prompt).toContain('"allowOther"');
  });

  it("includes constraint question requirement", () => {
    const prompt = goalRefinementPrompt("My goal", mockProfile);
    expect(prompt.toLowerCase()).toContain("constraint");
    expect(prompt.toLowerCase()).toContain("non-goal");
  });

  it("includes adaptive depth instruction", () => {
    const prompt = goalRefinementPrompt("My goal", mockProfile);
    expect(prompt.toLowerCase()).toContain("specific");
    expect(prompt.toLowerCase()).toContain("fewer");
  });

  it("includes example JSON output", () => {
    const prompt = goalRefinementPrompt("My goal", mockProfile);
    // Should have a parseable JSON example
    const jsonMatch = prompt.match(/```json\s*\n([\s\S]*?)```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });
});
