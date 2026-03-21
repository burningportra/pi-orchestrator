import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Bead, BvInsights, BvNextPick } from "./types.js";

// ─── bv (beads-viewer) Integration ────────────────────────────

let _bvAvailable: boolean | null = null;

/**
 * Detects whether the `bv` CLI is available. Result is cached.
 */
export async function detectBv(pi: ExtensionAPI): Promise<boolean> {
  if (_bvAvailable !== null) return _bvAvailable;
  try {
    const result = await pi.exec("which", ["bv"], { timeout: 5000 });
    _bvAvailable = result.stdout.trim().length > 0;
  } catch {
    _bvAvailable = false;
  }
  return _bvAvailable;
}

/** Reset bv detection cache (for testing). */
export function resetBvCache(): void {
  _bvAvailable = null;
}

/**
 * Runs `bv --robot-insights` and returns typed graph health data.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export async function bvInsights(
  pi: ExtensionAPI,
  cwd: string
): Promise<BvInsights | null> {
  if (!(await detectBv(pi))) return null;
  try {
    const result = await pi.exec("bv", ["--robot-insights"], { timeout: 15000, cwd });
    return JSON.parse(result.stdout) as BvInsights;
  } catch {
    return null;
  }
}

/**
 * Runs `bv --robot-next` and returns the optimal next bead pick.
 * Returns null if bv is unavailable, no actionable items, or parse error.
 */
export async function bvNext(
  pi: ExtensionAPI,
  cwd: string
): Promise<BvNextPick | null> {
  if (!(await detectBv(pi))) return null;
  try {
    const result = await pi.exec("bv", ["--robot-next"], { timeout: 15000, cwd });
    const stdout = result.stdout.trim();
    if (!stdout) return null;
    const data = JSON.parse(stdout);
    // bv --robot-next may return an object or null/empty
    if (!data || !data.id) return null;
    return data as BvNextPick;
  } catch {
    return null;
  }
}

// ─── Beads Integration ────────────────────────────────────────

/**
 * Reads all beads via `br list --json`.
 */
export async function readBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<Bead[]> {
  try {
    const result = await pi.exec("br", ["list", "--json"], { timeout: 10000, cwd });
    const data = JSON.parse(result.stdout);
    return (Array.isArray(data) ? data : data?.issues ?? []) as Bead[];
  } catch {
    return [];
  }
}

/**
 * Reads ready beads (unblocked) via `br ready --json`.
 */
export async function readyBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<Bead[]> {
  try {
    const result = await pi.exec("br", ["ready", "--json"], { timeout: 10000, cwd });
    const stdout = result.stdout.trim();
    if (!stdout) return [];
    const data = JSON.parse(stdout);
    // br ready --json returns a bare array, br list --json returns {issues: [...]}
    return (Array.isArray(data) ? data : data?.issues ?? []) as Bead[];
  } catch {
    return [];
  }
}

/**
 * Gets a single bead by ID via `br show <id> --json`.
 */
export async function getBeadById(
  pi: ExtensionAPI,
  cwd: string,
  id: string
): Promise<Bead | null> {
  try {
    const result = await pi.exec("br", ["show", id, "--json"], { timeout: 10000, cwd });
    const data = JSON.parse(result.stdout);
    return (data as Bead) ?? null;
  } catch {
    return null;
  }
}

/**
 * Lists dependency IDs for a bead via `br dep list <id>`.
 */
export async function beadDeps(
  pi: ExtensionAPI,
  cwd: string,
  id: string
): Promise<string[]> {
  try {
    const result = await pi.exec("br", ["dep", "list", id], { timeout: 10000, cwd });
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    // Each line typically contains a bead ID; extract first token
    return lines.map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extracts artifact file paths from a bead's description.
 * Looks for a '### Files:' section or lines starting with '- src/', '- lib/', etc.
 */
export function extractArtifacts(bead: Bead): string[] {
  const desc = bead.description ?? "";
  const paths: string[] = [];

  // Match lines like "- src/foo.ts" or "- lib/bar.js"
  const linePattern = /^[-*]\s+((?:src|lib|test|tests|dist|docs)\/\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(desc)) !== null) {
    paths.push(match[1]);
  }

  // Also check for a ### Files: section with indented paths
  const filesSection = desc.match(/###\s*Files:\s*\n([\s\S]*?)(?:\n###|\n\n|$)/);
  if (filesSection) {
    const sectionLines = filesSection[1].split("\n");
    for (const line of sectionLines) {
      const trimmed = line.replace(/^[-*\s]+/, "").trim();
      if (trimmed && /^[\w./]/.test(trimmed) && trimmed.includes("/")) {
        if (!paths.includes(trimmed)) paths.push(trimmed);
      }
    }
  }

  return paths;
}

/**
 * Updates the status of a bead.
 */
export async function updateBeadStatus(
  pi: ExtensionAPI,
  cwd: string,
  beadId: string,
  status: "in_progress" | "closed" | "deferred"
): Promise<void> {
  try {
    await pi.exec("br", ["update", beadId, "--status", status], {
      timeout: 10000,
      cwd,
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Syncs beads to disk.
 */
export async function syncBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<void> {
  try {
    await pi.exec("br", ["sync", "--flush-only"], { timeout: 10000, cwd });
  } catch {
    // Non-fatal
  }
}

/**
 * Validates beads — checks for dependency cycles, orphaned open beads, and graph health.
 * When bv is available, uses graph-theoretic analysis for richer validation.
 */
export async function validateBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<{ ok: boolean; orphaned: string[]; cycles: boolean; warnings: string[] }> {
  let cycles = false;
  let orphaned: string[] = [];
  const warnings: string[] = [];

  // Try bv insights first for richer analysis
  const insights = await bvInsights(pi, cwd);

  if (insights) {
    // Use bv data for cycles and orphans
    cycles = insights.Cycles !== null && insights.Cycles.length > 0;
    orphaned = insights.Orphans ?? [];

    // Add warnings for bottlenecks
    for (const b of insights.Bottlenecks ?? []) {
      if (b.Value > 5) {
        warnings.push(`bead ${b.ID} is a bottleneck (betweenness=${b.Value.toFixed(1)}) — consider splitting`);
      }
    }

    // Add warnings for articulation points
    for (const id of insights.Articulation ?? []) {
      warnings.push(`bead ${id} is a single point of failure in the dep graph`);
    }
  } else {
    // Fallback: manual cycle/orphan detection
    try {
      const cycleResult = await pi.exec("br", ["dep", "cycles"], { timeout: 10000, cwd });
      if (cycleResult.stdout.toLowerCase().includes("cycle")) {
        cycles = true;
      }
    } catch {
      // Non-fatal
    }

    try {
      const allBeads = await readBeads(pi, cwd);
      const openBeads = allBeads.filter((b) => b.status === "open");
      if (openBeads.length > 1) {
        const hasDeps = new Set<string>();
        const isDependedOn = new Set<string>();
        for (const bead of openBeads) {
          const deps = await beadDeps(pi, cwd, bead.id);
          if (deps.length > 0) {
            hasDeps.add(bead.id);
            for (const dep of deps) isDependedOn.add(dep);
          }
        }
        for (const bead of openBeads) {
          if (!hasDeps.has(bead.id) && !isDependedOn.has(bead.id)) {
            orphaned.push(bead.id);
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return { ok: !cycles && orphaned.length === 0, orphaned, cycles, warnings };
}

/**
 * Returns a human-readable summary of bead states.
 */
export function getBeadsSummary(beads: Bead[]): string {
  if (beads.length === 0) return "no beads tracked";

  let closed = 0;
  let inProgress = 0;
  let open = 0;
  let deferred = 0;

  for (const bead of beads) {
    const status = bead.status ?? "open";
    if (status === "closed") closed++;
    else if (status === "in_progress") inProgress++;
    else if (status === "deferred") deferred++;
    else open++;
  }

  const parts: string[] = [];
  if (closed > 0) parts.push(`${closed} closed ✅`);
  if (inProgress > 0) parts.push(`${inProgress} in-progress 🔄`);
  if (open > 0) parts.push(`${open} open ⏳`);
  if (deferred > 0) parts.push(`${deferred} deferred ⏸️`);
  return parts.join(", ") || "unknown";
}
