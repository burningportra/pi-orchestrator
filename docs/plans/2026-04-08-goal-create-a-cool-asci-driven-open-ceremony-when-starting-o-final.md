# Plan: ASCII-driven opening ceremony for `/orchestrate`

## 1. Architecture Overview

### Goal
Add a short, playful startup ceremony that runs immediately when `/orchestrate` begins, before the normal scan/plan workflow proceeds.

### High-level design
The feature should be implemented as a thin presentation layer around the existing orchestrate entry flow rather than mixed into planning or execution logic.

Proposed structure:
- **Entry hook in orchestrate startup path**: invoke a new `runOpeningCeremony(...)` helper as soon as the command begins.
- **Ceremony renderer module**: owns ASCII frames, timing, and output composition.
- **Capability-aware fallback**: if the environment is non-interactive, reduced-motion, or unsuitable for animation, render a single static intro frame or skip cleanly.
- **No persistent state**: the ceremony is ephemeral UI only and should not alter checkpoints, bead state, or orchestration decisions.

### Component relationships
- `src/index.ts` or the current `/orchestrate` command entrypoint triggers the ceremony.
- A new presentation helper module generates frames and writes them to the terminal/UI output channel already used by the extension.
- Existing orchestrator workflow continues unchanged after the ceremony completes.

### Architectural decisions
- **Keep ceremony isolated from orchestration state** so it cannot break discovery, beads, checkpointing, or review flow.
- **Prefer deterministic short frame sequences** over complex animation logic to keep it reliable and testable.
- **Degrade gracefully** to a static banner in non-TTY or snapshot-test environments.
- **Avoid external dependencies**; use plain TypeScript string builders and existing runtime APIs.

### Trade-offs
- A handcrafted ASCII intro is easy to control and test, but less visually rich than a full TUI animation.
- Very short timing improves ergonomics and avoids annoying repeat use, but limits dramatic effect.

## 2. User Workflows

### Primary flow
1. User runs `/orchestrate`.
2. Before repo scanning starts, the tool prints a short ceremonial ASCII intro.
3. The intro shows playful hacker/status flavor such as booting, linking agents, or igniting orchestration.
4. After a brief animation or single-frame fallback, the normal orchestrate workflow begins.

### Repeat-use flow
1. Power user runs `/orchestrate` often.
2. Ceremony remains short enough to feel fun without adding noticeable friction.
3. If configured environment is non-interactive or timing-sensitive, the ceremony reduces itself automatically.

### Existing workflow impact
- Discovery, planning, bead approval, implementation, and review remain behaviorally unchanged.
- Only the very first visible output is enhanced.
- Crash recovery and resumed orchestrations should not be blocked by the ceremony.

## 3. Data Model / Types

This feature likely needs only lightweight view-model types.

### New types
```ts
export interface CeremonyFrame {
  text: string;
  delayMs: number;
}

export interface CeremonyOptions {
  enabled?: boolean;
  interactive?: boolean;
  reducedMotion?: boolean;
  maxDurationMs?: number;
}

export interface CeremonyRenderResult {
  rendered: boolean;
  mode: 'animated' | 'static' | 'skipped';
  frameCount: number;
  durationMs: number;
}
```

### Possible existing type changes
- If there is already an orchestrate runtime/options type, add an optional field for presentation behavior rather than creating separate global config.
- If a UI abstraction exists, prefer passing that output writer into the ceremony helper rather than accessing global console state directly.

## 4. API Surface

### New internal helpers
Likely new internal APIs:

```ts
function buildOpeningCeremonyFrames(): CeremonyFrame[]
```
Returns the ordered frame list for the startup ceremony.

```ts
async function runOpeningCeremony(
  writer: { write(text: string): void },
  options?: CeremonyOptions,
): Promise<CeremonyRenderResult>
```
Renders the intro using animated or static mode depending on environment.

```ts
function shouldAnimateCeremony(options?: CeremonyOptions): boolean
```
Determines whether to animate based on interactivity and reduced-motion constraints.

### Entrypoint integration
Wherever `/orchestrate` currently begins its top-level flow:

```ts
await runOpeningCeremony(writer, { interactive, reducedMotion, maxDurationMs: 1200 })
```

### Behavioral expectations
- Animation duration should be capped tightly, ideally around 600–1200ms total.
- Failures inside the ceremony must never abort orchestration; catch and continue.

## 5. Testing Strategy

### Unit tests
Add tests for:
- frame generation returns expected number/order of frames
- unresolved placeholders or malformed ASCII are not present
- total animation duration stays within cap
- static fallback path returns `mode: 'static'`
- non-interactive path can skip or render once deterministically
- errors in write/sleep path are handled without crashing orchestration

### Integration tests
Add or extend tests around orchestrate startup to verify:
- ceremony is invoked before the first discovery/profiling status output
- workflow still proceeds if ceremony is skipped
- checkpoint/recovery flows still reach the same next step

### Snapshot/string tests
Use exact string assertions for the banner and key frame fragments because the feature is text-first.
Keep snapshots small and stable.

### Mocking strategy
- Mock the writer/output sink.
- Mock timing/sleep to avoid real delays.
- Avoid real terminal control sequences in tests unless the repo already abstracts them.

### Edge cases to cover
- empty writer or throwy writer
- reduced motion enabled
- maxDurationMs set lower than full animation duration
- repeated invocation in same process

## 6. Edge Cases & Failure Modes

### Possible issues
- **Animation too slow**: users perceive startup drag.
  - Mitigation: cap runtime; prefer 2–4 small frames.
- **Non-interactive terminals**: escape/control behavior looks messy.
  - Mitigation: use static text or skip.
- **Tests become flaky due to timing**.
  - Mitigation: inject sleep/timer dependency.
- **Crash recovery path feels noisy**.
  - Mitigation: optionally suppress or shorten ceremony during resume flows if such state is available.
- **Writer/UI incompatibility**.
  - Mitigation: keep writer interface minimal and fail open.

### Graceful degradation rules
- If animation cannot run safely, render one banner line/block and continue.
- If rendering throws, swallow error and continue orchestration.
- If terminal width is narrow, choose compact ASCII instead of wide art.

## 7. File Structure

### Likely files to modify
- `src/index.ts`
  - Hook the ceremony into the start of `/orchestrate`.
- Command/orchestration entry file if startup lives elsewhere in `src/`
  - Ensure the ceremony is triggered at the actual first user-visible step.

### Likely new files
- `src/opening-ceremony.ts`
  - ASCII content, frame generation, animation runner, fallback logic.
- `src/__tests__/opening-ceremony.test.ts` or similar test file
  - Unit tests for frames, timing, fallback behavior.

### Optional supporting updates
- `src/types.ts`
  - Shared ceremony option/result types if the repo prefers centralized types.
- README or docs only if maintainers want this visible as a feature; otherwise likely unnecessary.

## 8. Sequencing

### Sequential steps
1. Identify the true `/orchestrate` entrypoint and current first-output path.
2. Implement the isolated ceremony module.
3. Integrate the ceremony call at startup.
4. Add tests for frame generation and fallback behavior.
5. Run build and test suite.

### Parallelizable work
- ASCII copy/style drafting and unit test authoring can happen in parallel once the API shape is fixed.
- Documentation update can be done after implementation if desired.

### Recommended implementation order
1. **Code archaeology**: find startup callsite and output abstraction.
2. **Core module**: add `buildOpeningCeremonyFrames` and `runOpeningCeremony`.
3. **Integration**: call it before discovery/profile begins.
4. **Safeguards**: non-interactive and failure fallback.
5. **Tests**: verify ordering, duration cap, and graceful behavior.
6. **Verification**: `npm run build` and `npm test`.

## Notes grounded in repo context
- Since `pi-orchestrator` is a TypeScript extension with no detected UI framework, the safest implementation is string-based terminal output rather than a new rendering dependency.
- Because the repo already emphasizes strict workflow sequencing, the ceremony should remain presentation-only and must not change planning/bead/review control flow.
- Existing tests use Vitest, so mocking timers and output sinks should fit naturally.
