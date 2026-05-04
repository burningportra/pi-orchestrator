# Plan: Structured Error Recovery for br/External CLI Failures

## Goal
Add resilient wrappers around br CLI calls with structured error types, automatic retry for transient failures, and graceful degradation when br is unavailable mid-session.

---

## 1. Architecture Overview

### Current State
- **60+ `pi.exec()` calls** scattered across `commands.ts`, `beads.ts`, `coordination.ts`, `tools/approve.ts`, `tools/review.ts`, and `beads.ts`
- Error handling is ad-hoc: bare `try/catch` blocks returning `null`, `[]`, or `false` with no logging, no retry, and no structured error types
- `beads.ts` has 20+ functions that each silently swallow exec failures
- `commands.ts` has `/* best effort */` and `/* ignore */` comments on catches
- `coordination.ts` does detection via exec+timeout with no retry for flaky CLI detection

### Proposed Architecture

```
src/cli-exec.ts  (NEW — central resilient exec layer)
    ├── CliExecError (structured error type with command, stderr, exitCode, isTransient)
    ├── resilientExec() — retry-aware wrapper around pi.exec()
    ├── brExec() — br-specific wrapper with br-aware transient detection
    └── ExecResult<T> — typed result with ok/err discrimination
```

**Key decisions:**
1. **Single module, not a class** — matches the project's functional style (beads.ts, coordination.ts are all free functions)
2. **Opt-in adoption** — callers migrate gradually; existing bare pi.exec calls keep working
3. **Retry only for transient failures** — timeout, ENOENT (intermittent PATH issues), exit code 1 with empty stderr (br race condition). Permanent failures (bad arguments, missing beads) fail immediately.
4. **Logging, not throwing** — most call sites currently swallow errors. The wrapper logs structured warnings so failures are visible without breaking existing silent-degradation behavior.

### Trade-offs
- **Wrapper overhead**: Minimal — one async function call wrapping another
- **Not all calls need retry**: Detection calls in coordination.ts are one-shot by design. The wrapper supports `maxRetries: 0` for these.
- **Silent degradation preserved**: Functions that return `null`/`[]` on failure keep doing so, but now log why.

---

## 2. User Workflows

### No user-facing workflow changes
This is an internal reliability improvement. Users see:
- **Better error messages** when br fails (logged to console instead of silently swallowed)
- **Fewer random failures** during long orchestrations (transient br CLI timeouts are retried)
- **Graceful degradation** when br becomes unavailable mid-session (e.g., PATH changes, br update)

### Developer workflow
- New br-calling code uses `brExec()` instead of raw `pi.exec("br", ...)`
- Existing code migrated file-by-file (beads.ts first, then commands.ts, then tools/)

---

## 3. Data Model / Types

### New types in `src/cli-exec.ts`

```typescript
/** Structured error from a CLI exec call */
export interface CliExecError {
  command: string;       // e.g. "br update bd-123 --status closed"
  args: string[];
  exitCode: number | null;
  stderr: string;
  isTransient: boolean;  // true if retry might help
  attempts: number;      // how many times we tried
  lastError?: unknown;   // raw error for debugging
}

/** Discriminated result type */
export type ExecResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CliExecError };

/** Options for resilientExec */
export interface ResilientExecOptions {
  cwd?: string;
  timeout?: number;
  maxRetries?: number;      // default: 2
  retryDelayMs?: number;    // default: 500
  /** Custom transient detector. Default: timeout + empty-stderr heuristic */
  isTransient?: (exitCode: number | null, stderr: string, err: unknown) => boolean;
  /** If true, log warnings on failure. Default: true */
  logWarnings?: boolean;
}
```

### No changes to existing types
`OrchestratorState` in `types.ts` is unchanged. The wrapper is stateless.

---

## 4. API Surface

### `resilientExec(pi, cmd, args, opts?)` → `Promise<ExecResult<{stdout: string; stderr: string}>>`
Generic retry-aware exec wrapper. Used for any CLI call.

### `brExec(pi, args, opts?)` → `Promise<ExecResult<{stdout: string; stderr: string}>>`
Convenience wrapper that prefixes `"br"` and uses br-specific transient detection:
- Timeout → transient
- Exit code 1 + empty stderr → transient (br race condition)
- Exit code > 1 → permanent
- ENOENT / EACCES → permanent (br not installed)

### `brExecJson<T>(pi, args, opts?)` → `Promise<ExecResult<T>>`
Like `brExec` but parses stdout as JSON. Returns structured error if JSON parsing fails.

### Helper: `isTransientBrError(exitCode, stderr, err)` → `boolean`
Exported for testing. Encapsulates the transient-detection heuristic.

---

## 5. Testing Strategy

### Unit tests: `src/cli-exec.test.ts`

1. **resilientExec retries on transient failure then succeeds** — mock pi.exec to fail once with timeout, succeed on retry
2. **resilientExec does not retry permanent failures** — mock pi.exec to fail with exit code 2
3. **resilientExec respects maxRetries** — mock pi.exec to always timeout, verify exactly maxRetries+1 attempts
4. **brExec classifies transient vs permanent errors** — table-driven test with known exit code / stderr combos
5. **brExecJson parses valid JSON** — happy path
6. **brExecJson returns error on invalid JSON** — stdout is not JSON
7. **isTransientBrError unit tests** — edge cases: empty stderr, null exit code, ENOENT

### Integration-level: migration validation
After migrating `beads.ts`, run `npm test` to ensure existing bead tests still pass (they exercise `readBeads`, `readyBeads`, etc.).

### Mocking strategy
Create a minimal mock `pi` object with a jest-style `exec` mock:
```typescript
function mockPi(responses: Array<{stdout?: string; stderr?: string; throws?: Error}>) {
  let callIndex = 0;
  return {
    exec: async () => {
      const r = responses[callIndex++];
      if (r.throws) throw r.throws;
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
  } as unknown as ExtensionAPI;
}
```

---

## 6. Edge Cases & Failure Modes

| Scenario | Detection | Handling |
|----------|-----------|----------|
| br CLI not in PATH | ENOENT on first call | Return error, log warning, no retry |
| br hangs (timeout) | Timeout error | Retry up to maxRetries, then return error |
| br race condition (exit 1, empty stderr) | Exit code 1 + empty stderr | Retry once |
| br returns invalid JSON | JSON.parse throws | Return error with raw stdout in message |
| br returns valid JSON but wrong shape | Type assertion | Caller's responsibility (unchanged from today) |
| pi.exec rejects with unknown error | catch block | Classify as non-transient, return error |
| maxRetries = 0 | Config | No retry, single attempt (for detection calls) |
| Retry delay during fast tests | retryDelayMs = 0 | Tests pass `retryDelayMs: 0` |

---

## 7. File Structure

### New files
- `src/cli-exec.ts` — resilient exec wrapper, error types, br-specific helpers
- `src/cli-exec.test.ts` — comprehensive unit tests

### Modified files (migration order)
1. `src/beads.ts` — migrate 15+ `pi.exec("br", ...)` calls to `brExec`/`brExecJson`. This is the highest-value target: most br calls, most silent failures.
2. `src/commands.ts` — migrate ~15 `pi.exec("br", ...)` calls. Second priority.
3. `src/tools/review.ts` — migrate 2 br calls
4. `src/tools/approve.ts` — migrate 2 calls (br dep list, find)
5. `src/coordination.ts` — migrate detection calls with `maxRetries: 0` (detection is intentionally one-shot)

### NOT modified
- `src/types.ts` — no state changes needed
- `src/prompts.ts` — no exec calls
- `src/deep-plan.ts` — uses `pi.exec` for model spawning, not CLI tools
- Test files for existing modules — they test behavior, not exec internals

---

## 8. Sequencing

### Bead 1: Core wrapper (`src/cli-exec.ts` + `src/cli-exec.test.ts`)
- Create the module with `resilientExec`, `brExec`, `brExecJson`, `isTransientBrError`
- Write comprehensive tests
- No other files touched yet
- **Dependency**: none

### Bead 2: Migrate `beads.ts` to use resilient wrappers
- Replace bare `pi.exec("br", ...)` calls with `brExec`/`brExecJson`
- Add structured logging on failure (console.warn with command details)
- Preserve existing return-null/return-[] behavior for callers
- Run `npm test` to verify no regressions
- **Dependency**: Bead 1

### Bead 3: Migrate `commands.ts` to use resilient wrappers
- Replace br exec calls in commands.ts
- Non-br calls (git, npm, find, ubs) use `resilientExec` with appropriate transient detection
- **Dependency**: Bead 1

### Bead 4: Migrate `tools/` and `coordination.ts`
- `tools/review.ts` — 2 br calls
- `tools/approve.ts` — 2 calls
- `coordination.ts` — detection calls with `maxRetries: 0`
- **Dependency**: Bead 1

**Parallelism**: Beads 2, 3, and 4 can run in parallel after Bead 1 completes.

---

## Acceptance Criteria (global)

1. `npm run build` passes with no type errors
2. `npm test` passes with no regressions
3. All `pi.exec("br", ...)` calls in beads.ts, commands.ts, tools/review.ts, tools/approve.ts, and coordination.ts are migrated to the new wrappers
4. `cli-exec.test.ts` has ≥10 test cases covering retry, no-retry, JSON parse, transient detection
5. No behavior change for callers — functions that returned null/[] on failure continue to do so
6. Structured warnings are logged on failure (not silently swallowed)
