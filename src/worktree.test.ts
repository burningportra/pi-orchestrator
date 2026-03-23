import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  findOrphanedWorktrees,
  cleanupOrphanedWorktrees,
  WorktreePool,
  type WorktreeInfo,
  type OrphanedWorktreeInfo,
} from "./worktree.js";

// ─── Mock fs ────────────────────────────────────────────────

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { existsSync, readdirSync } from "fs";
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;

// ─── Mock pi.exec ───────────────────────────────────────────

/** Create a mock pi with exec. Default exec resolves to code 0, empty stdout/stderr. */
function createMockPi(execFn?: (...args: any[]) => any): ExtensionAPI {
  const defaultExec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  return {
    exec: execFn ?? defaultExec,
  } as unknown as ExtensionAPI;
}

// ─── findOrphanedWorktrees ──────────────────────────────────

describe("findOrphanedWorktrees", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty array when worktree dir does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const pi = createMockPi();
    const result = await findOrphanedWorktrees(pi, "/repo", []);
    expect(result).toEqual([]);
  });

  it("returns empty array when no step-* directories found", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["readme.md", ".git"]);
    const pi = createMockPi();
    const result = await findOrphanedWorktrees(pi, "/repo", []);
    expect(result).toEqual([]);
  });

  it("returns empty array when all worktrees are tracked", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["step-0", "step-1"]);
    const tracked: WorktreeInfo[] = [
      { path: "/repo/.pi-orchestrator/worktrees/step-0", branch: "main--worktree-step-0", stepIndex: 0 },
      { path: "/repo/.pi-orchestrator/worktrees/step-1", branch: "main--worktree-step-1", stepIndex: 1 },
    ];
    const pi = createMockPi();
    const result = await findOrphanedWorktrees(pi, "/repo", tracked);
    expect(result).toEqual([]);
  });

  it("detects orphaned worktrees not in tracked list", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["step-0", "step-1", "step-5"]);
    const tracked: WorktreeInfo[] = [
      { path: "/repo/.pi-orchestrator/worktrees/step-0", branch: "main--worktree-step-0", stepIndex: 0 },
    ];
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pi = createMockPi(exec);

    const result = await findOrphanedWorktrees(pi, "/repo", tracked);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("/repo/.pi-orchestrator/worktrees/step-1");
    expect(result[1].path).toBe("/repo/.pi-orchestrator/worktrees/step-5");
  });

  it("detects dirty orphaned worktrees", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["step-3"]);
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return Promise.resolve({ code: 0, stdout: " M src/index.ts\n", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);

    const result = await findOrphanedWorktrees(pi, "/repo", []);
    expect(result).toHaveLength(1);
    expect(result[0].isDirty).toBe(true);
    expect(result[0].path).toBe("/repo/.pi-orchestrator/worktrees/step-3");
  });

  it("detects branch from git worktree list", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["step-2"]);
    const porcelainOutput = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.pi-orchestrator/worktrees/step-2",
      "HEAD def456",
      "branch refs/heads/main--worktree-step-2",
      "",
    ].join("\n");
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      if (cmd === "git" && args[0] === "worktree") {
        return Promise.resolve({ code: 0, stdout: porcelainOutput, stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);

    const result = await findOrphanedWorktrees(pi, "/repo", []);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("main--worktree-step-2");
  });

  it("handles readdirSync failure gracefully", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => { throw new Error("EACCES"); });
    const pi = createMockPi();
    const result = await findOrphanedWorktrees(pi, "/repo", []);
    expect(result).toEqual([]);
  });

  it("handles git status failure gracefully (treats as not dirty)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["step-0"]);
    const exec = vi.fn().mockRejectedValue(new Error("exec failed"));
    const pi = createMockPi(exec);

    const result = await findOrphanedWorktrees(pi, "/repo", []);
    expect(result).toHaveLength(1);
    expect(result[0].isDirty).toBe(false);
  });
});

// ─── cleanupOrphanedWorktrees ───────────────────────────────

describe("cleanupOrphanedWorktrees", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("removes clean orphans without auto-commit", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pi = createMockPi(exec);
    const orphans: OrphanedWorktreeInfo[] = [
      { path: "/repo/.pi-orchestrator/worktrees/step-1", isDirty: false },
    ];

    const summary = await cleanupOrphanedWorktrees(pi, "/repo", orphans);
    expect(summary.removed).toBe(1);
    expect(summary.autoCommitted).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("auto-commits dirty orphans before removal", async () => {
    const execCalls: string[][] = [];
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      // autoCommitWorktree checks status --porcelain; return dirty
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return Promise.resolve({ code: 0, stdout: " M src/file.ts\n", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);
    const orphans: OrphanedWorktreeInfo[] = [
      { path: "/repo/.pi-orchestrator/worktrees/step-2", isDirty: true },
    ];

    const summary = await cleanupOrphanedWorktrees(pi, "/repo", orphans);
    expect(summary.removed).toBe(1);
    expect(summary.autoCommitted).toBe(1);

    // Verify auto-commit was called (status, add, commit sequence)
    const statusCall = execCalls.find(c => c[0] === "git" && c[1] === "status");
    const addCall = execCalls.find(c => c[0] === "git" && c[1] === "add");
    const commitCall = execCalls.find(c => c[0] === "git" && c[1] === "commit");
    expect(statusCall).toBeDefined();
    expect(addCall).toBeDefined();
    expect(commitCall).toBeDefined();
  });

  it("deletes branch when known", async () => {
    const execCalls: string[][] = [];
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);
    const orphans: OrphanedWorktreeInfo[] = [
      { path: "/repo/.pi-orchestrator/worktrees/step-3", branch: "main--worktree-step-3", isDirty: false },
    ];

    await cleanupOrphanedWorktrees(pi, "/repo", orphans);
    const branchDelete = execCalls.find(c => c[0] === "git" && c[1] === "branch" && c[2] === "-D");
    expect(branchDelete).toBeDefined();
    expect(branchDelete![3]).toBe("main--worktree-step-3");
  });

  it("falls back to prune when worktree remove fails", async () => {
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "fatal: lock" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);
    const orphans: OrphanedWorktreeInfo[] = [
      { path: "/repo/.pi-orchestrator/worktrees/step-4", isDirty: false },
    ];

    const summary = await cleanupOrphanedWorktrees(pi, "/repo", orphans);
    // removeWorktree falls back to prune, which succeeds → counts as removed
    expect(summary.removed).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it("handles empty orphans list", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pi = createMockPi(exec);

    const summary = await cleanupOrphanedWorktrees(pi, "/repo", []);
    expect(summary.removed).toBe(0);
    expect(summary.autoCommitted).toBe(0);
    // Only the final prune call
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// ─── WorktreePool.safeCleanup ───────────────────────────────

describe("WorktreePool.safeCleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns zero summary when pool is empty and no orphans", async () => {
    mockExistsSync.mockReturnValue(false); // no worktree dir
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pi = createMockPi(exec);
    const pool = new WorktreePool(pi, "/repo", "main");

    const summary = await pool.safeCleanup();
    expect(summary.removed).toBe(0);
    expect(summary.autoCommitted).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("cleans up tracked worktrees with auto-commit", async () => {
    mockExistsSync.mockReturnValue(false); // no orphans after cleanup
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      // git status returns dirty for auto-commit check
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return Promise.resolve({ code: 0, stdout: " M file.ts\n", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);
    const pool = WorktreePool.fromState(pi, {
      repoRoot: "/repo",
      baseBranch: "main",
      worktrees: [
        { path: "/repo/.pi-orchestrator/worktrees/step-0", branch: "main--worktree-step-0", stepIndex: 0 },
      ],
    });

    const summary = await pool.safeCleanup();
    expect(summary.removed).toBe(1);
    expect(summary.autoCommitted).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(pool.getAll()).toHaveLength(0);
  });

  it("cleans up tracked worktrees without auto-commit when clean", async () => {
    mockExistsSync.mockReturnValue(false);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pi = createMockPi(exec);
    const pool = WorktreePool.fromState(pi, {
      repoRoot: "/repo",
      baseBranch: "main",
      worktrees: [
        { path: "/repo/.pi-orchestrator/worktrees/step-0", branch: "main--worktree-step-0", stepIndex: 0 },
      ],
    });

    const summary = await pool.safeCleanup();
    expect(summary.removed).toBe(1);
    expect(summary.autoCommitted).toBe(0);
  });

  it("does not throw when removal hits errors", async () => {
    mockExistsSync.mockReturnValue(false);
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: error" });
      }
      // prune fallback succeeds → removeWorktree returns ok:true
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const pi = createMockPi(exec);
    const pool = WorktreePool.fromState(pi, {
      repoRoot: "/repo",
      baseBranch: "main",
      worktrees: [
        { path: "/repo/.pi-orchestrator/worktrees/step-0", branch: "main--worktree-step-0", stepIndex: 0 },
      ],
    });

    const summary = await pool.safeCleanup();
    expect(summary.removed).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it("also cleans up orphaned worktrees", async () => {
    // After tracked cleanup, orphan scan finds extras
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["step-99"]);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pi = createMockPi(exec);
    const pool = new WorktreePool(pi, "/repo", "main");

    const summary = await pool.safeCleanup();
    expect(summary.removed).toBe(1); // the orphan
    expect(summary.autoCommitted).toBe(0);
  });
});
