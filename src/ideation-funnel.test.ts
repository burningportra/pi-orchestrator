import { describe, it, expect } from "vitest";
import {
  broadIdeationPrompt,
  winnowingPrompt,
  expandIdeasPrompt,
  parseIdeasJSON,
  parseWinnowingResult,
} from "./ideation-funnel.js";
import type { RepoProfile, CandidateIdea } from "./types.js";

function makeProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: ["Vitest"],
    structure: "",
    entrypoints: ["src/index.ts"],
    recentCommits: [],
    hasTests: true,
    testFramework: "vitest",
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
    ...overrides,
  };
}

function makeIdea(overrides: Partial<CandidateIdea> = {}): CandidateIdea {
  return {
    id: "test-idea",
    title: "Test Idea",
    description: "A test idea for testing",
    category: "feature",
    effort: "medium",
    impact: "high",
    rationale: "Because testing",
    tier: "top",
    scores: { useful: 4, pragmatic: 3, accretive: 5, robust: 3, ergonomic: 4 },
    ...overrides,
  };
}

// ─── broadIdeationPrompt ────────────────────────────────────

describe("broadIdeationPrompt", () => {
  it("asks for exactly 30 ideas", () => {
    const prompt = broadIdeationPrompt(makeProfile());
    expect(prompt).toContain("30");
    expect(prompt).toContain("exactly 30");
  });

  it("tells the model NOT to winnow", () => {
    const prompt = broadIdeationPrompt(makeProfile());
    expect(prompt).toContain("do NOT winnow");
    expect(prompt).toContain("filter");
    expect(prompt).toContain("DO NOT filter");
  });

  it("includes repo context", () => {
    const prompt = broadIdeationPrompt(makeProfile({ name: "my-project" }));
    expect(prompt).toContain("my-project");
  });

  it("specifies JSON output format", () => {
    const prompt = broadIdeationPrompt(makeProfile());
    expect(prompt).toContain('"id"');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"scores"');
  });

  it("covers all categories", () => {
    const prompt = broadIdeationPrompt(makeProfile());
    expect(prompt).toContain("feature");
    expect(prompt).toContain("refactor");
    expect(prompt).toContain("security");
    expect(prompt).toContain("testing");
  });
});

// ─── winnowingPrompt ────────────────────────────────────────

describe("winnowingPrompt", () => {
  const ideas = Array.from({ length: 10 }, (_, i) =>
    makeIdea({ id: `idea-${i}`, title: `Idea ${i}` })
  );

  it("lists all ideas for evaluation", () => {
    const prompt = winnowingPrompt(ideas, makeProfile());
    expect(prompt).toContain("Idea 0");
    expect(prompt).toContain("Idea 9");
  });

  it("asks for exactly 5 keeps", () => {
    const prompt = winnowingPrompt(ideas, makeProfile());
    expect(prompt).toContain("exactly 5");
    expect(prompt).toContain("KEEP");
    expect(prompt).toContain("CUT");
  });

  it("requires explicit justification for each decision", () => {
    const prompt = winnowingPrompt(ideas, makeProfile());
    expect(prompt).toContain("one-sentence justification");
    expect(prompt).toContain("detailed rationale");
  });

  it("specifies JSON output with keeps and cuts", () => {
    const prompt = winnowingPrompt(ideas, makeProfile());
    expect(prompt).toContain('"cuts"');
    expect(prompt).toContain('"keeps"');
    expect(prompt).toContain('"rank"');
  });
});

// ─── expandIdeasPrompt ──────────────────────────────────────

describe("expandIdeasPrompt", () => {
  const top5 = Array.from({ length: 5 }, (_, i) =>
    makeIdea({ id: `top-${i}`, title: `Top Idea ${i}` })
  );

  it("lists the top 5 ideas", () => {
    const prompt = expandIdeasPrompt(top5, [], makeProfile());
    expect(prompt).toContain("Top Idea 0");
    expect(prompt).toContain("Top Idea 4");
  });

  it("asks for 10 more ideas", () => {
    const prompt = expandIdeasPrompt(top5, [], makeProfile());
    expect(prompt).toContain("10 MORE");
  });

  it("includes existing bead titles for dedup", () => {
    const prompt = expandIdeasPrompt(top5, ["Existing bead 1", "Existing bead 2"], makeProfile());
    expect(prompt).toContain("Existing bead 1");
    expect(prompt).toContain("DO NOT duplicate");
  });

  it("omits bead section when no beads exist", () => {
    const prompt = expandIdeasPrompt(top5, [], makeProfile());
    expect(prompt).not.toContain("DO NOT duplicate");
  });

  it("requires novelty check", () => {
    const prompt = expandIdeasPrompt(top5, ["Bead"], makeProfile());
    expect(prompt).toContain("checked against existing beads");
  });
});

// ─── parseIdeasJSON ─────────────────────────────────────────

describe("parseIdeasJSON", () => {
  it("parses valid JSON array of ideas", () => {
    const json = JSON.stringify([
      { id: "a", title: "Idea A", description: "desc", category: "feature", effort: "low", impact: "high" },
      { id: "b", title: "Idea B", description: "desc", category: "refactor", effort: "medium", impact: "medium" },
    ]);
    const ideas = parseIdeasJSON(json);
    expect(ideas).toHaveLength(2);
    expect(ideas[0].id).toBe("a");
    expect(ideas[0].title).toBe("Idea A");
    expect(ideas[1].category).toBe("refactor");
  });

  it("handles JSON wrapped in markdown fences", () => {
    const output = "Here are the ideas:\n```json\n" + JSON.stringify([
      { id: "x", title: "X", description: "d", category: "docs" },
    ]) + "\n```\nDone.";
    const ideas = parseIdeasJSON(output);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].id).toBe("x");
  });

  it("handles JSON with surrounding text", () => {
    const output = "Based on analysis:\n" + JSON.stringify([
      { id: "y", title: "Y", description: "d" },
    ]) + "\nThese are my suggestions.";
    const ideas = parseIdeasJSON(output);
    expect(ideas).toHaveLength(1);
  });

  it("validates required fields (id and title)", () => {
    const json = JSON.stringify([
      { id: "valid", title: "Valid" },
      { title: "No ID" },           // missing id
      { id: "no-title" },           // missing title
      { id: "also-valid", title: "Also Valid" },
    ]);
    const ideas = parseIdeasJSON(json);
    expect(ideas).toHaveLength(2);
    expect(ideas.map(i => i.id)).toEqual(["valid", "also-valid"]);
  });

  it("defaults missing optional fields", () => {
    const json = JSON.stringify([{ id: "min", title: "Minimal" }]);
    const ideas = parseIdeasJSON(json);
    expect(ideas[0].category).toBe("feature");
    expect(ideas[0].effort).toBe("medium");
    expect(ideas[0].impact).toBe("medium");
    expect(ideas[0].description).toBe("");
  });

  it("validates category values", () => {
    const json = JSON.stringify([
      { id: "a", title: "A", category: "FEATURE" },   // case insensitive
      { id: "b", title: "B", category: "invalid" },    // falls back to feature
      { id: "c", title: "C", category: "security" },   // valid
    ]);
    const ideas = parseIdeasJSON(json);
    expect(ideas[0].category).toBe("feature");
    expect(ideas[1].category).toBe("feature");
    expect(ideas[2].category).toBe("security");
  });

  it("parses scores when present", () => {
    const json = JSON.stringify([
      { id: "a", title: "A", scores: { useful: 5, pragmatic: 4, accretive: 3, robust: 2, ergonomic: 1 } },
    ]);
    const ideas = parseIdeasJSON(json);
    expect(ideas[0].scores).toEqual({ useful: 5, pragmatic: 4, accretive: 3, robust: 2, ergonomic: 1 });
  });

  it("clamps scores to 1-5", () => {
    const json = JSON.stringify([
      { id: "a", title: "A", scores: { useful: 10, pragmatic: -1, accretive: 3, robust: 0, ergonomic: 6 } },
    ]);
    const ideas = parseIdeasJSON(json);
    expect(ideas[0].scores!.useful).toBe(5);
    expect(ideas[0].scores!.pragmatic).toBe(1);
    expect(ideas[0].scores!.robust).toBe(1);
    expect(ideas[0].scores!.ergonomic).toBe(5);
  });

  it("returns empty array for unparseable output", () => {
    expect(parseIdeasJSON("No JSON here")).toEqual([]);
    expect(parseIdeasJSON("")).toEqual([]);
    expect(parseIdeasJSON("{not an array}")).toEqual([]);
  });
});

// ─── parseWinnowingResult ───────────────────────────────────

describe("parseWinnowingResult", () => {
  it("parses valid winnowing result", () => {
    const json = JSON.stringify({
      cuts: [
        { id: "cut-1", reason: "Too vague" },
        { id: "cut-2", reason: "Already done" },
      ],
      keeps: [
        { id: "keep-1", rank: 1, rationale: "Most impactful" },
        { id: "keep-2", rank: 2, rationale: "Second best" },
        { id: "keep-3", rank: 3, rationale: "Third" },
      ],
    });
    const result = parseWinnowingResult(json);
    expect(result.keptIds).toEqual(["keep-1", "keep-2", "keep-3"]);
    expect(result.cutCount).toBe(2);
  });

  it("sorts keeps by rank", () => {
    const json = JSON.stringify({
      cuts: [],
      keeps: [
        { id: "c", rank: 3 },
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ],
    });
    const result = parseWinnowingResult(json);
    expect(result.keptIds).toEqual(["a", "b", "c"]);
  });

  it("handles JSON with surrounding text", () => {
    const output = 'Here is my analysis:\n{"cuts": [{"id": "x", "reason": "bad"}], "keeps": [{"id": "y", "rank": 1}]}\nDone.';
    const result = parseWinnowingResult(output);
    expect(result.keptIds).toEqual(["y"]);
    expect(result.cutCount).toBe(1);
  });

  it("returns empty result for unparseable output", () => {
    expect(parseWinnowingResult("No JSON")).toEqual({ keptIds: [], cutCount: 0 });
    expect(parseWinnowingResult("")).toEqual({ keptIds: [], cutCount: 0 });
  });

  it("handles missing rank (defaults to 99)", () => {
    const json = JSON.stringify({
      cuts: [],
      keeps: [
        { id: "ranked", rank: 1 },
        { id: "unranked" },
      ],
    });
    const result = parseWinnowingResult(json);
    expect(result.keptIds[0]).toBe("ranked");
    expect(result.keptIds[1]).toBe("unranked");
  });
});
