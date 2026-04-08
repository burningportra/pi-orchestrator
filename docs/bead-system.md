# Bead System

Beads are the task-tracking primitives in pi-orchestrator. Each bead represents one scoped unit of work — an endpoint to add, a module to refactor, tests to write — with enough context for a fresh agent to implement it without further briefing.

This guide covers how beads are created, validated, split, and reviewed.

## Overview

The orchestration workflow moves through phases:

1. **Scan** — profile the codebase
2. **Plan** — produce a strategy document
3. **Beads** — decompose the plan into concrete, dependency-aware tasks
4. **Implement** — agents pick ready beads and execute them
5. **Review** — each bead is reviewed against its acceptance criteria

Beads are stored locally via the `br` CLI (beads-rust) in `.beads/` JSONL files and tracked with git. The graph-analysis tool `bv` (beads-viewer) adds PageRank, betweenness centrality, and critical-path analysis on top.

### Bead Structure

Every bead has these fields (defined in `src/types.ts` → `Bead`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Auto-generated, e.g. `pi-1mj` |
| `title` | `string` | Short summary |
| `description` | `string` | Full spec with rationale, criteria, file list |
| `status` | `"open" \| "in_progress" \| "closed" \| "deferred"` | Lifecycle state |
| `priority` | `number` | 0 (highest) to 4 (lowest) |
| `type` | `string` | `"task"`, `"feature"`, `"bug"`, etc. |
| `labels` | `string[]` | Freeform tags |
| `parent` | `string?` | Parent bead ID for hierarchy |

## Bead Lifecycle

```
open → in_progress → closed
  │                     ↑
  └──→ deferred         │ (review pass)
                        │
              in_progress (review fail → rework)
```

1. **Creation** — beads are created during the planning phase via `br create`. Each bead must include a rationale ("Why this bead exists"), acceptance criteria (`- [ ]` checkboxes), and a `### Files:` section listing affected paths.

2. **Validation** — `validateBeads()` runs automated checks before implementation starts (see [Validation Rules](#validation-rules)).

3. **In Progress** — an agent claims a bead with `br update <id> --status in_progress`. The agent should also reserve its files via Agent Mail to prevent conflicts.

4. **Review** — after implementation, the agent submits for review via `orch_review`. The review checks acceptance criteria and may request rework.

5. **Closed** — passing review closes the bead: `br update <id> --status closed`.

6. **Deferred** — beads that are out of scope or blocked indefinitely can be deferred.

### Reading Beads Programmatically

`src/beads.ts` provides these helpers:

- **`readBeads(pi, cwd)`** — returns all beads via `br list --json` (includes deferred)
- **`readyBeads(pi, cwd)`** — returns only unblocked beads via `br ready --json`
- **`getBeadById(pi, cwd, id)`** — fetches a single bead by ID
- **`beadDeps(pi, cwd, id)`** — lists dependency IDs for a bead
- **`extractArtifacts(bead)`** — parses file paths from the description's `### Files:` section or bullet lines matching known prefixes (`src/`, `lib/`, `test/`, etc.)
- **`updateBeadStatus(pi, cwd, id, status)`** — changes a bead's status
- **`syncBeads(pi, cwd)`** — flushes beads to JSONL on disk

### Graph Analysis (bv Integration)

When the `bv` CLI is available, the system uses graph-theoretic routing:

- **`bvNext(pi, cwd)`** — best single bead for one agent (PageRank + betweenness)
- **`bvTriage(pi, cwd)`** — best beads for parallel agents (non-contending)
- **`bvInsights(pi, cwd)`** — full graph health: bottlenecks, articulation points, cycles, orphans
- **`bvPlan(pi, cwd)`** — raw planning output from the graph

Detection is cached — `detectBv()` runs `which bv` once and remembers the result.

## Templates

Three built-in templates in `src/bead-templates.ts` accelerate bead creation for common patterns. Templates are **drafting aids**, not final syntax — they must be fully expanded before a bead is created.

### Built-in Templates

#### `add-api-endpoint`
Creates a new endpoint with validation, error handling, and tests.

**Placeholders:** `endpointPath`, `moduleName`, `endpointPurpose`, `httpMethod`, `implementationFile`, `testFile`

#### `refactor-module`
Restructures an existing module while preserving behavior and tests.

**Placeholders:** `moduleName`, `refactorGoal`, `currentPain`, `moduleFile`, `testFile`

#### `add-tests`
Adds missing unit or integration coverage for existing behavior.

**Placeholders:** `featureName`, `riskArea`, `implementationFile`, `testFile`

### Using Templates

```typescript
import { expandTemplate } from "./bead-templates.js";

const result = expandTemplate("add-api-endpoint", {
  endpointPath: "/users",
  moduleName: "user-management",
  endpointPurpose: "return a filtered user list",
  httpMethod: "GET",
  implementationFile: "src/api/users.ts",
  testFile: "src/api/users.test.ts",
});

if (result.success) {
  // result.description contains the fully expanded bead description
} else {
  // result.error explains what went wrong
}
```

`expandTemplate()` returns `{ success: true, description }` or `{ success: false, error }`. It fails if:
- The template ID is unknown
- Required placeholders are missing (and reports unrecognized keys as hints)
- Placeholder values contain carriage returns or null bytes
- Any `{{placeholder}}` remains unresolved after substitution

### Other Template Helpers

- **`listBeadTemplates()`** — returns deep clones of all built-in templates
- **`getTemplateById(id)`** — returns a single template or `undefined`
- **`formatTemplatesForPrompt()`** — one-line-per-template summary for LLM context injection

### Adding a New Template

1. Add an entry to `BUILTIN_TEMPLATES` in `src/bead-templates.ts` following the existing shape (`BeadTemplate` interface)
2. Add a matching test case in `src/_verify-templates.test.ts`
3. Run `npm test` to verify

## Validation Rules

`validateBeads()` in `src/beads.ts` runs a comprehensive suite of checks and returns:

```typescript
{
  ok: boolean;              // true only if no cycles, orphans, or template issues
  orphaned: string[];       // bead IDs disconnected from the graph
  cycles: boolean;          // dependency cycle detected
  warnings: string[];       // non-blocking issues (bottlenecks, articulation points, non-standard IDs)
  shallowBeads: { id, reason }[];    // beads with insufficient descriptions
  templateIssues: TemplateHygieneIssue[];  // unresolved template artifacts
}
```

### What Gets Checked

**Dependency health:**
- Cycle detection via `br dep cycles` (or `bv --robot-insights` when available)
- Orphan detection — open beads with no incoming or outgoing dependencies
- Only open/in_progress beads are considered (closed beads are filtered out)

**Shallow bead detection** (on open/in_progress beads):
- Empty description → flagged
- Description under 50 characters → flagged
- Missing `### Files:` section and no file-path bullets → flagged

**Template hygiene** (on open beads only):
- `[Use template: ...]` markers → `raw-template-marker`
- `see template` / `use the template` phrases → `template-shorthand`
- Unresolved `{{placeholder}}` or `<PLACEHOLDER>` patterns → `unresolved-placeholder`
- Template artifacts present but missing file scope or fewer than 2 acceptance criteria → `template-missing-structure`

**Graph warnings** (non-blocking, via bv):
- High-betweenness beads (>5) → "consider splitting"
- Articulation points → "single point of failure in the dep graph"
- Non-standard bead IDs that may break Agent Mail conventions

### Quality Checks

`qualityCheckBeads()` builds on `validateBeads()` with stricter per-bead rules:

| Check | Threshold |
|-------|-----------|
| `has-substance` | Description ≥ 100 chars |
| `has-file-scope` | Must have `### Files:` or path bullets |
| `has-acceptance-criteria` | Must contain `- [ ]` checkboxes |
| `not-oversimplified` | Word count ≥ 50 |
| `deps-connected` | Must have deps or be depended on (multi-bead plans) |
| `file-overlap` | Ready beads must not share files (parallel conflict) |

### Plan-to-Bead Audit

`auditPlanToBeads(plan, beads)` cross-references plan sections against bead descriptions using token overlap scoring. It reports:
- **Uncovered sections** — plan headings with no matching bead
- **Weak mappings** — sections where the best bead match scores below 0.35

## Bead Splitting

When `bv` identifies high-betweenness bottleneck beads, the splitting system in `src/bead-splitting.ts` proposes decompositions to increase parallelism.

### How It Works

1. **Identify bottlenecks** — `identifyBottlenecks(insights, beads, threshold)` filters `bv --robot-insights` data for beads with betweenness centrality ≥ threshold (default 0.3).

2. **Generate split prompt** — `beadSplitProposalPrompt(bead, betweenness)` creates a structured prompt asking the LLM to propose 2–3 independent child beads with disjoint file ownership.

3. **Parse proposal** — `parseSplitProposal(output, ...)` extracts the JSON response into a `SplitProposal` with children, each having a title, description, and file list.

4. **Format for execution** — `formatSplitCommands(proposal)` generates `br create` commands and dependency transfer instructions.

### Split Constraints

Each proposed child bead must:
- Own **disjoint files** from its siblings
- Be **independently implementable** (no child-to-child dependencies)
- Have **clear acceptance criteria**
- Together **fully cover** the parent bead's scope

If the bead is inherently sequential, the proposal returns `splittable: false` with a reason.

### After Splitting

The generated commands include instructions to:
1. Create child beads via `br create`
2. Transfer dependencies from the original bead to the appropriate children
3. Close the original bead

## Review Flow

Bead review happens through the `orch_review` tool registered in `src/tools/review.ts`. There are two layers:

### Per-Bead Review

When an agent submits `orch_review` with a bead ID:
1. The agent provides a **summary**, **verdict** (pass/fail), and **feedback**
2. On pass, the bead is closed and the next ready bead is selected (via `bv --robot-next` or `br ready`)
3. On fail, the agent receives revision instructions and reworks

### Cross-Model Review

`src/bead-review.ts` provides `crossModelBeadReview()` which sends beads to an alternative model (default: `gemini-2.5-pro`) for a fresh perspective. The reviewer checks for:

- Gaps in coverage relative to the goal
- Oversimplifications or vague beads
- Missing dependencies between beads
- Unclear scope for a fresh developer
- Split or merge candidates
- Redundancies and file overlap

The output is parsed into actionable suggestions via `parseSuggestions()`, which handles numbered lists, bullet points, markdown headers, and paragraph fallback.

### Guided Gates (Iteration Phase)

During the iteration phase, `orch_review` with `beadId: "__gates__"` triggers guided gate reviews. The system tracks **consecutive clean rounds** — two clean passes in a row signals the codebase is in good shape, and the orchestrator offers to finish.

A clean round requires: verdict = pass, no revision instructions.

On completion, the system:
- Reflects learnings into CASS memory
- Mines the session into MemPalace (if available)

## Quick Reference

```bash
# CLI commands
br list --json              # All beads
br ready --json             # Unblocked beads
br show <id>                # Bead details
br update <id> --status in_progress
br update <id> --status closed
br dep add <id> <dep-id>    # Add dependency
br dep cycles               # Check for cycles
br sync --flush-only        # Flush to JSONL
bv --robot-next             # Best next bead (single agent)
bv --robot-triage           # Best beads (parallel agents)
bv --robot-insights         # Graph health report
```

```bash
# Build & test
npm run build    # tsc --noEmit
npm test         # vitest run
```
