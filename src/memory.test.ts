import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as cp from "child_process";
import {
  readMemory,
  appendMemory,
  listMemoryEntries,
  searchMemory,
  getMemoryStats,
  getContext,
  markRule,
  detectCass,
  resetCassDetection,
} from "./memory.js";

// ─── Mock child_process ─────────────────────────────────────

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(cp.execFileSync);

function cmResponse(data: unknown, command = "test") {
  return JSON.stringify({
    success: true,
    command,
    data,
    metadata: { executionMs: 10, version: "0.2.3" },
  });
}

beforeEach(() => {
  resetCassDetection();
  mockExec.mockReset();
  // Default: cm is available
  mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
    if (cmd === "cm" && args?.[0] === "--version") return "0.2.3\n" as any;
    throw new Error(`Unmocked call: ${cmd} ${args?.join(" ")}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── detectCass ─────────────────────────────────────────────

describe("detectCass", () => {
  it("returns true when cm is available", () => {
    expect(detectCass()).toBe(true);
  });

  it("returns false when cm is not available", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(detectCass()).toBe(false);
  });

  it("caches the result", () => {
    detectCass();
    detectCass();
    // --version only called once (cached)
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

// ─── getContext ──────────────────────────────────────────────

describe("getContext", () => {
  it("returns parsed CASS context", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "context") {
        return cmResponse({
          task: "test task",
          relevantBullets: [{ id: "b-123", text: "Use caching", score: 0.9 }],
          antiPatterns: [{ id: "b-456", text: "Avoid global state" }],
          historySnippets: [{ text: "Previous session used Redis" }],
          suggestedCassQueries: [],
          degraded: null,
        }, "context") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const ctx = getContext("test task");
    expect(ctx).toBeTruthy();
    expect(ctx!.relevantBullets).toHaveLength(1);
    expect(ctx!.relevantBullets[0].id).toBe("b-123");
    expect(ctx!.antiPatterns).toHaveLength(1);
    expect(ctx!.historySnippets).toHaveLength(1);
  });

  it("returns null when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(getContext("test")).toBeNull();
  });
});

// ─── readMemory ─────────────────────────────────────────────

describe("readMemory", () => {
  it("returns empty string when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(readMemory("/tmp")).toBe("");
  });

  it("returns formatted string with bullets and anti-patterns", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "context") {
        return cmResponse({
          relevantBullets: [{ id: "b-1", text: "Rule one" }],
          antiPatterns: [{ id: "b-2", text: "Bad pattern" }],
          historySnippets: [],
          suggestedCassQueries: [],
          degraded: null,
        }) as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const result = readMemory("/tmp", "some task");
    expect(result).toContain("### Relevant Rules");
    expect(result).toContain("[b-1] Rule one");
    expect(result).toContain("### Anti-Patterns");
    expect(result).toContain("[b-2] Bad pattern");
  });

  it("returns empty string when context returns no data", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "context") {
        return cmResponse({
          relevantBullets: [],
          antiPatterns: [],
          historySnippets: [],
          suggestedCassQueries: [],
          degraded: null,
        }) as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    expect(readMemory("/tmp")).toBe("");
  });
});

// ─── appendMemory ───────────────────────────────────────────

describe("appendMemory", () => {
  it("calls cm add with content", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "add") {
        return cmResponse({ id: "b-new", text: "learning" }, "add") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    expect(appendMemory("/tmp", "new learning")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cm", ["add", "new learning", "--json"],
      expect.objectContaining({ timeout: 10000 })
    );
  });

  it("passes category when provided", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "add") return cmResponse({ id: "b-new" }) as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    appendMemory("/tmp", "rule", "security");
    expect(mockExec).toHaveBeenCalledWith(
      "cm", ["add", "rule", "--json", "--category", "security"],
      expect.objectContaining({ timeout: 10000 })
    );
  });

  it("returns false when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(appendMemory("/tmp", "test")).toBe(false);
  });
});

// ─── listMemoryEntries ──────────────────────────────────────

describe("listMemoryEntries", () => {
  it("returns parsed entries from cm ls", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "ls") {
        return cmResponse({
          bullets: [
            { id: "b-1", text: "First rule", category: "general" },
            { id: "b-2", text: "Second rule", category: "security" },
          ],
        }, "ls") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const entries = listMemoryEntries("/tmp");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ index: 1, id: "b-1", category: "general", content: "First rule" });
    expect(entries[1]).toEqual({ index: 2, id: "b-2", category: "security", content: "Second rule" });
  });

  it("returns empty array when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(listMemoryEntries("/tmp")).toEqual([]);
  });

  it("handles bare array response", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "ls") {
        return cmResponse([
          { id: "b-1", text: "Rule" },
        ], "ls") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const entries = listMemoryEntries("/tmp");
    expect(entries).toHaveLength(1);
  });
});

// ─── searchMemory ───────────────────────────────────────────

describe("searchMemory", () => {
  it("returns matched results from cm similar", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "similar") {
        return cmResponse({
          query: "redis",
          results: [
            { id: "b-1", text: "Use Redis for caching", score: 0.85, category: "performance" },
          ],
        }, "similar") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const results = searchMemory("/tmp", "redis");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Use Redis for caching");
    expect(results[0].category).toBe("performance");
  });

  it("returns empty array when no matches", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "similar") {
        return cmResponse({ query: "zzz", results: [] }, "similar") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    expect(searchMemory("/tmp", "zzz")).toEqual([]);
  });

  it("returns empty when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(searchMemory("/tmp", "test")).toEqual([]);
  });
});

// ─── markRule ───────────────────────────────────────────────

describe("markRule", () => {
  it("marks a rule as helpful", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "mark") return cmResponse({ updated: true }, "mark") as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    expect(markRule("b-123", true)).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cm", ["mark", "b-123", "--helpful", "--json"],
      expect.objectContaining({ timeout: 10000 })
    );
  });

  it("marks a rule as harmful with reason", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "mark") return cmResponse({ updated: true }, "mark") as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    markRule("b-456", false, "caused_bug");
    expect(mockExec).toHaveBeenCalledWith(
      "cm", ["mark", "b-456", "--harmful", "--json", "--reason", "caused_bug"],
      expect.objectContaining({ timeout: 10000 })
    );
  });

  it("returns false when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(markRule("b-123", true)).toBe(false);
  });
});

// ─── getMemoryStats ─────────────────────────────────────────

describe("getMemoryStats", () => {
  it("returns stats from cm doctor + stats", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "--version") return "0.2.3\n" as any;
      if (args?.[0] === "doctor") {
        return cmResponse({
          version: "0.2.3",
          overallStatus: "healthy",
        }, "doctor") as any;
      }
      if (args?.[0] === "stats") {
        return cmResponse({ totalBullets: 15 }, "stats") as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const stats = getMemoryStats("/tmp");
    expect(stats.entryCount).toBe(15);
    expect(stats.cassAvailable).toBe(true);
    expect(stats.overallStatus).toBe("healthy");
    expect(stats.version).toBe("0.2.3");
  });

  it("returns empty stats when cm unavailable", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    const stats = getMemoryStats("/tmp");
    expect(stats.entryCount).toBe(0);
    expect(stats.cassAvailable).toBe(false);
    expect(stats.overallStatus).toBeNull();
  });
});
