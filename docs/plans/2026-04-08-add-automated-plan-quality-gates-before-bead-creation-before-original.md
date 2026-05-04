# Plan: Add Automated Readiness Gates Before Bead Creation

## Architecture Overview

### Goal

Add a **single pre-creation readiness gate** that runs after plan approval and before any `br create` calls. Its job is to catch plan/bead issues while they are still cheap to fix, using existing analysis modules where possible and adding only a small amount of new logic for checks that do not yet exist.

### Chosen approach

Create a new module:

- `src/readiness-gate.ts`

with one main entry point:

- `runReadinessGate(...)`

This is the best synthesis of the three proposals:

- From the **correctness plan**: reuse existing quality/coverage/validation logic instead of re-implementing it.
- From the **robustness plan**: every check should degrade gracefully on partial failure, and the gate must support override.
- From the **ergonomics plan**: keep the integration seam narrow so `approve.ts` does not become even more scattered.

### Why a single gate module

`approve.ts` is already large and already performs several approval-time checks. The gate should not add more ad hoc inline logic there. Instead:

- `approve.ts` calls **one function**
- the gate module orchestrates multiple checks
- the gate returns a flat, display-friendly result
- the approval flow decides whether to proceed, refine, or override

### Proposed flow

#### Current
```text
Plan generated
→ Plan approval
→ Bead creation (br create)
→ Bead validation / quality checks
→ Implementation
```

#### New
```text
Plan generated
→ Plan approval
→ Readiness gate
   ├─ plan quality
   ├─ plan coverage
   ├─ plan simulation
   ├─ bead structure/content checks
   └─ proposed dependency graph checks
→ If pass/warn: create beads
→ If block: refine or override
→ Existing post-creation validation still remains
→ Implementation
```

### Scope of the new gate

The readiness gate should evaluate **proposed beads**, not persisted beads. That means:

- it should **not rely on `br` state**
- it should **not require beads to already exist**
- it should use pure or read-only checks wherever possible

### Checks included

#### 1. Plan content check
Block if:
- plan text is empty or whitespace
- proposed bead list is empty

#### 2. Plan quality check
Reuse existing plan-quality machinery.

Verdicts:
- `< 60` → `block`
- `60–79` → `warn`
- `>= 80` → `pass`

If the LLM call fails or parsing returns `null`:
- `warn`, not `block`

#### 3. Plan coverage check
Reuse existing coverage machinery.

Verdicts:
- `< 50` → `block`
- `50–69` → `warn`
- `>= 70` → `pass`

#### 4. Plan simulation check
Reuse existing simulation machinery, but keep it **advisory** unless it finds a clearly fatal condition.

Chosen rule:
- simulation findings are normally `warn`
- only escalate to `block` if the simulation layer already exposes a clearly unusable result such as “cannot execute any viable path” or equivalent hard failure
- if simulation errors out, degrade to `warn`

This preserves robustness without making simulation an unexpectedly hard blocker.

#### 5. Fast bead checks
New pure checks on proposed bead content:

- minimum description substance
- maximum description length
- acceptance criteria presence
- `### Files:` scope presence
- unresolved template artifacts / placeholders
- basic dependency sanity
- cycle detection in proposed bead dependencies
- orphan/unreachable dependency graph warnings where meaningful

#### 6. Dependency graph checks
Because this is **pre-creation**, dependency checks must be performed on the in-memory proposed beads, not by asking `br`/`bv`.

Chosen rule:
- cycle in proposed deps → `block`
- invalid dependency reference → `block`
- isolated/orphan graph shape → `warn`
- single-bead plans skip connectivity/orphan checks

### Explicit contradiction resolutions

#### Naming
The plans suggested `plan-readiness-gate`, `pre-creation-gate`, and `readiness-gate`.

**Decision:** use `readiness-gate.ts`.

Why:
- concise
- accurately describes the feature
- avoids tying the name to one exact call site while still being clear
- aligns with the “single seam” design

#### Result model
The plans varied between `passed:boolean + recommendation`, `GateVerdict`, and display-rich result objects.

**Decision:** use verdict-based flat result types:

- `pass | warn | block`

Why:
- easy to aggregate
- easy to display
- easy to serialize/checkpoint
- avoids awkward combinations like `passed=false` but override allowed

#### Whether oversize beads should warn or block
One plan treated oversize beads as warn; another as block.

**Decision:** use:
- **too short / missing required structure** → `block`
- **too large** → `warn`

Why:
- missing files / missing acceptance criteria / empty beads are structural failures
- oversized beads are important but not always fatal; the user may intentionally accept them
- this reduces false hard blocks while still surfacing scope problems

#### Whether to call `validateBeads` directly
One plan suggested reusing `validateBeads`, but also noted the gate runs before persistence.

**Decision:** do **not** directly rely on `validateBeads` for pre-creation correctness unless it already supports in-memory proposals without `br` access.

Instead:
- factor or add proposal-safe helpers if needed
- keep the gate independent of persisted bead state

Why:
- correctness: proposed beads do not yet exist in `.beads`
- robustness: avoids CLI contention and pre-creation state mismatch

#### Whether `br`/`bv` are required
Some plans suggested fallbacks if `br`/`bv` are missing.

**Decision:** the readiness gate should not require `br` or `bv` for core operation.

Why:
- pre-creation checks can and should be computed from in-memory proposed beads
- avoids contention and environment fragility
- simpler and more deterministic

## User Workflows

### 1. Happy path

```text
User runs /orchestrate
→ planner produces plan + proposed beads
→ user approves plan
→ readiness gate runs
→ all checks pass
→ UI shows gate summary
→ beads are created
→ normal orchestration continues
```

Example UI copy:
```text
✅ Readiness gate passed
- Plan quality: 83/100
- Plan coverage: 91%
- Simulation: no major issues
- Bead checks: all required structure present

Proceed to create beads
```

### 2. Warning path

```text
→ readiness gate runs
→ one or more checks return warn
→ user is shown issues and fix hints
→ options:
   - Proceed with warnings
   - Refine plan
```

Example:
```text
⚠️ Readiness gate found warnings
- Plan coverage: 66% — some plan sections may not map to beads
- Bead scope: 2 beads exceed 2000 chars

Options:
- Proceed with warnings
- Refine plan
```

### 3. Blocking path

```text
→ readiness gate runs
→ one or more checks return block
→ bead creation is halted by default
→ options:
   - Refine plan
   - Override and create beads anyway
```

Example:
```text
⛔ Readiness gate blocked bead creation
- No proposed beads were produced
- 1 bead is missing a ### Files: section
- 1 dependency cycle detected: api-refactor → add-tests → api-refactor

Options:
- Refine plan
- Override and create anyway
```

### 4. Refinement loop

When the user chooses **Refine plan**:

1. include gate failures/warnings in a refinement prompt
2. re-run planning/refinement
3. regenerate proposed beads
4. clear stale gate result
5. re-run readiness gate

The prompt should include:
- failing checks
- fix hints
- concrete bead ids if relevant
- missing sections/files/criteria details

### 5. Override flow

Override must remain available, following the current approval UX pattern.

Rules:
- `warn` never blocks proceeding
- `block` requires explicit override to proceed
- overridden gate results should still be stored in state/checkpoint for visibility

### 6. Resume/crash recovery

On resume:
- do **not** blindly trust a stored readiness result if plan/proposed beads may have changed
- re-run the gate if the plan or proposed beads are stale or unavailable
- checkpointed result is for UX continuity, not correctness authority

## Data Model / Types

Add new types in `src/readiness-gate.ts`.

```ts
export type ReadinessVerdict = "pass" | "warn" | "block";

export interface ReadinessCheckResult {
  check: string;           // e.g. "plan-quality", "plan-coverage", "bead-files"
  verdict: ReadinessVerdict;
  score?: number;          // for scored checks
  summary: string;         // one-line human-readable result
  details: string;         // multi-line explanation
  fixHint?: string;        // concrete next step
  durationMs?: number;     // optional telemetry/debugging
}

export interface ReadinessGateResult {
  overall: ReadinessVerdict;
  canProceed: boolean;              // true for pass/warn, false for block
  requiresAcknowledgement: boolean; // true if any warn/block exists
  checks: ReadinessCheckResult[];
}
```

### Config / thresholds

```ts
export interface ReadinessGateConfig {
  qualityBlockThreshold: number;      // default 60
  qualityWarnThreshold: number;       // default 80
  coverageBlockThreshold: number;     // default 50
  coverageWarnThreshold: number;      // default 70
  minBeadDescriptionChars: number;    // default 100
  maxBeadDescriptionChars: number;    // default 2000
  requireAcceptanceCriteria: boolean; // default true
  requireFileScope: boolean;          // default true
  llmTimeoutMs: number;               // default 30000
  skipLLMChecks: boolean;             // default false
}

export const DEFAULT_READINESS_GATE_CONFIG: ReadinessGateConfig = {
  qualityBlockThreshold: 60,
  qualityWarnThreshold: 80,
  coverageBlockThreshold: 50,
  coverageWarnThreshold: 70,
  minBeadDescriptionChars: 100,
  maxBeadDescriptionChars: 2000,
  requireAcceptanceCriteria: true,
  requireFileScope: true,
  llmTimeoutMs: 30000,
  skipLLMChecks: false,
};
```

### State additions

Add to `OrchestratorState` in `src/types.ts`:

```ts
readinessGateResult?: import("./readiness-gate.js").ReadinessGateResult;
```

If state already stores plan/proposed beads metadata, also clear `readinessGateResult` when those inputs change.

### Internal helper types

If needed for graph checks:

```ts
interface ProposedDepIssue {
  kind: "missing-dependency" | "cycle" | "orphan";
  beadId: string;
  relatedIds?: string[];
  details: string;
}
```

## API Surface

Create `src/readiness-gate.ts` with these exports.

```ts
export async function runReadinessGate(args: {
  plan: string;
  beads: Bead[];
  goal: string;
  pi: ExtensionAPI;
  cwd: string;
  config?: Partial<ReadinessGateConfig>;
}): Promise<ReadinessGateResult>;
```

Behavior:
- main entry point
- runs all fast checks
- runs LLM-backed checks unless skipped
- aggregates to one result

```ts
export function runFastReadinessChecks(
  beads: Bead[],
  config?: Partial<ReadinessGateConfig>,
): ReadinessCheckResult[];
```

Behavior:
- pure function
- no CLI calls
- no LLM calls
- runs structural/content/dependency checks on proposed beads

```ts
export function formatReadinessGateResult(
  result: ReadinessGateResult,
): string;
```

Behavior:
- returns display-friendly formatted text for approval UI/dashboard/checkpoints

### Recommended internal helpers

Keep these internal unless they are clearly reusable:

```ts
function checkPlanContent(plan: string, beads: Bead[]): ReadinessCheckResult;
function checkBeadStructure(beads: Bead[], config: ReadinessGateConfig): ReadinessCheckResult[];
function checkProposedDependencies(beads: Bead[]): ReadinessCheckResult[];
function aggregateVerdict(checks: ReadinessCheckResult[]): ReadinessGateResult;
```

### Integration points

#### `src/tools/approve.ts`
Add the primary integration here:

1. after plan approval and after proposed beads are available
2. before any `br create` call
3. store result in `oc.state.readinessGateResult`
4. show formatted output
5. gate the action options:
   - `pass` → normal proceed
   - `warn` → proceed or refine
   - `block` → refine or override

#### `src/prompts.ts`
Add a refinement prompt helper for gate failures, e.g.:

- `gateFailureRefinementPrompt(...)`

It should include:
- the original goal
- current plan
- proposed beads
- failed/warned checks
- concrete fix hints

#### `src/checkpoint.ts`
Persist `readinessGateResult` if checkpoint state is explicit rather than automatic.

#### Dashboard files
If the dashboard has explicit snapshot types, include gate result there so the approval phase shows gate status.

## Testing Strategy

### Testing philosophy

Test the gate as:
1. a pure fast-check module
2. an orchestrator of existing quality/coverage/simulation systems
3. a UI-facing formatter/integration seam

Prioritize failure modes and graceful degradation.

### New test file

- `src/readiness-gate.test.ts`

### 1. Fast check unit tests

#### Plan/bead existence
- empty plan + empty beads → `block`
- non-empty plan + empty beads → `block`
- non-empty plan + beads → no existence block

#### Bead description length
- 99 chars → `block`
- 100 chars → pass
- 1999 chars → pass
- 2001 chars → `warn`

#### Acceptance criteria
- missing checkbox-style criteria → `block` when required
- same bead passes when `requireAcceptanceCriteria: false`

#### File scope
- missing `### Files:` section → `block` when required
- passes when `requireFileScope: false`

#### Template hygiene
- unresolved `{{placeholder}}` → `block`
- leftover `[Use template: ...]` / `see template` artifacts → `block`

This should align with the repository’s bead template rules in `AGENTS.md`.

#### Dependency graph
- missing dependency id → `block`
- simple cycle → `block`
- single-bead plan skips connectivity/orphan warning
- multiple beads with isolated disconnected node → `warn` if not otherwise invalid

### 2. Gate orchestration tests with mocked LLM-backed modules

Mock/fake the existing quality/coverage/simulation layers.

Cases:
- all checks pass → `overall: "pass"`
- quality 55 → `overall: "block"`
- quality 75 → `overall: "warn"`
- coverage 45 → `overall: "block"`
- coverage 65 → `overall: "warn"`
- oversize bead + quality pass → `overall: "warn"`
- structural block + quality warn → `overall: "block"`

### 3. Graceful degradation tests

- plan quality parse failure → quality check becomes `warn`, gate continues
- plan quality timeout/error → `warn`, gate continues
- coverage helper failure → `warn`, gate continues unless another block exists
- simulation failure → `warn`, gate continues
- malformed bead shape (`description: undefined`) → no crash; returns structural `block`

### 4. Formatting tests

Snapshot or string-assert tests for:
- pass display
- warn display
- block display
- mixed results with fix hints

### 5. Approval flow integration tests

If the repo has approval-flow tests:
- gate pass allows normal creation path
- gate warn shows proceed/refine
- gate block suppresses default creation path until override
- refinement clears stale `readinessGateResult`
- override path preserves accurate state/reporting

### 6. Regression verification

After each implementation phase:

```bash
npm run build
npm test
```

Per repo rules, report results faithfully.

## Edge Cases & Failure Modes

### 1. Empty plan
Behavior:
- `block`
- summary: `Plan is empty`
- no expensive checks required

### 2. No proposed beads
Behavior:
- `block`
- summary: `No beads were proposed`
- do not proceed to creation

### 3. LLM quality scoring timeout or parse failure
Behavior:
- quality check becomes `warn`
- details explain that score is unavailable
- fast checks still run
- do not block solely because the scorer failed

### 4. Coverage computation failure
Behavior:
- `warn`
- preserve user progress
- do not block unless another check fails

### 5. Simulation failure
Behavior:
- `warn`
- simulation is advisory unless the existing module provides a clearly fatal result

### 6. Single-bead plans
Behavior:
- skip connectivity/orphan graph checks
- still run structure/content checks

### 7. Very small but valid plans
Risk:
- low coverage or quality scores may over-penalize intentionally narrow plans

Chosen mitigation:
- use warn thresholds generously
- preserve override
- keep structural failures separate from subjective quality signals

### 8. Proposed beads changed after gate ran
Behavior:
- readiness result is stale
- clear or recompute before create/start-implementing actions that depend on current beads

Minimum implementation:
- clear `readinessGateResult` whenever plan/proposed beads are refined/regenerated

### 9. Crash/restart
Behavior:
- checkpoint may restore a prior gate result
- on resume, re-run the gate if inputs are stale or regeneration occurred
- never assume checkpointed gate result is authoritative if inputs changed

### 10. CLI/tool availability
Because the gate is pre-creation and based on proposed beads:
- core readiness checks should not depend on `br`/`bv`
- avoid introducing failure modes around CLI locks/contention
- if any existing reused helper indirectly depends on CLI state, wrap it and degrade to `warn` on failure

## File Structure

```text
src/
  readiness-gate.ts            # NEW — gate types, fast checks, orchestration, formatting
  readiness-gate.test.ts       # NEW — unit + orchestration tests

  tools/
    approve.ts                 # MODIFY — run gate before br create, add refine/override UX

  prompts.ts                   # MODIFY — add gate failure refinement prompt
  types.ts                     # MODIFY — add readinessGateResult to OrchestratorState

  checkpoint.ts                # MODIFY if explicit serialization is needed
  dashboard/model.ts           # MODIFY if dashboard snapshot is explicit
  dashboard/types.ts           # MODIFY if dashboard types are explicit
  dashboard/render.ts          # MODIFY — show readiness gate status in approval phase
```

### Likely no changes needed
Unless code reuse requires extraction:
- `plan-quality.ts`
- `plan-coverage.ts`
- `plan-simulation.ts`

### Possible optional refactor
If existing validation logic in `beads.ts` is useful but too tied to persisted beads, extract proposal-safe helper(s) into reusable pure functions rather than duplicating regex/structure checks.

## Sequencing

### Phase 1: Inspect and isolate reusable logic
1. Read the existing implementations in:
   - `src/plan-quality.ts`
   - `src/plan-coverage.ts`
   - `src/plan-simulation.ts`
   - `src/beads.ts`
   - `src/tools/approve.ts`
   - `src/types.ts`
2. Identify which existing helpers are safe to reuse with in-memory proposed beads.
3. Decide whether any small extraction from `beads.ts` is needed for proposal-safe checks.

**Checkpoint:** design confirmed against real code, not assumptions.

### Phase 2: Build the gate module
4. Create `src/readiness-gate.ts`.
5. Add:
   - verdict/result/config types
   - default thresholds/config
   - `runFastReadinessChecks`
   - dependency graph checks
   - `formatReadinessGateResult`
   - `runReadinessGate`
6. Implement graceful degradation for quality/coverage/simulation failures.
7. Ensure no destructive or persistent side effects.

**Checkpoint:** isolated module complete.

### Phase 3: Add tests for the gate
8. Create `src/readiness-gate.test.ts`.
9. Add pure fast-check tests first.
10. Add mocked orchestration tests for quality/coverage/simulation integration.
11. Add formatter tests.
12. Run:
   - `npm run build`
   - `npm test`

**Checkpoint:** new module is green before flow integration.

### Phase 4: Wire into approval flow
13. Add `readinessGateResult` to `OrchestratorState` in `src/types.ts`.
14. In `src/tools/approve.ts`, call `runReadinessGate(...)` after plan approval and once proposed beads are available, before any bead creation.
15. Store the result in state.
16. Show formatted gate output in approval UI.
17. Update action options:
   - pass → create beads
   - warn → proceed or refine
   - block → refine or override
18. Clear stale gate result whenever plan/proposed beads are regenerated.

19. Run:
   - `npm run build`
   - `npm test`

**Checkpoint:** feature active in main workflow.

### Phase 5: Refinement loop support
20. Add `gateFailureRefinementPrompt(...)` in `src/prompts.ts`.
21. When user selects refine, pass gate failures and fix hints into the prompt.
22. After refinement, regenerate proposed beads and re-run the gate.
23. Run:
   - `npm run build`
   - `npm test`

**Checkpoint:** full refine/retry loop works.

### Phase 6: Persistence and dashboard
24. If required by the codebase, add `readinessGateResult` to checkpoint serialization in `src/checkpoint.ts`.
25. Add gate result to dashboard snapshot/types/rendering.
26. Ensure resumed sessions either re-run or invalidate stale results.
27. Run:
   - `npm run build`
   - `npm test`

**Checkpoint:** feature complete and visible across UX surfaces.

### Phase 7: Final validation
28. Manually exercise:
   - pass case
   - warn case
   - block + refine case
   - block + override case
29. Verify no beads are created before the gate decision.
30. Verify post-creation validation still works as before.
31. Final:
   - `npm run build`
   - `npm test`

## Implementation notes for the next agent

- Prefer reusing existing scoring/audit/simulation code, but do **not** force pre-creation logic through persisted-bead APIs.
- Keep the new gate module pure/read-only except for calling existing analyzers.
- Preserve the existing override pattern; the gate should improve quality, not trap the user.
- Do not claim checks passed unless they were actually run successfully.
- Follow repo rules: no destructive git/file operations, no script-based source rewrites, and always verify with build/tests after changes.