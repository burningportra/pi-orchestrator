# Architecture

## Overview

pi-orchestrator turns `/orchestrate` into a structured, multi-agent workflow. It scans the codebase, proposes improvements, creates beads (tasks) via the `br` CLI with dependency tracking, executes ready beads in order, reviews the results, and iterates until the user is satisfied.

Based on the [Agentic Coding Flywheel](https://agent-flywheel.com/).

## Architecture Diagram

```
/orchestrate
  │
  ├─► orch_profile     — Scan repo + load compound memory from prior runs
  │     └─ Discovery mode: 📋 Standard or 🚀 Creative (broader ideation, return 7)
  │
  ├─► orch_discover    — LLM generates 3–7 ideas (minimum enforced)
  │
  ├─► orch_select      — User picks idea + planning mode:
  │     │
  │     ├─ 📋 Standard    → single plan
  │     └─ 🧠 Deep plan   → pick 3 models → competing plans → synthesis
  │                           ┌──────────────────┐
  │                           │ Gemini plan       │
  │                           │ GPT plan          │──► "best of all worlds"
  │                           │ Claude plan       │
  │                           └──────────────────┘
  │
  ├─► LLM creates beads via `br create` + `br dep add`
  │
  ├─► orch_approve_beads — Bead approval:
  │     │   ✅ Approve / 🔍 Refine / ❌ Reject
  │     │
  │     ├─► Reads beads from `br list --json`
  │     ├─► Optional refinement passes (polish in bead space)
  │     └─► On approve: finds ready beads via `br ready`
  │
  │   ┌─── Per-Bead Loop ─────────────────────────────────────┐
  │   │  Pick next ready bead (`br ready`)                      │
  │   │  Implement (with fresh-eyes self-review before commit)  │
  │   │                                                         │
  │   │  orch_review — per-bead gate:                          │
  │   │    🔥 Hit me → 4 parallel review agents                │
  │   │    ✅ Looks good → mark bead done, advance             │
  │   │                                                         │
  │   │  `br done <id>` on pass → unlocks dependent beads      │
  │   │  ⏭️ Skip to completion if work done early              │
  │   └────────────────────────────────────────────────────────┘
  │
  └─► Post-Implementation Guided Gates (sequential):
        🔍 Self-review → 👥 Peer review (4 agents) →
        🧪 Test coverage → 📦 Commit → 🚀 Ship it → ✅ Done
        │
        └─► 🧠 Compound memory: extract learnings for future runs
```

## Scan Contract

Repository scanning now uses a dedicated contract so the orchestrator can add or swap scan providers without breaking the rest of the workflow.

### What exists today

The orchestrator now uses the abstraction in production:

- **`RepoProfile`** remains the legacy shape consumed throughout discovery, planning, and implementation.
- **`ScanResult`** wraps that profile with scan metadata:
  - `source` — the provider family (`ccc` or `builtin`)
  - `provider` — the concrete provider id that produced the result
  - `profile` — the unchanged legacy `RepoProfile` payload used by the rest of the workflow
  - `codebaseAnalysis` — normalized recommendation inputs, structural insights, and quality signals
  - `fallback` — explicit metadata describing provider degradation to the built-in scan path
- **`ScanProvider`** defines the provider interface.
- **`scanRepo()`** is the single orchestrator entrypoint. The runtime should call this instead of invoking `profileRepo()` directly.

### Current behavior

`scanRepo()` now attempts a ccc-backed scan first and pairs those findings with the legacy `RepoProfile` shape so the rest of the workflow keeps working. If ccc is unavailable, uninitialized, or otherwise fails, the orchestrator falls back to the built-in profiler.

### Context priority order

When scan data is rendered into prompts and tool output, the orchestrator now treats context in this order:

1. **Live codebase scan** — ccc summary, recommendations, and structural insights
2. **Repo profile details** — languages, frameworks, entrypoints, tests, docs, CI
3. **Recent commits and TODOs** — useful but secondary signals
4. **Compound memory / prior history** — enrichment only, never the primary driver

## Phases

### 1. Discovery

The workflow begins with `orch_profile`, which scans the repository and loads compound memory from prior runs. Discovery supports three modes:

- **📋 Standard** — straightforward repo analysis, 3-7 practical ideas
- **🧠 Idea Wizard** — structured ideation with rubric ranking. The LLM generates 25-30 candidates internally, scores each against 5 axes (useful, pragmatic, accretive, robust, ergonomic), winnows and merges overlaps, then returns 10-15 tiered ideas (5 top + 5-10 honorable mentions) with rationale and source evidence
- **🚀 Creative** — the LLM thinks of 100 ideas internally, applies the same rubric, and surfaces the 7 best with rationale

Each idea includes a `rationale` (why it beat other candidates, citing repo evidence), a `tier` (top vs honorable), and optional `scores`, `sourceEvidence`, `risks`, and `synergies`. In Idea Wizard and Creative modes, scores are required.

`orch_discover` generates 3–15 ideas (minimum 3 enforced). `orch_select` presents these grouped by tier (top picks first, then honorable mentions), with rationale shown as a subtitle. The user selects an idea or enters a custom goal. The actual planning-mode choice happens inside `orch_plan`, where the user can keep the standard plan, request deep planning, or reject it.

Full ideation results are persisted as a session artifact (`discovery/ideas-<timestamp>.md`) for later reference or follow-up orchestration runs.

### 2. Planning (Bead Creation)

After the user selects a goal, the LLM creates **beads** (tasks) using the `br` CLI:

```bash
br create "Implement auth module" --type task --priority 3
br create "Add tests for auth" --type task --priority 2
br dep add <test-bead-id> <auth-bead-id>   # tests depend on auth
```

Each bead has: title, description, type, priority, labels, and optional dependencies.

#### Deep Planning (Multi-Model Synthesis)

When you select "🧠 Deep plan":

1. **Pick 3 models** from available providers (sorted by context window)
2. **3 parallel agents** each create beads with a different focus: correctness, robustness, ergonomics
3. **Synthesis**: an LLM blends "best of all worlds" into a unified bead set

Agents get read-only tools and cannot call `orch_*` tools.

#### Bead Approval (`orch_approve_beads`)

The `orch_approve_beads` tool reads beads from `br list --json` and presents them for approval:

- **✅ Approve** → find ready beads and begin execution
- **🔍 Refine** → polish beads in bead space, then re-approve
- **❌ Reject** → stop

Refinement passes let you iterate on bead descriptions, dependencies, and priorities before committing to execution.

#### Bead Dependencies

Dependencies are managed via `br dep add <child> <parent>`. The `br ready` command returns beads whose dependencies are all satisfied. Cycle detection is handled by the br CLI.

### 3. Implementation

#### Bead-Based Execution

The orchestrator executes beads in dependency order:

1. **`br ready`** returns beads whose dependencies are satisfied
2. The LLM implements the next ready bead
3. On completion, **`br done <id>`** marks the bead complete and unlocks dependents
4. The loop continues until all beads are done

#### Parallel Execution & Worktrees

When multiple beads are ready simultaneously, they can run in parallel:

1. **`WorktreePool`** creates isolated git worktrees (`git worktree add`)
2. **`parallel_subagents`** spawns agents in separate terminal panes
3. Each agent's task includes explicit git commit instructions
4. **`autoCommitWorktree`** fallback commits any uncommitted changes
5. **`mergeWorktreeChanges`** merges back with `--no-ff`
6. Worktrees are cleaned up after merge

**Fallback**: if worktree creation fails, execution falls back to sequential mode.

#### Swarm Tender

`SwarmTender` monitors parallel agents automatically:

- **Polls every 60s** via `git status --porcelain` per worktree
- **Classifies agents**: active (< 2 min idle) / idle (2–5 min) / stuck (> 5 min)
- **Conflict detection**: flags the same file modified in multiple worktrees
- **Alerts**: `ctx.ui.notify` on stuck agents or conflicts
- **Widget**: shows `🐝 Tender: 2 active, 1 stuck`

Starts on parallel launch, stops on completion.

### 4. Review

#### Per-Bead Review

After each bead's self-review passes:

- **🔥 Hit me** — 4 parallel review agents (fresh-eyes / polish / ergonomics / reality-check)
- **✅ Looks good** — mark bead done, advance to next ready bead

After hit-me agents finish, the workflow auto-advances (no re-prompt). Only the first round shows the menu.

#### Post-Implementation Guided Gates

After all steps pass, a sequential gate flow runs (each gate offers: do it / ⏭️ skip / ✅ done):

| Gate | What happens |
|------|-------------|
| 🔍 Self-review | LLM reads all new code with fresh eyes, fixes issues |
| 👥 Peer review | 4 parallel agents: bugs, polish, ergonomics, reality-check |
| 🧪 Test coverage | Check unit tests + e2e, create tasks for gaps |
| 📦 Commit | Logical groupings with detailed messages, push |
| 🚀 Ship it | Tag, release, deploy, monitor CI, checksums |

Every review action includes auto-commit instructions.

### 5. Completion

#### Compound Memory

`.pi-orchestrator/memory.md` carries learnings across orchestration runs:

- **Read**: injected into `orch_profile` result as context
- **Write**: completion prompts the LLM to extract decisions, gotchas, and patterns
- **Truncation**: last 10KB on read to protect the context window
- **Format**: timestamped markdown sections

The system compounds knowledge — each run benefits from prior learnings.

#### Sophia Integration

When [Sophia](https://github.com/sophialab/sophia) is initialized:

- `orch_plan` creates a CR with task contracts (intent, acceptance, scope)
- `orch_review` checkpoints tasks via `sophia cr task done`
- Completion runs `sophia cr validate` + `sophia cr review`
- Session restore re-detects Sophia and rebuilds CR state via `getCRStatus`

**Fallback**: no Sophia = no CR tracking; everything else works.

## Flywheel-Derived Prompts

| Function | Pattern | Used In |
|----------|---------|---------|
| `synthesisInstructions` | "Best of all worlds" multi-model synthesis | Deep plan |
| `adversarialReviewInstructions` | "Fresh eyes, fix what you find" | Per-step review |
| `realityCheckInstructions` | "Do we actually have the thing?" | Peer review |
| `implementerInstructions` | "Read, understand, be proactive" + self-review | Implementation |
| `polishInstructions` | De-slopify | Peer review |
| `commitStrategyInstructions` | Logical commit grouping | Commit gate |
| `planToTasksInstructions` | "So detailed you never consult the plan" | Task creation |

## Project Structure

```
src/
├── index.ts           # Extension runtime: commands, tools, and orchestrator state machine
├── scan.ts            # First-class scan contract + provider entrypoint
├── profiler.ts        # Built-in repo profiling (find, git, grep) + detection
├── prompts.ts         # Flywheel-derived prompt templates
├── types.ts           # Shared TypeScript types: scan, state, beads, reviews
├── beads.ts           # br CLI wrapper: list, ready, done, create beads
├── coordination.ts    # Coordination backend detection (beads, sophia, agent-mail)
├── agent-mail.ts      # Agent-mail integration for multi-agent coordination
├── agents-md.ts       # AGENTS.md generation for sub-agent context
├── goal-refinement.ts # Goal refinement and constraint extraction
├── sophia.ts          # Sophia CLI wrapper + dependency analysis + merge
├── worktree.ts        # WorktreePool + autoCommitWorktree
├── tender.ts          # SwarmTender: agent health + conflict detection
├── memory.ts          # Compound memory: read/append .pi-orchestrator/memory.md
└── deep-plan.ts       # Direct pi CLI spawning helpers
```

Note: there is currently no separate `src/orchestrator.ts`; the orchestrator runtime lives in `src/index.ts`.
