# pi-orchestrator

A [pi](https://github.com/badlogic/pi-mono) extension that turns `/orchestrate` into a structured, multi-agent workflow. Based on the [Agentic Coding Flywheel](https://agent-flywheel.com/).

Type `/orchestrate` in any repo → it scans the codebase → proposes improvements → plans the work (optionally with 3 competing AI models) → implements steps in parallel git worktrees → reviews with parallel agents → repeats until you're satisfied.

## Architecture

```
/orchestrate
  │
  ├─► orch_profile     — Scan repo + load compound memory from prior runs
  │     └─ Discovery mode: 📋 Standard or 🚀 Creative or ✏️ Enter own goal
  │           └─ ✏️ triggers Goal Refinement questionnaire (see below)
  │
  ├─► orch_discover    — LLM generates 3–7 ideas (minimum enforced)
  │
  ├─► orch_select      — User picks idea + planning mode:
  │     │                  └─ ✏️ custom goal also triggers Goal Refinement
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

## Install

```bash
pi install git:github.com/burningportra/pi-orchestrator
```

## Deep Planning (Multi-Model Synthesis)

When you select "🧠 Deep plan":

1. **Pick 3 models** from available providers (sorted by context window)
2. **3 parallel agents** each create a plan with different focus (correctness / robustness / ergonomics)
3. **Synthesis**: LLM blends "best of all worlds" into a hybrid
4. **🚀 Creative brainstorm** (optional): 3 parallel brainstorm agents (innovator / hardener / simplifier) each think of 100 ideas, output top 3-5 with +EV justification. User picks which to include.

Agents get read-only tools and can't call `orch_*` tools.

## Goal Refinement (Custom Goals)

When you enter your own goal (via ✏️ in either discovery or idea selection), the orchestrator doesn't just take your one-liner — it asks follow-up questions first:

```
"Add rate limiting" → LLM generates contextual questions → questionnaire TUI → enriched goal
```

1. **LLM generates 3–5 questions** based on your goal + repo profile (not generic — references actual languages, frameworks, file structure)
2. **Interactive questionnaire** with tab navigation, pre-built options, and freeform input
3. **One question always asks about constraints/non-goals** — what you don't want changed
4. **Adaptive depth** — specific goals get fewer questions, vague goals get more
5. **Synthesizes into structured goal** with sections: Goal, Scope, Constraints, Non-Goals, Success Criteria, Implementation Notes
6. **Confirmation step** — review the enriched goal before planning (Y / edit / skip)

**Graceful degradation**: LLM timeout, bad JSON, user cancel → falls back to the raw goal. The questionnaire is an enrichment layer, not a gate.

## Plan Approval & Task Polishing

Plan approval is a 3-option select showing the full plan text:
- **✅ Approve** → create sophia tasks, start work
- **🚀 Creative brainstorm** → 3 parallel agents enhance the plan
- **❌ Reject** → stop

After approval, sophia tasks are created and shown with dependencies. User can:
- **🔍 Polish** — review tasks in plan space, send back for revision
- **▶️ Start implementing** — proceed to execution

## Step Dependencies (dependsOn)

Steps declare dependencies for parallel scheduling:

| `dependsOn` | Meaning |
|-------------|---------|
| omitted | Sequential — depends on previous step (default) |
| `[]` | Independent — can run in parallel |
| `[1, 3]` | Explicit — depends on steps 1 and 3 |

`resolveDependencies()` normalizes all modes, filters self-refs and invalid indices, detects cycles with exact path reporting. Merged additively with artifact-based deps.

The planner prompt includes a self-check: *"if your description says after/once/then, you probably need dependsOn."*

## Parallel Execution & Worktrees

When steps have no shared deps, they run in parallel:

1. `WorktreePool` creates isolated git worktrees (`git worktree add`)
2. `parallel_subagents` spawns agents in separate panes
3. Each agent's task includes explicit git commit instructions
4. `autoCommitWorktree` fallback commits uncommitted changes
5. `mergeWorktreeChanges` merges back with `--no-ff`
6. Worktrees cleaned up after merge

**Fallback**: worktree creation failure → sequential execution.

## Swarm Tending

`SwarmTender` monitors parallel agents automatically:

- **Polls every 60s** via `git status --porcelain` per worktree
- **Classifies agents**: active (< 2 min idle) / idle (2-5 min) / stuck (> 5 min)
- **Conflict detection**: flags same file modified in multiple worktrees
- **Alerts**: `ctx.ui.notify` on stuck agents or conflicts
- **Widget**: shows `🐝 Tender: 2 active, 1 stuck`

Starts on parallel launch, stops on completion.

## Per-Step Review

After each step's self-review passes:
- **🔥 Hit me** — 4 parallel agents (fresh-eyes / polish / ergonomics / reality-check)
- **✅ Looks good** — advance to next step

After hit-me agents finish, auto-advances (no re-prompt). First round only shows the menu.

## Post-Implementation Guided Gates

After all steps pass, a sequential gate flow (each: do it / ⏭️ skip / ✅ done):

| Gate | What happens |
|------|-------------|
| 🔍 Self-review | LLM reads all new code with fresh eyes, fixes issues |
| 👥 Peer review | 4 parallel agents: bugs, polish, ergonomics, reality-check |
| 🧪 Test coverage | Check unit tests + e2e, create tasks for gaps |
| 📦 Commit | Logical groupings with detailed messages, push |
| 🚀 Ship it | Tag, release, deploy, monitor CI, checksums |

Every review action includes auto-commit instructions.

## Sophia Integration

When [Sophia](https://github.com/sophialab/sophia) is initialized:

- `orch_plan` creates CR with task contracts (intent, acceptance, scope)
- `orch_review` checkpoints tasks via `sophia cr task done`
- Completion runs `sophia cr validate` + `sophia cr review`
- Session restore re-detects sophia, rebuilds CR state via `getCRStatus`

**Fallback**: no sophia = no CR tracking, everything else works.

## Compound Memory

`.pi-orchestrator/memory.md` carries learnings across orchestration runs:

- **Read**: injected into `orch_profile` result as context
- **Write**: completion prompts LLM to extract decisions/gotchas/patterns
- **Truncation**: last 10KB on read to protect context window
- **Format**: timestamped markdown sections

The system compounds knowledge — each run benefits from prior learnings.

## Flywheel-Derived Prompts

| Function | Pattern | Used |
|----------|---------|------|
| `goalRefinementPrompt` | Context-aware clarifying questions as JSON | Goal refinement |
| `synthesisInstructions` | "Best of all worlds" multi-model synthesis | Deep plan |
| `adversarialReviewInstructions` | "Fresh eyes, fix what you find" | Per-step review |
| `realityCheckInstructions` | "Do we actually have the thing?" | Peer review |
| `implementerInstructions` | "Read, understand, be proactive" + self-review | Implementation |
| `polishInstructions` | De-slopify | Peer review |
| `commitStrategyInstructions` | Logical commit grouping | Commit gate |
| `planToTasksInstructions` | "So detailed you never consult the plan" | Task creation |

## Commands

| Command | Description |
|---------|-------------|
| `/orchestrate` | Full workflow |
| `/orchestrate [goal]` | Skip discovery, plan directly |
| `/orchestrate-stop` | Cancel + cleanup worktrees |
| `/orchestrate-status` | Show phase + progress |

## Tools (called by LLM)

| Tool | Description |
|------|-------------|
| `orch_profile` | Scan repo, load compound memory, detect sophia |
| `orch_discover` | LLM submits 3–7 ideas (min 3 enforced) |
| `orch_select` | User picks idea, constraints, planning mode, models |
| `orch_plan` | Plan approval + brainstorm + sophia CR + polish + parallel launch |
| `orch_review` | Per-step review gates + post-implementation guided sequence |

## Project Structure

```
src/
├── index.ts               # Extension: 5 tools, commands, state machine
├── goal-refinement.ts     # Goal refinement: questionnaire TUI + synthesis
├── goal-refinement.test.ts # Tests for goal refinement (30 tests)
├── profiler.ts            # Repo scanning (find, git, grep) + detection
├── prompts.ts             # Flywheel-derived prompt templates
├── sophia.ts              # Sophia CLI wrapper + dependency analysis + merge
├── types.ts               # TypeScript types: state, plans, reviews
├── worktree.ts            # WorktreePool + autoCommitWorktree
├── tender.ts              # SwarmTender: agent health + conflict detection
├── memory.ts              # Compound memory: read/append .pi-orchestrator/memory.md
└── deep-plan.ts           # Direct pi CLI spawning (unused, kept for reference)
```

## Extending

- **New review agents**: add to `peerAgents` array in the peer review handler
- **New prompts**: export from `src/prompts.ts`, follow existing pattern
- **New guided gates**: add to the `gates` array in the sentinel handler
- **New tools**: `pi.registerTool()` + update system prompt

## Known Limitations

- **Gemini + extensions**: Gemini API rejects `patternProperties` in tool schemas from other extensions
- **Limited test coverage**: goal refinement has 30 tests, other modules need coverage
- **Worktree merge conflicts**: detected but not auto-resolved
- **Sub-agent output capture**: some models exit without summary (Gemini particularly)
- **dependsOn is LLM-declared**: the model can forget to set it

## Development

```bash
git clone https://github.com/burningportra/pi-orchestrator.git
cd pi-orchestrator && npm install

# Test locally
pi -e ./src/index.ts
```

## License

MIT
