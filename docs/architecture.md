# Architecture

## Overview

pi-orchestrator turns `/orchestrate` into a structured, multi-agent workflow. It scans the codebase, proposes improvements, plans the work, executes steps in git worktrees when parallelism is possible, reviews the results, and iterates until the user is satisfied.

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
  ├─► orch_plan        — Plan approval:
  │     │   ✅ Approve / 🚀 Creative brainstorm (3 agents) / ❌ Reject
  │     │
  │     ├─► Sophia CR + tasks created
  │     ├─► 🔍 Polish tasks in plan space / ▶️ Start implementing
  │     ├─► dependsOn analysis → parallel groups detected
  │     ├─► Worktrees created for parallel steps
  │     └─► 🐝 Swarm tender starts monitoring
  │
  │   ┌─── Per-Step Loop ──────────────────────────────────────┐
  │   │  Implement (with fresh-eyes self-review before commit)  │
  │   │                                                         │
  │   │  orch_review — per-step gate:                          │
  │   │    🔥 Hit me → 4 parallel review agents                │
  │   │    ✅ Looks good → advance                             │
  │   │                                                         │
  │   │  Auto-commit fallback for forgetful sub-agents          │
  │   │  Worktree merge-back on pass                           │
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

The workflow begins with `orch_profile`, which scans the repository and loads compound memory from prior runs. Discovery supports two modes:

- **📋 Standard** — straightforward repo analysis
- **🚀 Creative** — the LLM thinks of 100 ideas internally and surfaces the 7 best

`orch_discover` then generates 3–7 improvement ideas (minimum 3 enforced). `orch_select` presents these to the user and captures the selected goal plus any constraints. The actual planning-mode choice happens inside `orch_plan`, where the user can keep the standard plan, request deep planning, or reject it.

### 2. Planning

#### Standard Planning

A single LLM generates a step-by-step plan for the selected goal.

#### Deep Planning (Multi-Model Synthesis)

When you select "🧠 Deep plan":

1. **Pick 3 models** from available providers (sorted by context window)
2. **3 parallel agents** each create a plan with a different focus:
   - Correctness
   - Robustness
   - Ergonomics
3. **Synthesis**: an LLM blends "best of all worlds" into a hybrid plan
4. **🚀 Creative brainstorm** (optional): 3 parallel brainstorm agents (innovator / hardener / simplifier) each think of 100 ideas, output their top 3–5 with +EV justification. The user picks which to include.

Agents get read-only tools and cannot call `orch_*` tools.

#### Plan Approval & Task Polishing

Plan approval is a 3-option select showing the full plan text:

- **✅ Approve** → keep the plan and move to the pre-implementation polish loop
- **🚀 Creative brainstorm** → 3 parallel agents enhance the plan
- **❌ Reject** → stop

After approval, the user gets one more gate before execution:

- **🔍 Polish** — review tasks in plan space and send them back for revision
- **▶️ Start implementing** — commit to execution

Only after the user chooses **Start implementing** does the orchestrator create Sophia tasks / CR state. That avoids orphaned Sophia artifacts if the plan gets revised in polish mode.

#### Step Dependencies (dependsOn)

Steps declare dependencies for parallel scheduling:

| `dependsOn` | Meaning |
|-------------|---------|
| omitted | Sequential — depends on previous step (default) |
| `[]` | Independent — can run in parallel |
| `[1, 3]` | Explicit — depends on steps 1 and 3 |

`resolveDependencies()` normalizes all modes, filters self-refs and invalid indices, and detects cycles with exact path reporting. Dependencies are merged additively with artifact-based deps.

The planner prompt includes a self-check: *"if your description says after/once/then, you probably need dependsOn."*

### 3. Implementation

#### Parallel Execution & Worktrees

When steps have no shared dependencies, they run in parallel:

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

#### Per-Step Review

After each step's self-review passes:

- **🔥 Hit me** — 4 parallel review agents (fresh-eyes / polish / ergonomics / reality-check)
- **✅ Looks good** — advance to next step

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
├── index.ts      # Extension runtime: commands, tools, and orchestrator state machine
├── scan.ts       # First-class scan contract + provider entrypoint (currently builtin only)
├── profiler.ts   # Built-in repo profiling (find, git, grep) + detection
├── prompts.ts    # Flywheel-derived prompt templates
├── sophia.ts     # Sophia CLI wrapper + dependency analysis + merge
├── types.ts      # Shared TypeScript types: scan, state, plans, reviews
├── worktree.ts   # WorktreePool + autoCommitWorktree
├── tender.ts     # SwarmTender: agent health + conflict detection
├── memory.ts     # Compound memory: read/append .pi-orchestrator/memory.md
└── deep-plan.ts  # Direct pi CLI spawning helpers
```

Note: there is currently no separate `src/orchestrator.ts`; the orchestrator runtime lives in `src/index.ts`.
