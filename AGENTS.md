# AGENTS.md

This file provides guidance for AI coding agents working in this repository.

## Project Context
pi-orchestrator is a pi extension (TypeScript) that provides `/orchestrate` — scan, plan, implement, review in one command. Key files:
- src/beads.ts — bead helpers (readBeads, validateBeads, template hygiene checks, etc.)
- src/bead-templates.ts — built-in bead template library
- src/tools/approve.ts — bead approval + refinement flow  
- src/tools/review.ts — per-bead review + next-bead selection
- src/prompts.ts — all prompt templates and bead-planning instructions
- src/types.ts — TypeScript interfaces, including bead template types
- src/deep-plan.ts — multi-model planning agents

## Bead template workflow

The bead template library exists to speed up planning for a few common bead shapes while keeping final beads readable by a fresh agent. Current built-in templates are:
- `add-api-endpoint`
- `refactor-module`
- `add-tests`

Templates are optional scaffolds, not required syntax. Use them only as drafting aids, then expand them into a normal self-contained bead description before creating or approving the bead.

Correct usage pattern:
- Start from a built-in template
- Fill placeholders such as `{{endpointPath}}`, `{{moduleName}}`, and `{{testFile}}`
- Create a normal kebab-case bead id such as `add-users-endpoint`
- Ensure the final bead text includes the real rationale, acceptance criteria, and `### Files:` section directly

Do not leave template shorthand in final beads. Validation in `src/beads.ts` rejects unresolved artifacts such as `[Use template: ...]`, `see template`, and raw `{{placeholderName}}` markers. Final beads must be fully expanded and self-contained.

To add a new template, append an entry to `BUILTIN_TEMPLATES` in `src/bead-templates.ts`, add a matching expansion case to `src/_verify-templates.test.ts` (which proves example text matches expansion output), and run `npm test`.

## Build & Test
```bash
npm run build    # tsc --noEmit
npm test         # vitest run
```
Both must pass after every change.

## MCP Agent Mail Coordination

### Quick Reference
```bash
# Register with agent-mail
BOOTSTRAP=$(curl -s -X POST http://127.0.0.1:8765/api -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"macro_start_session","arguments":{"human_key":"/Users/kevtrinh/Code/pi-orchestrator","program":"pi-subagent","model":"auto","task_description":"implementing bead","file_reservation_paths":[],"inbox_limit":10}}}')
export AM_AGENT_NAME=$(echo "$BOOTSTRAP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result']['structuredContent']['agent']['name'])" 2>/dev/null)
echo "I am: $AM_AGENT_NAME"

# Send a message
curl -s -X POST http://127.0.0.1:8765/api -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"send_message\",\"arguments\":{\"human_key\":\"/Users/kevtrinh/Code/pi-orchestrator\",\"sender_name\":\"$AM_AGENT_NAME\",\"to\":[\"all\"],\"subject\":\"Hello\",\"body\":\"My message\",\"thread_id\":\"general\",\"importance\":\"normal\"}}}"

# Check inbox
curl -s -X POST http://127.0.0.1:8765/api -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"fetch_inbox\",\"arguments\":{\"human_key\":\"/Users/kevtrinh/Code/pi-orchestrator\",\"agent_name\":\"$AM_AGENT_NAME\",\"limit\":20}}}"

# Acknowledge a message
curl -s -X POST http://127.0.0.1:8765/api -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"acknowledge_message\",\"arguments\":{\"human_key\":\"/Users/kevtrinh/Code/pi-orchestrator\",\"agent_name\":\"$AM_AGENT_NAME\",\"message_id\":\"MSG_ID_HERE\"}}}"
```

### Conventions
- Thread ID = bead ID (e.g. "pi-orchestrator-3c2")
- Use thread "general" for cross-bead coordination
- Announce start, announce completion, respond to messages promptly
- Use `bv --robot-next` to pick your next bead when idle

## Episodic Memory (MemPalace) — Optional

pi-orchestrator supports a second memory layer alongside CASS: **MemPalace** stores verbatim session text and retrieves it via semantic search. It is fully optional — if not installed, orchestration runs unchanged.

### Setup (one-time)
```bash
pip install mempalace
python -m mempalace init
```

### How it works
- **Automatic mining:** When an orchestration completes two clean review rounds, the current session transcript is automatically mined into MemPalace under a wing named after the project directory (e.g. `pi-orchestrator`).
- **Automatic retrieval:** When creating beads, the planner queries MemPalace for past sessions relevant to the current goal and injects verbatim excerpts as a `## Past Session Examples` section.
- **Wing convention:** Each project gets its own wing derived from `path.basename(cwd)` with non-alphanumeric chars replaced by `-`. All sessions for a project are grouped under one wing.
- **Room classification:** Sessions are classified into `decisions`, `preferences`, `milestones`, `problems`, `emotional` rooms via the `--extract general` flag.

### Two memory systems at a glance

| System | Storage | Retrieval | What it answers |
|--------|---------|-----------|------------------|
| CASS (`cm`) | Extracted rules/bullets | BM25 / similarity | "What patterns apply to this task?" |
| MemPalace | Verbatim session text | Semantic vector search | "What happened last time we did something like this?" |

### Troubleshooting
- If `python -m mempalace --version` crashes (e.g. macOS ARM64 segfault), detection returns false and episodic memory is silently skipped.
- Mining and search calls have a 10s timeout and are always best-effort — they never block orchestration.
- To check status: `python -m mempalace status --json`
- For more: `src/episodic-memory.ts` mirrors the structure of `src/memory.ts`.

## Beads (br CLI)
```bash
br list                    # All beads
br ready                   # Unblocked beads
br show <id>               # Bead details
br update <id> --status in_progress
br update <id> --status closed
bv --robot-next            # Smart next-bead pick
bv --robot-insights        # Graph health
```

## Core Rules

1. **Rule 0 — Override Prerogative**: The human's instructions override everything in this document.
2. **Rule 1 — No File Deletion**: Never delete files without explicit human permission.
3. **Rule 2 — No Destructive Git**: `git reset --hard`, `git clean -fd`, `rm -rf` are absolutely forbidden.
4. **Rule 3 — Branch Policy**: All work happens on the designated branch (usually `main`). Never create feature branches unless explicitly told to.
5. **Rule 4 — No Script-Based Code Changes**: Always make code changes manually via edit tools. No `sed`/`awk`/`perl` one-liners on source files.
6. **Rule 5 — No File Proliferation**: No `mainV2.ts`, `main_improved.ts`, `backup_main.ts` variants. One canonical file per concern.
7. **Rule 6 — Verify After Changes**: Always run the project's build/type-check/lint after modifying code. Verify no errors were introduced.
8. **Rule 7 — Multi-Agent Awareness**: Never stash, revert, or overwrite other agents' changes. Treat unfamiliar changes as if you made them and forgot.

## Memory System: cass-memory

The Cass Memory System (cm) is a tool for giving agents an effective memory based on the ability to quickly search across previous coding agent sessions across an array of different coding agent tools (e.g., Claude Code, Codex, Gemini-CLI, Cursor, etc) and projects (and even across multiple machines, optionally) and then reflect on what they find and learn in new sessions to draw out useful lessons and takeaways; these lessons are then stored and can be queried and retrieved later, much like how human memory works.

The `cm onboard` command guides you through analyzing historical sessions and extracting valuable rules.

### Quick Start

```bash
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
```

## Beads CLI (br) — task tracking

br is the local task tracker. Tasks are stored in .beads/ JSONL files.

### Key commands
- `br list --json` — all beads
- `br ready --json` — unblocked beads (your work queue)
- `br show <id>` — full bead details
- `br update <id> --status in_progress` — claim a bead
- `br update <id> --status closed` — complete a bead
- `br create --title "..." --description "..."` — create a bead
- `br dep add <id> <depends-on-id>` — add dependency
- `br sync --flush-only` — export to JSONL before committing
- `br dep cycles` — verify no dependency cycles

### Conventions
- Always mark beads in_progress before starting work
- Always close beads before committing
- Use bead ID in commit messages: "bead br-123: summary"
- Run `br sync --flush-only && git add .beads/` before committing

## Beads Viewer (bv) — graph-theory task compass

bv analyzes the bead dependency graph using PageRank, betweenness centrality, and critical-path analysis to tell you which bead to work on next.

### Key commands
- `bv --robot-next` — best single bead for one agent (PageRank + betweenness)
- `bv --robot-triage` — best beads for a swarm (routes agents to parallel-safe, non-contending beads)
- `bv --robot-insights` — full graph health report (bottlenecks, critical path, cycle detection)

### When to use which
- Solo agent: use `bv --robot-next`
- Multiple agents running in parallel: use `bv --robot-triage` to avoid all agents piling on the same bottleneck
- Stuck or unsure why progress is slow: run `bv --robot-insights` for graph diagnostics

Always prefer bv over `br ready` when bv is available — bv's graph-theoretic routing unlocks more downstream work.
