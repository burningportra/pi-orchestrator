import { describe, it, expect } from "vitest";
import { diffBeadSnapshots, formatDiffSummary, type DiffSummary } from "./tools/approve.js";

function makeSnap(entries: Record<string, { title: string; descLength: number; descHash: string; files: string[] }>) {
  return new Map(Object.entries(entries));
}

describe("diffBeadSnapshots", () => {
  it("detects added beads", () => {
    const prev = makeSnap({ a: { title: "A", descLength: 10, descHash: "10:hello", files: ["f1"] } });
    const curr = makeSnap({
      a: { title: "A", descLength: 10, descHash: "10:hello", files: ["f1"] },
      b: { title: "B", descLength: 20, descHash: "20:world", files: ["f2"] },
    });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.added).toEqual([{ id: "b", title: "B" }]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("detects removed beads", () => {
    const prev = makeSnap({
      a: { title: "A", descLength: 10, descHash: "10:hello", files: [] },
      b: { title: "B", descLength: 20, descHash: "20:world", files: [] },
    });
    const curr = makeSnap({ a: { title: "A", descLength: 10, descHash: "10:hello", files: [] } });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.added).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("detects title changes", () => {
    const prev = makeSnap({ a: { title: "Old", descLength: 10, descHash: "10:hello", files: [] } });
    const curr = makeSnap({ a: { title: "New", descLength: 10, descHash: "10:hello", files: [] } });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].id).toBe("a");
    expect(diff.modified[0].changes[0]).toContain("title");
  });

  it("detects description changes with length delta", () => {
    const prev = makeSnap({ a: { title: "A", descLength: 10, descHash: "10:hello", files: [] } });
    const curr = makeSnap({ a: { title: "A", descLength: 25, descHash: "25:hello world extended!!", files: [] } });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].changes[0]).toContain("+15 chars");
  });

  it("detects file changes", () => {
    const prev = makeSnap({ a: { title: "A", descLength: 10, descHash: "10:hello", files: ["f1", "f2"] } });
    const curr = makeSnap({ a: { title: "A", descLength: 10, descHash: "10:hello", files: ["f1", "f3"] } });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].changes[0]).toContain("files");
    expect(diff.modified[0].changes[0]).toContain("+f3");
    expect(diff.modified[0].changes[0]).toContain("-f2");
  });

  it("reports unchanged correctly", () => {
    const snap = makeSnap({
      a: { title: "A", descLength: 10, descHash: "10:hello", files: [] },
      b: { title: "B", descLength: 20, descHash: "20:world", files: [] },
    });
    const diff = diffBeadSnapshots(snap, snap);
    expect(diff.unchangedCount).toBe(2);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("handles mixed changes", () => {
    const prev = makeSnap({
      a: { title: "A", descLength: 10, descHash: "10:hello", files: [] },
      b: { title: "B", descLength: 20, descHash: "20:world", files: [] },
      c: { title: "C", descLength: 30, descHash: "30:ccccc", files: [] },
    });
    const curr = makeSnap({
      a: { title: "A modified", descLength: 10, descHash: "10:hello", files: [] },
      c: { title: "C", descLength: 30, descHash: "30:ccccc", files: [] },
      d: { title: "D", descLength: 40, descHash: "40:ddddd", files: [] },
    });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.added).toEqual([{ id: "d", title: "D" }]);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].id).toBe("a");
    expect(diff.unchangedCount).toBe(1);
  });
});

describe("formatDiffSummary", () => {
  it("formats a complete diff", () => {
    const diff: DiffSummary = {
      added: [{ id: "x", title: "New bead" }],
      removed: ["y"],
      modified: [{ id: "z", changes: ["title: \"Old\" → \"New\""] }],
      unchangedCount: 2,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("➕ Added");
    expect(text).toContain("➖ Removed");
    expect(text).toContain("✏️");
    expect(text).toContain("2 beads unchanged");
  });

  it("handles no changes", () => {
    const diff: DiffSummary = { added: [], removed: [], modified: [], unchangedCount: 3 };
    const text = formatDiffSummary(diff);
    expect(text).toContain("No changes detected");
  });
});
