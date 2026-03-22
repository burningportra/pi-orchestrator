# Flywheel Gap Analysis

Comparison of the [Agent Flywheel Complete Guide](https://agent-flywheel.com/complete-guide) against pi-orchestrator's current capabilities.

---

## Priority Summary: Top 10 Gaps

| # | Gap | Severity | Section |
|---|-----|----------|---------|
| 1 | No standalone markdown plan phase (deep planning partially covers reasoning) | Significant | §2-3 |
| 2 | bv graph-theory routing not used for agent bead selection | Significant | §6 |
| 3 | No staggered agent launch / thundering herd prevention | Significant | §7 |
| 4 | No agent-mail file reservations enforced during parallel execution | Significant | §6 |
| 5 | No multi-agent swarm with persistent identity & coordination | Significant | §7 |
| 6 | Worktrees used instead of single-branch model (deliberate divergence) | Divergence | §6 |
| 7 | No UBS / DCG / SLB safety tooling | Minor | §9 |
| 8 | No recursive self-improvement / skill refinement loop | Minor | §10 |
| 9 | No post-compaction AGENTS.md re-read enforcement | Minor | §7 |
| 10 | No plan-to-bead transfer audit (both-directions coverage check) | Minor | §4-5 |

---

## Section-by-Section Analysis

### §1 Complete Workflow

**Status: ✅ Fully covered (with different emphases)**

pi-orchestrator implements the full arc: scan → discover → select → plan → create beads → approve → implement → review → complete. The phase state machine (`OrchestratorPhase` in `src/index.ts`) covers 13 states with session persistence.

**Where pi-orchestrator exceeds the guide:**
- Dual-provider scan contract (ccc + built-in fallback) — the guide assumes ccc is always available
- Session persistence and restore across restarts
- Live status widget showing phase/progress

---

### §2-3 Planning (85%) & Creating the Markdown Plan

**Status: 🔴 Critical gap — no standalone plan document phase**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| 3,000-6,000 line markdown plan as primary artifact | No plan document; goes straight from idea → beads | **Critical** |
| Multi-model competing plans (GPT Pro + Opus + Gemini + Grok) | Deep planning uses 3 models but for bead creation, not plan creation | Significant |
| 4-5 rounds of fresh-conversation refinement of the plan | Goal refinement questionnaire only | Significant |
| Best-of-all-worlds synthesis prompt for plan merging | `synthesisInstructions` exists but applied at bead level | Partial |
| Foundation bundle (AGENTS.md, best practices, tech stack) | AGENTS.md generation exists; no best-practices guides | Minor |
| Plan-space reasoning before bead-space | Jumps from idea selection to bead creation | **Critical** |
| Three reasoning spaces (plan/bead/code) explicitly separated | Only bead-space and code-space | Significant |

**Severity: Critical** — The flywheel's core thesis is that 85% of time should be spent in plan-space. pi-orchestrator skips this entirely, going from a one-line goal description to bead creation. This means architectural decisions that should happen cheaply in plan-space get made expensively in bead-space or code-space.

**Suggested fix:** Add an optional "plan phase" between goal selection and bead creation. The LLM would produce a comprehensive markdown plan document, optionally run multi-model competing plans, synthesize, and iterate 2-3 rounds before converting to beads. This could be offered as a "📋 Plan first" option alongside the current "direct to beads" flow for smaller changes.

---

### §4 Converting Plan to Beads

**Status: 🟡 Mostly covered, one notable gap**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| Plan-to-beads as distinct translation problem | `beadCreationPrompt()` instructs LLM to create beads | ✅ |
| Self-contained beads with embedded context | Quality gate (WHAT/WHY/HOW scoring) enforces this | ✅ |
| `### Files:` section in each bead | Required in bead creation prompt | ✅ |
| Explicit dependencies via `br dep add` | Full dependency management in `src/beads.ts` | ✅ |
| Plan-to-bead transfer audit (both directions) | No explicit coverage check against source plan | **Minor gap** |
| Never write pseudo-beads in markdown | Enforced by directing LLM to use `br create` | ✅ |

**Suggested fix:** Add a `planToBeadAudit` prompt that cross-references the plan document (if one exists) against beads in both directions to ensure nothing was lost.

---

### §5 Check Your Beads N Times

**Status: ✅ Well covered, exceeds in some areas**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| 4-6+ polishing rounds | Approval flow with unlimited polish rounds | ✅ |
| Fresh eyes technique (new session) | `freshContextRefinementPrompt()` via `pi --print` | ✅ |
| Convergence detection | `computeConvergenceScore()` with auto-stop at ≥90% | ✅ |
| Dedup check | Bead dedup prompt in approval flow | ✅ |
| Blunder hunt ("lie to them") | `blunderHuntInstructions()` | ✅ |
| Cross-model review | `crossModelBeadReview()` in `src/bead-review.ts` | ✅ |
| Idea-wizard 30→5→15 funnel | Idea generation uses 25-30→10-15 funnel | ✅ (variant) |

**Where pi-orchestrator exceeds the guide:**
- Automated convergence auto-stop (the guide describes manual judgment)
- Quality checklist gate with numeric WHAT/WHY/HOW scoring
- Graph health analysis via bv integration
- Advanced options sub-menu with all review modes accessible

---

### §6 The Coordination Stack

**Status: 🟡 Partially covered, significant architectural differences**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| Agent Mail + Beads + bv triangle | Agent Mail + Beads integrated; bv detected but underused | **Significant** |
| No worktrees, single-branch model | Uses worktrees (`WorktreePool`) for parallel execution | **Significant** |
| Advisory file reservations with TTL | Agent Mail RPC available but not enforced during parallel exec | **Significant** |
| bv `--robot-triage` / `--robot-next` for bead selection | `bvNext()` and `bvInsights()` exist but agents use `br ready` primarily | **Significant** |
| Agent fungibility (no specialists) — kernel invariant #6 | Hit-me agents have specialized roles (fresh-eyes, polish, ergonomics, reality-check) | **Significant** |
| Bead IDs as Agent Mail thread anchors | Agent Mail task preamble exists; thread convention not enforced | Minor |
| AGENTS.md as operating manual with 8 core rules | `ensureAgentMailSection()` generates AGENTS.md content | Partial |
| DCG (Destructive Command Guard) | Not integrated | Minor |
| Single-branch git, no worktrees | Worktree-based parallel execution | **Significant** |

**Severity: Significant** — The guide explicitly argues against worktrees ("I really think worktrees are a bad pattern"). pi-orchestrator's parallel execution model is built on worktrees. The guide's alternative (Agent Mail file reservations + single-branch commits) trades isolation for immediate conflict visibility.

**Suggested fix:**
1. Add a coordination mode that uses Agent Mail file reservations instead of worktrees
2. Make bv `--robot-next` the default bead selection method for sub-agents
3. Consider offering both modes: worktrees (current) and single-branch (flywheel-style)

---

### §7 Launching & Running the Swarm

**Status: 🟡 Partially covered, different execution model**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| NTM/terminal mux for swarm management | `parallel_subagents` via pi's built-in sub-agent system | Different approach (✅) |
| Swarm marching orders prompt | `swarmMarchingOrders()` in `src/prompts.ts` | ✅ |
| Staggered agent launch (30s apart) | No stagger; all parallel agents launch simultaneously | **Significant** |
| Human as clockwork deity (10-30 min monitoring cadence) | Automated SwarmTender polls every 60s | ✅ (automated) |
| Agent composition (cc=2, cod=1, gmi=1) | Sub-agents use same model as orchestrator | Minor |
| Strategic drift check | `strategicDriftCheckInstructions()` exists | ✅ |
| Post-compaction AGENTS.md re-read | No automatic re-read after compaction | **Minor** |
| Persistent agent identity via Agent Mail | Sub-agents are ephemeral (created per-bead) | Significant |
| Account switching (CAAM) | Not integrated (handled by pi framework) | N/A |

**Severity: Significant** — The fundamental model differs. The flywheel uses long-running persistent agents that coordinate via Agent Mail. pi-orchestrator uses ephemeral sub-agents spawned per-bead. Both are valid but produce different coordination dynamics.

**Suggested fix:**
1. Add staggered launch delay for parallel sub-agents
2. Consider a "persistent swarm" mode for large projects where agents live across beads
3. The ephemeral model is actually simpler and avoids many flywheel problems (compaction, identity management, crash recovery)

---

### §8 Review, Testing & Hardening

**Status: ✅ Well covered, some differences**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| Fresh eyes review after each bead | Per-bead review with 5 parallel agents | ✅ |
| 4 questions framework | Review agents cover correctness, edge cases, integration, quality | ✅ |
| Test coverage prompt | Test coverage gate in guided gates | ✅ |
| UBS bug scanner | Not integrated | Minor |
| UI/UX polish 5-step | Not explicitly structured | Minor |
| De-slopify | `deSlopifyInstructions()` with auto-skip logic | ✅ |
| Random code exploration | `randomExplorationInstructions()` | ✅ |
| Cross-agent review | `crossAgentReviewInstructions()` | ✅ |
| Organized commits | `commitStrategyInstructions()` | ✅ |
| Landing the plane 6-step | `landingChecklistInstructions()` in guided gates | ✅ |

**Where pi-orchestrator exceeds the guide:**
- 7-step guided gates with auto/prompt modes and resumable state
- File-conflict detection during peer review
- Auto-skip logic for de-slopify when no docs changed
- 5 parallel review agents (vs guide's suggestion of 1-2 at a time)

---

### §9 Complete Toolchain

**Status: 🟡 Covers core tools, misses ancillary ones**

| Flywheel tool | pi-orchestrator | Status |
|---------------|-----------------|--------|
| NTM | pi's built-in sub-agent system | ✅ Alternative |
| Agent Mail | `src/agent-mail.ts` | ✅ Integrated |
| UBS | Not integrated | Minor gap |
| Beads (br) | `src/beads.ts` | ✅ Full wrapper |
| bv | `src/beads.ts` — `detectBv()`, `bvInsights()`, `bvNext()` | ✅ Integrated |
| RCH | N/A (not applicable to pi's model) | N/A |
| CASS | `src/memory.ts` | ✅ Full integration |
| CM | Via `src/memory.ts` | ✅ |
| CAAM | N/A (pi handles auth) | N/A |
| DCG | Not integrated | Minor gap |
| SLB | N/A (pi has skills system) | N/A |

**Where pi-orchestrator exceeds the guide:**
- 6 registered orchestrator tools (`orch_profile`, `orch_discover`, `orch_select`, `orch_approve_beads`, `orch_review`, `orch_memory`)
- Pluggable scan contract with provider abstraction
- System prompt injection via `before_agent_start` hook
- Research prompts for external project study

---

### §10 The Flywheel Effect

**Status: 🟡 Foundations present, recursive loops missing**

| Flywheel prescribes | pi-orchestrator has | Gap |
|---------------------|---------------------|-----|
| CASS 3-layer memory (episodic→working→procedural) | Full CASS integration via cm CLI | ✅ |
| Read/write/feedback/search memory | All four operations in `src/memory.ts` | ✅ |
| Recursive self-improvement (skills refining skills) | Not implemented | **Minor** |
| Agent feedback forms | Not implemented | Minor |
| CASS ritual detection (mining repeated prompts) | Not implemented | Minor |
| Skill ecosystem growth | Relies on pi's external skill system | ✅ (delegated) |
| Meta-skill pattern (skill-refiner skill) | Not implemented | Minor |

**Suggested fix:** Most of the recursive improvement belongs in the pi framework itself (skills, CASS mining), not in the orchestrator extension. The orchestrator could add a "learnings extraction" step at completion that's more structured than the current `appendMemory()` call.

---

## Areas Where pi-orchestrator Exceeds the Guide

| Feature | Details |
|---------|---------|
| **Dual-provider scan** | ccc + built-in fallback with pluggable provider contract |
| **Session persistence** | Full state restore across session restarts |
| **Automated convergence** | Numeric convergence scoring with auto-stop |
| **Quality checklist gate** | WHAT/WHY/HOW scoring (1-5 scale) for beads |
| **7-step guided gates** | Structured post-implementation review with auto/prompt modes |
| **File-conflict detection** | Detects same file modified in multiple worktrees |
| **SwarmTender** | Automated health monitoring (active/idle/stuck classification) |
| **Scan contract abstraction** | Provider interface enables future scan backends |
| **Research workflow prompts** | Investigate, deepen, and inversion prompts for external project study |
| **Graph health remediation** | Orphan detection and bv integration for bottleneck analysis |

---

## Architectural Divergences (Not Gaps)

These are deliberate design choices where pi-orchestrator differs from the flywheel guide. Neither approach is strictly better — they represent different trade-offs.

| Area | Flywheel approach | pi-orchestrator approach | Trade-off |
|------|-------------------|--------------------------|-----------|
| **Parallel execution** | Single branch + Agent Mail file reservations | Git worktrees for isolation | Worktrees: safer isolation, harder merge. Single-branch: immediate conflict visibility, requires discipline |
| **Agent lifecycle** | Persistent long-running agents | Ephemeral per-bead sub-agents | Persistent: more context, needs compaction handling. Ephemeral: simpler, no compaction, fresh context each time |
| **Operator interface** | Human manages terminal mux (NTM/WezTerm) | Automated orchestrator manages sub-agents | Manual: more control, more effort. Automated: hands-off, less flexibility |
| **Plan artifact** | Standalone 3,000-6,000 line markdown document | Goal → beads directly (no intermediate plan) | Plan: better for large/novel projects. Direct: faster for incremental work |
| **Agent model mix** | cc=2, cod=1, gmi=1 (diverse models) | Same model for all sub-agents | Mixed: diverse perspectives. Same: simpler coordination |
