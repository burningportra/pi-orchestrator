import { describe, it, expect } from "vitest";
import {
  identifyBottlenecks,
  beadSplitProposalPrompt,
  parseSplitProposal,
  formatSplitProposal,
  formatSplitCommands,
} from "./bead-splitting.js";
import type { Bead, BvInsights } from "./types.js";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "test-1",
    title: "Test bead",
    description: "### Files: src/foo.ts, src/bar.ts\n\n- [ ] Do stuff",
    status: "open",
    priority: 2,
    type: "task",
    labels: [],
    ...overrides,
  };
}

// ─── identifyBottlenecks ────────────────────────────────────

describe("identifyBottlenecks", () => {
  const beads: Bead[] = [
    makeBead({ id: "b-1", title: "Bead 1" }),
    makeBead({ id: "b-2", title: "Bead 2" }),
    makeBead({ id: "b-3", title: "Bead 3" }),
  ];

  it("returns beads above betweenness threshold", () => {
    const insights: BvInsights = {
      Bottlenecks: [
        { ID: "b-1", Value: 0.8 },
        { ID: "b-2", Value: 0.5 },
        { ID: "b-3", Value: 0.1 },
      ],
      Cycles: null, Orphans: [], Articulation: [], Slack: [],
    };
    const result = identifyBottlenecks(insights, beads, 0.3);
    expect(result).toHaveLength(2);
    expect(result[0].bead.id).toBe("b-1"); // highest first
    expect(result[1].bead.id).toBe("b-2");
  });

  it("returns empty for no bottlenecks", () => {
    const insights: BvInsights = {
      Bottlenecks: [{ ID: "b-1", Value: 0.1 }],
      Cycles: null, Orphans: [], Articulation: [], Slack: [],
    };
    expect(identifyBottlenecks(insights, beads)).toEqual([]);
  });

  it("skips beads not found in bead list", () => {
    const insights: BvInsights = {
      Bottlenecks: [{ ID: "nonexistent", Value: 0.9 }],
      Cycles: null, Orphans: [], Articulation: [], Slack: [],
    };
    expect(identifyBottlenecks(insights, beads)).toEqual([]);
  });

  it("sorts by betweenness descending", () => {
    const insights: BvInsights = {
      Bottlenecks: [
        { ID: "b-2", Value: 0.5 },
        { ID: "b-1", Value: 0.9 },
      ],
      Cycles: null, Orphans: [], Articulation: [], Slack: [],
    };
    const result = identifyBottlenecks(insights, beads);
    expect(result[0].bead.id).toBe("b-1");
    expect(result[1].bead.id).toBe("b-2");
  });
});

// ─── beadSplitProposalPrompt ────────────────────────────────

describe("beadSplitProposalPrompt", () => {
  const bead = makeBead({ id: "b-42", title: "Setup auth system" });

  it("includes bead ID and title", () => {
    const prompt = beadSplitProposalPrompt(bead, 0.75);
    expect(prompt).toContain("b-42");
    expect(prompt).toContain("Setup auth system");
  });

  it("includes betweenness score", () => {
    const prompt = beadSplitProposalPrompt(bead, 0.75);
    expect(prompt).toContain("0.75");
  });

  it("includes full bead description", () => {
    const prompt = beadSplitProposalPrompt(bead, 0.5);
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("Do stuff");
  });

  it("specifies JSON output format", () => {
    const prompt = beadSplitProposalPrompt(bead, 0.5);
    expect(prompt).toContain('"splittable"');
    expect(prompt).toContain('"children"');
    expect(prompt).toContain('"files"');
  });

  it("requires disjoint file ownership", () => {
    const prompt = beadSplitProposalPrompt(bead, 0.5);
    expect(prompt).toContain("disjoint file ownership");
  });

  it("allows NOT splitting if inherently sequential", () => {
    const prompt = beadSplitProposalPrompt(bead, 0.5);
    expect(prompt).toContain('"splittable": false');
  });
});

// ─── parseSplitProposal ─────────────────────────────────────

describe("parseSplitProposal", () => {
  it("parses a valid splittable proposal", () => {
    const output = JSON.stringify({
      splittable: true,
      reason: "Can be split into data and UI",
      children: [
        { title: "Data layer", description: "Build the data model", files: ["src/data.ts"] },
        { title: "UI layer", description: "Build the UI components", files: ["src/ui.tsx"] },
      ],
    });
    const proposal = parseSplitProposal(output, "b-1", "Full stack feature", 0.8);
    expect(proposal.splittable).toBe(true);
    expect(proposal.children).toHaveLength(2);
    expect(proposal.children[0].title).toBe("Data layer");
    expect(proposal.children[0].files).toEqual(["src/data.ts"]);
    expect(proposal.children[1].title).toBe("UI layer");
  });

  it("parses a non-splittable proposal", () => {
    const output = JSON.stringify({
      splittable: false,
      reason: "This is inherently sequential — step 2 depends on step 1's output",
      children: [],
    });
    const proposal = parseSplitProposal(output, "b-2", "Sequential task", 0.6);
    expect(proposal.splittable).toBe(false);
    expect(proposal.reason).toContain("sequential");
    expect(proposal.children).toHaveLength(0);
  });

  it("handles JSON with surrounding text", () => {
    const output = 'Analysis:\n{"splittable": true, "children": [{"title": "A", "description": "d", "files": []}], "reason": "ok"}\nDone.';
    const proposal = parseSplitProposal(output, "b-3", "Title", 0.5);
    // splittable is true but only 1 child, so we mark as not splittable (need >= 2)
    expect(proposal.splittable).toBe(false);
  });

  it("requires at least 2 children to be splittable", () => {
    const output = JSON.stringify({
      splittable: true,
      children: [{ title: "Only child", description: "d", files: [] }],
    });
    const proposal = parseSplitProposal(output, "b-4", "Title", 0.5);
    expect(proposal.splittable).toBe(false);
  });

  it("handles unparseable output", () => {
    const proposal = parseSplitProposal("No JSON here", "b-5", "Title", 0.5);
    expect(proposal.splittable).toBe(false);
    expect(proposal.reason).toContain("Failed to parse");
  });

  it("preserves bead metadata", () => {
    const output = JSON.stringify({ splittable: false, children: [] });
    const proposal = parseSplitProposal(output, "b-99", "My Bead", 0.42);
    expect(proposal.originalBeadId).toBe("b-99");
    expect(proposal.originalTitle).toBe("My Bead");
    expect(proposal.betweennessScore).toBe(0.42);
  });

  it("filters invalid children (missing title)", () => {
    const output = JSON.stringify({
      splittable: true,
      children: [
        { title: "Valid", description: "d", files: [] },
        { description: "No title", files: [] },
        { title: "Also valid", description: "d", files: [] },
      ],
    });
    const proposal = parseSplitProposal(output, "b-6", "T", 0.5);
    expect(proposal.splittable).toBe(true);
    expect(proposal.children).toHaveLength(2);
  });
});

// ─── formatSplitProposal ────────────────────────────────────

describe("formatSplitProposal", () => {
  it("formats a splittable proposal", () => {
    const formatted = formatSplitProposal({
      originalBeadId: "b-1",
      originalTitle: "Big feature",
      betweennessScore: 0.75,
      dependentCount: 5,
      splittable: true,
      children: [
        { title: "Data layer", description: "Build data", files: ["src/data.ts"] },
        { title: "UI layer", description: "Build UI", files: ["src/ui.tsx"] },
      ],
    });
    expect(formatted).toContain("b-1");
    expect(formatted).toContain("Big feature");
    expect(formatted).toContain("Data layer");
    expect(formatted).toContain("UI layer");
    expect(formatted).toContain("0.75");
  });

  it("formats a non-splittable proposal", () => {
    const formatted = formatSplitProposal({
      originalBeadId: "b-2",
      originalTitle: "Sequential",
      betweennessScore: 0.5,
      dependentCount: 3,
      splittable: false,
      reason: "inherently sequential",
      children: [],
    });
    expect(formatted).toContain("Cannot split");
    expect(formatted).toContain("inherently sequential");
  });
});

// ─── formatSplitCommands ────────────────────────────────────

describe("formatSplitCommands", () => {
  it("generates br create commands", () => {
    const commands = formatSplitCommands({
      originalBeadId: "b-1",
      originalTitle: "Big feature",
      betweennessScore: 0.75,
      dependentCount: 5,
      splittable: true,
      children: [
        { title: "Data layer", description: "Build data model", files: ["src/data.ts"] },
        { title: "UI layer", description: "Build UI", files: ["src/ui.tsx"] },
      ],
    });
    expect(commands).toContain('br create "Data layer"');
    expect(commands).toContain('br create "UI layer"');
    expect(commands).toContain("br dep add");
    expect(commands).toContain("b-1");
  });

  it("returns empty string for non-splittable", () => {
    expect(formatSplitCommands({
      originalBeadId: "b-2",
      originalTitle: "Seq",
      betweennessScore: 0.5,
      dependentCount: 0,
      splittable: false,
      children: [],
    })).toBe("");
  });

  it("includes file references in descriptions", () => {
    const commands = formatSplitCommands({
      originalBeadId: "b-1",
      originalTitle: "Feature",
      betweennessScore: 0.5,
      dependentCount: 0,
      splittable: true,
      children: [
        { title: "A", description: "Do A", files: ["src/a.ts"] },
        { title: "B", description: "Do B", files: ["src/b.ts"] },
      ],
    });
    expect(commands).toContain("src/a.ts");
    expect(commands).toContain("src/b.ts");
  });
});
