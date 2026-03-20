# pi-orchestrator

A [pi](https://github.com/badlogic/pi-mono) extension that turns "improve this repo" into a structured, multi-agent workflow.

**What it does:** Type `/orchestrate` in any repo → it scans the codebase → proposes improvements → plans the work (optionally with 3 competing AI models) → implements steps in parallel git worktrees → reviews with 4 specialized agents → repeats until you're satisfied.

Based on the [Agentic Coding Flywheel](https://agent-flywheel.com/).

## Architecture

```
/orchestrate
  │
  ├─► orch_profile     — Scan repo (languages, frameworks, commits, TODOs, key files)
  ├─► orch_discover    — LLM generates 3–7 project ideas
  ├─► orch_select      — User picks idea + planning mode:
  │     │
  │     ├─ 📋 Standard    → single plan
  │     └─ 🧠 Deep plan   → 3 competing agents (pick models) → synthesis
  │                           ┌─────────────┐
  │                           │ Gemini plan  │
  │                           │ GPT plan     │──► "best of all worlds" hybrid
  │                           │ Claude plan  │
  │                           └─────────────┘
  │
  ├─► orch_plan        — Plan shown to user for approval
  │     │                Sophia CR + tasks created automatically
  │     │                Parallel groups detected from artifact deps
  │     │                Worktrees created for parallel steps
  │     │
  │     ├─ Parallel steps → parallel_subagents in isolated worktrees
  │     └─ Sequential steps → implement one at a time
  │
  │   ┌─── Per-Step Loop ───────────────────────────────────┐
  │   │  Implement with code tools (read, write, edit, bash) │
  │   │                                                      │
  │   │  orch_review — self-review against criteria          │
  │   │    │                                                 │
  │   │    ├─► 🔥 Hit me — spawn 4 parallel review agents:  │
  │   │    │     • fresh-eyes (bug hunting)                  │
  │   │    │     • polish (de-slopify)                       │
  │   │    │     • ergonomics (agent-friendliness)           │
  │   │    │     • reality-check (are we on track?)          │
  │   │    │   → present findings → hit me again or:         │
  │   │    │                                                 │
  │   │    └─► ✅ Looks good — advance to next step          │
  │   │                                                      │
  │   │  Auto-commit fallback if sub-agents forget to commit │
  │   │  Worktree merge-back on step pass                    │
  │   │  Sophia task checkpoint on step pass                 │
  │   └──────────────────────────────────────────────────────┘
  │
  └─► Post-completion iteration:
        🔥 Hit me — 4 parallel review agents on full project
        ✅ Done — finish orchestration
```

### Key Design Decision

Pi extensions can't call the LLM directly — the LLM calls tools. Instead of an imperative orchestrator, this is a **tool-driven state machine**: each tool advances state and returns context for the next phase.

## Quick Start

```bash
# 1. Install
cd ~/.pi/agent/extensions/
git clone <this-repo> pi-orchestrator
cd pi-orchestrator
npm install

# 2. Use — open any repo in pi, then type:
/orchestrate
```

That's it. The extension walks you through profiling → idea selection → planning → implementation → review.

You can also skip discovery and go straight to a goal:
```bash
/orchestrate add comprehensive error handling
```

Other commands: `/orchestrate-status` (check progress), `/orchestrate-stop` (cancel & clean up).

## Deep Planning (Multi-Model Synthesis)

Based on the [Agentic Coding Flywheel](https://agent-flywheel.com/core-flywheel) competing plans pattern. When you select "🧠 Deep plan":

1. **Pick 3 models** from your available providers (Gemini, GPT, Claude, etc.)
2. **3 parallel agents** each independently create a plan with different focus:
   - Alpha: correctness, minimal scope, clean architecture
   - Beta: robustness, edge cases, testing strategy
   - Gamma: developer experience, ergonomics, extensibility
3. **Synthesis**: the main LLM combines the strongest elements into a hybrid plan
4. The synthesized plan is submitted to `orch_plan` for approval

Agents get read-only tools (`read,bash,grep,find,ls`) and explicit instructions not to call `orch_*` tools or implement anything.

If only one provider is available, all 3 agents use the same model with different focus prompts.

## Sophia Integration

When Sophia is detected (`sophia init` has been run):

- **`orch_plan`** creates a Sophia CR with tasks matching plan steps, each with contracts (intent, acceptance criteria, scope)
- **`orch_review`** checkpoints completed tasks via `sophia cr task done`
- **Post-completion** runs `sophia cr validate` and `sophia cr review`
- **Session restore** re-detects Sophia, queries `getCRStatus` to rebuild full CR state

If Sophia is not installed or not initialized, the orchestrator works without it — no CR tracking, no errors.

## Parallel Execution with Worktree Isolation

When plan steps have no shared file artifacts, they can run in parallel:

1. `analyzeParallelGroups()` builds a dependency graph from artifact overlaps
2. A `WorktreePool` creates isolated git worktrees (`git worktree add`) for each parallel step
3. `parallel_subagents` spawns agents in separate terminal panes, each working in its own worktree
4. On step pass, `autoCommitWorktree` commits any uncommitted changes (fallback for forgetful agents)
5. `mergeWorktreeChanges` merges the worktree branch back with `--no-ff`
6. Worktrees are cleaned up after merge or on `/orchestrate-stop`

If worktree creation fails, falls back to sequential execution in the shared directory.

## Review System

### Per-Step Review
After self-review passes, the user chooses:
- **🔥 Hit me** — spawns 4 parallel review agents (fresh-eyes, polish, ergonomics, reality-check)
- **✅ Looks good** — advance to next step

Each "hit me" round is tracked. You can hit me multiple times per step.

### Post-Completion Review
After all steps pass, the same "🔥 Hit me / ✅ Done" loop runs on the full project.

### Reality Check Agent
Every "hit me" round includes a reality-check agent that answers:
1. Would implementing remaining tasks close the gap?
2. What's actually blocking us?
3. Are there missing tasks the plan didn't account for?
4. Is completed work actually broken despite being marked done?

## Session Persistence & Restore

State persisted via `pi.appendEntry()` (deep-copied):

| Field | Persisted | Restored |
|-------|-----------|----------|
| Phase, plan, step results | ✅ | ✅ from last entry |
| Review verdicts, pass counts | ✅ | ✅ |
| Sophia CR ID, branch, title, task IDs | ✅ | ✅ via `getCRStatus` if sophia available, else from persisted values |
| `hasSophia` flag | ✅ | ✅ re-validated via `isSophiaAvailable` |
| WorktreePool state | ✅ | ✅ via `WorktreePool.fromState` |
| Iteration round counter | ✅ | ✅ |

## Flywheel-Derived Prompts

Prompt functions in `src/prompts.ts` based on the [Agentic Coding Flywheel](https://agent-flywheel.com/complete-guide):

| Function | Flywheel Pattern | Used Where |
|----------|-----------------|-----------|
| `synthesisInstructions()` | Multi-model synthesis | After deep plan agents return |
| `adversarialReviewInstructions()` | Fresh-eyes adversarial review | Per-step review pass |
| `realityCheckInstructions()` | Progress validation | Every hit-me round |
| `implementerInstructions()` | Step implementation briefing | Per-step implementation |
| `polishInstructions()` | De-slopify | Hit-me polish agent |
| `commitStrategyInstructions()` | Logical commit grouping | Post-completion |
| `skillExtractionInstructions()` | Compound learnings into reusable skills | Post-completion |
| `crossAgentReviewInstructions()` | Independent full-diff audit | Post-completion |
| `planToTasksInstructions()` | Detailed task elaboration | Available for task elaboration |

## Commands

| Command | Description |
|---------|-------------|
| `/orchestrate` | Start the full workflow |
| `/orchestrate [goal]` | Skip discovery, go straight to planning with a stated goal |
| `/orchestrate-stop` | Cancel and clean up worktrees |
| `/orchestrate-status` | Show current phase and progress |

## Tools (called by LLM)

| Tool | Phase | Description |
|------|-------|-------------|
| `orch_profile` | Profiling | Scans repo via shell commands, detects Sophia |
| `orch_discover` | Discovery | LLM submits 3–7 structured ideas (enforced minimum) |
| `orch_select` | Selection | User picks idea, constraints, planning mode (standard/deep), models |
| `orch_plan` | Planning | LLM submits plan; creates Sophia CR; detects parallel groups; creates worktrees |
| `orch_review` | Review | Self-review → hit-me prompt → parallel agents → iteration loop |

## Project Structure

```
src/
├── index.ts        # Extension entry: commands, 5 tools, events, state machine
├── profiler.ts     # Repo signal collection (find, git, grep) + language/framework detection
├── prompts.ts      # 10 flywheel-derived prompt templates for each agent phase
├── sophia.ts       # Sophia CLI wrapper: CR/task lifecycle, getCRStatus, parallel analysis, merge
├── types.ts        # TypeScript types: OrchestratorState, phases, plans, review verdicts
├── worktree.ts     # WorktreePool: create/acquire/release/cleanup + autoCommitWorktree
└── deep-plan.ts    # Direct pi CLI spawning for deep plan agents (--no-extensions)
```

## Extending

Add new phases by registering tools and updating the system prompt:

```typescript
pi.registerTool({
  name: "orch_security_review",
  description: "Security-focused review",
  // ...
});
```

Add new "hit me" review agents by appending to the `agentConfigs` array in the hit-me handler.

Add new prompts by exporting functions from `src/prompts.ts` — follow the existing pattern.

Add new post-completion actions by extending the iteration menu in the `orch_review` completion path.

## Known Limitations

- **Parallel dependency analysis is file-only** — steps sharing no files are considered independent even if logically dependent. A `dependsOn` field would fix this.
- **Gemini + extensions** — Gemini API rejects `patternProperties` in tool schemas from other extensions. Deep planning works around this with `--no-extensions`.
- **No tests** — `analyzeParallelGroups`, `WorktreePool`, and other core logic lack unit tests.

## License

MIT
