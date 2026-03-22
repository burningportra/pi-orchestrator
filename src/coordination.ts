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

async function isAgentMailReachable(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("curl", [
      "-s", "--max-time", "2",
      "http://127.0.0.1:8765/health/liveness",
    ], { timeout: 5000 });
    try {
      const parsed = JSON.parse(result.stdout.trim());
      return parsed?.status === "ok" || parsed?.status === "healthy";
    } catch {
      return result.code === 0 && result.stdout.length > 0;
    }
  } catch {
    return false;
  }
}

async function detectAgentMail(pi: ExtensionAPI): Promise<boolean> {
  // Check if already running
  if (await isAgentMailReachable(pi)) return true;

  // Not running — check if installed and try to start it
  try {
    const whichResult = await pi.exec("uv", ["run", "python", "-c", "import mcp_agent_mail"], { timeout: 5000 });
    if (whichResult.code !== 0) return false; // not installed
  } catch {
    return false;
  }

  // Installed but not running — start in background
  try {
    await pi.exec("bash", ["-c",
      "nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &"
    ], { timeout: 5000 });

    // Wait up to 5 seconds for it to become reachable
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isAgentMailReachable(pi)) return true;
    }
  } catch {
    // Failed to start — fall through
  }

  return false;
}

// ─── UBS Detection ─────────────────────────────────────────────

let _ubsAvailable: boolean | null = null;

/**
 * Detects whether the `ubs` CLI is available. Result is cached.
 */
export async function detectUbs(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  if (_ubsAvailable !== null) return _ubsAvailable;
  try {
    const result = await pi.exec("ubs", ["--help"], { timeout: 3000, cwd });
    _ubsAvailable = result.code === 0;
  } catch {
    _ubsAvailable = false;
  }
  return _ubsAvailable;
}

/** Reset UBS detection cache (for testing). */
export function resetUbsCache(): void {
  _ubsAvailable = null;
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
