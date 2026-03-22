# Architecture

## Overview

pi-orchestrator turns `/orchestrate` into a structured, multi-agent workflow. It scans the codebase, proposes improvements, creates beads (tasks) via the `br` CLI with dependency tracking, executes ready beads in order, reviews the results, and iterates until the user is satisfied.

Based on the [Agentic Coding Flywheel](https://agent-flywheel.com/).

## Architecture Diagram

```
/orchestrate
  │
  ├─► orch_profile     — Scan repo + load CASS memory from prior runs
  │     └─ 💡 Suggest improvements  or  ✏️ I know what I want
  │
  ├─► orch_discover    — LLM generates 10–15 scored ideas (rubric-ranked)
  │
  ├─► orch_select      — User picks idea → straight to bead creation
  │                       (custom goals get refinement questionnaire)
  │
  ├─► LLM creates beads via `br create` + `br dep add`
  │
  ├─► orch_approve_beads — Bead approval:
  │     │   ✅ Approve / 🔍 Refine / ❌ Reject
  │     │
  │     ├─► Reads beads from `br list --json`
  │     ├─► Quality checklist gate (WHAT/WHY/HOW scoring)
  │     ├─► Optional refinement passes with convergence scoring
  │     │     ├─ Round 1: LLM polish in-context
  │     │     ├─ Round 2+: fresh sub-agent review (no anchoring)
  │     │     └─ Stops at steady-state or ≥90% convergence
  │     ├─► Cross-model bead review (alternative AI model)
  │     ├─► Bead dedup check (detect overlapping beads)
  │     └─► On approve: finds ready beads via `br ready`
  │
  │   ┌─── Per-Bead Loop ─────────────────────────────────────┐
  │   │  Pick next ready bead (`br ready`)                      │
  │   │  Implement (with fresh-eyes self-review before commit)  │
  │   │                                                         │
  │   │  orch_review — per-bead gate:                          │
  │   │    🔥 Hit me → 5 parallel review agents                │
  │   │    ✅ Looks good → mark bead done, advance             │
  │   │                                                         │
  │   │  `br done <id>` on pass → unlocks dependent beads      │
  │   │  ⏭️ Skip to completion if work done early              │
  │   └────────────────────────────────────────────────────────┘
  │
  └─► Post-Implementation Guided Gates (sequential):
        🔍 Self-review → 👥 Peer review (+ file-conflict detection) →
        🧪 Test coverage → ✏️ De-slopify → 📦 Commit →
        🚀 Ship it → 🛬 Landing checklist → ✅ Done
        │
        └─► 🧠 CASS memory: extract learnings for future runs
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
4. **CASS memory / prior history** — enrichment only, never the primary driver

## Phases

### 1. Discovery

The workflow begins with `orch_profile`, which scans the repository and loads CASS memory from prior runs. The user chooses between:

- **💡 Suggest improvements** — structured ideation with rubric ranking. The LLM generates 25-30 candidates internally, scores each against 5 weighted axes (useful 2×, pragmatic 2×, accretive 1.5×, robust 1×, ergonomic 1×), winnows and merges overlaps, then returns 10-15 tiered ideas (5 top + 5-10 honorable mentions) with rationale and source evidence
- **✏️ I know what I want** — enter a custom goal directly, with optional refinement questionnaire

Each idea includes a `rationale` (why it beat other candidates, citing repo evidence), a `tier` (top vs honorable), and `scores`, `sourceEvidence`, `risks`, and `synergies`.

`orch_discover` generates 3–15 ideas (minimum 3 enforced). `orch_select` presents these grouped by tier (top picks first, then honorable mentions), with rationale shown as a subtitle. The user selects an idea (which proceeds directly to bead creation) or enters a custom goal (which gets a refinement questionnaire first).

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

- **▶️ Start implementing** → quality gate then begin execution
- **🔍 Polish / Refine further** → round 0 uses same-agent polish; round 1+ auto-selects fresh-agent refinement
- **⚙️ Advanced options** → sub-menu with: fresh-agent, same-agent, blunder hunt, dedup check, cross-model review, graph health fix
- **❌ Reject** → stop

Refinement passes let you iterate on bead descriptions, dependencies, and priorities before committing to execution.

#### Iterative Refinement with Convergence Scoring

Polish rounds track change counts per round and compute a weighted convergence score (combining velocity, output size stability, and streak of zero-change rounds). The system stops automatically when:

- **Steady-state**: 2 consecutive rounds with 0 changes
- **Diminishing returns**: convergence score ≥ 90%
- **Ready to implement**: convergence score ≥ 75% (shown as a hint)

After the first polish round, a **fresh sub-agent** (spawned via `pi --print` with no prior context) reviews the beads using `freshContextRefinementPrompt`. This avoids anchoring bias from the in-context LLM that created the beads.

#### Quality Checklist Gate

Before approval proceeds, `qualityCheckBeads()` validates each bead against automated quality checks — scoring WHAT (clear deliverable), WHY (rationale), and HOW (implementation detail) on a 1–5 scale via `beadQualityScoringPrompt`. Beads that fail are flagged for refinement.

#### Cross-Model Bead Review

`bead-review.ts` sends the full bead set to an alternative AI model (auto-selected from available providers) for a fresh-perspective review. The parser handles all response formats — numbered lists, markdown, and freeform text. Suggestions are surfaced during the approval flow.

#### Bead Dedup Check

Before implementation begins, a deduplication prompt scans for overlapping beads — tasks that cover substantially the same work. Detected duplicates are flagged for the user to merge or remove.

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

- **🔥 Hit me** — 5 parallel review agents (fresh-eyes / polish / ergonomics / reality-check / random-exploration)
- **✅ Looks good** — mark bead done, advance to next ready bead

After hit-me agents finish, the workflow auto-advances (no re-prompt). Only the first round shows the menu.

#### Agent Fungibility

Review agents use different **prompts** (fresh-eyes, polish, ergonomics, reality-check, random-exploration) but are fully interchangeable — any model can run any review prompt. There is no persistent identity or specialization; agents are ephemeral, spawned fresh per bead with no compaction concerns or accumulated state.

This is **prompt diversity**, not specialist agents. The distinction matters:

- **Prompt diversity** (what we do): different review lenses applied by interchangeable agents. If one agent slot fails, any other can take its place with the same prompt.
- **Specialist agents** (what the flywheel warns against): long-running agents with unique roles, accumulated context, and irreplaceable expertise that become single points of failure.

This satisfies the spirit of the fungible-agents invariant: no agent is special, all are replaceable, and better reviews emerge from applying diverse prompts rather than cultivating diverse identities.

#### Post-Implementation Guided Gates

After all beads pass, a sequential gate flow runs. Gates marked **auto** run immediately without prompting; gates marked **prompt** offer: do it / ⏭️ skip / ✅ done:

| Gate | Mode | What happens |
|------|------|-------------|
| 🔍 Self-review | auto | LLM reads all new code with fresh eyes, fixes issues |
| 👥 Peer review | prompt | 4 parallel agents: bugs, polish, ergonomics, reality-check + file-conflict detection |
| 🧪 Test coverage | auto | Check unit tests + e2e, create tasks for gaps |
| ✏️ De-slopify | auto | Remove AI writing patterns from docs (auto-skips if no docs changed) |
| 📦 Commit | prompt | Logical groupings with detailed messages, push |
| 🚀 Ship it | prompt | Tag, release, deploy, monitor CI, checksums |
| 🛬 Landing | prompt | Session completion checklist: verify resumability |

Every review action includes auto-commit instructions.

### 5. Completion

#### CASS Memory

The orchestrator uses [CASS](https://github.com/Dicklesworthstone/cass_memory_system) (cm CLI) for procedural memory across runs:

- **Read**: `cm context` returns relevance-scored rules, anti-patterns, and history snippets — injected into `orch_profile`
- **Write**: completion prompts the LLM to add learnings via `cm add`
- **Feedback**: rules can be marked helpful/harmful via `cm mark`, improving future relevance scoring
- **Search**: `cm similar` finds related rules by semantic similarity

When cm is not installed, memory gracefully degrades to no-op (empty results).

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
| `freshContextRefinementPrompt` | Fresh sub-agent bead review (no anchoring) | Bead polish |
| `computeConvergenceScore` | Weighted convergence (velocity + size + streak) | Bead polish |
| `strategicDriftCheckInstructions` | "Do we actually have the thing?" (proactive) | Drift detection |
| `blunderHuntInstructions` | Overshoot mismatch: "at least 80 errors" | Bead polish |
| `randomExplorationInstructions` | Explore files NOT in the change set | Per-bead review |
| `deSlopifyInstructions` | Remove AI writing patterns (extensible catalogue) | De-slop gate |
| `landingChecklistInstructions` | Session completion verification | Landing gate |
| `swarmMarchingOrders` | Canonical swarm kickoff prompt | Swarm launch |
| `beadQualityScoringPrompt` | WHAT/WHY/HOW evaluation (1-5 each) | Bead polish |
| `researchInvestigatePrompt` | Study external project, propose reimagined ideas | Research workflow |
| `researchDeepenPrompt` | Push past conservative suggestions | Research workflow |
| `researchInversionPrompt` | What can WE do that THEY cannot? | Research workflow |
| `goalRefinementPrompt` | Sharpen raw goal into structured spec via questions | Goal refinement |

## Project Structure

```
src/
├── index.ts           # Extension runtime: commands, tools, and orchestrator state machine
├── scan.ts            # First-class scan contract + provider entrypoint
├── profiler.ts        # Built-in repo profiling (find, git, grep) + detection
├── prompts.ts         # Flywheel-derived prompt templates
├── types.ts           # Shared TypeScript types: scan, state, beads, reviews
├── beads.ts           # br CLI wrapper: list, ready, done, create beads + quality checks
├── bead-review.ts     # Cross-model bead review via alternative AI model
├── commands.ts        # Command registration (/orchestrate, /orchestrate-status, /orchestrate-reset)
├── coordination.ts    # Coordination backend detection (beads, sophia, agent-mail)
├── agent-mail.ts      # Agent-mail integration for multi-agent coordination
├── agents-md.ts       # AGENTS.md generation for sub-agent context
├── goal-refinement.ts # Goal refinement and constraint extraction
├── gates.ts           # Guided review gates (7-step sequential flow with resumable state)
├── sophia.ts          # Sophia CLI wrapper + dependency analysis + merge
├── worktree.ts        # WorktreePool + autoCommitWorktree
├── tender.ts          # SwarmTender: agent health + conflict detection
├── memory.ts          # CASS memory: wraps cm CLI for rules, context, and feedback
└── deep-plan.ts       # Direct pi CLI spawning helpers
```

Note: there is currently no separate `src/orchestrator.ts`; the orchestrator runtime lives in `src/index.ts`.
