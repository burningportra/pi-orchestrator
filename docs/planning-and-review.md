# Planning & Review

How pi-orchestrator plans work, gets reviewed, and reaches production quality.

## Where Planning Fits

The orchestration workflow has a strict phase order:

```
profile → discover → select → plan → approve beads → implement → review → gates → done
```

Planning sits between goal selection and implementation. Its job is to produce a
plan document detailed enough that a fresh agent can implement it without guessing,
then convert that plan into dependency-tracked beads (tasks) via the `br` CLI.

Three subsystems guard quality before any code is written:

| Subsystem | File | Purpose |
|-----------|------|---------|
| Plan Quality | `plan-quality.ts` | Score plans on 5 dimensions, gate the plan→bead transition |
| Plan Coverage | `plan-coverage.ts` | Verify every plan section maps to at least one bead |
| Plan Simulation | `plan-simulation.ts` | Validate execution order, detect file conflicts |

## Deep Planning

**Deep planning** runs 3 competing LLM agents, each with a different focus lens,
then synthesizes the best ideas into one plan.

### How It Works

1. User selects "🧠 Deep plan" during goal selection
2. Three agents are spawned in parallel via `runDeepPlanAgents()` (`deep-plan.ts`):
   - **Correctness** — architectural consistency, contract preservation
   - **Robustness** — failure modes, edge cases, rollout safety
   - **Ergonomics** — clarity, maintainability, agent-friendliness
3. Each agent runs `pi --print` with read-only tools (`read,bash,grep,find,ls`)
   and a 3-minute timeout
4. A synthesis step merges the three plans into one document

### Agent Isolation

Deep plan agents run with `--no-extensions --no-skills --no-prompt-templates` to
avoid schema issues (e.g. Gemini's `patternProperties` incompatibility) and
to keep planners focused on planning rather than executing.

### Synthesis

`planSynthesisPrompt()` in `prompts.ts` feeds all three plans to an LLM with
instructions to:

- Pick the strongest ideas from each plan
- Resolve contradictions in favor of the better-justified approach
- Produce a unified markdown document covering architecture, workflows, types,
  API surface, testing, edge cases, file structure, and sequencing

The synthesis can optionally output as a unified diff against Plan 1 for
more surgical merging.

## Plan Quality

`plan-quality.ts` implements an LLM-based quality oracle that scores plans on
5 weighted dimensions:

| Dimension | Weight | What It Measures |
|-----------|--------|------------------|
| Workflows | 25% | Step-by-step user-facing workflows with inputs/outputs/errors |
| Edge Cases | 20% | Explicit failure modes and recovery per workflow |
| Architecture | 20% | Design decisions with tradeoff rationale |
| Specificity | 20% | Concrete types, signatures, parameters |
| Testability | 15% | Derivable test cases and expected behaviors |

### Scoring & Gates

The weighted average produces a composite score (0–100). Three gate levels:

| Score | Recommendation | Effect in Approval UI |
|-------|----------------|----------------------|
| < 60 | `block` | "Accept" is hidden; must refine first |
| 60–79 | `warn` | "Accept" available but refinement suggested |
| ≥ 80 | `proceed` | "Accept" is the default option |

The approval tool (`orch_approve_beads`) scores the plan on first view and
after each refinement round. When the score says `block` or the plan is under
100 lines, the UI offers an "Auto-refine (4 rounds, rotate models)" option
that runs 4 sequential refinement passes with different models.

### Convergence Tracking

Each refinement round records the number of line-level changes. After 3+ rounds
a convergence score (0–1) is computed. Two consecutive rounds with zero changes
triggers a "steady-state" signal, indicating diminishing returns from further
refinement.

## Plan Coverage

`plan-coverage.ts` ensures the plan→bead conversion doesn't lose requirements.

### Two Modes

| Mode | How It Works | When It Runs |
|------|-------------|--------------|
| **Fast (keyword)** | Reuses `auditPlanToBeads()` from `beads.ts` — keyword matching between plan section headings and bead descriptions | Every approval cycle |
| **Deep (LLM)** | Semantic scoring via sub-agent, evaluates how well each bead addresses each plan section's requirements | On demand or when fast mode detects gaps |

### Coverage Result

Each plan section gets a score (0–100):
- **≥ 50** — adequately covered
- **< 50** — gap detected (flagged as `uncovered`)

The overall score is the average across all sections. Gaps are surfaced in the
approval UI with the specific section heading and a preview of what's missing.

## Plan Simulation

`plan-simulation.ts` validates structural properties of the bead graph before
execution starts.

### What Gets Checked

1. **Execution order** — Kahn's algorithm produces a topological sort. If
   cycles exist, the simulation fails immediately.

2. **Parallel groups** — Beads are assigned to execution levels by longest
   dependency chain depth. Beads at the same level can run in parallel.

3. **File conflicts** — If two beads in the same parallel group modify the
   same file, that's a conflict. Sequential beads sharing files is fine.

4. **Missing files** — Files referenced by beads that don't exist in the repo
   are flagged (with a caveat: beads that *create* new files will trigger
   this — treated as warnings, not errors).

### Simulation Output

```typescript
interface SimulationResult {
  valid: boolean;           // false if file conflicts or missing files
  executionOrder: string[]; // topologically sorted bead IDs
  parallelGroups: string[][]; // beads grouped by execution level
  fileConflicts: FileConflict[];
  missingFiles: MissingFileRef[];
  warnings: string[];
}
```

The formatted report is shown during bead approval so issues can be fixed
before any implementation work begins.

## Review System

The review tool (`orch_review` in `tools/review.ts`) is the per-bead quality
gate. It serves three distinct functions depending on the `beadId` parameter.

### Per-Bead Review

When called with an actual bead ID:

1. Records the review verdict (`pass` or `fail`)
2. On pass: closes the bead via `br update --status closed`, syncs to disk
3. Auto-closes parent beads when all subtasks are complete
4. Runs **wrong-space detection** — checks if implementation work included
   unexpected scope that belongs in planning (the Flywheel's #1 diagnostic)
5. Advances to the next ready bead or transitions to guided gates

A completed bead cannot be re-reviewed downward — the guard prevents a
"fresh-eyes" re-review from downgrading a successful bead to partial.

### Guided Gates (`__gates__`)

When `beadId` is `"__gates__"`, the review tool delegates to `runGuidedGates()`
from `gates.ts`. These are post-implementation quality gates run sequentially:

| Gate | Auto? | What It Does |
|------|-------|-------------|
| 🔍 Fresh self-review | Yes | Read all new code with fresh eyes |
| 👥 Peer review | No | Parallel agents review each other's work |
| 🧪 Test coverage | Yes | Check unit + e2e tests, create tasks for gaps |
| ✏️ De-slopify | Yes | Remove AI writing patterns from docs |
| 📦 Commit | No | Logical groupings with detailed messages |
| 🚀 Ship it | No | Tag, release, deploy, monitor CI |
| 🛬 Landing checklist | No | Verify session is resumable |

Gates marked `auto: true` execute immediately. Others present the user with
execute / skip / done options.

**Two clean rounds = done**: The review tool tracks consecutive clean rounds
(pass verdict, no revision instructions). After two consecutive clean rounds,
the user is offered "✅ Finish" — this is the Flywheel's stop condition.

### Phase Regression

Three sentinel `beadId` values allow mechanical regression to earlier phases
when a gate reveals fundamental problems:

| Sentinel | Resets | Target Phase |
|----------|--------|-------------|
| `__regress_to_plan__` | Beads, reviews, gates | `planning` |
| `__regress_to_beads__` | Gates, iteration round | `creating_beads` |
| `__regress_to_implement__` | Gates; re-opens partial beads | `implementing` |

This follows the Flywheel principle: "If a gate fails, drop back a phase
instead of pushing forward optimistically."

## Approval Flow

The approval tool (`orch_approve_beads` in `tools/approve.ts`) manages the
plan→bead transition with multiple rounds of refinement.

### Plan Approval Stage

When the orchestrator has a plan document but no beads yet:

1. Reads the plan artifact from disk
2. Tracks refinement history (change counts per round, convergence score)
3. Runs plan quality scoring (see above)
4. Presents the plan with quality metrics and size info
5. Offers: Accept / Refine / Auto-refine (4 rounds) / Reject

**Size gate**: Plans under 100 lines are flagged as "too short" — the guide
recommends 3,000–6,000+ lines for mature plans.

### Bead Approval Stage

After beads exist:

1. Reads all beads from the `br` CLI
2. Computes a change diff against the previous round's snapshot
3. Tracks convergence (consecutive zero-change rounds = steady state)
4. Runs plan-to-bead coverage analysis
5. Runs execution path simulation
6. Presents beads with all diagnostics
7. Offers: Approve / Polish (another refinement round) / Reject

### Polish Loop

Each refinement round:
- Snapshots all beads (title + description fingerprint + files)
- After the agent refines, diffs against the previous snapshot
- Records change counts in `polishChanges[]`
- Computes convergence score after 3+ rounds
- Auto-approves when convergence ≥ 0.90 or two consecutive zero-change rounds
- Hard cap of 12 polish rounds to prevent infinite loops

### Transition to Implementation

On approval, the orchestrator:
1. Sets phase to `implementing`
2. Uses `bv --robot-next` (graph-theory task routing) to pick the first bead
3. Emits implementer instructions with bead description, acceptance criteria,
   repo context, and previous bead results
4. For multiple ready beads: orders by priority and launches parallel agents
   with staggered delays to avoid file conflicts
