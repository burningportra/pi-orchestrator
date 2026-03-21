import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

const AGENT_MAIL_SECTION = `
## MCP Agent Mail: coordination for multi-agent workflows

What it is
- A mail-like layer that lets coding agents coordinate asynchronously via MCP tools and resources.
- Provides identities, inbox/outbox, searchable threads, and advisory file reservations, with human-auditable artifacts in Git.

Why it's useful
- Prevents agents from stepping on each other with explicit file reservations (leases) for files/globs.
- Keeps communication out of your token budget by storing messages in a per-project archive.
- Offers quick reads (\`resource://inbox/...\`, \`resource://thread/...\`) and macros that bundle common flows.

How to use effectively
1) Same repository
   - Register an identity: call \`ensure_project\`, then \`register_agent\` using this repo's absolute path as \`project_key\`.
   - Reserve files before you edit: \`file_reservation_paths(project_key, agent_name, ["src/**"], ttl_seconds=3600, exclusive=true)\` to signal intent and avoid conflict.
   - Communicate with threads: use \`send_message(..., thread_id="FEAT-123")\`; check inbox with \`fetch_inbox\` and acknowledge with \`acknowledge_message\`.
   - Read fast: \`resource://inbox/{Agent}?project=<abs-path>&limit=20\` or \`resource://thread/{id}?project=<abs-path>&include_bodies=true\`.
   - Tip: set \`AGENT_NAME\` in your environment so the pre-commit guard can block commits that conflict with others' active exclusive file reservations.

2) Across different repos in one project
   - Option A (single project bus): register both sides under the same \`project_key\`. Keep reservation patterns specific (e.g., \`frontend/**\` vs \`backend/**\`).
   - Option B (separate projects): each repo has its own \`project_key\`; use \`macro_contact_handshake\` or \`request_contact\`/\`respond_contact\` to link agents, then message directly.

Macros vs granular tools
- Prefer macros when you want speed: \`macro_start_session\`, \`macro_prepare_thread\`, \`macro_file_reservation_cycle\`, \`macro_contact_handshake\`.
- Use granular tools when you need control: \`register_agent\`, \`file_reservation_paths\`, \`send_message\`, \`fetch_inbox\`, \`acknowledge_message\`.

Common pitfalls
- "from_agent not registered": always \`register_agent\` in the correct \`project_key\` first.
- "FILE_RESERVATION_CONFLICT": adjust patterns, wait for expiry, or use a non-exclusive reservation.
`;

const SECTION_MARKER = "## MCP Agent Mail";

const DEFAULT_HEADER = `# AGENTS.md

This file provides guidance for AI coding agents working in this repository.

`;

export async function ensureAgentMailSection(cwd: string): Promise<void> {
  const agentsMdPath = join(cwd, "AGENTS.md");

  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, DEFAULT_HEADER + AGENT_MAIL_SECTION.trimStart(), "utf-8");
    return;
  }

  const content = readFileSync(agentsMdPath, "utf-8");
  if (content.includes(SECTION_MARKER)) {
    // Already has the section — idempotent
    return;
  }

  // Append the section
  appendFileSync(agentsMdPath, "\n" + AGENT_MAIL_SECTION.trimStart(), "utf-8");
}
