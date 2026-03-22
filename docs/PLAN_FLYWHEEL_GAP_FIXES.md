# Plan: Closing the Flywheel Gaps

Comprehensive implementation plan for addressing the gaps identified in `docs/flywheel-gap-analysis.md`. Organized into 5 workstreams, each independent enough to be worked in parallel once foundations are laid.

---

## Table of Contents

1. [Workstream A: Plan Phase](#workstream-a-plan-phase)
2. [Workstream B: bv-Driven Bead Selection](#workstream-b-bv-driven-bead-selection)
3. [Workstream C: Single-Branch Coordination Mode](#workstream-c-single-branch-coordination-mode)
4. [Workstream D: Swarm Launch Improvements](#workstream-d-swarm-launch-improvements)
5. [Workstream E: Minor Gaps & Polish](#workstream-e-minor-gaps--polish)
6. [Dependency Graph](#dependency-graph)
7. [Testing Strategy](#testing-strategy)
8. [Risk Analysis](#risk-analysis)

---

## Workstream A: Plan Phase

**Gap addressed:** #1 — No standalone markdown plan phase (Significant)

### Problem

pi-orchestrator jumps from goal selection directly to bead creation. The flywheel's core thesis is that 85% of effort belongs in plan-space, where global reasoning is cheap. Without a plan phase, architectural decisions get made in bead-space (5× rework cost) or code-space (25× rework cost).

The deep planning system (`src/deep-plan.ts`) partially covers this — it runs 3 competing models and synthesizes. But it produces beads directly, not an intermediate plan document that can be iterated, refined, and audited before bead conversion.

### Design

Add an optional **plan phase** between goal selection and bead creation. The user chooses their workflow:

```
Goal selected →
  ├─ 📋 Plan first (new) → plan doc → refine → convert to beads → approve
  ├─ 🧠 Deep plan (existing) → multi-model beads → approve  
  └─ ⚡ Direct to beads (existing) → single-model beads → approve
```

#### A1. New OrchestratorPhase: `planning_doc`

Add a new phase `planning_doc` between `awaiting_selection` and `creating_beads`. This phase:
1. LLM generates a comprehensive markdown plan document from the goal + repo profile
2. Plan is saved as a session artifact (`plans/<goal-slug>.md`)
3. User sees the plan and chooses: refine / accept / reject

**Files:** `src/types.ts` (add phase), `src/index.ts` (state machine transitions)

#### A2. Plan Generation Prompt

New prompt `planDocumentPrompt()` in `src/prompts.ts`. Instructs the LLM to produce a comprehensive plan covering:
- Architecture overview
- User-visible workflows
- Data model and key types
- API surface
- Testing strategy
- Edge cases and failure modes
- File structure
- Sequencing (what depends on what)

The prompt should reference the repo profile and scan results for grounding.

**Files:** `src/prompts.ts`

#### A3. Multi-Model Competing Plans

Reuse the existing `runDeepPlanAgents()` infrastructure from `src/deep-plan.ts`, but have agents produce plan documents instead of beads. Each agent gets a different lens:
- Agent 1: Architecture & correctness focus
- Agent 2: Robustness & failure modes focus  
- Agent 3: Ergonomics & developer experience focus

Then synthesize using the existing `synthesisInstructions()` prompt.

**Files:** `src/deep-plan.ts` (parameterize to output plan docs or beads), `src/prompts.ts` (plan synthesis variant)

#### A4. Plan Refinement Loop

After the initial plan is generated:
1. Show plan to user (via tool return or artifact link)
2. Offer: **🔍 Refine** / **✅ Accept → create beads** / **❌ Reject**
3. Refinement uses a fresh sub-agent (`pi --print`) with `planRefinementPrompt()` — same fresh-eyes technique as bead polishing
4. Track convergence using the same `computeConvergenceScore()` machinery (changes per round)
5. Auto-suggest acceptance when convergence ≥ 75%

**Files:** `src/tools/approve.ts` (or new `src/tools/plan-approve.ts`), `src/prompts.ts`

#### A5. Plan-to-Bead Conversion

When the user accepts the plan, transition to bead creation with a specialized `planToBeadsPrompt()` that:
- References the plan document by path
- Instructs "embed all context in beads — never reference 'see the plan'"
- Requires `### Files:` section in each bead
- Runs the plan-to-bead transfer audit (both directions) as a quality gate

**Files:** `src/prompts.ts`, `src/beads.ts` (add `planToBeadAudit()`)

#### A6. Plan-to-Bead Transfer Audit

**Gap addressed:** #10 — No plan-to-bead transfer audit

New function `planToBeadAudit()` that:
1. Reads the plan document
2. Reads all beads via `br list --json`
3. Asks LLM: "For each section of the plan, which bead(s) cover it? For each bead, which plan section does it implement? Flag any plan sections with no bead and any beads with no clear plan backing."
4. Returns a coverage report

This runs automatically after plan-to-bead conversion and surfaces gaps before the user approves beads.

**Files:** `src/beads.ts` (new function), `src/prompts.ts` (audit prompt)

### State Machine Changes

```
Current: awaiting_selection → creating_beads → awaiting_bead_approval
New:     awaiting_selection → planning_doc → creating_beads → awaiting_bead_approval
                            ↑______refine_____↓
```

The `planning_doc` phase is **optional** — "Direct to beads" and "Deep plan" skip it entirely.

---

## Workstream B: bv-Driven Bead Selection

**Gap addressed:** #2 — bv graph-theory routing not used for agent bead selection

### Problem

`bvNext()` and `bvInsights()` exist in `src/beads.ts` and are used in `src/tools/review.ts` line 289. But when sub-agents are launched for implementation, they primarily use `br ready` (which returns beads in arbitrary order) rather than `bv --robot-next` (which uses PageRank/betweenness to pick the highest-impact bead).

### Design

#### B1. bv-First Bead Ordering in Parallel Launch

When `orch_approve_beads` launches parallel sub-agents (the `parallel_subagents` JSON block in the approve tool return), order beads by bv priority:

1. Call `bvNext()` repeatedly or `bv --robot-plan` to get ordered execution tracks
2. Assign beads to parallel agents in bv priority order
3. If bv is unavailable, fall back to `br ready` (current behavior)

**Files:** `src/tools/approve.ts` (bead ordering before launch), `src/beads.ts` (add `bvPlan()` wrapper for `bv --robot-plan`)

#### B2. Inject bv Instructions into Sub-Agent Tasks

When constructing sub-agent task strings, add: "When you finish this bead and need to pick the next one, use `bv --robot-next` instead of `br ready`."

Currently `implementerInstructions()` in `src/prompts.ts` line 417 doesn't mention bv. Add bv usage to the implementer instructions.

**Files:** `src/prompts.ts` (update `implementerInstructions()`)

#### B3. bv Bottleneck Warning in Approve Flow

During `orch_approve_beads`, if bv is available, run `bv --robot-insights` and surface any high-betweenness bottleneck beads as a warning. This already partially exists (graph health in approve flow) but should be more prominent.

**Files:** `src/tools/approve.ts`

---

## Workstream C: Single-Branch Coordination Mode

**Gap addressed:** #4 — No agent-mail file reservations enforced during parallel execution, #6 — Worktrees divergence

### Problem

pi-orchestrator uses git worktrees for parallel execution (safe isolation but merge overhead). The flywheel advocates single-branch + Agent Mail file reservations (immediate conflict visibility, no merge). Both are valid — the plan is to **support both modes** so users can choose.

### Design

#### C1. Coordination Mode Selection

Add a coordination mode enum: `"worktree"` (current default) | `"single-branch"` (new flywheel-style).

The mode is selected based on:
1. If Agent Mail is available → offer `single-branch` as an option
2. If Agent Mail is unavailable → use `worktree` (current behavior)
3. User can override via `/orchestrate --mode single-branch`

**Files:** `src/types.ts` (add `CoordinationMode`), `src/coordination.ts` (mode selection), `src/index.ts` (pass mode through)

#### C2. Single-Branch Parallel Execution

New execution path when mode is `single-branch`:

1. **No worktree creation** — all agents work in the same directory
2. **File reservations** — before launching each agent, call Agent Mail to reserve the files listed in the bead's `### Files:` section
3. **Agent task preamble** includes reservation instructions: "Check reservations before editing. Reserve files you need. Release when done."
4. **Pre-commit guard** — agents should check reservations before committing (advisory, not blocking)
5. **Conflict detection** — SwarmTender adapted to detect same-file-modified-by-multiple-agents via `git diff` instead of worktree comparison

**Files:** `src/worktree.ts` (add single-branch path or new `src/single-branch.ts`), `src/agent-mail.ts` (file reservation helpers), `src/tender.ts` (adapt for single-branch)

#### C3. File Reservation Helpers

Add high-level helpers in `src/agent-mail.ts`:
- `reserveFiles(pi, cwd, agentName, files, beadId)` — reserve files via Agent Mail RPC
- `releaseFiles(pi, cwd, agentName, files)` — release reservations
- `checkReservations(pi, cwd, files)` — check if files are reserved by another agent

These wrap the low-level `agentMailRPC()` calls that already exist.

**Files:** `src/agent-mail.ts`

#### C4. Agent Task Preamble for Single-Branch Mode

Update `agentMailTaskPreamble()` in `src/agent-mail.ts` to include file reservation instructions when running in single-branch mode. The preamble should tell agents:
1. Bootstrap with Agent Mail
2. Reserve your bead's files before editing
3. Commit and push after each logical unit
4. Release reservations when done
5. Pull before starting work

**Files:** `src/agent-mail.ts`

---

## Workstream D: Swarm Launch Improvements

**Gap addressed:** #3 — No staggered launch, #5 — No persistent identity, #9 — No post-compaction re-read

### Design

#### D1. Staggered Agent Launch

The constant `SWARM_STAGGER_DELAY_MS = 30_000` already exists in `src/prompts.ts` line 840 but is **never used in runtime code**. Wire it up:

When `orch_approve_beads` returns a `parallel_subagents` block with N agents, the orchestrator should instruct pi to stagger launches by `SWARM_STAGGER_DELAY_MS` between each agent.

**Approach:** The `parallel_subagents` tool doesn't natively support staggered launch. Two options:
1. **Option A (simple):** Instead of one `parallel_subagents` call, emit N sequential `subagent` calls with `sleep(SWARM_STAGGER_DELAY_MS)` between them. Loses parallel launch but gains staggering.
2. **Option B (better):** Add a `stagger_ms` field to the `parallel_subagents` agents config (requires pi framework support). If not available, fall back to Option A.
3. **Option C (pragmatic):** Since `orch_approve_beads` returns a JSON suggestion to the LLM (which then calls `parallel_subagents`), add a note in the return text: "Launch agents with 30-second gaps between each." This relies on the LLM to execute sequentially.

**Recommended: Option A** — emit sequential subagent calls with delays. This is fully within the orchestrator's control.

**Files:** `src/tools/approve.ts` (change parallel launch to staggered sequential), `src/prompts.ts` (document stagger in implementer instructions)

#### D2. Agent Identity via Agent Mail

When agents bootstrap with Agent Mail (via `agentMailTaskPreamble()`), they already get semi-persistent identities. The gap is that this only happens when Agent Mail is available, and identities don't carry across bead boundaries (ephemeral agents).

For the single-branch mode (Workstream C), agent identity is natural — agents register once and work across multiple beads. For worktree mode, the identity dies with the sub-agent.

**Design decision:** Don't try to make worktree-mode agents persistent. Instead, ensure single-branch mode agents are properly identitied via Agent Mail. This is handled by C4.

**Files:** No additional changes beyond C4.

#### D3. Post-Compaction AGENTS.md Re-Read

**Gap addressed:** #9

The flywheel's most common prompt is "Reread AGENTS.md so it's still fresh in your mind" after context compaction. pi-orchestrator's sub-agents are ephemeral (no compaction), so this mostly doesn't apply.

However, for long-running orchestration sessions where the main agent compacts, the orchestrator system prompt (injected via `before_agent_start`) should include: "If you've just experienced context compaction, re-read AGENTS.md immediately."

**Files:** `src/prompts.ts` (add compaction recovery note to `orchestratorSystemPrompt()`)

#### D4. Agent Fungibility — De-Specialize Review Agents

**Gap addressed:** Agent fungibility (kernel invariant #6)

Currently, hit-me review agents have specialized roles:
- fresh-eyes
- polish  
- ergonomics
- reality-check
- random-exploration

The flywheel argues against specialist agents (invariant #6). However, pi-orchestrator's review agents are ephemeral and short-lived — specialization here is more like "different review prompts" than "specialist identities." The risk is low.

**Design decision:** Keep the specialized review prompts (they produce better reviews) but frame them differently:
1. Rename from role-based ("fresh-eyes agent") to prompt-based ("review with fresh-eyes prompt")
2. Any agent can run any review prompt — they're interchangeable
3. Document this distinction in architecture.md

This is a framing change, not a code change. The current implementation already treats review agents as fungible (any model, spawned fresh each time).

**Files:** `docs/architecture.md` (update review section framing)

---

## Workstream E: Minor Gaps & Polish

#### E1. UBS Integration (Optional)

**Gap addressed:** #7 — No UBS

If `ubs` CLI is available, run it as part of the test coverage gate:
1. Detect `ubs` in PATH
2. During the test coverage guided gate, run `ubs <changed-files>`
3. Surface findings in the gate output

**Files:** `src/gates.ts` (add UBS check), `src/coordination.ts` (add UBS detection)

#### E2. Structured Learnings Extraction

**Gap addressed:** #8 — No recursive self-improvement

The current completion flow calls `appendMemory()` which prompts the LLM to add learnings. Make this more structured:

1. After completion, run a dedicated `learningsExtractionPrompt()` that asks specific questions:
   - What architectural decisions were made and why?
   - What gotchas or surprises were encountered?
   - What patterns worked well?
   - What would you do differently next time?
2. Each answer becomes a separate `cm add` call with appropriate categories
3. Include the bead IDs so learnings are traceable

**Files:** `src/prompts.ts` (new `learningsExtractionPrompt()`), `src/memory.ts` (structured extraction)

#### E3. Validation Gates Alignment

**Gap addressed:** Flywheel §9 validation gates

The flywheel prescribes 6 validation gates. pi-orchestrator has 7 guided gates. Map them explicitly:

| Flywheel Gate | pi-orchestrator Gate | Status |
|---------------|---------------------|--------|
| Foundation | Not explicit | Add check in profile phase |
| Plan | New plan phase (A4) | Add with Workstream A |
| Translation | Plan-to-bead audit (A6) | Add with Workstream A |
| Bead | Quality checklist gate | ✅ Exists |
| Per-bead | Fresh-eyes review | ✅ Exists |
| Ship | Landing checklist | ✅ Exists |

Add a "foundation gate" that verifies AGENTS.md, test framework, and build tooling exist before proceeding past discovery.

**Files:** `src/tools/profile.ts` (foundation gate check)

---

## Dependency Graph

```
A1 (phase type) ──► A2 (plan prompt) ──► A3 (multi-model plans) ──► A4 (refinement loop) ──► A5 (plan-to-beads) ──► A6 (transfer audit)
                                                                                                  
B1 (bv ordering) ──► B2 (bv in implementer) ──► B3 (bottleneck warning)

C1 (mode selection) ──► C2 (single-branch exec) ──► C3 (reservation helpers) ──► C4 (task preamble)

D1 (staggered launch) [independent]
D3 (compaction re-read) [independent]
D4 (fungibility framing) [independent]

E1 (UBS) [independent]
E2 (structured learnings) [independent]
E3 (validation gates) → depends on A4 for plan gate
```

**Parallel groups:**
- Group 1 (independent): B1-B3, D1, D3, D4, E1, E2
- Group 2 (depends on types): A1-A2, C1
- Group 3 (depends on Group 2): A3-A6, C2-C4, E3

---

## Testing Strategy

### Unit Tests

| Component | Test Focus |
|-----------|-----------|
| `planDocumentPrompt()` | Prompt contains repo profile, goal, scan results |
| `planToBeadAudit()` | Returns coverage report; detects missing coverage |
| `computeConvergenceScore()` | Already tested; extend for plan refinement |
| `bvPlan()` | Parses `bv --robot-plan` output correctly |
| `reserveFiles()` / `releaseFiles()` | Agent Mail RPC called with correct params |
| Stagger logic | Delays between agent launches |
| Mode selection | Correct mode based on backend availability |

### Integration Tests

| Scenario | What to verify |
|----------|---------------|
| Plan phase → bead creation flow | Plan artifact saved, beads reference plan |
| Single-branch parallel execution | No worktree created, file reservations called |
| bv-ordered parallel launch | Agents launched in bv priority order |
| Staggered launch timing | Agents start ≥30s apart |

### Existing Tests

`npm test` must pass after every change. Key existing test files:
- `src/beads.test.ts` — bead CRUD, bvInsights, bvNext
- `src/coordination.test.ts` — backend detection
- `src/flywheel.test.ts` — prompt templates, convergence scoring

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Plan phase adds too much friction for small changes | High | Medium | Make it optional; "Direct to beads" remains the default for system-suggested ideas |
| Single-branch mode causes merge conflicts | Medium | High | Advisory reservations + SwarmTender conflict detection; worktree mode remains available |
| bv not installed → degraded experience | Medium | Low | Already handled: `detectBv()` returns null, falls back to `br ready` |
| Staggered launch slows down small parallel groups | Low | Low | Only stagger when N > 2 agents |
| Plan document becomes stale during implementation | Medium | Medium | Plan-to-bead transfer audit ensures all plan content is in beads before implementation starts |

---

## Implementation Order (Recommended)

1. **Sprint 1 (foundation):** A1 + A2 + D1 + D3 — add plan phase type, basic prompt, wire stagger constant, compaction note
2. **Sprint 2 (plan phase):** A3 + A4 + A5 + A6 — full plan phase with multi-model, refinement, conversion, audit
3. **Sprint 3 (bv + coordination):** B1 + B2 + B3 + C1 — bv ordering, mode selection
4. **Sprint 4 (single-branch):** C2 + C3 + C4 — single-branch execution path
5. **Sprint 5 (polish):** D4 + E1 + E2 + E3 — fungibility framing, UBS, learnings, gates

Each sprint should be completable in 1-2 orchestration sessions.

---

## Estimated Effort

| Workstream | Beads | Effort | Priority |
|-----------|-------|--------|----------|
| A: Plan Phase | 6 | High | P1 — addresses the #1 gap |
| B: bv Selection | 3 | Low | P1 — quick win, code mostly exists |
| C: Single-Branch | 4 | High | P2 — significant new code path |
| D: Swarm Launch | 4 | Low-Medium | P1 — D1 is a quick win |
| E: Minor Gaps | 3 | Low | P3 — polish |
| **Total** | **20** | | |
