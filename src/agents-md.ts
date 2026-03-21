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

## Integrating with Beads (dependency-aware task planning)

Beads provides a lightweight, dependency-aware issue database and a CLI (\`br\`) for selecting "ready work," setting priorities, and tracking status. It complements MCP Agent Mail's messaging, audit trail, and file-reservation signals. Project: [steveyegge/beads](https://github.com/steveyegge/beads)

Recommended conventions
- **Single source of truth**: Use **Beads** for task status/priority/dependencies; use **Agent Mail** for conversation, decisions, and attachments (audit).
- **Shared identifiers**: Use the Beads issue id (e.g., \`bd-123\`) as the Mail \`thread_id\` and prefix message subjects with \`[bd-123]\`.
- **Reservations**: When starting a \`bd-###\` task, call \`file_reservation_paths(...)\` for the affected paths; include the issue id in the \`reason\` and release on completion.

Typical flow (agents)
1) **Pick ready work** (Beads)
   - \`br ready --json\` → choose one item (highest priority, no blockers)
2) **Reserve edit surface** (Mail)
   - \`file_reservation_paths(project_key, agent_name, ["src/**"], ttl_seconds=3600, exclusive=true, reason="bd-123")\`
3) **Announce start** (Mail)
   - \`send_message(..., thread_id="bd-123", subject="[bd-123] Start: <short title>", ack_required=true)\`
4) **Work and update**
   - Reply in-thread with progress and attach artifacts/images; keep the discussion in one thread per issue id
5) **Complete and release**
   - \`br close bd-123 --reason "Completed"\` (Beads is status authority)
   - \`release_file_reservations(project_key, agent_name, paths=["src/**"])\`
   - Final Mail reply: \`[bd-123] Completed\` with summary and links

Mapping cheat-sheet
- **Mail \`thread_id\`** ↔ \`bd-###\`
- **Mail subject**: \`[bd-###] …\`
- **File reservation \`reason\`**: \`bd-###\`
- **Commit messages (optional)**: include \`bd-###\` for traceability

Event mirroring (optional automation)
- On \`br update --status blocked\`, send a high-importance Mail message in thread \`bd-###\` describing the blocker.
- On Mail "ACK overdue" for a critical decision, add a Beads label (e.g., \`needs-ack\`) or bump priority to surface it in \`br ready\`.

Pitfalls to avoid
- Don't create or manage tasks in Mail; treat Beads as the single task queue.
- Always include \`bd-###\` in message \`thread_id\` to avoid ID drift across tools.
`;

const CASS_MEMORY_SECTION = `
## Memory System: cass-memory

The Cass Memory System (cm) is a tool for giving agents an effective memory based on the ability to quickly search across previous coding agent sessions across an array of different coding agent tools (e.g., Claude Code, Codex, Gemini-CLI, Cursor, etc) and projects (and even across multiple machines, optionally) and then reflect on what they find and learn in new sessions to draw out useful lessons and takeaways; these lessons are then stored and can be queried and retrieved later, much like how human memory works.

The \`cm onboard\` command guides you through analyzing historical sessions and extracting valuable rules.

### Quick Start

\`\`\`bash
# 1. Check status and see recommendations
cm onboard status

# 2. Get sessions to analyze (filtered by gaps in your playbook)
cm onboard sample --fill-gaps

# 3. Read a session with rich context
cm onboard read /path/to/session.jsonl --template

# 4. Add extracted rules (one at a time or batch)
cm playbook add "Your rule content" --category "debugging"
# Or batch add:
cm playbook add --file rules.json

# 5. Mark session as processed
cm onboard mark-done /path/to/session.jsonl
\`\`\`
`;

const SECTION_MARKER = "## MCP Agent Mail";
const CASS_SECTION_MARKER = "## Memory System: cass-memory";

const DEFAULT_HEADER = `# AGENTS.md

This file provides guidance for AI coding agents working in this repository.

`;

export async function ensureAgentMailSection(cwd: string): Promise<void> {
  const agentsMdPath = join(cwd, "AGENTS.md");

  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, DEFAULT_HEADER + AGENT_MAIL_SECTION.trimStart() + "\n" + CASS_MEMORY_SECTION.trimStart(), "utf-8");
    return;
  }

  let content = readFileSync(agentsMdPath, "utf-8");

  if (!content.includes(SECTION_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + AGENT_MAIL_SECTION.trimStart(), "utf-8");
    content += "\n" + AGENT_MAIL_SECTION.trimStart();
  }

  if (!content.includes(CASS_SECTION_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + CASS_MEMORY_SECTION.trimStart(), "utf-8");
  }
}
