# Current Capabilities Map

Maps pi-orchestrator's existing capabilities to the 10 sections of the [Agentic Coding Flywheel](https://agent-flywheel.com/).

---

## 1. Complete Workflow

The orchestrator provides an end-to-end `/orchestrate` command that moves through Discovery → Planning → Implementation → Review → Completion phases.

| Capability | Source | Details |
|------------|--------|---------|
| Phase state machine | `src/index.ts` — `OrchestratorPhase` type, `setPhase()` | 13 phases: idle → profiling → discovering → awaiting_selection → planning → creating_beads → refining_beads → awaiting_bead_approval → implementing → reviewing → iterating → complete |
| Session persistence & restore | `src/index.ts` — `session_start` handler, `persistState()` | Survives session restarts; re-detects coordination backends, restores worktree pool and bead progress |
| Status widget | `src/index.ts` — `updateWidget()` | Live status bar showing phase, repo, goal, bead progress, tender state |
| Commands | `src/commands.ts` — `registerCommands()` | `/orchestrate`, `/orchestrate-status`, `/orchestrate-reset` |

## 2. Planning (85%)

Goal refinement, idea generation, and multi-model deep planning.

| Capability | Source | Details |
|------------|--------|---------|
| Repo profiling | `src/scan.ts` — `scanRepo()` | Dual-provider scan: ccc-backed (semantic code search) with fallback to built-in profiler (`src/profiler.ts`) |
| Scan contract | `src/scan.ts` — `ScanProvider`, `ScanResult`, `ScanCodebaseAnalysis` | Pluggable provider interface with normalized recommendations, insights, quality signals |
| Context priority | `src/scan.ts` | Live codebase scan > repo profile > commits/TODOs > CASS memory |
| Idea generation | `src/tools/discover.ts` — `registerDiscoverTool()` | LLM generates 25-30 candidates, scores against 5 weighted axes, winnows to 10-15 tiered ideas |
| Idea selection | `src/tools/select.ts` — `registerSelectTool()` | Grouped by tier (top/honorable), custom goal path triggers refinement |
| Goal refinement | `src/goal-refinement.ts` — `runGoalRefinement()`, `refineGoal()`, `synthesizeGoal()` | Interactive TUI questionnaire sharpening raw goals into structured specs |
| Constraint extraction | `src/goal-refinement.ts` — `extractConstraints()` | Pull constraint strings from refinement answers |
| Deep planning | `src/deep-plan.ts` — `runDeepPlanAgents()` | 3 parallel LLM agents (correctness / robustness / ergonomics focus) with synthesis into unified bead set |
| Discovery persistence | `src/tools/select.ts` | Ideas saved as session artifact `discovery/ideas-<timestamp>.md` |
| CASS memory integration | `src/memory.ts` — `getContext()`, `readMemory()` | Prior learnings injected during profiling phase |

## 3. Creating & Refining Plan

Bead creation, refinement passes, and quality validation.

| Capability | Source | Details |
|------------|--------|---------|
| Bead creation prompt | `src/prompts.ts` — `beadCreationPrompt()` | Instructs LLM to create beads via `br create` + `br dep add` |
| Bead refinement prompt | `src/prompts.ts` — `beadRefinementPrompt()` | Same-agent polish of bead descriptions/deps |
| Fresh-context refinement | `src/prompts.ts` — `freshContextRefinementPrompt()` | Fresh sub-agent review (no anchoring bias) via `pi --print` |
| Convergence scoring | `src/prompts.ts` — `computeConvergenceScore()` | Weighted score (velocity + size stability + zero-change streak); auto-stops at ≥90% or steady-state |
| Quality checklist gate | `src/beads.ts` — `qualityCheckBeads()` | Scores each bead on WHAT/WHY/HOW (1-5 scale) via `beadQualityScoringPrompt` |
| Bead validation | `src/beads.ts` — `validateBeads()` | Structural checks on bead graph |
| Blunder hunt | `src/prompts.ts` — `blunderHuntInstructions()` | Adversarial review prompt: "find at least 80 errors" |
| Dedup check | `src/prompts.ts` (bead dedup prompt) | Detects overlapping beads before implementation |

## 4. Plan to Beads

Translation of plans into executable bead graph with dependencies.

| Capability | Source | Details |
|------------|--------|---------|
| br CLI wrapper | `src/beads.ts` — `readBeads()`, `readyBeads()`, `getBeadById()`, `beadDeps()` | Full CRUD over bead lifecycle |
| Dependency management | `src/beads.ts` — `beadDeps()` | Via `br dep add`; cycle detection handled by br CLI |
| Status tracking | `src/beads.ts` — `updateBeadStatus()` | open → in_progress → closed |
| Artifact extraction | `src/beads.ts` — `extractArtifacts()` | Parse file paths from bead descriptions |
| Orphan remediation | `src/beads.ts` — `remediateOrphans()` | Fix disconnected beads in the graph |
| Sync | `src/beads.ts` — `syncBeads()` | `br sync --flush-only` |
| bv integration | `src/beads.ts` — `detectBv()`, `bvInsights()`, `bvNext()` | Smart next-bead pick and graph health insights |
| Bead summary | `src/beads.ts` — `getBeadsSummary()` | Human-readable summary of bead set |

## 5. Check Beads N Times

Multi-round review and approval flow before implementation begins.

| Capability | Source | Details |
|------------|--------|---------|
| Approval flow | `src/tools/approve.ts` — `registerApproveTool()` | ▶️ Start / 🔍 Polish / ⚙️ Advanced / ❌ Reject |
| Same-agent polish | `src/prompts.ts` — `beadRefinementPrompt()` | Round 0 in-context refinement |
| Fresh-agent review | `src/prompts.ts` — `freshContextRefinementPrompt()` | Round 1+ fresh sub-agent (no anchoring) |
| Cross-model review | `src/bead-review.ts` — `crossModelBeadReview()`, `parseSuggestions()` | Alternative AI model reviews full bead set |
| Convergence auto-stop | `src/prompts.ts` — `computeConvergenceScore()` | Stops at steady-state (2× zero-change) or ≥90% convergence |
| Advanced options menu | `src/tools/approve.ts` | Fresh-agent, same-agent, blunder hunt, dedup check, cross-model review, graph health fix |

## 6. Coordination Stack

Multi-agent coordination, messaging, and conflict prevention.

| Capability | Source | Details |
|------------|--------|---------|
| Backend detection | `src/coordination.ts` — `detectCoordinationBackend()` | Auto-detects beads, agent-mail, sophia availability |
| Strategy selection | `src/coordination.ts` — `selectStrategy()` | `beads+agentmail` > `sophia` > `worktrees` |
| Agent Mail RPC | `src/agent-mail.ts` — `agentMailRPC()`, `ensureAgentMailProject()` | JSON-RPC calls to agent-mail MCP server for messaging + file reservations |
| Agent Mail task preamble | `src/agent-mail.ts` — `agentMailTaskPreamble()` | Injects agent-mail bootstrap instructions into sub-agent tasks |
| AGENTS.md generation | `src/agents-md.ts` — `ensureAgentMailSection()` | Writes/updates agent-mail + beads integration docs in AGENTS.md |
| Sophia integration | `src/sophia.ts` | CR lifecycle, task contracts, dependency analysis, merge |
| File reservation helpers | `src/agent-mail.ts` — `amRpcCmd()` | Generate curl commands for file reservations |

## 7. Launching the Swarm

Parallel agent execution with worktree isolation and health monitoring.

| Capability | Source | Details |
|------------|--------|---------|
| Worktree pool | `src/worktree.ts` — `WorktreePool` class | Creates/manages isolated git worktrees for parallel agents |
| Worktree CRUD | `src/worktree.ts` — `createWorktree()`, `removeWorktree()`, `listWorktrees()` | `git worktree add/remove/list` |
| Auto-commit | `src/worktree.ts` — `autoCommitWorktree()` | Fallback commit for uncommitted agent changes |
| Swarm tender | `src/tender.ts` — `SwarmTender` class | Polls every 60s; classifies agents as active/idle/stuck; detects file conflicts across worktrees |
| Conflict alerts | `src/tender.ts` — `ConflictAlert` | Flags same file modified in multiple worktrees |
| Swarm marching orders | `src/prompts.ts` — `swarmMarchingOrders()` | Canonical prompt for swarm kickoff |
| Hit-me review agents | `src/index.ts` — `runHitMeAgents()` | 5 parallel review agents via `pi --print` |
| Implementer instructions | `src/prompts.ts` — `implementerInstructions()` | "Read, understand, be proactive" + self-review before commit |

## 8. Review Testing Hardening

Per-bead review, post-implementation gates, and quality enforcement.

| Capability | Source | Details |
|------------|--------|---------|
| Per-bead review | `src/tools/review.ts` — `registerReviewTool()` | 🔥 Hit me (5 parallel agents) or ✅ Looks good |
| Guided gates | `src/gates.ts` — `runGuidedGates()` | 7-step sequential flow: self-review → peer review → test coverage → de-slopify → commit → ship → landing |
| Review prompts | `src/prompts.ts` — `reviewerInstructions()`, `adversarialReviewInstructions()`, `crossAgentReviewInstructions()` | Fresh-eyes, adversarial, and cross-agent review perspectives |
| Reality check | `src/prompts.ts` — `realityCheckInstructions()` | "Do we actually have the thing?" verification |
| Random exploration | `src/prompts.ts` — `randomExplorationInstructions()` | Explore files NOT in the change set |
| De-slopify | `src/prompts.ts` — `deSlopifyInstructions()` | Remove AI writing patterns from docs; auto-skips if no docs changed |
| Commit strategy | `src/prompts.ts` — `commitStrategyInstructions()` | Logical commit groupings with detailed messages |
| Landing checklist | `src/prompts.ts` — `landingChecklistInstructions()` | Session completion verification |
| Polish | `src/prompts.ts` — `polishInstructions()` | Code polish pass |

## 9. Complete Toolchain

Registered tools, CLI integrations, and extension infrastructure.

| Capability | Source | Details |
|------------|--------|---------|
| `orch_profile` | `src/tools/profile.ts` | Scan repo + load CASS memory |
| `orch_discover` | `src/tools/discover.ts` | Generate scored improvement ideas |
| `orch_select` | `src/tools/select.ts` | User picks idea or enters custom goal |
| `orch_approve_beads` | `src/tools/approve.ts` | Bead approval + refinement flow |
| `orch_review` | `src/tools/review.ts` | Per-bead review + next-bead selection |
| `orch_memory` | `src/tools/memory-tool.ts` | CASS memory: stats, search, list, context, mark |
| System prompt injection | `src/index.ts` — `before_agent_start` | Injects orchestrator system prompt when active |
| Research prompts | `src/prompts.ts` — `researchInvestigatePrompt()`, `researchDeepenPrompt()`, `researchInversionPrompt()` | External project study + competitive analysis |
| Summary | `src/prompts.ts` — `summaryInstructions()` | Session summary generation |

## 10. Flywheel Effect

Continuous learning, memory, and cross-session improvement.

| Capability | Source | Details |
|------------|--------|---------|
| CASS read | `src/memory.ts` — `readMemory()`, `getContext()` | Relevance-scored rules + anti-patterns injected at profiling |
| CASS write | `src/memory.ts` — `appendMemory()` | LLM extracts learnings at completion |
| CASS feedback | `src/memory.ts` — `markRule()` | Mark rules helpful/harmful to improve future scoring |
| CASS search | `src/memory.ts` — `searchMemory()` | Semantic similarity search across memory |
| CASS stats | `src/memory.ts` — `getMemoryStats()` | Entry count, availability status |
| Memory list | `src/memory.ts` — `listMemoryEntries()` | Browse all stored entries |
| Graceful degradation | `src/memory.ts` — `detectCass()` | No cm CLI → empty results, no errors |
| Discovery artifacts | `src/tools/select.ts` | Ideas persisted for follow-up runs |
| Session state restore | `src/index.ts` — `session_start` handler | Full state reconstruction across sessions |
