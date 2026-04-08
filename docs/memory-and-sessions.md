# Memory & Session Management

pi-orchestrator tracks knowledge across sessions using two optional memory systems (CASS and MemPalace) and manages orchestration progress through session state detection and artifact storage. This guide explains each subsystem and how they interact.

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────┐
│                   Orchestration Loop                     │
│                                                         │
│   scan → discover → plan → approve → implement → review │
│     │                  │                    │            │
│     ▼                  ▼                    ▼            │
│  Profiler          CASS Memory        Session State      │
│  + ccc scan        + MemPalace        + Artifacts        │
└─────────────────────────────────────────────────────────┘
```

| Subsystem | Source | Purpose |
|-----------|--------|---------|
| CASS Memory | `src/memory.ts` | Extracted rules and anti-patterns from past sessions |
| MemPalace | `src/episodic-memory.ts` | Verbatim session text for semantic search |
| Session State | `src/session-state.ts` | Detect and resume orchestration phases |
| Session Artifacts | `src/session-artifacts.ts` | Store plans, context, and outputs per session |
| Profiler | `src/profiler.ts` | Collect repo metadata (languages, frameworks, etc.) |
| Scanner | `src/scan.ts` | Coordinate profiling with optional ccc analysis |

---

## CASS Memory

CASS (Cass Memory System) stores **procedural memory** — rules, anti-patterns, and history snippets extracted from past coding sessions. It is accessed via the `cm` CLI.

### Detection

```typescript
// src/memory.ts
detectCass(): boolean
```

Probes for `cm --version` or `cm --help`. Successful detection is cached permanently; failures are cached for 5 seconds to allow mid-session installation.

### Core Operations

| Function | CLI Command | Purpose |
|----------|------------|---------|
| `getContext(task)` | `cm context <task> --json` | Get relevance-scored bullets, anti-patterns, and history for a task |
| `readMemory(cwd, task)` | (wraps `getContext`) | Format bullets as markdown for prompt injection |
| `appendMemory(cwd, entry)` | `cm add <entry> --json` | Save a new learning to the playbook |
| `searchMemory(cwd, query)` | `cm similar <query> --json` | Search entries by similarity |
| `listMemoryEntries()` | `cm ls --json` | List all playbook entries |
| `markRule(bulletId, helpful)` | `cm mark <id> --helpful/--harmful` | Give feedback on a rule |
| `reflectMemory()` | `cm reflect` | Mine session logs for new patterns |
| `onboardMemory()` | `cm onboard --auto` | Bootstrap memory for a new project |

### How Memory Flows into Planning

During orchestration, `readMemory()` is called with the current task description. The output — a markdown block of relevant rules and anti-patterns — is injected into planning prompts so the LLM avoids known pitfalls:

```markdown
### Relevant Rules
- [b-8f3a2c] Always run `npm test` after editing source files
- [b-2d1e9f] Bead descriptions must be self-contained

### Anti-Patterns
- [b-4a7c31] Never use `sed` for code changes — use edit tools
```

### Skill Refinement

`mineSkillGaps()` searches CASS for planning-related sessions and returns snippets. `skillRefinerPrompt()` wraps a skill file and those snippets into a prompt for recursive self-improvement — identifying gaps, workarounds, and missing anti-patterns from real usage data.

---

## Episodic Memory (MemPalace)

MemPalace stores **verbatim session text** and retrieves it via semantic vector search. It is fully optional — if not installed, all functions return empty results without error.

### Detection

```typescript
// src/episodic-memory.ts
detectMempalace(): boolean
```

Runs `python3 -m mempalace status`. Same caching strategy as CASS: true cached permanently, false cached for 5 seconds.

### Wing/Room Model

MemPalace organises sessions into a **palace → wing → room** hierarchy:

- **Wing** = project name, derived from `basename(cwd)` with non-alphanumeric chars replaced by `-`
- **Room** = classification category: `decisions`, `preferences`, `milestones`, `problems`, `emotional`

The `sanitiseSlug()` helper converts a working directory path into a wing name:
```
/Volumes/1tb/Projects/pi-orchestrator → "pi-orchestrator"
```

### Mining Sessions

```typescript
mineSession(transcriptPath: string, projectSlug: string): boolean
```

Passes the session directory to `mempalace mine` with:
- `--mode convos` — chunks by human/assistant exchange pairs
- `--wing <slug>` — groups under the project wing
- `--extract general` — classifies into rooms (decisions, problems, etc.)

Mining is triggered automatically after two clean review rounds in an orchestration. MemPalace deduplicates, so re-mining the same directory is safe.

### Semantic Search

```typescript
searchEpisodic(query: string, options?: { wing?: string; nResults?: number }): string
```

Returns formatted results for prompt injection:
```
[pi-orchestrator / decisions] (sim=0.82)
  We decided to use bead templates as drafting aids only...
```

The high-level wrapper `getEpisodicContext(task, projectSlug)` adds a `## Past Session Examples` header suitable for direct injection into planning prompts.

### CASS vs MemPalace

| Aspect | CASS (`cm`) | MemPalace |
|--------|-------------|-----------|
| Storage | Extracted rules/bullets | Verbatim session text |
| Retrieval | BM25 / similarity | Semantic vector search |
| Answers | "What patterns apply here?" | "What happened last time we did this?" |
| CLI | `cm` | `python3 -m mempalace` |

---

## Session State

`src/session-state.ts` detects and resumes orchestration phases, even after a cold restart where `state.phase` may have reset to `"idle"`.

### Detection Logic

`detectSessionStage(state, beads)` resolves the current phase in priority order:

1. **Persisted phase** — if `state.phase` is a concrete non-idle value, trust it (confidence: `"high"`)
2. **Research state** — if `researchState` has incomplete phases, set to `"researching"` (confidence: `"medium"`)
3. **On-disk inference** — cross-check beads and plan artifacts:
   - In-progress beads → `implementing`
   - Open beads + plan doc → `implementing`
   - Completed beads, none open → `complete`
   - Repo profile present, no beads → `discovering`
   - Plan doc but no beads → `awaiting_plan_approval`
   - Nothing → `idle` (confidence: `"low"`)

### The `SessionStage` Object

The returned `SessionStage` contains everything needed to resume:

| Field | Purpose |
|-------|---------|
| `phase` | Resolved `OrchestratorPhase` |
| `label` / `emoji` | Human-readable display |
| `goal` | The user's selected goal |
| `currentBeadId` | Bead that was in-progress |
| `openBeadCount` / `completedBeadCount` / `totalBeadCount` | Progress counters |
| `nextAction` | One-line hint (e.g. "Call `orch_review` to continue") |
| `resumePrompt` | Full message to send the agent on resume |
| `confidence` | `"high"` / `"medium"` / `"low"` |
| `inferredFrom` | Signals used (e.g. "3 in-progress bead(s) found on disk") |

### Formatting Helpers

- `formatSessionContext(stage)` — builds the multi-line status display shown in the `/orchestrate` menu
- `buildResumeLabel(stage)` — builds the "📂 Resume implementing — br-5 in-progress, 2 more queued" label

---

## Session Artifacts

`src/session-artifacts.ts` provides path resolution for per-session storage.

### Path Resolution

```typescript
sessionArtifactRoot(ctx): string   // Base directory for this session's artifacts
sessionArtifactPath(ctx, name): string  // Full path to a named artifact
```

Resolution priority:
1. `sessionManager.getSessionDir()` + `sessionId` → `<sessionDir>/artifacts/<sessionId>/`
2. `sessionManager.getSessionFile()` + `sessionId` → `<sessionFileParent>/../artifacts/<sessionId>/`
3. Fallback → `<cwd>/.pi-orchestrator-artifacts/`

Artifacts include plan documents, scan results, and any intermediate outputs that need to persist across tool calls within a single orchestration session.

---

## Codebase Profiling

`src/profiler.ts` collects raw repository signals into a `RepoProfile` struct.

### What It Detects

The profiler runs four parallel collectors:

| Collector | Method | Signals |
|-----------|--------|---------|
| **File tree** | `find . -maxdepth 4` (excluding `node_modules`, `.git`, etc.) | Structure, file extensions |
| **Commits** | `git log -n 20` | Recent activity, authors |
| **TODOs** | `grep -rn` for `TODO/FIXME/HACK/XXX` | Code debt signals |
| **Key files** | `head -c 4096` on known config files | `package.json`, `Cargo.toml`, `Dockerfile`, etc. |

From these raw signals, detectors identify:
- **Languages** — from file extension frequency
- **Frameworks** — from dependency declarations (e.g. `next` in `package.json` → Next.js)
- **Test framework** — Vitest, Jest, pytest, cargo test, etc.
- **CI platform** — GitHub Actions, GitLab CI, Jenkins, CircleCI
- **Package manager** — npm, pnpm, yarn, bun, cargo, uv, pip, etc.
- **Entry points** — from `package.json` fields and common file paths
- **Best practices guides** — `CONTRIBUTING.md`, `ARCHITECTURE.md`, and similar docs

### Usage

The profile feeds into discovery (idea generation) and planning prompts, giving the LLM concrete knowledge about the repo's stack, conventions, and existing patterns.

---

## Scanning

`src/scan.ts` orchestrates the scan phase, which is the first step of every `/orchestrate` run.

### Two-Provider Architecture

| Provider | ID | What it does |
|----------|----|-------------|
| **ccc** | `ccc-cli` | Runs `ccc index` + targeted `ccc search` queries for deeper structural analysis |
| **Built-in** | `builtin` | Uses `profileRepo()` from `src/profiler.ts` |

### Scan Flow

```
scanRepo(pi, cwd)
  │
  ├─ Try ccc provider:
  │    1. Ensure ccc is ready (init + index)
  │    2. Run predefined search queries in parallel
  │    3. Combine with profiler output
  │
  └─ On failure → fall back to built-in provider
```

The ccc provider runs three search queries in parallel:
- **Workflow entrypoints** — orchestrator patterns and state machines
- **Planning and review** — gates, prompts, implementation flow
- **Reliability and fallbacks** — error handling, validation, tests

### Output: `ScanResult`

```typescript
interface ScanResult {
  source: "ccc" | "builtin";      // Which provider produced this
  provider: string;                // Provider ID
  profile: RepoProfile;           // Always present (from profiler)
  codebaseAnalysis: ScanCodebaseAnalysis;  // Richer with ccc
  sourceMetadata?: ScanSourceMetadata;     // Warnings, version info
  fallback?: ScanFallbackInfo;             // Present if degraded
}
```

The `codebaseAnalysis` includes recommendations, structural insights, and quality signals. When ccc is unavailable, this is empty but the `profile` still contains full profiler output — the workflow continues unchanged.
