# Coordination & Swarm System

> How pi-orchestrator detects backends, selects strategies, composes agent swarms, and coordinates parallel work via Agent Mail.

## Overview

When `/orchestrate` runs implementation steps, it needs to coordinate potentially many parallel agents working on the same codebase. The coordination system handles three concerns:

1. **Backend detection** — discover which tools are available (beads, Agent Mail, Sophia)
2. **Strategy selection** — pick the best coordination mode for the environment
3. **Swarm management** — compose, launch, and monitor parallel agents

Key source files:

| File | Responsibility |
|------|---------------|
| `src/coordination.ts` | Backend detection, strategy/mode selection, pre-commit guard |
| `src/agent-mail.ts` | JSON-RPC client for Agent Mail, file reservations, task preamble |
| `src/swarm.ts` | Agent composition, staggered launch config, status formatting |
| `src/tender.ts` | `SwarmTender` — polls worktrees, detects stuck agents and conflicts |
| `src/prompts.ts` | Marching orders, stagger delay constant, model IDs |

---

## Backend Detection

`detectCoordinationBackend()` in `src/coordination.ts` probes for three independent backends in parallel:

| Backend | Detection method |
|---------|-----------------|
| **Beads** (`br` CLI) | Runs `br --help` and checks for `.beads/` directory |
| **Agent Mail** | Hits `http://127.0.0.1:8765/health/liveness`; if unreachable but installed, starts the server in the background and waits up to 5s |
| **Sophia** | Runs `sophia --help`, checks for `SOPHIA.yaml`, and verifies `sophia cr list --json` returns `ok: true` |

Results are cached after the first call. Use `resetDetection()` to force a re-probe (e.g. after installing a missing tool mid-session).

```ts
const backend = await detectCoordinationBackend(pi, cwd);
// => { beads: true, agentMail: true, sophia: false, preCommitGuardInstalled: true }
```

### Auto-start behavior

Agent Mail gets special treatment: if the Python package is installed (`uv run python -c "import mcp_agent_mail"` succeeds) but the HTTP server isn't running, detection will launch it with `nohup` and poll for readiness. This means users don't need to manually start the server.

### Pre-commit guard

When Agent Mail is detected, the system also checks for a git pre-commit hook that blocks commits to files reserved by other agents. If missing, a warning is logged. The hook can be installed programmatically via `scaffoldPreCommitGuard()`, which writes a shell script to `.git/hooks/pre-commit` that queries the `check_commit_conflicts` MCP tool before allowing commits.

---

## Strategy Selection

`selectStrategy()` applies a strict priority order:

| Priority | Strategy | Requirements | What it provides |
|----------|----------|-------------|-----------------|
| 1 (best) | `beads+agentmail` | `br` CLI + Agent Mail server | Task lifecycle via beads, messaging, file reservations |
| 2 | `sophia` | Sophia CLI + `SOPHIA.yaml` | CR/task lifecycle, worktree isolation |
| 3 (fallback) | `worktrees` | Just git | Worktree isolation only — no task tracking or messaging |

`selectMode()` picks the git workflow based on Agent Mail availability:

- **Agent Mail available** → `single-branch` — agents share one branch, using file reservations to prevent conflicts
- **No Agent Mail** → `worktree` — each agent gets an isolated git worktree

The strategy and mode are stored on `OrchestratorState` and influence how implementation steps are launched and how review agents coordinate.

---

## Swarm Composition

`recommendComposition()` in `src/swarm.ts` maps the number of open beads to an agent count and model distribution:

| Open beads | Agents | Opus | GPT | Haiku | Rationale |
|-----------|--------|------|-----|-------|-----------|
| ≥ 400 | 10 | 4 | 4 | 2 | Large project, full swarm |
| ≥ 100 | 8 | 3 | 3 | 2 | Medium project, moderate swarm |
| < 100 | 3 | 1 | 1 | 1 | Small project, minimal swarm |

The model constants are defined in `src/prompts.ts` under `SWARM_MODELS`:

- `opus` → `anthropic/claude-opus-4-6` (deep reasoning)
- `gpt` → `openai-codex/gpt-5.4` (fast implementation)
- `haiku` → `anthropic/claude-haiku-4-5` (lightweight tasks)

Mixing models is intentional: different architectures catch different classes of bugs and produce more diverse implementations.

### Config generation

`generateAgentConfigs()` takes the composition and produces an array of `SwarmAgentConfig` objects, each with:

- A name like `swarm-3-claude-opus` (index + model short name)
- Marching orders from `swarmMarchingOrders()` — tells the agent to read `AGENTS.md`, check mail, use `bv --robot-triage`, and work autonomously
- A stagger delay: agent *i* waits `i * 30_000` ms before spawning

---

## Staggered Launches

Agents are launched with a **30-second stagger** between each spawn (`SWARM_STAGGER_DELAY_MS` in `src/prompts.ts`). This prevents the "thundering herd" problem:

1. **bv contention** — if all agents call `bv --robot-next` simultaneously, they might all pick the same bead before any can claim it
2. **API rate limits** — staggering spreads LLM API calls across a wider time window
3. **Agent Mail load** — bootstrap sessions and file reservations are spread out
4. **Git conflicts** — agents pulling and pushing at slightly different times reduces rebase collisions

The delay is cumulative: agent 0 starts immediately, agent 1 at +30s, agent 2 at +60s, etc. For a 10-agent swarm, the last agent starts 4.5 minutes after the first.

`formatLaunchInstructions()` renders the full launch plan as structured Markdown that the orchestrating LLM can use to spawn each agent with the `subagent` tool.

---

## Agent Mail Integration

`src/agent-mail.ts` provides the RPC layer for communicating with the Agent Mail MCP server at `http://127.0.0.1:8765`.

### RPC calls

`agentMailRPC()` wraps any MCP tool call as a JSON-RPC HTTP request via `curl`. The orchestrator uses this to:

- `ensure_project` — register the project directory with Agent Mail
- `file_reservation_paths` — reserve files exclusively for an agent
- `release_file_reservations` — release reservations after work completes
- `macro_start_session` — bootstrap a new sub-agent identity
- `macro_prepare_thread` — join an existing message thread
- `check_commit_conflicts` — verify no reservation conflicts before committing

`agentMailReadResource()` reads MCP resources (e.g. `resource://file_reservations/<slug>`) for querying active reservations.

### File reservations

The reservation system prevents two agents from editing the same file:

```
reserveFileReservations(exec, cwd, "agent-1", ["src/index.ts"], "implementing bead xyz")
  → exclusive lock on src/index.ts for 1 hour

checkFileReservations(exec, cwd, ["src/index.ts"], "agent-2")
  → returns conflicts if agent-1 holds the lock

releaseFileReservations(exec, cwd, "agent-1")
  → releases all locks held by agent-1
```

Path matching supports exact paths, globs (`src/*.ts`), and recursive globs (`src/**`). The `matchesReservationPath()` helper normalizes patterns and handles all three forms.

### Task preamble injection

`agentMailTaskPreamble()` generates a multi-step bootstrap script that gets prepended to every sub-agent's task. It includes:

1. **Session bootstrap** — a `curl` command to call `macro_start_session`, which assigns the agent a unique name (e.g. "VioletLantern")
2. **Helper functions** — a bash script defining `am_send`, `am_dm`, `am_inbox`, `am_release`, and `am_join_thread` with the project key and thread ID baked in
3. **Mandatory workflow** — announce start → check inbox → do work → check inbox again → announce completion → release reservations
4. **Git workflow** (single-branch mode) — instructions for `git pull --rebase` before editing and `git push` after committing, with explicit conflict-handling rules

The preamble ensures every agent, regardless of which LLM powers it, follows the same coordination protocol. The helper functions abstract away the raw JSON-RPC curl commands so agents don't need to construct them manually.

---

## SwarmTender — Runtime Monitoring

`SwarmTender` in `src/tender.ts` is a polling loop that monitors agent health during swarm execution:

- **Poll interval**: 60s (configurable)
- **Health classification**: checks `git status --porcelain` in each worktree
  - `active` — files changed since last poll
  - `idle` — no changes for > 2 minutes
  - `stuck` — no changes for > 5 minutes
- **Conflict detection**: if the same file appears in multiple worktrees' `git status`, a conflict alert fires
- **Cadence checks**: every 20 minutes, emits an operator checklist prompting the human to review progress, handle compactions, check rate limits, and trigger review rounds

The tender exposes callbacks (`onStuck`, `onConflict`, `onTick`, `onCadenceCheck`) and a `getSummary()` method used by the status widget:

```
🟢 Swarm Status (5 agents)
  Active: 3 | Idle: 1 | Stuck: 1
  Beads: 12 open | 3 in progress | 8 closed
  ⚠️ Stuck agents: #4
```

When an agent completes its work, `removeAgent(stepIndex)` removes it from monitoring. The tender auto-stops when no agents remain.

---

## Architecture Diagram

```
/orchestrate
  │
  ├─ detectCoordinationBackend()     ← probes beads, agent-mail, sophia
  │    └─ selectStrategy()           ← picks beads+agentmail / sophia / worktrees
  │    └─ selectMode()               ← single-branch or worktree
  │
  ├─ recommendComposition()          ← agent count + model mix
  │    └─ generateAgentConfigs()     ← names, tasks, stagger delays
  │
  ├─ agentMailTaskPreamble()         ← injected into each agent's task
  │    └─ macro_start_session        ← assigns agent identity
  │    └─ helper functions           ← am_send, am_inbox, am_release
  │
  ├─ Launch agents (30s stagger)
  │    └─ Each agent: bv --robot-triage → claim bead → implement → orch_review
  │
  └─ SwarmTender.start()             ← monitors health, conflicts, cadence
```

---

## See Also

- [Architecture](architecture.md) — overall orchestrator workflow
- [Setup & Configuration](setup.md) — installing prerequisites including Agent Mail
- `AGENTS.md` — agent-facing conventions for beads, bv, and Agent Mail
