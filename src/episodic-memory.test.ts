import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as cp from "child_process";
import {
  detectMempalace,
  resetMempalaceDetection,
  mineSession,
  searchEpisodic,
  getEpisodicContext,
  getEpisodicStats,
  sanitiseSlug,
} from "./episodic-memory.js";

// ─── Mock child_process ─────────────────────────────────────

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(cp.execFileSync);

// ─── Fake output helpers ─────────────────────────────────────

/**
 * Build fake plain-text `mempalace search` output matching the real CLI format.
 * Pass an empty array to simulate no results.
 */
function fakePlainTextSearch(
  results: Array<{ text: string; similarity: number; wing: string; room: string }>
): string {
  if (results.length === 0) {
    return "\n  No results found.\n\n";
  }
  const header =
    "============================================================\n" +
    '  Results for: "query"\n' +
    "============================================================\n\n";
  const sep = "\n  ────────────────────────────────────────────────────────\n";
  const blocks = results.map((r, i) => {
    const indented = r.text
      .split("\n")
      .map((l) => `      ${l}`)
      .join("\n");
    return (
      `  [${i + 1}] ${r.wing} / ${r.room}\n` +
      `      Source: fake-source.md\n` +
      `      Match:  ${r.similarity.toFixed(3)}\n\n` +
      indented
    );
  });
  return header + blocks.join(sep) + "\n";
}

/**
 * Build fake plain-text `mempalace status` output matching the real CLI format.
 */
function fakePlainTextStatus(drawerCount: number, wing = "pi-orchestrator"): string {
  return (
    "=======================================================\n" +
    `  MemPalace Status — ${drawerCount} drawers\n` +
    "=======================================================\n\n" +
    `  WING: ${wing}\n` +
    `    ROOM: general      ${drawerCount} drawers\n\n` +
    "=======================================================\n"
  );
}

beforeEach(() => {
  resetMempalaceDetection();
  mockExec.mockReset();
  // Default: mempalace is available — `status` command succeeds
  mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
    if (
      cmd === "python3" &&
      args?.[0] === "-m" &&
      args?.[1] === "mempalace" &&
      args?.[2] === "status"
    ) {
      return fakePlainTextStatus(100) as any;
    }
    throw new Error(`Unmocked call: ${cmd} ${args?.join(" ")}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── detectMempalace ─────────────────────────────────────────

describe("detectMempalace", () => {
  it("returns true when python3 -m mempalace is available", () => {
    expect(detectMempalace()).toBe(true);
  });

  it("returns false when python3 throws ENOENT", () => {
    mockExec.mockImplementation(() => {
      const err = new Error("spawn python3 ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(detectMempalace()).toBe(false);
  });

  it("returns false when python3 -m mempalace times out", () => {
    mockExec.mockImplementation(() => {
      const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      throw err;
    });
    expect(detectMempalace()).toBe(false);
  });

  it("returns false when mempalace module exits non-zero", () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error("Command failed"), { status: 1 });
    });
    expect(detectMempalace()).toBe(false);
  });

  it("caches true permanently — only probes once on repeated calls", () => {
    detectMempalace();
    detectMempalace();
    detectMempalace();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("does not permanently cache false — re-probes after 5s", () => {
    vi.useFakeTimers();
    mockExec.mockImplementation(() => { throw new Error("not found"); });

    expect(detectMempalace()).toBe(false);
    expect(mockExec).toHaveBeenCalledTimes(1);

    // Still false within the 5s window — no re-probe
    vi.advanceTimersByTime(4_000);
    expect(detectMempalace()).toBe(false);
    expect(mockExec).toHaveBeenCalledTimes(1);

    // After 5s the cache expires — should re-probe
    vi.advanceTimersByTime(2_000);
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === "python3" && args?.[2] === "status") {
        return fakePlainTextStatus(0) as any;
      }
      throw new Error("unexpected");
    });
    expect(detectMempalace()).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

// ─── mineSession ─────────────────────────────────────────────

describe("mineSession", () => {
  it("calls python3 -m mempalace mine with correct args", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(0) as any;
      if (args?.[2] === "mine") return "" as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const result = mineSession("/tmp/session.jsonl", "my-project");
    expect(result).toBe(true);

    const mineCalls = mockExec.mock.calls.filter(
      ([, args]) => (args as string[])?.[2] === "mine"
    );
    expect(mineCalls).toHaveLength(1);
    const [cmd, args] = mineCalls[0] as [string, string[]];
    expect(cmd).toBe("python3");
    // mine receives the parent directory, not the individual file
    expect(args).toEqual([
      "-m", "mempalace",
      "mine", "/tmp",
      "--mode", "convos",
      "--wing", "my-project",
      "--extract", "general",
    ]);
  });

  it("returns false when CLI throws", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(0) as any;
      throw new Error("mining failed");
    });
    expect(mineSession("/tmp/session.jsonl", "my-project")).toBe(false);
  });

  it("returns false when mempalace is not available", () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(mineSession("/tmp/session.jsonl", "my-project")).toBe(false);
  });

  it("never throws — returns false on unexpected errors", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(0) as any;
      throw new TypeError("completely unexpected");
    });
    expect(() => mineSession("/tmp/session.jsonl", "slug")).not.toThrow();
    expect(mineSession("/tmp/session.jsonl", "slug")).toBe(false);
  });
});

// ─── searchEpisodic ──────────────────────────────────────────

describe("searchEpisodic", () => {
  it("parses plain-text results and formats with sim score and room label", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") {
        return fakePlainTextSearch([{
          text: "We chose to use CLI wrapper",
          similarity: 0.91,
          wing: "pi-orchestrator",
          room: "decisions",
        }]) as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const result = searchEpisodic("how to handle deps");
    expect(result).toContain("[pi-orchestrator / decisions] (sim=0.91)");
    expect(result).toContain("We chose to use CLI wrapper");
  });

  it("passes --results and --wing args correctly", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") return fakePlainTextSearch([]) as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    searchEpisodic("query", { wing: "pi-orchestrator", nResults: 3 });

    const searchCalls = mockExec.mock.calls.filter(
      ([, args]) => (args as string[])?.[2] === "search"
    );
    expect(searchCalls).toHaveLength(1);
    const [, args] = searchCalls[0] as [string, string[]];
    expect(args).toContain("--results");
    expect(args).toContain("3");
    expect(args).toContain("--wing");
    expect(args).toContain("pi-orchestrator");
  });

  it("returns empty string when results list is empty", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") return fakePlainTextSearch([]) as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });
    expect(searchEpisodic("anything")).toBe("");
  });

  it("returns empty string when output has no parseable blocks", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") return "some garbage output\n" as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });
    expect(searchEpisodic("anything")).toBe("");
  });

  it("returns empty string when CLI throws", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      throw new Error("search failed");
    });
    expect(searchEpisodic("anything")).toBe("");
  });

  it("returns empty string when mempalace is not available", () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(searchEpisodic("anything")).toBe("");
  });

  it("formats multiline text with consistent indentation", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") {
        return fakePlainTextSearch([{
          text: "line one\nline two\nline three",
          similarity: 0.85,
          wing: "proj",
          room: "milestones",
        }]) as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });
    const output = searchEpisodic("query");
    expect(output).toContain("[proj / milestones] (sim=0.85)");
    // Each line after the first should be indented
    expect(output).toContain("  line two");
    expect(output).toContain("  line three");
  });
});

// ─── getEpisodicContext ───────────────────────────────────────

describe("getEpisodicContext", () => {
  it("wraps results in ## Past Session Examples header", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") {
        return fakePlainTextSearch([{
          text: "We chose to use CLI wrapper",
          similarity: 0.91,
          wing: "pi-orchestrator",
          room: "decisions",
        }]) as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const ctx = getEpisodicContext("plan beads", "pi-orchestrator");
    expect(ctx).toMatch(/^## Past Session Examples\n/);
    expect(ctx).toContain("[pi-orchestrator / decisions]");
  });

  it("returns empty string when mempalace is not available", () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(getEpisodicContext("plan beads", "pi-orchestrator")).toBe("");
  });

  it("returns empty string when search yields no results", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") return fakePlainTextSearch([]) as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });
    expect(getEpisodicContext("plan beads", "pi-orchestrator")).toBe("");
  });

  it("passes projectSlug as wing to searchEpisodic", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(100) as any;
      if (args?.[2] === "search") return fakePlainTextSearch([]) as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    getEpisodicContext("task", "my-slug");

    const searchCalls = mockExec.mock.calls.filter(
      ([, args]) => (args as string[])?.[2] === "search"
    );
    expect(searchCalls).toHaveLength(1);
    const [, args] = searchCalls[0] as [string, string[]];
    expect(args).toContain("--wing");
    expect(args).toContain("my-slug");
  });
});

// ─── getEpisodicStats ─────────────────────────────────────────

describe("getEpisodicStats", () => {
  it("parses drawer count from plain-text status output", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return fakePlainTextStatus(42) as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const stats = getEpisodicStats();
    expect(stats.available).toBe(true);
    expect(stats.drawerCount).toBe(42);
    // Palace path derived from HOME env
    expect(stats.palacePath).toMatch(/\.mempalace\/palace$/);
  });

  it("returns drawerCount=0 when status output has no drawer line", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return "  No palace found.\n" as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });

    const stats = getEpisodicStats();
    expect(stats.available).toBe(true);
    expect(stats.drawerCount).toBe(0);
  });

  it("returns safe zero-value struct when CLI throws", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") {
        // First call (probe): succeed; second call (stats): fail
        mockExec.mockImplementationOnce(() => { throw new Error("status failed"); });
        return fakePlainTextStatus(0) as any;
      }
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });
    // Trigger detection first so it's cached as true
    detectMempalace();
    // Now make the stats call throw
    mockExec.mockImplementation(() => { throw new Error("status failed"); });

    const stats = getEpisodicStats();
    expect(stats.available).toBe(true); // detect cached, only runMempalace failed
    expect(stats.palacePath).toBeNull();
    expect(stats.drawerCount).toBe(0);
  });

  it("returns available=false when mempalace is not installed", () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });

    const stats = getEpisodicStats();
    expect(stats.available).toBe(false);
    expect(stats.palacePath).toBeNull();
    expect(stats.drawerCount).toBe(0);
  });

  it("never throws — returns zero struct on unexpected output", () => {
    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (args?.[2] === "status") return "some unexpected output" as any;
      throw new Error(`Unmocked: ${args?.join(" ")}`);
    });
    expect(() => getEpisodicStats()).not.toThrow();
    const stats = getEpisodicStats();
    expect(stats.available).toBe(true);
    expect(stats.drawerCount).toBe(0);
  });
});

// ─── sanitiseSlug ─────────────────────────────────────────────

describe("sanitiseSlug", () => {
  it("returns basename of path", () => {
    expect(sanitiseSlug("/Volumes/1tb/Projects/pi-orchestrator")).toBe("pi-orchestrator");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitiseSlug("/projects/my project")).toBe("my-project");
  });

  it("replaces parentheses and dots", () => {
    expect(sanitiseSlug("/projects/my project (v2)")).toBe("my-project--v2-");
  });

  it("handles paths with no special chars", () => {
    expect(sanitiseSlug("/home/user/myapp")).toBe("myapp");
  });

  it("replaces backslashes with hyphens on non-Windows", () => {
    // path.basename on macOS/Linux treats backslash as a regular char,
    // so the whole Windows path is the basename — all non-alphanumeric chars become hyphens.
    const result = sanitiseSlug("C:\\Users\\user\\my-app");
    // Must not contain raw backslashes
    expect(result).not.toContain("\\");
    // Must end with the expected suffix
    expect(result).toMatch(/my-app$/);
  });
});
