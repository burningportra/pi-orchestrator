import { describe, it, expect } from "vitest";
import {
  parsePlanSections,
  planCoverageScoringPrompt,
  parsePlanCoverageResult,
  coverageFromKeywordAudit,
  formatPlanCoverage,
  type PlanCoverageResult,
  type ParsedPlanSection,
} from "./plan-coverage.js";
import type { Bead } from "./types.js";
import type { PlanToBeadAudit } from "./beads.js";

// ─── parsePlanSections ──────────────────────────────────────

describe("parsePlanSections", () => {
  it("parses markdown headings into sections", () => {
    const plan = `# Title
## Architecture
This describes the architecture of the system in detail.

## Testing
This describes the testing strategy for the project.
`;
    const sections = parsePlanSections(plan);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Architecture");
    expect(sections[0].body).toContain("architecture");
    expect(sections[1].heading).toBe("Testing");
  });

  it("filters out trivial sections (body < 20 chars)", () => {
    const plan = `## Big Section
This has plenty of content to be meaningful.

## Tiny
Short.
`;
    const sections = parsePlanSections(plan);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Big Section");
  });

  it("handles multiple heading levels", () => {
    const plan = `# Top
## Second Level
Content for second level section here enough.

### Third Level
Content for third level section here enough.
`;
    const sections = parsePlanSections(plan);
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for empty plan", () => {
    expect(parsePlanSections("")).toEqual([]);
    expect(parsePlanSections("No headings here at all")).toEqual([]);
  });
});

// ─── planCoverageScoringPrompt ──────────────────────────────

describe("planCoverageScoringPrompt", () => {
  const sections: ParsedPlanSection[] = [
    { heading: "Architecture", body: "System design details" },
    { heading: "Testing", body: "Test strategy" },
  ];
  const beads: Bead[] = [
    { id: "b-1", title: "Setup architecture", description: "Build the core", status: "open", priority: 1, type: "task", labels: [] },
  ];

  it("includes all section headings", () => {
    const prompt = planCoverageScoringPrompt(sections, beads);
    expect(prompt).toContain("Architecture");
    expect(prompt).toContain("Testing");
  });

  it("includes all bead IDs and titles", () => {
    const prompt = planCoverageScoringPrompt(sections, beads);
    expect(prompt).toContain("b-1");
    expect(prompt).toContain("Setup architecture");
  });

  it("specifies JSON output format", () => {
    const prompt = planCoverageScoringPrompt(sections, beads);
    expect(prompt).toContain('"heading"');
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"matchedBeadIds"');
  });

  it("describes the 0-100 scoring scale", () => {
    const prompt = planCoverageScoringPrompt(sections, beads);
    expect(prompt).toContain("100 =");
    expect(prompt).toContain("0 =");
  });
});

// ─── parsePlanCoverageResult ────────────────────────────────

describe("parsePlanCoverageResult", () => {
  const sections: ParsedPlanSection[] = [
    { heading: "Architecture", body: "System design details for architecture" },
    { heading: "Testing", body: "Test strategy details for the project" },
    { heading: "Deployment", body: "Deployment pipeline and infrastructure" },
  ];

  it("parses valid LLM output", () => {
    const output = JSON.stringify([
      { heading: "Architecture", score: 90, matchedBeadIds: ["b-1", "b-2"], gap: "" },
      { heading: "Testing", score: 60, matchedBeadIds: ["b-3"], gap: "missing e2e" },
      { heading: "Deployment", score: 20, matchedBeadIds: [], gap: "no bead for deployment" },
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.totalSections).toBe(3);
    expect(result.sections[0].score).toBe(90);
    expect(result.sections[1].score).toBe(60);
    expect(result.sections[2].score).toBe(20);
    expect(result.gaps).toHaveLength(1); // only Deployment < 50
    expect(result.coveredSections).toBe(2);
  });

  it("computes overall as average of section scores", () => {
    const output = JSON.stringify([
      { heading: "Architecture", score: 90, matchedBeadIds: [] },
      { heading: "Testing", score: 60, matchedBeadIds: [] },
      { heading: "Deployment", score: 30, matchedBeadIds: [] },
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.overall).toBe(60); // (90+60+30)/3
  });

  it("handles fuzzy heading matching", () => {
    const output = JSON.stringify([
      { heading: "architecture", score: 85, matchedBeadIds: ["b-1"] }, // lowercase
      { heading: "Test", score: 70, matchedBeadIds: ["b-2"] }, // partial match
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.sections[0].score).toBe(85);
    expect(result.sections[1].score).toBe(70);
  });

  it("clamps scores to 0-100", () => {
    const output = JSON.stringify([
      { heading: "Architecture", score: 150, matchedBeadIds: [] },
      { heading: "Testing", score: -10, matchedBeadIds: [] },
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.sections[0].score).toBe(100);
    expect(result.sections[1].score).toBe(0);
  });

  it("handles unparseable output gracefully", () => {
    const result = parsePlanCoverageResult("No JSON here", sections);
    expect(result.overall).toBe(0);
    expect(result.totalSections).toBe(3);
    expect(result.gaps).toHaveLength(3); // all uncovered
  });

  it("handles JSON with surrounding text", () => {
    const output = "Here is my analysis:\n" + JSON.stringify([
      { heading: "Architecture", score: 80, matchedBeadIds: ["b-1"] },
    ]) + "\nDone.";
    const result = parsePlanCoverageResult(output, sections);
    expect(result.sections[0].score).toBe(80);
  });

  it("defaults unmatched sections to score 0", () => {
    const output = JSON.stringify([
      { heading: "Architecture", score: 100, matchedBeadIds: ["b-1"] },
      // Testing and Deployment missing from LLM output
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.sections[1].score).toBe(0); // Testing
    expect(result.sections[2].score).toBe(0); // Deployment
  });
});

// ─── coverageFromKeywordAudit ───────────────────────────────

describe("coverageFromKeywordAudit", () => {
  it("converts PlanToBeadAudit to PlanCoverageResult", () => {
    const audit: PlanToBeadAudit = {
      sections: [
        { heading: "Architecture", summary: "System design", matches: [{ beadId: "b-1", title: "Arch", score: 0.8 }] },
        { heading: "Testing", summary: "Test plan", matches: [{ beadId: "b-2", title: "Test", score: 0.3 }] },
        { heading: "Empty", summary: "Nothing", matches: [] },
      ],
      uncoveredSections: [{ heading: "Empty", summary: "Nothing", matches: [] }],
      weakMappings: [{ heading: "Testing", summary: "Test plan", matches: [{ beadId: "b-2", title: "Test", score: 0.3 }] }],
    };

    const result = coverageFromKeywordAudit(audit);
    expect(result.totalSections).toBe(3);
    expect(result.sections[0].score).toBe(80); // 0.8 * 100
    expect(result.sections[1].score).toBe(30); // 0.3 * 100
    expect(result.sections[2].score).toBe(0);  // no matches
    expect(result.gaps).toHaveLength(2); // Testing (30 < 50) and Empty (0 < 50)
    expect(result.coveredSections).toBe(1); // only Architecture >= 50
  });

  it("handles empty audit", () => {
    const audit: PlanToBeadAudit = {
      sections: [],
      uncoveredSections: [],
      weakMappings: [],
    };
    const result = coverageFromKeywordAudit(audit);
    expect(result.overall).toBe(0);
    expect(result.totalSections).toBe(0);
  });
});

// ─── formatPlanCoverage ─────────────────────────────────────

describe("formatPlanCoverage", () => {
  it("returns empty string for no sections", () => {
    const result: PlanCoverageResult = {
      overall: 0, sections: [], gaps: [], totalSections: 0, coveredSections: 0,
    };
    expect(formatPlanCoverage(result)).toBe("");
  });

  it("shows overall percentage and bar", () => {
    const result: PlanCoverageResult = {
      overall: 75,
      sections: [
        { heading: "A", preview: "content", score: 75, matchedBeadIds: [], uncovered: false },
      ],
      gaps: [],
      totalSections: 1,
      coveredSections: 1,
    };
    const formatted = formatPlanCoverage(result);
    expect(formatted).toContain("75%");
    expect(formatted).toContain("█");
    expect(formatted).toContain("1/1");
  });

  it("shows ✅ for high coverage", () => {
    const result: PlanCoverageResult = {
      overall: 90, sections: [], gaps: [], totalSections: 1, coveredSections: 1,
    };
    expect(formatPlanCoverage(result)).toContain("✅");
  });

  it("shows ⛔ for low coverage", () => {
    const result: PlanCoverageResult = {
      overall: 40, sections: [], gaps: [
        { heading: "Gap", preview: "missing stuff", score: 20, matchedBeadIds: [], uncovered: true },
      ], totalSections: 1, coveredSections: 0,
    };
    const formatted = formatPlanCoverage(result);
    expect(formatted).toContain("⛔");
    expect(formatted).toContain("Gap");
  });

  it("limits gap display to 5", () => {
    const gaps = Array.from({ length: 8 }, (_, i) => ({
      heading: `Gap ${i}`, preview: "p", score: 10, matchedBeadIds: [] as string[], uncovered: true,
    }));
    const result: PlanCoverageResult = {
      overall: 20, sections: gaps, gaps, totalSections: 8, coveredSections: 0,
    };
    const formatted = formatPlanCoverage(result);
    expect(formatted).toContain("Gap 0");
    expect(formatted).toContain("Gap 4");
    expect(formatted).toContain("3 more");
    expect(formatted).not.toContain("Gap 5");
  });
});
