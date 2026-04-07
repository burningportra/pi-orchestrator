# Interactive TUI Dashboard & Plan Simulation Guide

## TUI Monitoring Dashboard

### Overview

The orchestrator now displays a real-time monitoring dashboard during `/orchestrate` runs. It replaces the old 4-line status widget with a richer, width-aware TUI component that shows bead statuses, progress, and agent activity.

### What it shows

- **Phase header** — current orchestration phase with emoji badge
- **Repository info** — repo name and scan source (ccc/builtin)
- **Goal** — selected orchestration goal (truncated for narrow terminals)
- **Progress bar** — visual `[████░░░░]` with bead completion counts
- **Bead table** — all beads with status badges:
  - `○` open (muted)
  - `◉` in progress (primary)
  - `●` closed (success)
  - `◇` deferred (warning)
- **Stale data banner** — warning when bead reads fail
- **Swarm tender summary** — agent activity when swarm mode is active
- **Alerts** — info/warning/error messages

### How it works

The dashboard is fully automatic — no commands to run:

1. When `/orchestrate` enters an active phase, a `DashboardController` starts polling bead data every 3 seconds (active phases) or 6 seconds (planning phases).
2. Each refresh builds an immutable `DashboardSnapshot` from orchestrator state + live bead reads + tender summary.
3. The snapshot is rendered via pure functions into width-aware string lines.
4. The widget uses pi-tui's Component factory (`render(width)`) for responsive layout.
5. On `idle` or `complete`, the controller stops and the widget is cleared.
6. On session restore, the controller restarts if the session was mid-orchestration.

### Failure safety

- All dashboard code is wrapped in try/catch
- If the Component factory fails, it falls back to the original 4-line string-array widget
- If bead reads fail, a stale-data banner is shown with the last known data
- After 3 consecutive failures, the refresh interval backs off to 30 seconds
- The dashboard can never crash the orchestrator

### Architecture

```
src/dashboard/
├── types.ts          # BeadSnapshot, DashboardSnapshot, DashboardAlert
├── model.ts          # buildDashboardSnapshot() — pure, never throws
├── render.ts         # renderDashboardLines() + 7 helper functions
├── controller.ts     # DashboardController — polling, backoff, lifecycle
├── index.ts          # Barrel re-exports
└── __tests__/
    ├── model.test.ts
    ├── render.test.ts
    ├── controller.test.ts
    ├── integration.test.ts
    └── fuzz.test.ts
```

---

## Plan Execution Path Simulation

### Overview

Before beads are approved, the orchestrator now automatically simulates their execution path to catch structural problems early — file conflicts between parallel beads, missing file references, and dependency ordering issues.

### What it checks

1. **Execution order** — Kahn's algorithm topological sort validates that beads can be executed in dependency order
2. **Parallel groups** — beads are grouped by execution level (same-level beads run concurrently)
3. **File conflicts** — detects when parallel beads modify the same file (sequential beads sharing files is fine)
4. **Missing files** — checks that files referenced in bead descriptions exist in the repo (new files are expected to show as missing)

### How it works

During `orch_approve_beads`:

1. The simulation reads all open beads and their dependency edges
2. It scans `src/` for existing repo files
3. `simulateExecutionPaths()` runs all checks and produces a `SimulationResult`
4. Results are displayed in the approval output:
   - **Pass**: `✅ Simulation passed — 3 execution level(s), no structural issues.`
   - **Fail**: Detailed report with file conflicts, missing files, and fix guidance

### Fix guidance

When issues are found, the report includes actionable fixes:

- **File conflicts**: Add a dependency edge between conflicting beads, or split them
- **Missing files**: Update file paths or mark new files explicitly
- **Cycles**: Break the cycle by removing or reversing one dependency edge

### Integration with refinement

The `freshContextRefinementPrompt` now accepts an optional `simulationReport` parameter. When simulation issues exist, they're injected into the refinement context so the LLM can fix structural problems directly.

### Architecture

```
src/plan-simulation.ts    # Types + 7 exported functions
src/plan-simulation.test.ts  # 26 tests across 7 describe blocks
```

### Exported API

```typescript
// Types
SimulatedBead, FileConflict, MissingFileRef, SimulationResult

// Functions
beadsToSimulated(beads, depMap)       // Convert Bead[] → SimulatedBead[]
computeExecutionOrder(beads)          // Kahn's algorithm topo sort
computeParallelGroups(beads)          // Level assignment by dep chain
detectFileConflicts(beads, groups)    // Parallel-group-aware conflicts
detectMissingFiles(beads, repoFiles)  // Validate file references
simulateExecutionPaths(beads, files)  // Run all checks
formatSimulationReport(result)        // Markdown report
```
