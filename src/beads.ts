import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PlanStep } from "./types.js";

// ─── Beads Integration ────────────────────────────────────────

/**
 * Creates beads for each plan step and sets up dependency edges.
 * Returns a map of stepIndex → beadId.
 */
export async function createBeadsFromPlan(
  pi: ExtensionAPI,
  cwd: string,
  steps: PlanStep[]
): Promise<Record<number, string>> {
  const beadIds: Record<number, string> = {};

  // Create a bead for each step
  for (const step of steps) {
    const acText = step.acceptanceCriteria.length > 0
      ? step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
      : "See plan step description.";
    const description = `Acceptance criteria:\n${acText}`;
    const title = `Step ${step.index}: ${step.description}`;

    try {
      const result = await pi.exec("br", [
        "create", title,
        "-t", "feature",
        "-p", "1",
        "--description", description,
      ], { timeout: 10000, cwd });

      // Parse bead ID from output: "✓ Created <id>: <title>"
      const match = result.stdout.match(/Created\s+([^\s:]+)/);
      if (match) {
        beadIds[step.index] = match[1];
      }
    } catch {
      // Non-fatal: skip this bead
    }
  }

  // Add dependency edges
  for (const step of steps) {
    if (!step.dependsOn || step.dependsOn.length === 0) continue;
    const childBeadId = beadIds[step.index];
    if (!childBeadId) continue;

    for (const parentStepIndex of step.dependsOn) {
      const parentBeadId = beadIds[parentStepIndex];
      if (!parentBeadId) continue;
      try {
        await pi.exec("br", ["dep", "add", childBeadId, parentBeadId], {
          timeout: 10000,
          cwd,
        });
      } catch {
        // Non-fatal: skip this dependency
      }
    }
  }

  // Persist
  await syncBeads(pi, cwd);

  return beadIds;
}

/**
 * Updates the status of a bead.
 */
export async function updateBeadStatus(
  pi: ExtensionAPI,
  cwd: string,
  beadId: string,
  status: "in_progress" | "closed"
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
 * Validates beads — checks for dependency cycles and orphaned open beads.
 */
export async function validateBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<{ ok: boolean; orphaned: string[]; cycles: boolean }> {
  let cycles = false;
  const orphaned: string[] = [];

  try {
    const cycleResult = await pi.exec("br", ["dep", "cycles"], { timeout: 10000, cwd });
    // If output contains cycle info, mark as detected
    if (cycleResult.stdout.toLowerCase().includes("cycle")) {
      cycles = true;
    }
  } catch {
    // Non-fatal
  }

  return { ok: !cycles && orphaned.length === 0, orphaned, cycles };
}

/**
 * Returns a human-readable summary of bead states.
 */
export async function getBeadsSummary(
  pi: ExtensionAPI,
  cwd: string,
  beadIds: Record<number, string>
): Promise<string> {
  const ids = Object.values(beadIds);
  if (ids.length === 0) return "no beads tracked";

  let closed = 0;
  let inProgress = 0;
  let open = 0;

  for (const beadId of ids) {
    try {
      const result = await pi.exec("br", ["get", beadId, "--json"], { timeout: 10000, cwd });
      const data = JSON.parse(result.stdout);
      const status = data?.status ?? "open";
      if (status === "closed") closed++;
      else if (status === "in_progress") inProgress++;
      else open++;
    } catch {
      open++;
    }
  }

  const parts: string[] = [];
  if (closed > 0) parts.push(`${closed} closed ✅`);
  if (inProgress > 0) parts.push(`${inProgress} in-progress 🔄`);
  if (open > 0) parts.push(`${open} open ⏳`);
  return parts.join(", ") || "unknown";
}
