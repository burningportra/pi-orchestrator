# Flywheel Gap Analysis — Post-Implementation Update

Updated after executing the full bead plan from `docs/PLAN_FLYWHEEL_GAP_FIXES.md`.

This document revisits the original gap analysis in `docs/flywheel-gap-analysis.md` and marks which gaps are now resolved, partially resolved, or intentionally divergent.

---

## Executive Summary

### Overall outcome
The largest flywheel-alignment gaps have now been addressed:
- **Plan-space now exists as a first-class phase**
- **Plan refinement and approval flow now exists**
- **Plan-to-beads conversion now works from an approved plan artifact**
- **Plan-to-bead transfer audit now exists**
- **Single-branch coordination mode now exists alongside worktrees**
- **Agent Mail reservation helpers now exist at orchestrator level**
- **bv usage is substantially improved**
- **Structured learnings extraction and foundation validation now exist**

What remains are primarily:
1. **intentional architectural divergences** from the flywheel, or
2. **partial integrations** where the host pi/LLM execution model still mediates behavior.

---

## Updated Priority Summary

| # | Original Gap | Original Severity | Current Status | Notes |
|---|--------------|------------------|----------------|-------|
| 1 | No standalone markdown plan phase | Significant | **Resolved** | Plan-first workflow, plan prompts, plan approval, multi-model planning added |
| 2 | bv graph-theory routing not used for agent bead selection | Significant | **Mostly resolved** | bv guidance, bottleneck surfacing, and recommendations added; some routing still LLM-mediated |
| 3 | No staggered agent launch / thundering herd prevention | Significant | **Resolved within current architecture** | Stagger launch guidance added to approve/review output |
| 4 | No agent-mail file reservations enforced during parallel execution | Significant | **Mostly resolved** | Reservation helpers + single-branch mode added; enforcement still partly delegated through prompt/tool flow |
| 5 | No multi-agent swarm with persistent identity & coordination | Significant | **Still divergent** | Still primarily ephemeral subagents rather than long-lived swarm sessions |
| 6 | Worktrees used instead of single-branch model | Divergence | **Still divergent by design** | Single-branch mode added, but worktree mode intentionally remains available |
| 7 | No UBS / DCG / SLB safety tooling | Minor | **Partially resolved** | UBS integrated optionally; DCG/SLB still outside orchestrator scope |
| 8 | No recursive self-improvement / skill refinement loop | Minor | **Partially resolved** | Structured learnings extraction added; full recursive skill-refinement loop still absent |
| 9 | No post-compaction AGENTS.md re-read enforcement | Minor | **Resolved** | Added to orchestrator system prompt |
| 10 | No plan-to-bead transfer audit | Minor | **Resolved** | Added `auditPlanToBeads()` and warnings in approval flow |

---

## Section-by-Section Update

### §1 Complete Workflow

**Previous status:** Fully covered  
**Current status:** **Still fully covered**

No regression. The workflow is now stronger because it includes a real plan phase rather than jumping directly from goal selection to bead creation.

**New capabilities added:**
- `orch_plan` tool registration
- plan-first path integrated into workflow
- plan approval before bead creation

---

### §2–3 Planning (85%) & Creating the Markdown Plan

**Previous status:** Significant / critical gap  
**Current status:** **Resolved**

### What changed
The orchestrator now supports:
- **plan-first workflow selection** after goal selection
- **plan state fields** in orchestrator state
- **single-model plan generation prompt**
- **multi-model competing plan prompts**
- **plan synthesis prompt**
- **plan refinement / approval flow** with convergence tracking
- **approved plan artifact path persisted in state**

### Files / commits
- `52ba9e7` — plan state fields + workflow choice
- `8a09fc0` — plan prompts
- `8ecff39` — competing plan prompts + synthesis
- `9fee7af` — plan refinement approval flow

### Remaining difference
The flywheel’s strongest form uses very large human-reviewed markdown plans and repeated fresh external-model rounds. pi-orchestrator now supports the same shape, but still runs within pi’s extension/tool-call model rather than a pure external planning cockpit.

**Assessment:** Good enough to count as resolved.

---

### §4 Converting Plan to Beads

**Previous status:** Mostly covered, one notable gap  
**Current status:** **Resolved**

### What changed
Added:
- `planToBeadsPrompt(...)`
- plan acceptance path wired to bead creation from approved plan
- plan-to-bead transfer audit
- audit warning surfacing in approval flow

### Files / commits
- `bd27c37` — plan-to-beads conversion prompt
- `e6c23e8` — plan-to-bead transfer audit

**Assessment:** The original missing piece is now implemented.

---

### §5 Check Your Beads N Times

**Previous status:** Well covered  
**Current status:** **Still well covered, slightly improved**

The bead polishing system was already strong. It is now stronger because when a plan artifact exists, there is an upstream audit that checks whether bead creation actually preserved plan coverage.

**Assessment:** No major gap remains here.

---

### §6 Coordination Stack

**Previous status:** Partially covered, significant differences  
**Current status:** **Mostly resolved, with one intentional divergence**

### What changed
Added:
- `CoordinationMode` groundwork
- `selectMode()`
- single-branch execution path wiring
- orchestrator-level reservation helpers
- single-branch task preamble guidance
- better bv surfacing in approval flow

### Files / commits
- `11547c8` — CoordinationMode groundwork
- `153d021` — Agent Mail reservation helpers
- `a7ff5f2` — single-branch task preamble guidance
- `fb718b8` — single-branch execution path
- `9fc8def` — bv bottleneck warning in approval flow

### What is still divergent
- **Worktree mode still exists**
- **Single-branch mode is now supported, but not mandatory**

This means the repo is now **flywheel-compatible** in coordination style, but not exclusively flywheel-style.

**Assessment:**
- Missing capability: mostly resolved
- Architectural divergence: intentionally remains

---

### §7 Launching & Running the Swarm

**Previous status:** Partially covered  
**Current status:** **Mostly resolved, but still architecturally different**

### What changed
Added:
- stagger launch guidance using `SWARM_STAGGER_DELAY_MS`
- model diversification in parallel agent configs
- compaction recovery instruction in system prompt

### Files / commits
- `6fb88bc` — stagger guidance
- `f31ca96` — model diversification
- `e8a485d` — compaction re-read instruction

### What remains different
- The flywheel prefers **persistent, long-running swarm agents**
- pi-orchestrator still mainly uses **ephemeral subagents**

That is still a meaningful divergence, though less damaging now that single-branch mode and Agent Mail helpers exist.

**Assessment:**
- Stagger gap: resolved
- Persistent-swarm identity gap: still divergent

---

### §8 Review, Testing & Hardening

**Previous status:** Well covered  
**Current status:** **Still well covered, improved**

### What changed
- UBS optional integration added
- structured learnings extraction added
- fungibility clarified in docs

### Files / commits
- `34925e3` — UBS integration
- `549c592` — structured learnings extraction
- `986f043` — fungibility documentation

**Assessment:** No significant gap remains here.

---

### §9 Complete Toolchain

**Previous status:** Covers core tools, misses ancillary ones  
**Current status:** **Partially improved**

### What changed
- UBS integrated optionally
- model diversification added where supported
- foundation validation warnings added

### Files / commits
- `34925e3` — UBS
- `49e6398` — foundation validation warnings
- `f31ca96` — model diversification

### Still outside scope / unresolved
- DCG integration is still absent
- SLB integration is still absent
- some flywheel tools remain outside pi-orchestrator’s scope because pi provides analogous capabilities differently

**Assessment:** Improved, but not fully aligned with the entire flywheel toolchain.

---

### §10 The Flywheel Effect

**Previous status:** Foundations present, recursive loops missing  
**Current status:** **Partially resolved**

### What changed
Added:
- structured learnings extraction at completion
- stronger CASS integration path for future runs

### Files / commits
- `549c592` — structured learnings extraction

### What remains missing
- no full recursive skill-refinement loop
- no automatic ritual mining / skill rewriting
- no explicit tool-feedback-form workflow built into orchestrator

**Assessment:** Better memory capture exists now, but the full self-improving flywheel loop is still only partially implemented.

---

## Resolved Gaps

These are now effectively closed:

- ✅ Standalone markdown plan phase
- ✅ Plan refinement / approval flow
- ✅ Plan-to-beads conversion from approved plan artifact
- ✅ Plan-to-bead transfer audit
- ✅ Stagger launch guidance
- ✅ Post-compaction AGENTS.md re-read instruction
- ✅ Foundation validation warnings
- ✅ Structured learnings extraction
- ✅ Optional UBS integration
- ✅ Fungibility clarification in docs

---

## Mostly Resolved Gaps

These are substantially improved but still somewhat constrained by the host architecture:

- 🟡 bv-driven bead routing (better guidance, still partly recommendation-based)
- 🟡 Agent Mail reservation enforcement during parallel execution (helpers and mode support exist, but some behavior still depends on prompt/tool-call mediation)
- 🟡 Coordination-stack flywheel alignment (single-branch mode exists, but worktrees remain available)
- 🟡 Flywheel-effect learning loop (better capture, not full recursive refinement)

---

## Deliberate Divergences That Remain

These are still different from the flywheel by design:

### 1. Ephemeral subagents instead of persistent swarm agents
pi-orchestrator still favors short-lived spawned agents over continuously running named swarm sessions.

### 2. Worktree mode still available
The repo now supports flywheel-style single-branch coordination, but it intentionally keeps worktree mode as a first-class option.

### 3. LLM-mediated orchestration remains central
Many actions still happen because the orchestrator returns tool-call guidance to the LLM, rather than the extension runtime directly enforcing every execution detail.

### 4. Full recursive tool/skill self-improvement loop not yet implemented
Memory capture is improved, but auto-mining session patterns into rewritten skills/playbooks still does not exist here.

---

## Updated Bottom Line

### Before this work
pi-orchestrator was **inspired by** the flywheel but skipped its most important middle layer: the markdown plan phase.

### After this work
pi-orchestrator is now **materially aligned** with the flywheel methodology:
- plan-space exists
- plan refinement exists
- plan-to-beads conversion exists
- plan-to-bead auditing exists
- single-branch coordination mode exists
- launch/review/memory loops are stronger

The remaining differences are no longer foundational gaps. They are mostly:
- intentional product choices, or
- host-framework constraints.

That is a major shift: the repo has moved from **partial imitation** to **substantial flywheel compatibility**.
