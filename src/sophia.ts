import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PlanStep } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────

export interface SophiaResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SophiaCR {
  id: number;
  branch: string;
  title: string;
}

export interface SophiaTask {
  id: number;
  title: string;
}

export interface SophiaTaskStatus {
  id: number;
  title: string;
  status: string;
}

export interface SophiaCRStatus {
  id: number;
  branch: string;
  title: string;
  status: string;
  tasks: SophiaTaskStatus[];
}

// ─── Detection ─────────────────────────────────────────────────

let _sophiaAvailable: boolean | null = null;

export async function isSophiaAvailable(
  pi: ExtensionAPI,
  cwd: string
): Promise<boolean> {
  if (_sophiaAvailable !== null) return _sophiaAvailable;
  try {
    const result = await pi.exec("sophia", ["--help"], {
      timeout: 3000,
      cwd,
    });
    _sophiaAvailable = result.code === 0;
  } catch {
    _sophiaAvailable = false;
  }
  return _sophiaAvailable;
}

export async function isSophiaInitialized(
  pi: ExtensionAPI,
  cwd: string
): Promise<boolean> {
  try {
    const result = await pi.exec("sophia", ["cr", "list", "--json"], {
      timeout: 3000,
      cwd,
    });
    const parsed = JSON.parse(result.stdout);
    return parsed.ok === true;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

async function runSophia<T = unknown>(
  pi: ExtensionAPI,
  cwd: string,
  args: string[]
): Promise<SophiaResult<T>> {
  try {
    const result = await pi.exec("sophia", args, {
      timeout: 10000,
      cwd,
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.ok) {
      return { ok: true, data: parsed.data as T };
    }
    return {
      ok: false,
      error: parsed.error?.message ?? "Unknown sophia error",
    };
  } catch (err) {
    return {
      ok: false,
      error: `Sophia exec failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Init ──────────────────────────────────────────────────────

export async function initSophia(
  pi: ExtensionAPI,
  cwd: string
): Promise<SophiaResult> {
  return runSophia(pi, cwd, ["init"]);
}

// ─── CR Status ─────────────────────────────────────────────────

export async function getCRStatus(
  pi: ExtensionAPI,
  cwd: string,
  crId: number
): Promise<SophiaResult<SophiaCRStatus>> {
  const result = await runSophia<any>(pi, cwd, [
    "cr",
    "status",
    String(crId),
    "--json",
  ]);
  if (!result.ok || !result.data) {
    return { ok: false, error: result.error ?? "CR not found" };
  }
  const d = result.data;
  const cr = d.cr ?? d;
  const tasks: SophiaTaskStatus[] = (cr.tasks ?? d.tasks ?? []).map(
    (t: any) => ({
      id: t.id,
      title: t.title,
      status: t.status ?? "unknown",
    })
  );
  return {
    ok: true,
    data: {
      id: cr.id ?? crId,
      branch: cr.branch ?? "",
      title: cr.title ?? "",
      status: cr.status ?? "unknown",
      tasks,
    },
  };
}

// ─── CR Operations ─────────────────────────────────────────────

export async function createCR(
  pi: ExtensionAPI,
  cwd: string,
  title: string,
  description: string
): Promise<SophiaResult<SophiaCR>> {
  const result = await runSophia<any>(pi, cwd, [
    "cr",
    "add",
    title,
    "--description",
    description,
    "--switch",
  ]);
  if (result.ok && result.data?.cr) {
    return {
      ok: true,
      data: {
        id: result.data.cr.id,
        branch: result.data.cr.branch,
        title: result.data.cr.title,
      },
    };
  }
  return { ok: false, error: result.error };
}

export async function setCRContract(
  pi: ExtensionAPI,
  cwd: string,
  crId: number,
  opts: {
    why: string;
    scope: string[];
    nonGoals?: string[];
    invariants?: string[];
    testPlan?: string;
    rollbackPlan?: string;
    blastRadius?: string;
  }
): Promise<SophiaResult> {
  const args = ["cr", "contract", "set", String(crId), "--why", opts.why];
  for (const s of opts.scope) {
    args.push("--scope", s);
  }
  if (opts.nonGoals) {
    for (const ng of opts.nonGoals) args.push("--non-goal", ng);
  }
  if (opts.invariants) {
    for (const inv of opts.invariants) args.push("--invariant", inv);
  }
  if (opts.testPlan) args.push("--test-plan", opts.testPlan);
  if (opts.rollbackPlan) args.push("--rollback-plan", opts.rollbackPlan);
  if (opts.blastRadius) args.push("--blast-radius", opts.blastRadius);
  return runSophia(pi, cwd, args);
}

// ─── Task Operations ───────────────────────────────────────────

export async function addTask(
  pi: ExtensionAPI,
  cwd: string,
  crId: number,
  title: string
): Promise<SophiaResult<SophiaTask>> {
  const result = await runSophia<any>(pi, cwd, [
    "cr",
    "task",
    "add",
    String(crId),
    title,
  ]);
  if (result.ok && result.data?.task) {
    return {
      ok: true,
      data: {
        id: result.data.task.id,
        title: result.data.task.title,
      },
    };
  }
  return { ok: false, error: result.error };
}

export async function setTaskContract(
  pi: ExtensionAPI,
  cwd: string,
  crId: number,
  taskId: number,
  opts: {
    intent: string;
    acceptance: string[];
    scope: string[];
  }
): Promise<SophiaResult> {
  const args = [
    "cr",
    "task",
    "contract",
    "set",
    String(crId),
    String(taskId),
    "--intent",
    opts.intent,
  ];
  for (const a of opts.acceptance) args.push("--acceptance", a);
  for (const s of opts.scope) args.push("--scope", s);
  return runSophia(pi, cwd, args);
}

export async function checkpointTask(
  pi: ExtensionAPI,
  cwd: string,
  crId: number,
  taskId: number,
  commitType: string = "feat"
): Promise<SophiaResult> {
  return runSophia(pi, cwd, [
    "cr",
    "task",
    "done",
    String(crId),
    String(taskId),
    "--commit-type",
    commitType,
    "--from-contract",
  ]);
}

// ─── Validate & Review ─────────────────────────────────────────

export async function validateCR(
  pi: ExtensionAPI,
  cwd: string,
  crId: number
): Promise<SophiaResult> {
  return runSophia(pi, cwd, ["cr", "validate", String(crId)]);
}

export async function reviewCR(
  pi: ExtensionAPI,
  cwd: string,
  crId: number
): Promise<SophiaResult> {
  return runSophia(pi, cwd, ["cr", "review", String(crId)]);
}

// ─── Batch: Create CR + Tasks from Plan ────────────────────────

export interface PlanToCRResult {
  cr: SophiaCR;
  taskIds: Map<number, number>; // stepIndex → sophia task ID
}

/**
 * Creates a Sophia CR from a plan, with tasks and contracts for each step.
 * Returns the CR info and a mapping of plan step indices to sophia task IDs.
 */
export async function createCRFromPlan(
  pi: ExtensionAPI,
  cwd: string,
  goal: string,
  steps: PlanStep[],
  constraints: string[]
): Promise<SophiaResult<PlanToCRResult>> {
  // Create CR
  const crResult = await createCR(
    pi,
    cwd,
    goal.length > 72 ? goal.slice(0, 69) + "..." : goal,
    `Goal: ${goal}${constraints.length > 0 ? `\nConstraints: ${constraints.join(", ")}` : ""}`
  );
  if (!crResult.ok || !crResult.data) {
    return { ok: false, error: crResult.error };
  }
  const cr = crResult.data;

  // Set CR contract
  const allArtifacts = [
    ...new Set(steps.flatMap((s) => s.artifacts)),
  ];
  await setCRContract(pi, cwd, cr.id, {
    why: goal,
    scope: allArtifacts.length > 20
      ? (console.warn(`[sophia] CR scope truncated: ${allArtifacts.length} artifacts → 20 (sophia arg limit)`), allArtifacts.slice(0, 20))
      : allArtifacts,
    invariants: constraints,
    testPlan: "All acceptance criteria met per step",
    rollbackPlan: "git revert CR merge commit",
  });

  // Create tasks with contracts
  const taskIds = new Map<number, number>();
  const warnings: string[] = [];
  for (const step of steps) {
    const taskResult = await addTask(
      pi,
      cwd,
      cr.id,
      `Step ${step.index}: ${step.description}`
    );
    if (taskResult.ok && taskResult.data) {
      taskIds.set(step.index, taskResult.data.id);

      const contractResult = await setTaskContract(pi, cwd, cr.id, taskResult.data.id, {
        intent: step.description,
        acceptance: step.acceptanceCriteria,
        scope: step.artifacts,
      });
      if (!contractResult.ok) {
        warnings.push(`Step ${step.index}: task created but contract failed: ${contractResult.error}`);
      }
    } else {
      warnings.push(`Step ${step.index}: task creation failed: ${taskResult.error}`);
    }
  }

  if (taskIds.size === 0) {
    return { ok: false, error: `CR created but all ${steps.length} tasks failed: ${warnings.join("; ")}` };
  }
  if (warnings.length > 0) {
    console.warn(`[sophia] CR #${cr.id} partial: ${warnings.join("; ")}`);
  }

  return { ok: true, data: { cr, taskIds } };
}

// ─── Worktree Merge ────────────────────────────────────────────

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
  conflictFiles?: string[];
  error?: string;
}

/**
 * Merge changes from a worktree branch back to the target branch.
 * Uses --no-ff to keep a clear merge history.
 * If conflicts occur, aborts the merge and reports conflicting files.
 */
export async function mergeWorktreeChanges(
  pi: ExtensionAPI,
  cwd: string,
  sourceBranch: string,
  targetBranch: string,
  stepDescription?: string
): Promise<MergeResult> {
  try {
    // Switch to target branch
    const checkout = await pi.exec("git", ["checkout", targetBranch], {
      timeout: 10000,
      cwd,
    });
    if (checkout.code !== 0) {
      return { ok: false, conflict: false, error: `checkout failed: ${checkout.stderr.trim()}` };
    }

    // Attempt merge
    const msg = stepDescription
      ? `Merge worktree: ${stepDescription}`
      : `Merge ${sourceBranch} into ${targetBranch}`;
    const merge = await pi.exec(
      "git",
      ["merge", "--no-ff", "-m", msg, sourceBranch],
      { timeout: 30000, cwd }
    );

    if (merge.code === 0) {
      return { ok: true, conflict: false };
    }

    // Check if it's a conflict
    const status = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"], {
      timeout: 5000,
      cwd,
    });
    const conflictFiles = status.stdout.trim().split("\n").filter(Boolean);

    if (conflictFiles.length > 0) {
      // Abort the failed merge
      await pi.exec("git", ["merge", "--abort"], { timeout: 5000, cwd });
      return { ok: false, conflict: true, conflictFiles };
    }

    return { ok: false, conflict: false, error: merge.stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      conflict: false,
      error: `merge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Dependency Resolution ─────────────────────────────────────

/**
 * Resolve dependsOn for all steps. Applies implicit-sequential-default:
 * - omitted dependsOn → depends on previous step (index - 1)
 * - dependsOn: [] → independent (can parallelize)
 * - dependsOn: [1,3] → explicit deps
 *
 * Filters self-references and invalid indices.
 * Detects cycles and returns them as warnings.
 */
export function resolveDependencies(
  steps: PlanStep[]
): { resolved: Map<number, number[]>; warnings: string[] } {
  const resolved = new Map<number, number[]>();
  const warnings: string[] = [];
  const validIndices = new Set(steps.map((s) => s.index));

  for (const step of steps) {
    let deps: number[];

    if (step.dependsOn === undefined) {
      // Implicit sequential default: depend on previous step
      const prevStep = steps.find((s) => s.index === step.index - 1);
      deps = prevStep ? [prevStep.index] : [];
    } else {
      // Explicit: filter self-refs and invalid indices
      deps = step.dependsOn.filter((d) => {
        if (d === step.index) return false; // self-ref
        if (!validIndices.has(d)) return false; // invalid index
        return true;
      });
    }

    resolved.set(step.index, deps);
  }

  // Cycle detection via DFS
  const visited = new Set<number>();
  const inStack = new Set<number>();

  function dfs(node: number, path: number[]): boolean {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      warnings.push(`Cycle detected: ${cycle.join(" → ")}`);
      return true;
    }
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    for (const dep of resolved.get(node) ?? []) {
      if (dfs(dep, [...path, node])) return true;
    }

    inStack.delete(node);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.index)) {
      dfs(step.index, []);
    }
  }

  return { resolved, warnings };
}

export interface ParallelAnalysis {
  groups: number[][];
  /** Flat merge order — groups in sequence, steps within a group in index order */
  mergeOrder: number[];
}

/**
 * Group steps into parallel execution waves.
 *
 * Builds a dependency graph from two sources (merged additively):
 * 1. Explicit `dependsOn` (with implicit-sequential-default from resolveDependencies)
 * 2. Shared artifacts — if steps A and B both touch the same file and A appears
 *    earlier in the plan, B depends on A (chained by plan order).
 *
 * Returns groups of step indices that can run in parallel,
 * plus a flat merge order for applying results sequentially.
 */
export function analyzeParallelGroups(steps: PlanStep[]): ParallelAnalysis {
  // 1. Resolve explicit dependsOn (with implicit-sequential-default)
  const { resolved: resolvedDeps, warnings } = resolveDependencies(steps);
  if (warnings.length > 0) {
    console.warn("Dependency warnings:", warnings.join("; "));
  }

  // 2. Build artifact → step mapping
  const artifactToSteps = new Map<string, number[]>();
  for (const step of steps) {
    for (const artifact of step.artifacts) {
      const existing = artifactToSteps.get(artifact) ?? [];
      existing.push(step.index);
      artifactToSteps.set(artifact, existing);
    }
  }

  // 3. Build merged dependency graph: resolved dependsOn + artifact overlap
  const deps = new Map<number, Set<number>>();
  for (const step of steps) deps.set(step.index, new Set());

  // Add resolved dependsOn edges
  for (const [stepIdx, stepDeps] of resolvedDeps) {
    for (const dep of stepDeps) {
      deps.get(stepIdx)?.add(dep);
    }
  }

  // Add artifact-based edges (additive — doesn't remove dependsOn edges).
  // When multiple steps touch the same file, chain them in plan order
  // so later steps wait for earlier ones (prevents merge conflicts).
  for (const [_artifact, stepIndices] of artifactToSteps) {
    if (stepIndices.length > 1) {
      for (let i = 1; i < stepIndices.length; i++) {
        deps.get(stepIndices[i])!.add(stepIndices[i - 1]);
      }
    }
  }

  // Topological grouping: steps with no unresolved deps can run in parallel
  const groups: number[][] = [];
  const completed = new Set<number>();
  const remaining = new Set(steps.map((s) => s.index));

  while (remaining.size > 0) {
    const group: number[] = [];
    for (const idx of remaining) {
      const unresolved = [...deps.get(idx)!].filter(
        (d) => !completed.has(d)
      );
      if (unresolved.length === 0) {
        group.push(idx);
      }
    }
    if (group.length === 0) {
      // Cycle detected (resolveDependencies warns separately) or artifact
      // edges created one. Force progress by taking the lowest-index step.
      const forced = Math.min(...remaining);
      console.warn(`Dependency cycle: forcing step ${forced} to unblock`);
      group.push(forced);
    }
    groups.push(group);
    for (const idx of group) {
      completed.add(idx);
      remaining.delete(idx);
    }
  }

  // Preserve group ordering: within each group sort by index, groups in sequence
  const mergeOrder = groups.flatMap((g) => [...g].sort((a, b) => a - b));
  return { groups, mergeOrder };
}
