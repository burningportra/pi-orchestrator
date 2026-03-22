# Flywheel Alignment Changelog

Human-facing summary of the recent flywheel-alignment work completed in this repository.

This is not a full architecture spec. It is a concise changelog for contributors who want to understand what changed, why it changed, and what the orchestrator can do now that it could not do before.

---

## What changed

pi-orchestrator now supports a much more complete version of the Agent Flywheel workflow.

The biggest change is that the orchestrator no longer has to jump directly from a selected goal to bead creation. It now supports an intermediate **plan phase**, where the system can generate, refine, and approve a markdown plan before converting it into beads.

That closes the single largest gap between the original orchestrator and the flywheel methodology.

---

## New capabilities

### 1. Plan-first workflow
After selecting a goal, users can now choose among:
- **Plan first** — create and refine a markdown plan before bead creation
- **Deep plan (beads)** — existing multi-model planning path
- **Direct to beads** — existing faster path for smaller changes

This adds a real **plan-space** phase to the workflow.

### 2. Plan generation and refinement
The orchestrator now supports:
- single-model plan generation
- multi-model competing plans
- plan synthesis
- plan refinement with convergence tracking
- explicit plan approval before bead creation

This gives users a proper reviewable artifact before work is translated into beads.

### 3. Plan-to-beads conversion
The system now has a dedicated prompt for converting an approved plan into beads.

That prompt explicitly tells the agent to:
- read the approved plan artifact
- carry context forward into each bead
- avoid lazy shorthand like “see the plan”
- preserve sequencing, edge cases, and testing obligations

### 4. Plan-to-bead transfer audit
The orchestrator now audits the mapping between a plan and its beads.

It can flag:
- uncovered plan sections
- weak section-to-bead mappings
- places where the plan may not have been faithfully transferred into executable work

This helps catch planning loss before implementation starts.

### 5. Single-branch coordination mode
In addition to the existing worktree-based path, the orchestrator now supports a flywheel-style **single-branch coordination mode**.

This includes:
- `CoordinationMode` groundwork
- orchestrator-level Agent Mail reservation helpers
- single-branch task preamble guidance
- execution-path wiring for shared-checkout operation

The repository intentionally still supports worktrees; single-branch mode is additive, not destructive.

### 6. Better swarm launch behavior
Parallel launch behavior is now improved with:
- stagger-launch guidance to reduce thundering herd collisions
- model diversification for parallel subagents when multiple models are available
- clearer agent guidance about bv-driven next-bead selection
- better bottleneck surfacing in approval flow

### 7. Better review and learning loops
The repo now includes:
- structured learnings extraction at completion
- optional UBS integration in the test coverage gate
- foundation validation warnings during profiling
- post-compaction AGENTS.md re-read guidance in the system prompt

### 8. Clearer architecture documentation
The architecture docs now clarify that review-agent “specialization” is really **prompt diversity**, not persistent specialist-agent architecture.

This matters because the flywheel strongly prefers fungible agents. The orchestrator now documents how its approach satisfies the spirit of fungibility while still benefiting from multiple review lenses.

---

## What contributors should understand now

### The orchestrator has three planning paths
This is now the most important conceptual change.

A contributor should think about `/orchestrate` as having three valid routes after goal selection:

1. **Plan first**
   - best for large or architectural work
   - produces a reviewable markdown plan
   - then converts that plan into beads

2. **Deep plan (beads)**
   - best when multi-model planning is useful but a standalone plan document is not necessary
   - still useful for higher-effort work

3. **Direct to beads**
   - best for smaller, bounded tasks
   - lowest overhead path

### Plan artifacts are now first-class
If a plan exists, it is no longer just extra text. It can actively shape the workflow:
- refinement and approval happen against it
- bead creation can read from it
- transfer audit can validate against it

### Coordination is now mode-aware
Contributors should assume that the orchestrator may run in either:
- **worktree mode**, or
- **single-branch mode**

Any future coordination change should be careful not to hardcode assumptions that only one of those modes exists.

### Approval flow is richer than before
Approval is no longer just “are these beads good enough?”

It now has hooks for:
- graph-health warnings
- plan-to-bead audit warnings
- convergence-based refinement
- bottleneck surfacing

That means approval logic is becoming a true control surface, not just a confirmation prompt.

---

## What did not change

### Worktrees were not removed
The repo still supports worktree-based execution. This is deliberate.

The flywheel prefers single-branch coordination, but this orchestrator now supports both rather than forcing one ideology.

### Persistent swarm sessions were not introduced
The orchestrator still mainly uses ephemeral subagents rather than long-running named swarm agents.

That remains one of the largest structural differences between pi-orchestrator and a pure flywheel operator setup.

### The orchestrator still relies heavily on LLM-mediated tool execution
A lot of behavior is still implemented by returning structured guidance to the agent, which then calls tools like `subagent` or `parallel_subagents`.

That means some flywheel alignment is implemented as stronger prompting and workflow wiring, not pure runtime enforcement.

---

## Practical impact

For users, the repo is now better at:
- doing large work without skipping the planning layer
- preserving plan intent when generating beads
- catching scope loss before implementation
- coordinating agents in a more flywheel-compatible way
- surfacing bottlenecks and graph issues earlier
- capturing useful learnings at the end of runs

For contributors, the repo now has a clearer internal shape:
- planning is a first-class concern
- coordination is mode-aware
- approval is more intelligent
- memory capture is more structured

---

## Recommended next documentation updates

If we want to make this even easier for new contributors, the next useful docs changes would be:

1. **README update**
   - add the three workflow paths after goal selection
   - mention plan-first mode explicitly
   - mention single-branch coordination mode

2. **Architecture diagram refresh**
   - insert the plan generation / approval branch before bead creation
   - show plan-to-bead audit in the approval path
   - show coordination mode split (worktree vs single-branch)

3. **Contributor guide note**
   - explain when to choose plan-first vs direct-to-beads
   - explain how to think about single-branch coordination safely

---

## Bottom line

The orchestrator now has a real planning layer, a real transfer-audit layer, and a more flywheel-aligned coordination model.

It is still not identical to a pure Agent Flywheel operator environment, but it is no longer missing the core middle pieces that made the original gap analysis significant.

The biggest remaining differences are deliberate product choices, not missing fundamentals.
