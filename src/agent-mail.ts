/**
 * Minimal exec function signature — avoids depending on the full ExtensionAPI.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string }
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const AGENT_MAIL_URL = "http://127.0.0.1:8765";

export interface AgentMailReservation {
  id?: number | string;
  agent_name?: string;
  path_pattern?: string;
  path?: string;
  exclusive?: boolean;
  active?: boolean;
  expires_at?: string;
  [key: string]: unknown;
}

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
 * Read an agent-mail MCP resource via the same JSON-RPC HTTP endpoint.
 */
export async function agentMailReadResource(exec: ExecFn, uri: string): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "resources/read",
    params: { uri },
  });
  const result = await exec("curl", [
    "-s", "-X", "POST", `${AGENT_MAIL_URL}/api`,
    "-H", "Content-Type: application/json",
    "-d", body,
    "--max-time", "5",
  ], { timeout: 8000 });

  try {
    const parsed = JSON.parse(result.stdout);
    const content = parsed?.result?.contents?.[0]?.text;
    if (typeof content === "string") {
      return JSON.parse(content);
    }
    return parsed?.result?.contents ?? parsed?.result ?? null;
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

async function getAgentMailProjectSlug(exec: ExecFn, cwd: string): Promise<string | null> {
  const project = await agentMailRPC(exec, "ensure_project", { human_key: cwd });
  const slug = project?.project?.slug ?? project?.slug;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

function matchesReservationPath(file: string, reservation: AgentMailReservation): boolean {
  const rawPattern = reservation.path_pattern ?? reservation.path;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) return false;
  const normalized = rawPattern.replace(/^\.\//, "");
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (normalized.includes("*")) {
    const escaped = normalized
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(file);
  }
  return file === normalized;
}

function normalizeReservations(payload: any): AgentMailReservation[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.reservations)) return payload.reservations;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

/**
 * Reserve files for an agent before launch/hand-off.
 */
export async function reserveFileReservations(
  exec: ExecFn,
  cwd: string,
  agentName: string,
  files: string[],
  reason?: string
): Promise<any> {
  return agentMailRPC(exec, "file_reservation_paths", {
    project_key: cwd,
    agent_name: agentName,
    paths: files,
    ttl_seconds: 3600,
    exclusive: true,
    ...(reason ? { reason } : {}),
  });
}

/**
 * Release file reservations for an agent during cleanup.
 */
export async function releaseFileReservations(
  exec: ExecFn,
  cwd: string,
  agentName: string,
  files?: string[]
): Promise<any> {
  return agentMailRPC(exec, "release_file_reservations", {
    project_key: cwd,
    agent_name: agentName,
    ...(files && files.length > 0 ? { paths: files } : {}),
  });
}

/**
 * Check whether any requested files are already reserved by another agent.
 */
export async function checkFileReservations(
  exec: ExecFn,
  cwd: string,
  files: string[],
  agentName?: string
): Promise<AgentMailReservation[]> {
  if (files.length === 0) return [];

  const slug = await getAgentMailProjectSlug(exec, cwd);
  if (!slug) return [];

  const resource = await agentMailReadResource(exec, `resource://file_reservations/${slug}?active_only=true`);
  const reservations = normalizeReservations(resource);

  return reservations.filter((reservation) => {
    if (reservation.active === false) return false;
    if (agentName && reservation.agent_name === agentName) return false;
    return files.some((file) => matchesReservationPath(file, reservation));
  });
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
 * Build a bash helper script that wraps agent-mail calls.
 * Sub-agents source this to get am_send, am_inbox, am_release functions
 * with their agent name and project key baked in — no manual substitution needed.
 */
function amHelperScript(cwd: string, threadId: string): string {
  return `
# ── Agent Mail helper functions (source these) ──────────────
AM_URL="${AGENT_MAIL_URL}"
AM_PROJECT="${cwd}"
AM_THREAD="${threadId}"

am_rpc() {
  local tool="$1" args="$2"
  curl -s -X POST "$AM_URL/api" \
    -H 'Content-Type: application/json' \
    -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"$tool\\",\\"arguments\\":$args}}"
}

am_send() {
  local subject="$1" body="$2"
  am_rpc "send_message" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"sender_name\\":\\"$AM_AGENT_NAME\\",\\"to\\":[],\\"broadcast\\":true,\\"subject\\":\\"$subject\\",\\"body_md\\":\\"$body\\",\\"thread_id\\":\\"$AM_THREAD\\"}"
}

am_inbox() {
  am_rpc "fetch_inbox" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\",\\"limit\\":10,\\"include_bodies\\":true}"
}

am_release() {
  am_rpc "release_file_reservations" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\"}"
}
`.trim();
}

/**
 * Generates an agent-mail bootstrap preamble for a parallel sub-agent's task.
 * Uses a bash helper script approach — sub-agents get am_send/am_inbox/am_release
 * functions with correct field names baked in. No manual JSON construction needed.
 */
export function agentMailTaskPreamble(
  cwd: string,
  _agentName: string,
  stepDesc: string,
  artifacts: string[],
  threadId: string
): string {
  const safeDesc = stepDesc.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\n/g, '\\n');

  const startSessionCmd = amRpcCmd("macro_start_session", {
    human_key: cwd, program: "pi-subagent", model: "auto",
    task_description: safeDesc,
    file_reservation_paths: artifacts,
    inbox_limit: 5,
  });

  const helperScript = amHelperScript(cwd, threadId);

  return `## Agent Mail Coordination — MANDATORY
You are coordinating with other parallel agents via agent-mail.
You MUST follow ALL steps below. Do NOT skip any.

### Step 1: Bootstrap (run FIRST, before ANY work)
\`\`\`bash
BOOTSTRAP_RESULT=$(${startSessionCmd})
echo "$BOOTSTRAP_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result']['structuredContent']['agent']['name'])" 2>/dev/null
\`\`\`
Copy the agent name from the output (e.g. "VioletLantern") and set it:
\`\`\`bash
export AM_AGENT_NAME="<paste your agent name here>"
\`\`\`

### Step 2: Set up helper functions
\`\`\`bash
${helperScript}
\`\`\`

### Step 3: Announce start
\`\`\`bash
am_send "Starting: ${safeDesc.slice(0, 60)}" "Working on: ${safeDesc.slice(0, 100)}. Files: ${artifacts.join(", ")}"
\`\`\`

### Step 4: Check inbox (do this BEFORE starting work)
\`\`\`bash
am_inbox | python3 -c "import json,sys; d=json.load(sys.stdin); msgs=d.get('result',{}).get('structuredContent',{}).get('messages',[]); [print(f'FROM {m[\"sender_name\"]}: {m[\"subject\"]}') for m in msgs]" 2>/dev/null
\`\`\`
If there are messages from other agents, read and acknowledge them before proceeding.

### Step 5: Do your work (implement the bead)

### Step 6: Check inbox again BEFORE finishing
\`\`\`bash
am_inbox | python3 -c "import json,sys; d=json.load(sys.stdin); msgs=d.get('result',{}).get('structuredContent',{}).get('messages',[]); [print(f'FROM {m[\"sender_name\"]}: {m[\"subject\"]}\\n  {m.get(\"body_md\",\"\")[:200]}') for m in msgs]" 2>/dev/null
\`\`\`
Respond to any messages that need a response.

### Step 7: Send completion summary + release reservations
\`\`\`bash
am_send "Done: ${safeDesc.slice(0, 60)}" "YOUR_SUMMARY_HERE — replace this with what you actually did"
am_release
\`\`\`

---

`;
}
