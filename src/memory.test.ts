import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readMemory,
  appendMemory,
  listMemoryEntries,
  searchMemory,
  pruneMemoryEntries,
  getMemoryStats,
} from "./memory.js";

// ─── Helpers ────────────────────────────────────────────────

let tmp: string;

function memFile(cwd: string): string {
  return join(cwd, ".pi-orchestrator", "memory.md");
}

function writeMemoryFile(cwd: string, content: string): void {
  const dir = join(cwd, ".pi-orchestrator");
  mkdirSync(dir, { recursive: true });
  writeFileSync(memFile(cwd), content, "utf8");
}

const HEADER = "# Compound Memory\n\nLearnings carried across orchestration runs.\n";

function makeFile(entries: { ts: string; body: string }[]): string {
  let out = HEADER;
  for (const e of entries) {
    out += `\n## ${e.ts}\n\n${e.body}\n`;
  }
  return out;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mem-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── readMemory + appendMemory round-trip ───────────────────

describe("readMemory + appendMemory", () => {
  it("returns empty string for missing file", () => {
    expect(readMemory(tmp)).toBe("");
  });

  it("appends and reads back entries", () => {
    appendMemory(tmp, "first learning");
    appendMemory(tmp, "second learning");
    const content = readMemory(tmp);
    expect(content).toContain("# Compound Memory");
    expect(content).toContain("first learning");
    expect(content).toContain("second learning");
  });

  it("creates directory and file on first append", () => {
    expect(appendMemory(tmp, "hello")).toBe(true);
    const raw = readFileSync(memFile(tmp), "utf8");
    expect(raw).toContain("# Compound Memory");
    expect(raw).toContain("hello");
  });
});

// ─── listMemoryEntries ──────────────────────────────────────

describe("listMemoryEntries", () => {
  it("parses multiple entries", () => {
    writeMemoryFile(
      tmp,
      makeFile([
        { ts: "2026-03-01 10:00:00", body: "Entry one" },
        { ts: "2026-03-02 11:00:00", body: "Entry two" },
        { ts: "2026-03-03 12:00:00", body: "Entry three" },
      ])
    );

    const entries = listMemoryEntries(tmp);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ index: 1, timestamp: "2026-03-01 10:00:00", content: "Entry one" });
    expect(entries[1]).toEqual({ index: 2, timestamp: "2026-03-02 11:00:00", content: "Entry two" });
    expect(entries[2]).toEqual({ index: 3, timestamp: "2026-03-03 12:00:00", content: "Entry three" });
  });

  it("returns empty array for missing file", () => {
    expect(listMemoryEntries(tmp)).toEqual([]);
  });

  it("returns empty array for file with only header", () => {
    writeMemoryFile(tmp, HEADER);
    expect(listMemoryEntries(tmp)).toEqual([]);
  });

  it("handles entries with multi-line content", () => {
    writeMemoryFile(
      tmp,
      makeFile([{ ts: "2026-03-01 10:00:00", body: "Line 1\nLine 2\nLine 3" }])
    );
    const entries = listMemoryEntries(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles malformed sections (non-timestamp headings)", () => {
    writeMemoryFile(
      tmp,
      HEADER + "\n## not-a-real-timestamp\n\nSome content\n"
    );
    const entries = listMemoryEntries(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe("not-a-real-timestamp");
    expect(entries[0].content).toBe("Some content");
  });
});

// ─── searchMemory ───────────────────────────────────────────

describe("searchMemory", () => {
  it("finds entries matching content (case-insensitive)", () => {
    writeMemoryFile(
      tmp,
      makeFile([
        { ts: "2026-03-01 10:00:00", body: "Use Redis for caching" },
        { ts: "2026-03-02 11:00:00", body: "Postgres is the main DB" },
        { ts: "2026-03-03 12:00:00", body: "Redis cluster setup" },
      ])
    );

    const results = searchMemory(tmp, "redis");
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain("Redis");
    expect(results[1].content).toContain("Redis");
  });

  it("finds entries matching timestamp", () => {
    writeMemoryFile(
      tmp,
      makeFile([
        { ts: "2026-03-01 10:00:00", body: "Entry A" },
        { ts: "2026-03-02 11:00:00", body: "Entry B" },
      ])
    );

    const results = searchMemory(tmp, "03-01");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Entry A");
  });

  it("returns empty array when no matches", () => {
    writeMemoryFile(tmp, makeFile([{ ts: "2026-03-01 10:00:00", body: "Hello world" }]));
    expect(searchMemory(tmp, "zzzzz")).toEqual([]);
  });

  it("handles special regex characters in query", () => {
    writeMemoryFile(
      tmp,
      makeFile([{ ts: "2026-03-01 10:00:00", body: "Price is $100 (USD)" }])
    );
    const results = searchMemory(tmp, "$100 (USD)");
    expect(results).toHaveLength(1);
  });

  it("returns empty for missing file", () => {
    expect(searchMemory(tmp, "anything")).toEqual([]);
  });
});

// ─── pruneMemoryEntries ─────────────────────────────────────

describe("pruneMemoryEntries", () => {
  const threeEntries = [
    { ts: "2026-03-01 10:00:00", body: "First" },
    { ts: "2026-03-02 11:00:00", body: "Second" },
    { ts: "2026-03-03 12:00:00", body: "Third" },
  ];

  it("removes a single entry by index", () => {
    writeMemoryFile(tmp, makeFile(threeEntries));
    const removed = pruneMemoryEntries(tmp, [2]);
    expect(removed).toBe(1);

    const remaining = listMemoryEntries(tmp);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe("First");
    expect(remaining[1].content).toBe("Third");
  });

  it("removes first entry", () => {
    writeMemoryFile(tmp, makeFile(threeEntries));
    pruneMemoryEntries(tmp, [1]);

    const remaining = listMemoryEntries(tmp);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe("Second");
  });

  it("removes last entry", () => {
    writeMemoryFile(tmp, makeFile(threeEntries));
    pruneMemoryEntries(tmp, [3]);

    const remaining = listMemoryEntries(tmp);
    expect(remaining).toHaveLength(2);
    expect(remaining[1].content).toBe("Second");
  });

  it("removes multiple entries", () => {
    writeMemoryFile(tmp, makeFile(threeEntries));
    const removed = pruneMemoryEntries(tmp, [1, 3]);
    expect(removed).toBe(2);

    const remaining = listMemoryEntries(tmp);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("Second");
  });

  it("ignores out-of-bounds indices", () => {
    writeMemoryFile(tmp, makeFile(threeEntries));
    const removed = pruneMemoryEntries(tmp, [0, 4, 99]);
    expect(removed).toBe(0);

    expect(listMemoryEntries(tmp)).toHaveLength(3);
  });

  it("preserves header after pruning", () => {
    writeMemoryFile(tmp, makeFile(threeEntries));
    pruneMemoryEntries(tmp, [1, 2, 3]);

    const raw = readFileSync(memFile(tmp), "utf8");
    expect(raw).toContain("# Compound Memory");
  });

  it("returns 0 for missing file", () => {
    expect(pruneMemoryEntries(tmp, [1])).toBe(0);
  });

  it("returns 0 for empty file (header only)", () => {
    writeMemoryFile(tmp, HEADER);
    expect(pruneMemoryEntries(tmp, [1])).toBe(0);
  });
});

// ─── getMemoryStats ─────────────────────────────────────────

describe("getMemoryStats", () => {
  it("returns accurate counts and date range", () => {
    writeMemoryFile(
      tmp,
      makeFile([
        { ts: "2026-03-01 10:00:00", body: "Oldest" },
        { ts: "2026-03-02 11:00:00", body: "Middle" },
        { ts: "2026-03-03 12:00:00", body: "Newest" },
      ])
    );

    const stats = getMemoryStats(tmp);
    expect(stats.entryCount).toBe(3);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.oldest).toBe("2026-03-01 10:00:00");
    expect(stats.newest).toBe("2026-03-03 12:00:00");
  });

  it("returns zeros for missing file", () => {
    const stats = getMemoryStats(tmp);
    expect(stats).toEqual({
      entryCount: 0,
      totalBytes: 0,
      oldest: null,
      newest: null,
    });
  });

  it("returns zero entries for header-only file", () => {
    writeMemoryFile(tmp, HEADER);
    const stats = getMemoryStats(tmp);
    expect(stats.entryCount).toBe(0);
    expect(stats.totalBytes).toBeGreaterThan(0); // file exists with header
    expect(stats.oldest).toBeNull();
    expect(stats.newest).toBeNull();
  });

  it("returns correct stats for single entry", () => {
    writeMemoryFile(
      tmp,
      makeFile([{ ts: "2026-03-15 08:30:00", body: "Only entry" }])
    );

    const stats = getMemoryStats(tmp);
    expect(stats.entryCount).toBe(1);
    expect(stats.oldest).toBe("2026-03-15 08:30:00");
    expect(stats.newest).toBe("2026-03-15 08:30:00");
  });
});
