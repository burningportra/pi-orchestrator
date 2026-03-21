import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { join } from "path";

// ─── Types ─────────────────────────────────────────────────────

export interface CoordinationBackend {
  /** br CLI installed AND .beads/ initialized in project */
  beads: boolean;
  /** Agent-mail MCP server reachable */
  agentMail: boolean;
  /** Sophia CLI installed AND SOPHIA.yaml present */
  sophia: boolean;
}

/**
 * Coordination strategy derived from available backends.
 *
 * - "beads+agentmail": full coordination — beads for task lifecycle, agent-mail for messaging + file reservations
 * - "sophia": legacy — sophia CR/task lifecycle, worktrees for isolation
 * - "worktrees": bare — worktree isolation only, no task tracking or messaging
 */
export type CoordinationStrategy =
  | "beads+agentmail"
  | "sophia"
  | "worktrees";

export function selectStrategy(backend: CoordinationBackend): CoordinationStrategy {
  if (backend.beads && backend.agentMail) return "beads+agentmail";
  if (backend.sophia) return "sophia";
  return "worktrees";
}

// ─── Detection ─────────────────────────────────────────────────

let _cached: CoordinationBackend | null = null;

/**
 * Detect all available coordination backends. Cached after first call.
 * Call `resetDetection()` to force re-detect (e.g. after install).
 */
export async function detectCoordinationBackend(
  pi: ExtensionAPI,
  cwd: string
): Promise<CoordinationBackend> {
  if (_cached) return _cached;

  const [beads, agentMail, sophia] = await Promise.all([
    detectBeads(pi, cwd),
    detectAgentMail(pi),
    detectSophia(pi, cwd),
  ]);

  _cached = { beads, agentMail, sophia };
  return _cached;
}

export function resetDetection(): void {
  _cached = null;
}

export function getCachedBackend(): CoordinationBackend | null {
  return _cached;
}

// ─── Individual detectors ──────────────────────────────────────

async function detectBeads(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  // Check br CLI is installed
  try {
    const result = await pi.exec("br", ["--help"], { timeout: 3000, cwd });
    if (result.code !== 0) return false;
  } catch {
    return false;
  }

  // Check .beads/ directory exists (initialized)
  return existsSync(join(cwd, ".beads"));
}

async function detectAgentMail(pi: ExtensionAPI): Promise<boolean> {
  // Check if agent-mail HTTP server is reachable
  try {
    const result = await pi.exec("curl", [
      "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "--max-time", "2",
      "http://127.0.0.1:8765/",
    ], { timeout: 5000 });
    const code = parseInt(result.stdout.trim(), 10);
    return code >= 200 && code < 500;
  } catch {
    return false;
  }
}

async function detectSophia(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  // CLI available
  try {
    const result = await pi.exec("sophia", ["--help"], { timeout: 3000, cwd });
    if (result.code !== 0) return false;
  } catch {
    return false;
  }

  // SOPHIA.yaml present (initialized)
  if (!existsSync(join(cwd, "SOPHIA.yaml"))) return false;

  // Can list CRs (fully functional)
  try {
    const result = await pi.exec("sophia", ["cr", "list", "--json"], { timeout: 3000, cwd });
    const parsed = JSON.parse(result.stdout);
    return parsed.ok === true;
  } catch {
    return false;
  }
}
