import { describe, it, expect } from "vitest";
import {
  getDomainChecklist,
  formatDomainBlunderItems,
  formatDomainReviewItems,
} from "./domain-knowledge.js";
import type { RepoProfile } from "./types.js";

function makeProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: [],
    structure: "",
    entrypoints: [],
    recentCommits: [],
    hasTests: false,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
    ...overrides,
  };
}

// ─── getDomainChecklist ─────────────────────────────────────

describe("getDomainChecklist", () => {
  it("returns TypeScript checklist for a TypeScript project", () => {
    const profile = makeProfile({ languages: ["TypeScript"] });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.language).toBe("TypeScript");
    expect(checklist!.framework).toBeUndefined();
  });

  it("prefers language+framework match over language-only", () => {
    const profile = makeProfile({
      languages: ["TypeScript"],
      frameworks: ["React"],
    });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.framework).toBe("React");
  });

  it("matches Next.js framework", () => {
    const profile = makeProfile({
      languages: ["TypeScript"],
      frameworks: ["Next.js"],
    });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.framework).toBe("Next.js");
  });

  it("returns Rust checklist", () => {
    const profile = makeProfile({ languages: ["Rust"], frameworks: [] });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.language).toBe("Rust");
  });

  it("returns Python checklist", () => {
    const profile = makeProfile({ languages: ["Python"], frameworks: [] });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.language).toBe("Python");
  });

  it("returns Go checklist", () => {
    const profile = makeProfile({ languages: ["Go"], frameworks: [] });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.language).toBe("Go");
  });

  it("returns null for unknown language", () => {
    const profile = makeProfile({ languages: ["Haskell"], frameworks: [] });
    expect(getDomainChecklist(profile)).toBeNull();
  });

  it("is case-insensitive for language matching", () => {
    const profile = makeProfile({ languages: ["typescript"], frameworks: ["react"] });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.framework).toBe("React");
  });

  it("falls back to language-only when framework doesn't match", () => {
    const profile = makeProfile({
      languages: ["TypeScript"],
      frameworks: ["SomeUnknownFramework"],
    });
    const checklist = getDomainChecklist(profile);
    expect(checklist).not.toBeNull();
    expect(checklist!.language).toBe("TypeScript");
    expect(checklist!.framework).toBeUndefined();
  });
});

// ─── formatDomainBlunderItems ───────────────────────────────

describe("formatDomainBlunderItems", () => {
  it("formats items with framework header", () => {
    const checklist = getDomainChecklist(
      makeProfile({ languages: ["TypeScript"], frameworks: ["React"] })
    )!;
    const formatted = formatDomainBlunderItems(checklist);
    expect(formatted).toContain("TypeScript/React-Specific Checks");
    expect(formatted).toContain("Stale closure");
  });

  it("formats items with language-only header", () => {
    const checklist = getDomainChecklist(
      makeProfile({ languages: ["Rust"] })
    )!;
    const formatted = formatDomainBlunderItems(checklist);
    expect(formatted).toContain("Rust-Specific Checks");
    expect(formatted).toContain("Unwrap");
  });

  it("returns empty string for empty checklist", () => {
    const formatted = formatDomainBlunderItems({
      language: "Unknown",
      blunderHuntItems: [],
      reviewItems: [],
      antiPatterns: [],
    });
    expect(formatted).toBe("");
  });
});

// ─── formatDomainReviewItems ────────────────────────────────

describe("formatDomainReviewItems", () => {
  it("includes review items and anti-patterns", () => {
    const checklist = getDomainChecklist(
      makeProfile({ languages: ["TypeScript"], frameworks: ["React"] })
    )!;
    const formatted = formatDomainReviewItems(checklist);
    expect(formatted).toContain("TypeScript/React-Specific Review");
    expect(formatted).toContain("Rules of Hooks");
    expect(formatted).toContain("Anti-Patterns");
    expect(formatted).toContain("any");
  });

  it("omits anti-patterns section when empty", () => {
    const formatted = formatDomainReviewItems({
      language: "Test",
      blunderHuntItems: [],
      reviewItems: ["Check something"],
      antiPatterns: [],
    });
    expect(formatted).toContain("Check something");
    expect(formatted).not.toContain("Anti-Patterns");
  });
});
