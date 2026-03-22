# Agent Flywheel Complete Guide — Structured Summary

> Comprehensive reference cataloguing the 10 sections, prompt templates, tools, patterns, anti-patterns, operators, and kernel invariants from the Agent Flywheel methodology.

---

## Table of Contents

1. [Complete Workflow](#1-complete-workflow)
2. [Planning is 85%](#2-planning-is-85)
3. [Creating & Refining the Plan](#3-creating--refining-the-plan)
4. [Plan to Beads](#4-plan-to-beads)
5. [Check Beads N Times](#5-check-beads-n-times)
6. [Coordination Stack](#6-coordination-stack)
7. [Launching the Swarm](#7-launching-the-swarm)
8. [Review Testing Hardening](#8-review-testing-hardening)
9. [Complete Toolchain](#9-complete-toolchain)
10. [Flywheel Effect](#10-flywheel-effect)

---

## 1. Complete Workflow

The flywheel is a **9-step arc**:

| Step | Phase | Description |
|------|-------|-------------|
| 1 | **Explain** | Describe what you want to build in plain language |
| 2 | **Competing Plans** | Generate multiple plans using different models |
| 3 | **Synthesize** | Merge best ideas into a single best-of-all-worlds plan |
| 4 | **Iterate** | Refine the plan through 4-5 rounds of fresh conversations |
| 5 | **Beads** | Convert plan into self-contained executable beads |
| 6 | **Polish** | Check beads N times until convergence |
| 7 | **Swarm** | Launch fungible agents to execute beads in parallel |
| 8 | **Tend** | Monitor, coordinate, and unstick the swarm |
| 9 | **Review** | Fresh-eyes review, testing, hardening, and landing |

**CASS Case Study**: 5,500-line plan → 347 beads → 25 agents → 11,000 lines of code in 5 hours.

---

## 2. Planning is 85%

### Core Concept: Context Horizon
The maximum amount of context an agent can hold at once. Plans must be structured so each bead fits within a single agent's context horizon.

### Three Reasoning Spaces

| Space | Purpose | Artifact |
|-------|---------|----------|
| **Plan-space** | Global reasoning, architecture decisions, trade-offs | Markdown plan document |
| **Bead-space** | Task decomposition, dependencies, execution order | Bead graph (br/bv) |
| **Code-space** | Implementation details, actual code changes | Source files |

### Rework Cost Escalation

| Where caught | Cost multiplier |
|--------------|----------------|
| Plan-space | **1×** |
| Bead-space | **5×** |
| Code-space | **25×** |

**Key insight**: Every hour invested in planning saves 5-25 hours of rework downstream.

---

## 3. Creating & Refining the Plan

### Foundation Bundle
Before planning, assemble:
- Project description / goals
- Existing codebase context (structure, conventions)
- Constraints and requirements
- Prior art / reference implementations

### Multi-Model Planning
Generate competing plans from different models:
- **GPT Pro** — initial comprehensive plan
- **Opus** — alternative architecture perspective
- **Gemini** — different trade-off analysis
- **Grok** — contrarian/edge-case focus

### Best-of-All-Worlds Synthesis Prompt
Merge the best ideas from all competing plans into one synthesized plan. Takes all model outputs and produces a unified document that cherry-picks the strongest elements from each.

### Iterative Refinement
- **4-5 rounds** of fresh conversations (new session each time)
- Each round focuses on different aspects (architecture, edge cases, testing, performance)
- Fresh context prevents anchoring bias

### "Lie to Them" Technique (Overshoot Mismatch Hunt)
Deliberately overstate the plan's completeness to provoke the model into finding gaps. Tell the model the plan is "perfect and complete" — it will work harder to find what's actually missing.

### Convergence Detection
Plan is ready when:
- New rounds produce diminishing changes
- Feedback becomes cosmetic rather than structural
- Multiple models agree on the core architecture

---

## 4. Plan to Beads

### The Plan-Bead Gap
Converting a plan to beads is a **distinct translation problem** — not a mechanical copy-paste. Common failure: writing pseudo-beads in markdown instead of using the beads tool.

### Bead Requirements

| Property | Description |
|----------|-------------|
| **Self-contained** | Each bead has all context needed for a single agent to execute it |
| **Rich content** | Includes rationale, approach, acceptance criteria, file paths |
| **Complete coverage** | Every plan item maps to at least one bead |
| **Explicit dependencies** | Bead graph encodes execution order |
| **Testing included** | Test beads accompany implementation beads |

### Plan-to-Beads Conversion Prompt
Systematically walks through the plan, creating beads with proper granularity, dependencies, and acceptance criteria. Never write pseudo-beads in markdown — always use `br create`.

### Anti-Patterns
- ❌ Beads that reference "see the plan" without embedding the relevant context
- ❌ Beads too large (multiple files, multiple concerns)
- ❌ Beads too small (trivial one-liners that create dependency overhead)
- ❌ Missing dependency edges (causes parallel conflicts)
- ❌ Pseudo-beads written as markdown instead of using `br create`

---

## 5. Check Beads N Times

### Bead Polishing Loop
Run the **bead polishing prompt 4-6+ times** until convergence.

### Fresh Eyes Technique
Each polishing round uses a **new session** to avoid anchoring to previous feedback. The fresh model sees the beads without memory of prior iterations.

### Convergence Detection Metrics

| Signal | Threshold | Meaning |
|--------|-----------|---------|
| Output shrinking | — | Less feedback each round |
| Velocity slowing | — | Changes becoming smaller |
| Similarity increasing | — | Rounds producing similar suggestions |
| Ready score | **≥ 0.75** | Beads are execution-ready |
| Diminishing returns | **≥ 0.90** | Stop polishing |

### Dedup Check
After polishing, run a deduplication pass to merge beads that overlap or could be combined.

### Idea-Wizard for Existing Projects
For existing codebases, use the **30 → 5 → 15 funnel**:
1. Generate 30 raw ideas
2. Filter to 5 best candidates
3. Expand winners into 15 detailed beads

### Major Features: Research & Reimagine Pattern
For large features, conduct a research phase before planning — explore the problem space, study prior art, then reimagine the solution before committing to a plan.

---

## 6. Coordination Stack

### The Triangle: Agent Mail + Beads + bv

| Tool | Role |
|------|------|
| **Agent Mail** | Inter-agent messaging with threading |
| **Beads (br)** | Task tracking, status, dependencies |
| **bv** | Graph-theory compass for bead selection |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **No worktrees** | Single branch simplifies coordination |
| **Advisory file reservations** | With TTL — not hard locks |
| **Bead IDs as thread anchors** | Thread ID = bead ID in Agent Mail |
| **Agent fungibility** | Any agent can pick up any bead |
| **Directed Cyclic Graph (DCG)** | Beads form a DAG with dependency edges |

### bv Graph-Theory Compass
Uses graph algorithms to recommend next beads:
- **PageRank** — most connected/important beads
- **Betweenness centrality** — bottleneck beads
- **HITS** — hub and authority beads
- **Critical path** — longest dependency chain

### AGENTS.md Operating Manual — 8 Core Rules
1. Register with Agent Mail on startup
2. Use `bv --robot-next` to pick beads
3. Announce bead start via Agent Mail
4. Use bead ID as thread ID
5. Announce bead completion
6. Check inbox between beads
7. Respect file reservations
8. Single-branch git (pull before push)

---

## 7. Launching the Swarm

### Operator Interface
Use **NTM / WezTerm / tmux** as the terminal multiplexer for managing multiple agent panes.

### Swarm Marching Orders Prompt
Initial prompt given to each agent with:
- Project context and goals
- AGENTS.md rules
- First bead assignment or instruction to use `bv --robot-next`

### First 10 Minutes Sequence
1. Launch agents one at a time (staggered)
2. Verify each registers with Agent Mail
3. Confirm first bead pickups
4. Watch for early conflicts or confusion

### Agent Composition
Recommended mix for a typical swarm:
- **cc=2** (Claude Code instances)
- **cod=1** (Codex instance)
- **gmi=1** (Gemini instance)

### Thundering Herd Fix
**Stagger agent launches by 30 seconds** to prevent all agents from grabbing the same ready beads simultaneously.

### Human as Clockwork Deity
The human operator:
- Monitors overall progress
- Resolves conflicts agents can't handle
- Makes architectural decisions when agents diverge
- Provides strategic course corrections

### Anti-Patterns
- ❌ **Strategic drift** — agents wander from the plan (run drift check prompt)
- ❌ **Stuck swarm** — all agents blocked on dependencies (diagnose with bv insights)
- ❌ **Thundering herd** — multiple agents grab same bead (stagger launches)

---

## 8. Review Testing Hardening

### Fresh Eyes Review
After each bead, run a **fresh-eyes review** in a new session with the **4 questions framework**:
1. Does the code match the bead's acceptance criteria?
2. Are there bugs or edge cases?
3. Does it integrate cleanly with adjacent beads?
4. Is it production-quality?

### Test Coverage
Treat test writing as **free labor** — agents should write tests for every bead. Use the test coverage prompt to identify gaps.

### UBS Bug Scanner
Automated bug scanning tool that catches common issues across the codebase.

### UI/UX Polish — 5-Step Process
1. Visual consistency check
2. Interaction flow review
3. Error state handling
4. Accessibility audit
5. Platform-specific polish

### De-Slopify
Clean up AI-generated code patterns:
- Remove unnecessary comments
- Fix naming inconsistencies
- Eliminate dead code
- Standardize patterns

### Deep Cross-Agent Review
**Alternate between two modes**:
1. **Random code exploration** — agent reads random files looking for issues
2. **Cross-agent review** — agent reviews code written by a different agent

### Organized Commits
Structure commits logically — one per bead or logical unit, with clear messages.

### Landing the Plane — 6-Step Process
1. Final integration test
2. README update
3. Dependency audit
4. Performance check
5. Security scan
6. Release preparation

---

## 9. Complete Toolchain

### 11 Core Tools

| Tool | Purpose |
|------|---------|
| **NTM** | Terminal multiplexer for swarm management |
| **Agent Mail** | Inter-agent messaging and coordination |
| **UBS** | Universal Bug Scanner |
| **Beads (br)** | Task/bead management CLI |
| **bv** | Bead graph visualizer and recommender |
| **RCH** | Reality Check tool |
| **CASS** | Compound Agentic Software System (memory) |
| **CM** | CASS Memory CLI |
| **CAAM** | CASS Agent Autonomy Manager |
| **DCG** | Directed Cyclic Graph manager |
| **SLB** | Skill Library Browser |

### VPS Environment
Recommended: run swarms on a VPS for stability, persistent sessions, and resource isolation.

### Incremental Onboarding
Don't adopt all 11 tools at once. Start with:
1. Planning workflow (no tools needed)
2. Add beads (br)
3. Add Agent Mail
4. Add bv
5. Layer in remaining tools as needed

### Validation Gates — 6 Gates

| Gate | When | What |
|------|------|------|
| 1 | Plan complete | Architecture review |
| 2 | Beads created | Coverage + dependency check |
| 3 | Beads polished | Convergence score ≥ 0.75 |
| 4 | Per-bead | Fresh-eyes review |
| 5 | All beads done | Integration test |
| 6 | Pre-release | Landing the plane checklist |

---

## 10. Flywheel Effect

### Four Compounding Dimensions

| Dimension | What compounds |
|-----------|---------------|
| **Planning** | Each project improves plan templates and heuristics |
| **Execution** | Swarm patterns, agent configs, coordination protocols |
| **Tool** | Tools improve from usage feedback |
| **Memory** | CASS captures and retrieves learnings |

### CASS 3-Layer Memory

| Layer | Retention | Purpose |
|-------|-----------|---------|
| **Episodic** | Session-scoped | Raw session history |
| **Working** | Cross-session | Active project context |
| **Procedural** | Permanent | Distilled rules and patterns |

### Recursive Self-Improvement
The system improves itself:
- Agent feedback → tool improvements
- Session learnings → CASS procedural memory
- Skill refinement → better skills for future projects

### Skills Ecosystem
Skills are reusable, composable capabilities that agents can load on demand. The flywheel grows the skill library over time.

---

## 9 Kernel Invariants

These are the **non-negotiable principles** of the flywheel:

| # | Invariant | Implication |
|---|-----------|-------------|
| 1 | **Global reasoning belongs in plan space** | Never make architectural decisions in code-space |
| 2 | **Markdown plan must be comprehensive before coding starts** | No "we'll figure it out as we go" |
| 3 | **Plan-to-beads is a distinct translation problem** | Not a copy-paste — requires deliberate decomposition |
| 4 | **Beads are the execution substrate** | All work flows through beads, no side-channel tasks |
| 5 | **Convergence matters more than first drafts** | Polish loops are essential, not optional |
| 6 | **Swarm agents are fungible** | Any agent can execute any bead — no specialists |
| 7 | **Coordination must survive crashes and compaction** | Agent Mail + bead state persists across failures |
| 8 | **Session history is part of the system** | CASS memory makes past sessions actionable |
| 9 | **Implementation is not the finish line** | Review, testing, hardening are mandatory final phases |

---

## Prompt Templates Catalogue

### Planning Prompts
| Prompt | Phase | Purpose |
|--------|-------|---------|
| **Best-of-all-worlds synthesis** | §3 | Merge competing plans into unified document |
| **Plan refinement** | §3 | Iterative improvement in fresh sessions |
| **Overshoot mismatch hunt** | §3 | "Lie to them" — provoke gap-finding |

### Bead Prompts
| Prompt | Phase | Purpose |
|--------|-------|---------|
| **Plan-to-beads conversion** | §4 | Systematic bead creation from plan |
| **Bead polishing** | §5 | Improve bead quality (run 4-6× times) |
| **Fresh eyes on beads** | §5 | New-session bead review |
| **Bead dedup** | §5 | Merge overlapping beads |
| **Idea-wizard generate** | §5 | 30→5→15 idea funnel for existing projects |

### Swarm Prompts
| Prompt | Phase | Purpose |
|--------|-------|---------|
| **Swarm marching orders** | §7 | Initial agent instructions |
| **Advance to next bead** | §8 | Agent self-selects next work |
| **Post-compaction reset** | §7 | Re-orient agent after context compaction |

### Review Prompts
| Prompt | Phase | Purpose |
|--------|-------|---------|
| **Fresh eyes review** | §8 | Per-bead quality check (4 questions) |
| **Test coverage** | §8 | Identify and fill test gaps |
| **UI/UX scrutiny** | §8 | Visual and interaction review |
| **Platform-specific polish** | §8 | OS/browser-specific fixes |
| **De-slopify** | §8 | Clean up AI code patterns |
| **Random code exploration** | §8 | Discovery-mode code review |
| **Cross-agent review** | §8 | Review another agent's work |
| **Organized commits** | §8 | Structure git history |

### Meta Prompts
| Prompt | Phase | Purpose |
|--------|-------|---------|
| **Reality check** | Any | Sanity-check current state |
| **README reviser** | §8 | Update project documentation |
| **Quick sanity check** | Any | Lightweight validation |
| **Agent tool feedback** | §10 | Capture tool improvement ideas |
| **Skill refinement meta-skill** | §10 | Improve skills from usage |

---

## 8 Operators

Operators are the high-level cognitive moves that drive the flywheel:

| # | Operator | Phase | Description |
|---|----------|-------|-------------|
| 1 | **Plan-first expansion** | §2-3 | Invest heavily in plan before any code |
| 2 | **Competing-plan triangulation** | §3 | Use multiple models for plan diversity |
| 3 | **Overshoot mismatch hunt** | §3 | Deliberately overstate to find gaps |
| 4 | **Plan-to-beads transfer audit** | §4 | Verify complete plan coverage in beads |
| 5 | **Convergence polish loop** | §5 | Iterate until diminishing returns |
| 6 | **Fresh-eyes reset** | §5, §8 | New session to avoid anchoring |
| 7 | **Fungible swarm launch** | §7 | Deploy interchangeable agents |
| 8 | **Feedback-to-infrastructure closure** | §10 | Turn learnings into permanent improvements |

---

## Key Anti-Patterns Summary

| Anti-Pattern | Section | Fix |
|--------------|---------|-----|
| Pseudo-beads in markdown | §4 | Use `br create` |
| Beads referencing "see the plan" | §4 | Embed all context in bead |
| Skipping polish loops | §5 | Run 4-6× minimum |
| Same-session polishing | §5 | Fresh session each round |
| Thundering herd on launch | §7 | Stagger 30s between agents |
| Strategic drift | §7 | Run drift check prompt |
| Skipping review phase | §8 | Review is mandatory (invariant 9) |
| Specialist agents | §6 | Keep agents fungible (invariant 6) |
| Hard file locks | §6 | Advisory reservations with TTL |
| Multiple git branches | §6 | Single-branch coordination |
