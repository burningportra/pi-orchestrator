import { describe, it, expect } from "vitest";
import {
  classifyBeadComplexity,
  routeModel,
  routeBeads,
  formatRoutingSummary,
  type ModelRoute,
} from "./model-routing.js";
import type { Bead } from "./types.js";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "b-1",
    title: "Test bead",
    description: "A simple task.\n### Files: src/foo.ts",
    status: "open",
    priority: 2,
    type: "task",
    labels: [],
    ...overrides,
  };
}

// ─── classifyBeadComplexity ─────────────────────────────────

describe("classifyBeadComplexity", () => {
  it("classifies simple beads (docs, config, rename)", () => {
    const bead = makeBead({ title: "Update README", description: "Fix typo in docs.\n### Files: README.md" });
    const { complexity } = classifyBeadComplexity(bead);
    expect(complexity).toBe("simple");
  });

  it("classifies complex beads (architecture, security, multi-file)", () => {
    const bead = makeBead({
      title: "Refactor authentication architecture",
      description: "Major refactor of the authentication and authorization system. " +
        "Migrate from session-based to JWT tokens with secure cookie handling. " +
        "This is a cross-cutting concern that touches the entire security boundary.\n" +
        "### Files: src/auth.ts, src/middleware.ts, src/session.ts, src/jwt.ts, src/cookies.ts, src/routes.ts",
      priority: 0,
    });
    const { complexity } = classifyBeadComplexity(bead);
    expect(complexity).toBe("complex");
  });

  it("classifies medium beads (moderate scope, multiple files, some complexity)", () => {
    const bead = makeBead({
      title: "Add search filtering with integration",
      description: "Implement keyword and tag filtering for the search endpoint. " +
        "Add query parameter parsing, filter logic, and integrate with the existing API layer. " +
        "Handle edge cases for empty queries and malformed input.\n" +
        "### Files: src/search.ts, src/filters.ts, src/routes.ts, src/api.ts",
      priority: 1,
    });
    const { complexity } = classifyBeadComplexity(bead);
    expect(complexity).toBe("medium");
  });

  it("boosts score for high priority (P0/P1)", () => {
    const lowPri = makeBead({ priority: 4, description: "Short task." });
    const highPri = makeBead({ priority: 0, description: "Short task." });
    const lowResult = classifyBeadComplexity(lowPri);
    const highResult = classifyBeadComplexity(highPri);
    // High priority should score higher (not necessarily different tier, but higher score)
    expect(highResult.reason).toContain("high priority");
  });

  it("detects complexity signals in text", () => {
    const bead = makeBead({
      title: "Implement distributed state machine",
      description: "Build a distributed concurrent protocol for state synchronization. " +
        "This is a major architectural change with security implications and cryptographic requirements.\n" +
        "### Files: src/state.ts, src/protocol.ts, src/crypto.ts, src/sync.ts",
      priority: 0,
    });
    const { complexity, reason } = classifyBeadComplexity(bead);
    expect(complexity).toBe("complex");
    expect(reason).toContain("complexity signals");
  });

  it("detects simplicity signals", () => {
    const bead = makeBead({
      title: "Update changelog and bump version",
      description: "Add latest changes to changelog. Bump version in package.json.\n### Files: CHANGELOG.md, package.json",
    });
    const { complexity } = classifyBeadComplexity(bead);
    expect(complexity).toBe("simple");
  });

  it("considers description length", () => {
    const shortBead = makeBead({ description: "Short." });
    const longBead = makeBead({
      description: "A".repeat(2500) + "\n### Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts",
    });
    const shortResult = classifyBeadComplexity(shortBead);
    const longResult = classifyBeadComplexity(longBead);
    // Longer descriptions should score higher
    expect(["medium", "complex"]).toContain(longResult.complexity);
  });

  it("considers file count", () => {
    const fewFiles = makeBead({ description: "Task.\n### Files: src/a.ts" });
    const manyFiles = makeBead({
      description: "Task.\n### Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts",
    });
    const fewResult = classifyBeadComplexity(fewFiles);
    const manyResult = classifyBeadComplexity(manyFiles);
    // Many files should score higher
    expect(manyResult.reason).toContain("files");
  });

  it("returns a reason string", () => {
    const bead = makeBead({ title: "Security audit", priority: 0 });
    const { reason } = classifyBeadComplexity(bead);
    expect(reason.length).toBeGreaterThan(0);
  });

  it("handles empty description gracefully", () => {
    const bead = makeBead({ description: "" });
    const { complexity } = classifyBeadComplexity(bead);
    expect(["simple", "medium", "complex"]).toContain(complexity);
  });
});

// ─── routeModel ─────────────────────────────────────────────

describe("routeModel", () => {
  it("returns different implementation and review models", () => {
    const bead = makeBead();
    const route = routeModel(bead);
    expect(route.implementation).not.toBe(route.review);
  });

  it("routes simple beads to fast model", () => {
    const bead = makeBead({ title: "Fix typo in README", description: "Fix typo.\n### Files: README.md" });
    const route = routeModel(bead);
    expect(route.complexity).toBe("simple");
    expect(route.implementation).toContain("haiku");
  });

  it("routes complex beads to strongest model", () => {
    const bead = makeBead({
      title: "Refactor authentication architecture",
      description: "Major security refactor with distributed state machine and cryptographic protocol.\n" +
        "### Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts",
      priority: 0,
    });
    const route = routeModel(bead);
    expect(route.complexity).toBe("complex");
    expect(route.implementation).toContain("opus");
  });

  it("includes complexity and reason", () => {
    const route = routeModel(makeBead());
    expect(route.complexity).toBeTruthy();
    expect(route.reason).toBeTruthy();
  });

  it("accepts custom tiers", () => {
    const customTiers = {
      simple: { implementation: "custom/fast", review: "custom/review-fast" },
      medium: { implementation: "custom/mid", review: "custom/review-mid" },
      complex: { implementation: "custom/best", review: "custom/review-best" },
    };
    const route = routeModel(makeBead({ title: "Fix typo", description: "Rename.\n### Files: x.md" }), customTiers);
    expect(route.implementation).toBe("custom/fast");
    expect(route.review).toBe("custom/review-fast");
  });
});

// ─── routeBeads ─────────────────────────────────────────────

describe("routeBeads", () => {
  it("routes multiple beads and summarizes", () => {
    const beads: Bead[] = [
      makeBead({ id: "b-1", title: "Fix typo", description: "Rename.\n### Files: README.md" }),
      makeBead({ id: "b-2", title: "Add feature", description: "New feature.\n### Files: src/a.ts, src/b.ts, src/c.ts" }),
      makeBead({
        id: "b-3", title: "Security refactor",
        description: "Major authentication and cryptographic protocol redesign.\n### Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts",
        priority: 0,
      }),
    ];
    const { routes, summary } = routeBeads(beads);
    expect(routes.size).toBe(3);
    expect(summary.simple + summary.medium + summary.complex).toBe(3);
  });

  it("returns empty for no beads", () => {
    const { routes, summary } = routeBeads([]);
    expect(routes.size).toBe(0);
    expect(summary.simple).toBe(0);
  });
});

// ─── formatRoutingSummary ───────────────────────────────────

describe("formatRoutingSummary", () => {
  it("returns empty for no routes", () => {
    expect(formatRoutingSummary(new Map(), [])).toBe("");
  });

  it("shows tier distribution", () => {
    const beads = [
      makeBead({ id: "b-1", title: "Fix typo", description: "Rename.\n### Files: README.md" }),
      makeBead({ id: "b-2", title: "Add auth", description: "Security architecture redesign with distributed protocol.\n### Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts", priority: 0 }),
    ];
    const { routes } = routeBeads(beads);
    const formatted = formatRoutingSummary(routes, beads);
    expect(formatted).toContain("Model Routing");
    expect(formatted).toContain("Simple:");
    expect(formatted).toContain("Complex:");
    expect(formatted).toContain("haiku");
    expect(formatted).toContain("opus");
  });

  it("lists complex beads specifically when few", () => {
    const beads = [
      makeBead({
        id: "b-1", title: "Crypto protocol",
        description: "Distributed cryptographic authentication protocol.\n### Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts",
        priority: 0,
      }),
    ];
    const { routes } = routeBeads(beads);
    const formatted = formatRoutingSummary(routes, beads);
    expect(formatted).toContain("b-1");
    expect(formatted).toContain("Crypto protocol");
  });
});
