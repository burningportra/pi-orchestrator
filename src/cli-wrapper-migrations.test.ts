import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const reviewSource = readFileSync(join(__dir, "tools/review.ts"), "utf8");
const approveSource = readFileSync(join(__dir, "tools/approve.ts"), "utf8");
const profileSource = readFileSync(join(__dir, "tools/profile.ts"), "utf8");
const indexSource = readFileSync(join(__dir, "index.ts"), "utf8");

describe("review.ts resilient exec migration", () => {
  it("uses brExec to re-open partial beads and degrades cleanly on failure", () => {
    expect(reviewSource).toContain("const reopenResult = await brExec(oc.pi");
    expect(reviewSource).toContain("if (reopenResult.ok) {");
    expect(reviewSource).toContain("reopened.push(id)");
  });

  it("uses resilientExec for changed-files lookup with a one-retry best-effort path", () => {
    expect(reviewSource).toContain('const gitResult = await resilientExec(oc.pi, "git", ["diff", "--name-only", "HEAD~1"]');
    expect(reviewSource).toContain("maxRetries: 1");
    expect(reviewSource).toContain("if (gitResult.ok) {");
    expect(reviewSource).toContain("if (filesChanged.length > 0)");
  });
});

describe("approve.ts resilient exec migration", () => {
  it("uses brExecJson for dependency lookup and skips failed optional lookups", () => {
    expect(approveSource).toContain("const depResult = await brExecJson");
    expect(approveSource).toContain("if (!depResult.ok) continue");
    expect(approveSource).toContain("depResult.value.dependencies ?? []");
  });

  it("uses resilientExec for repo file discovery and keeps empty fallback behavior", () => {
    expect(approveSource).toContain('const findResult = await resilientExec(oc.pi, "find", ["src", "-type", "f"]');
    expect(approveSource).toContain("maxRetries: 0");
    expect(approveSource).toContain("if (findResult.ok) {");
    expect(approveSource).toContain("const repoFiles = new Set<string>()");
  });
});

describe("profile.ts resilient exec migration", () => {
  it("uses brExecJson for deep discovery bead-title preload and preserves readBeads fallback", () => {
    expect(profileSource).toContain("const brListResult = await brExecJson<unknown[]>");
    expect(profileSource).toContain("if (!brListResult.ok) {");
    expect(profileSource).toContain('const { readBeads } = await import("../beads.js")');
    expect(profileSource).toContain("phase1BeadTitles = beads.map((b) => b.title)");
  });

  it("uses brExec for deferred-bead reactivation and keeps best-effort continuation", () => {
    expect(profileSource).toContain("const reactivateResult = await brExec(oc.pi");
    expect(profileSource).toContain("if (reactivateResult.ok) {");
    expect(profileSource).toContain("reactivated++");
  });

  it("uses brExec for clear-beads delete fallback and preserves the manual warning path", () => {
    expect(profileSource).toContain("const hardDeleteResult = await brExec(oc.pi");
    expect(profileSource).toContain("const forceDeleteResult = await brExec(oc.pi");
    expect(profileSource).toContain("Failed to delete beads — try \\\`br delete --force\\\` manually.");
  });
});

describe("index.ts resilient exec migration", () => {
  it("uses brExecJson for dashboard unblocked-bead lookup and keeps [] fallback behavior", () => {
    expect(indexSource).toContain("const readyResult = await brExecJson<{ issues?: { id: string }[] }>(pi");
    expect(indexSource).toContain("if (!readyResult.ok) {");
    expect(indexSource).toContain("return []");
    expect(indexSource).toContain("return (readyResult.value.issues ?? []).map((b) => b.id)");
  });
});
