import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "path";

// ─── Types ─────────────────────────────────────────────────────

export interface WorktreeResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  stepIndex: number;
}

export interface WorktreePoolState {
  repoRoot: string;
  baseBranch: string;
  worktrees: WorktreeInfo[];
}

// ─── Constants ─────────────────────────────────────────────────

const WORKTREE_DIR = ".pi-orchestrator/worktrees";

function worktreePath(repoRoot: string, stepIndex: number): string {
  return join(repoRoot, WORKTREE_DIR, `step-${stepIndex}`);
}

function worktreeBranch(baseBranch: string, stepIndex: number): string {
  // Use -- separator to avoid git ref path conflicts with slashes in baseBranch
  return `${baseBranch}--worktree-step-${stepIndex}`;
}

// ─── Low-level helpers ─────────────────────────────────────────

export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
  path: string
): Promise<WorktreeResult> {
  try {
    // Create the worktree branch from current HEAD
    const result = await pi.exec(
      "git",
      ["worktree", "add", "-b", branch, path],
      { timeout: 15000, cwd }
    );
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() || `git worktree add failed (code ${result.code})` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `worktree create failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function removeWorktree(
  pi: ExtensionAPI,
  cwd: string,
  path: string
): Promise<WorktreeResult> {
  try {
    // Force remove to handle dirty worktrees
    const result = await pi.exec(
      "git",
      ["worktree", "remove", "--force", path],
      { timeout: 10000, cwd }
    );
    if (result.code !== 0) {
      // Try prune as fallback if the directory was already deleted
      await pi.exec("git", ["worktree", "prune"], { timeout: 5000, cwd });
      return { ok: true }; // prune cleans up stale entries
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `worktree remove failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function listWorktrees(
  pi: ExtensionAPI,
  cwd: string
): Promise<WorktreeResult<string[]>> {
  try {
    const result = await pi.exec(
      "git",
      ["worktree", "list", "--porcelain"],
      { timeout: 5000, cwd }
    );
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() };
    }
    const paths = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    return { ok: true, data: paths };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── WorktreePool ──────────────────────────────────────────────

export class WorktreePool {
  private pi: ExtensionAPI;
  private state: WorktreePoolState;

  constructor(pi: ExtensionAPI, repoRoot: string, baseBranch: string) {
    this.pi = pi;
    this.state = {
      repoRoot,
      baseBranch,
      worktrees: [],
    };
  }

  /** Restore from persisted state. */
  static fromState(pi: ExtensionAPI, state: WorktreePoolState): WorktreePool {
    const pool = new WorktreePool(pi, state.repoRoot, state.baseBranch);
    pool.state = state;
    return pool;
  }

  /** Get serializable state for persistence. */
  getState(): WorktreePoolState {
    return {
      ...this.state,
      worktrees: this.state.worktrees.map((w) => ({ ...w })),
    };
  }

  /** Create and acquire a worktree for a step. Returns the worktree cwd. */
  async acquire(stepIndex: number): Promise<WorktreeResult<string>> {
    // Check if already exists
    const existing = this.state.worktrees.find(
      (w) => w.stepIndex === stepIndex
    );
    if (existing) {
      return { ok: true, data: existing.path };
    }

    const path = worktreePath(this.state.repoRoot, stepIndex);
    const branch = worktreeBranch(this.state.baseBranch, stepIndex);

    const result = await createWorktree(
      this.pi,
      this.state.repoRoot,
      branch,
      path
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const info: WorktreeInfo = { path, branch, stepIndex };
    this.state.worktrees.push(info);
    return { ok: true, data: path };
  }

  /** Release (remove) a worktree for a step. */
  async release(stepIndex: number): Promise<WorktreeResult> {
    const idx = this.state.worktrees.findIndex(
      (w) => w.stepIndex === stepIndex
    );
    if (idx < 0) {
      return { ok: true }; // nothing to release
    }

    const info = this.state.worktrees[idx];
    const result = await removeWorktree(
      this.pi,
      this.state.repoRoot,
      info.path
    );

    // Also delete the branch
    await this.pi.exec("git", ["branch", "-D", info.branch], {
      timeout: 5000,
      cwd: this.state.repoRoot,
    }).catch(() => {});

    this.state.worktrees.splice(idx, 1);
    return result;
  }

  /** Get the worktree path for a step, if it exists. */
  getPath(stepIndex: number): string | undefined {
    return this.state.worktrees.find((w) => w.stepIndex === stepIndex)?.path;
  }

  /** Get the branch name for a step's worktree. */
  getBranch(stepIndex: number): string | undefined {
    return this.state.worktrees.find((w) => w.stepIndex === stepIndex)?.branch;
  }

  /** Get all active worktree infos. */
  getAll(): ReadonlyArray<WorktreeInfo> {
    return this.state.worktrees;
  }

  /** Clean up all worktrees. */
  async cleanup(): Promise<void> {
    const indices = this.state.worktrees.map((w) => w.stepIndex);
    for (const idx of indices) {
      await this.release(idx);
    }
    // Prune any stale entries
    await this.pi.exec("git", ["worktree", "prune"], {
      timeout: 5000,
      cwd: this.state.repoRoot,
    }).catch(() => {});
  }
}
