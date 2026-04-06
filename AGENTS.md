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
