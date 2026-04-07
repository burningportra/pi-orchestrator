# MemPalace Episodic Memory Integration
**Goal:** Add MemPalace as a complementary episodic memory layer alongside the existing CASS procedural memory system in pi-orchestrator.

---

## Background

pi-orchestrator currently uses CASS (`cm` CLI) for memory — a procedural, rule-extraction system that distills learnings into bullet-style playbook entries ("always do X when Y"). CASS is good at *rules*. It doesn't store *what actually happened*.

MemPalace stores raw verbatim session text and retrieves it via semantic search (ChromaDB, all-MiniLM-L6-v2). Its headline result — 96.6% LongMemEval R@5 with zero LLM calls — comes from keeping the full context rather than summarising it. The two systems are complementary:

| System | Storage | Retrieval | What it answers |
|--------|---------|-----------|-----------------|
| CASS | Extracted rules/bullets | BM25 / similarity | "What patterns apply to this task?" |
| MemPalace | Verbatim session text | Semantic vector search | "What happened last time we did something like this?" |

This integration adds MemPalace as an **optional, gracefully-degrading** second memory source. If `mempalace` isn't installed, nothing changes. If it is, agents get richer context during planning and implementation.

---

## Scope

**In scope:**
- New `src/episodic-memory.ts` module (wraps `python -m mempalace` CLI)
- Mine completed orchestration sessions into MemPalace on two-clean-rounds completion
- Search episodic memory during bead planning and implementation, inject as context
- Graceful degradation: never block orchestration if mempalace is absent or errors
- Tests for the new module (detection, mock CLI, context formatting)
- AGENTS.md update with setup instructions

**Out of scope:**
- Mining the *target project's codebase* into MemPalace (out of scope for v1)
- Replacing or modifying CASS memory in any way
- AAAK compression (benchmarks show it regresses retrieval: 84.2% vs 96.6%)
- Building a direct ChromaDB TypeScript client (use CLI only, same pattern as `cm`)
- Any UI for browsing the episodic palace

---

## Architecture

### New module: `src/episodic-memory.ts`

Mirrors the structure of `memory.ts`. Shell-invokes `python -m mempalace` with typed helpers. All functions are best-effort and never throw.

```typescript
// Detection (cached, same pattern as detectCass())
export function detectMempalace(): boolean

// Mine a session transcript into the palace
// transcriptPath: absolute path to a pi session .jsonl file
// projectSlug: sanitised basename of cwd, used as MemPalace wing name
export function mineSession(transcriptPath: string, projectSlug: string): boolean

// Semantic search — returns formatted string ready for prompt injection
// Returns "" if mempalace unavailable or no results
export function searchEpisodic(query: string, options?: {
  wing?: string;
  nResults?: number;
}): string

// High-level: get episodic context for a task/goal
// Searches for relevant past sessions, returns formatted prompt section or ""
export function getEpisodicContext(task: string, projectSlug: string): string

// Stats (for diagnostics)
export function getEpisodicStats(): { available: boolean; palacePath: string | null; drawerCount: number }
```

**CLI calls used:**
- `python -m mempalace mine <transcriptPath> --mode convos --wing <slug>` — ingest
- `python -m mempalace search "<query>" --json --n 5` — retrieve
- `python -m mempalace status --json` — detection/stats

**Detection:** `python -m mempalace --version` with 3s timeout, cached like CASS. False results cache for 5s, true results cache permanently for the process lifetime.

**Wing naming:** `projectSlug` is derived from `path.basename(cwd)` with non-alphanumeric chars replaced by `-`. E.g. `/Volumes/1tb/Projects/pi-orchestrator` → `pi-orchestrator`. This groups all sessions for a project under one MemPalace wing.

**Room assignment:** Delegated to MemPalace's built-in `general` extractor (decisions, preferences, milestones, problems, emotional). We pass `--extract general` on mine calls.

### Changes to `src/prompts.ts`

`implementerInstructions` already accepts an optional `cassMemory?: string` param and renders it as a `## Memory from Prior Orchestrations` section. Add a parallel optional `episodicContext?: string` param rendered as a `## Past Session Examples` section — verbatim excerpts of what worked (and didn't) in prior runs on this project.

Same treatment for `reviewerInstructions` (the function used in swarm review spawning at ~line 1323 and ~1511).

The two sections remain distinct in the prompt — CASS rules vs. MemPalace examples — so the agent can reason about them differently.

```
## Memory from Prior Orchestrations    ← CASS (rules/bullets)
- [b-8f3a2c] always run npm test before marking bead done
...

## Past Session Examples               ← MemPalace (verbatim, new)
[pi-orchestrator / decisions] (sim=0.91)
  We chose to wrap the CLI rather than use the ChromaDB TS client directly
  because keeping the Python dependency isolated to a shell boundary lets us
  upgrade mempalace without touching TypeScript. Lesson: prefer thin wrappers
  for cross-language optional deps.
...
```

### Changes to `src/tools/review.ts`

At the two-clean-rounds completion handler (line ~68), alongside the existing `reflectMemory()` call, add a best-effort `mineSession()` call:

```typescript
// After two clean rounds — mine session into MemPalace
try {
  const { mineSession } = await import("../episodic-memory.js");
  const sessionFile = ctx.sessionManager.getSessionFile();
  const projectSlug = path.basename(ctx.cwd).replace(/[^a-zA-Z0-9]/g, "-");
  if (sessionFile) mineSession(sessionFile, projectSlug);
} catch { /* best-effort */ }
```

This runs after the session is complete, so the full transcript is available. It's fire-and-forget.

### Changes to bead planning (bead creation phase)

In `src/tools/approve.ts` (or wherever bead planning prompts are assembled), before sending the plan prompt to the LLM, call `getEpisodicContext(goal, projectSlug)` and inject the result. This gives the planner verbatim examples of how similar projects were structured in beads previously.

Look for the `cassContext` injection pattern near where `orch_plan` assembles its prompt, and add `episodicContext` in the same way.

---

## Implementation Phases

### Phase 1 — Core module (`src/episodic-memory.ts`)
Create the module with:
- `detectMempalace()` with caching
- `mineSession()` — shells out to `python -m mempalace mine`
- `searchEpisodic()` — shells out to `python -m mempalace search --json`, parses output, formats as a prompt-ready string
- `getEpisodicContext()` — calls `searchEpisodic`, adds header/footer
- `getEpisodicStats()` — calls `python -m mempalace status --json`
- Full TypeScript types for all return values
- All functions wrapped in try/catch, return empty/false on any error

### Phase 2 — Prompt integration (`src/prompts.ts`)
- Add `episodicContext?: string` to `implementerInstructions` signature
- Add `## Past Session Examples` section rendered when non-empty (same pattern as `cassMemory`)
- Same for `reviewerInstructions` (both the ~1323 and ~1511 variants)
- Keep CASS and episodic sections visually distinct with different headers

### Phase 3 — Mining on completion (`src/tools/review.ts`)
- At two-clean-rounds completion, call `mineSession()` best-effort after `reflectMemory()`
- Import is dynamic (same pattern as the existing reflectMemory import) to avoid circular deps
- Log a notification to `ctx.ui.notify` if mining succeeds: `"📚 Session mined into MemPalace"`

### Phase 4 — Search at planning time
- In the bead creation/planning phase, call `getEpisodicContext(goal, projectSlug)`
- Pass result into the bead planning prompt alongside `cassContext`
- Find the correct injection point in `src/tools/approve.ts` or `src/deep-plan.ts` where the planning LLM prompt is assembled

### Phase 5 — Tests (`src/episodic-memory.test.ts`)
- `detectMempalace()`: mock `execFileSync` — returns true when CLI exits 0, false on ENOENT, false on timeout
- `mineSession()`: mock CLI call, verify correct args constructed (`mine <path> --mode convos --wing <slug> --extract general`)
- `searchEpisodic()`: mock CLI response JSON, verify correct arg construction and result formatting
- `getEpisodicContext()`: verify empty string returned when not available
- Slug sanitisation: test `path.basename(cwd)` → slug conversion edge cases

### Phase 6 — Documentation
- Update `AGENTS.md`: add MemPalace setup section (`pip install mempalace`, one-time `mempalace init`)
- Note that episodic memory is optional — skipped gracefully if not installed
- Document the wing/room convention used by pi-orchestrator

---

## Acceptance Criteria

1. **`src/episodic-memory.ts` exists** with all 5 exported functions typed and tested
2. **Zero breakage if mempalace absent** — `npm test` passes on a machine without mempalace installed; orchestration runs normally
3. **`npm run build` passes** (tsc --noEmit) with all new code
4. **`npm test` passes** including the new test file
5. **`implementerInstructions` in `prompts.ts`** accepts and renders `episodicContext` when non-empty
6. **Mining fires on two-clean-rounds** in `review.ts`, best-effort, no error propagation
7. **Episodic context queried during bead planning** when mempalace is available
8. **AGENTS.md** documents setup steps

---

## Key Design Decisions

**Why shell to CLI, not TypeScript ChromaDB client?**
Same reason CASS uses `cm` rather than a direct DB connection: isolates the Python/ChromaDB dependency behind a process boundary. If mempalace upgrades its schema, we don't recompile TypeScript. The thin wrapper pattern has proven itself with CASS.

**Why mine on completion, not on every session stop?**
Two-clean-rounds = a meaningful, complete orchestration. Partial sessions (abandoned, regressed, in-progress) would pollute the palace with low-quality incomplete context. Better to mine good sessions only.

**Why not use L1/L2 wake-up?**
MemPalace's L1 has a known bug (importance metadata never written by miner → all drawers score equal). We use L3 direct semantic search (`mempalace search`) exclusively, which is the highest-accuracy mode (96.6%).

**Why not AAAK compression?**
Benchmarks: AAAK scores 84.2% vs raw 96.6% on LongMemEval. Compression hurts retrieval because it discards semantic content. We store and retrieve verbatim.

**Why `--mode convos` for pi session JSONL?**
Pi session files are structured as interleaved human/assistant turns — exactly what `convo_miner.py`'s exchange-pair chunking handles. The `--extract general` flag additionally classifies chunks into decisions/preferences/milestones/problems — useful room metadata for future filtering.

---

## Dependencies

- **Runtime:** `python3` (already required by CASS workflow), `pip install mempalace` (one-time user step)
- **New npm packages:** none
- **New TypeScript types:** all internal to `episodic-memory.ts`

---

## Risk & Mitigations

| Risk | Mitigation |
|------|-----------|
| `python -m mempalace` slow at scale | 3s timeout on detect, 10s on mine/search. All calls are best-effort, never block UI. |
| ChromaDB unpinned in mempalace deps (Issue #100) | Document `pip install "mempalace[dev]"` isn't needed; plain `pip install mempalace` installs whatever chromadb version mempalace pins at time of install. Not our problem to fix upstream. |
| macOS ARM64 segfault (mempalace Issue #74) | Detection catches this — if `python -m mempalace --version` crashes, `detectMempalace()` returns false and we skip silently. |
| Session JSONL format changes in pi | `--mode convos` is format-agnostic (falls back to paragraph chunking if no `>` markers found). Low risk. |
| Mining adds latency at completion | Called after UI shows "complete" message, fire-and-forget. User never waits on it. |
