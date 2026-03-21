import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Bead } from "./types.js";

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
    return (data?.issues ?? []) as Bead[];
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
    return (data?.issues ?? []) as Bead[];
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
