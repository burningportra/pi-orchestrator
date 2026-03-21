import type { PlanStep } from "./types.js";

/**
 * Minimal exec function signature — avoids depending on the full ExtensionAPI.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string }
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const AGENT_MAIL_URL = "http://127.0.0.1:8765";

/**
 * Call an agent-mail MCP tool via its JSON-RPC HTTP endpoint.
 * Used by the orchestrator itself (not sub-agents) to manage projects/reservations.
 */
export async function agentMailRPC(
  exec: ExecFn,
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const result = await exec("curl", [
    "-s", "-X", "POST", `${AGENT_MAIL_URL}/api`,
    "-H", "Content-Type: application/json",
    "-d", body,
    "--max-time", "5",
  ], { timeout: 8000 });
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.result?.structuredContent ?? parsed?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure project exists in agent-mail. Called once during orch_profile.
 */
export async function ensureAgentMailProject(exec: ExecFn, cwd: string): Promise<void> {
  await agentMailRPC(exec, "ensure_project", { human_key: cwd });
}

/**
 * Build a JSON-RPC curl command string for agent-mail.
 */
export function amRpcCmd(tool: string, args: Record<string, unknown>): string {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  return `curl -s -X POST ${AGENT_MAIL_URL}/api -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
}

/**
 * Generates an agent-mail bootstrap preamble for a parallel sub-agent's task.
 * Uses curl commands against the JSON-RPC HTTP endpoint (pi has no MCP).
 *
 * macro_start_session handles registration + file reservations in one call.
 * The agent parses its auto-assigned name from the response for subsequent calls.
 */
export function agentMailTaskPreamble(
  cwd: string,
  _agentName: string,
  stepDesc: string,
  artifacts: string[],
  threadId: string
): string {
  const safeDesc = stepDesc.replace(/"/g, '\\"').replace(/`/g, '\\`');

  const startSessionCmd = amRpcCmd("macro_start_session", {
    human_key: cwd, program: "pi-subagent", model: "auto",
    task_description: safeDesc,
    file_reservation_paths: artifacts,
    inbox_limit: 5,
  });

  return `## Agent Mail Coordination
You are coordinating with other parallel agents via agent-mail (HTTP at ${AGENT_MAIL_URL}).
Run these bash commands. **This is required, not optional.**

**1. Bootstrap session + reserve files (run FIRST, before any work):**
\`\`\`bash
${startSessionCmd}
\`\`\`
This registers you, reserves your files, and fetches your inbox in one call.
Parse the JSON response: your agent name is at \`result.structuredContent.agent.name\` (e.g. "VioletLantern").
Save it in a variable — you need it for the remaining calls. Example:
\`\`\`bash
export MY_AGENT_NAME="<name from response>"
\`\`\`

**2. Announce start** (use your actual agent name):
\`\`\`bash
${amRpcCmd("send_message", {
    project_key: cwd, sender_name: "YOUR_AGENT_NAME", to: ["all"],
    subject: `[${threadId}] Starting: ${safeDesc.slice(0, 60)}`,
    body_md: `Working on: ${safeDesc}\\nFiles: ${artifacts.join(", ")}`,
    thread_id: threadId,
  })}
\`\`\`

**3. When DONE — send summary + release** (replace YOUR_AGENT_NAME and YOUR_SUMMARY):
\`\`\`bash
${amRpcCmd("send_message", {
    project_key: cwd, sender_name: "YOUR_AGENT_NAME", to: ["all"],
    subject: `[${threadId}] Done`,
    body_md: "YOUR_SUMMARY_HERE",
    thread_id: threadId,
  })}
${amRpcCmd("release_file_reservations", {
    project_key: cwd, agent_name: "YOUR_AGENT_NAME",
  })}
\`\`\`

`;
}

/**
 * Check whether all steps in a parallel group have disjoint artifact sets.
 * If true, agents can safely work in the same directory with file reservations.
 */
export function groupArtifactsAreDisjoint(group: number[], steps: PlanStep[]): boolean {
  const seen = new Set<string>();
  for (const idx of group) {
    const step = steps.find((s) => s.index === idx);
    if (!step) return false;
    for (const artifact of step.artifacts) {
      if (seen.has(artifact)) return false;
      seen.add(artifact);
    }
  }
  return true;
}
