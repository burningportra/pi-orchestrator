# pi-orchestrator

A repo-aware, multi-agent meta-orchestrator extension for [pi](https://github.com/badlogic/pi-mono).

Scans a code repository, proposes high-leverage improvements, then runs a **Planner → Implementer → Reviewer** loop to execute them — all driven by the LLM calling structured tools.

## Architecture

The extension registers phase-specific tools that the LLM calls in sequence. An orchestrator system prompt is injected to guide the workflow:

```
/orchestrate
  │
  ├─► orch_profile    — Scan repo: languages, frameworks, commits, TODOs, key files
  ├─► orch_discover   — LLM submits 3–7 structured project ideas
  ├─► orch_select     — User picks an idea (or enters custom goal)
  ├─► orch_plan       — LLM submits step-by-step plan, user approves
  │
  │   ┌─── Implementation Loop ─────────────────────────┐
  │   │  LLM uses code tools (read, write, edit, bash)  │
  │   │  to implement each step, then calls:            │
  │   │                                                 │
  │   │  orch_review   — self-review against criteria   │
  │   │    ├─ pass → next step                          │
  │   │    └─ fail → retry (max 3)                      │
  │   └─────────────────────────────────────────────────┘
  │
  └─► Final summary + follow-up suggestions
```

### Key Design Decision

Pi extensions can't call the LLM directly — the LLM calls tools. So instead of an imperative orchestrator, this is a **tool-driven state machine**: the LLM follows the workflow by calling tools in order, and each tool advances the state and returns context for the next phase.

## Install

```bash
# Option 1: Clone into pi extensions directory
cd ~/.pi/agent/extensions/
git clone <this-repo> pi-orchestrator
cd pi-orchestrator
npm install

# Option 2: Test from anywhere
pi -e /path/to/pi-orchestrator/src/index.ts
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/orchestrate` | Start the full discovery → plan → implement → review workflow |
| `/orchestrate [goal]` | Skip discovery, go straight to planning with a specific goal |
| `/orchestrate-stop` | Cancel a running orchestration |
| `/orchestrate-status` | Show current phase and progress widget |

### Orchestrator Tools (called by LLM)

| Tool | Phase | Description |
|------|-------|-------------|
| `orch_profile` | Profiling | Scans repo via shell (find, git log, grep, file reads) |
| `orch_discover` | Discovery | LLM submits structured ideas (3–7 with category, effort, impact) |
| `orch_select` | Selection | Presents ideas to user via UI select dialog |
| `orch_plan` | Planning | LLM submits a plan; shown to user for approval |
| `orch_review` | Review | LLM self-reviews implementation against acceptance criteria |

### Example Session

```
> /orchestrate

📊 Profiling repository...
💡 Generating 5 project ideas...
🎯 Select a project idea:
  1. [dx] Add development scripts — ...
  2. [testing] Comprehensive test suite — ...
  3. [docs] API documentation — ...
  > 2

📝 Plan: Comprehensive test suite (4 steps)
  1. Set up test framework and config
  2. Unit tests for core modules
  3. Integration tests for API endpoints
  4. CI pipeline test step
  Approve? [y/n] y

🔨 Implementing step 1/4...
  (LLM reads files, writes test config, installs packages)
🔍 Reviewing step 1... ✅ Passed

🔨 Implementing step 2/4...
  ...

🎉 All 4 steps completed!
  Summary: Added Vitest config, 12 unit tests, 4 integration tests, CI step.
  Would you like me to create a commit?
```

## Project Structure

```
src/
├── index.ts      # Extension entry: commands, 5 orchestrator tools, events, state machine
├── profiler.ts   # Repo signal collection (find, git, grep) + language/framework detection
├── prompts.ts    # Prompt templates and formatting for each agent phase
└── types.ts      # TypeScript types for all data structures and state
```

## State & Session Persistence

Orchestrator state is persisted via `pi.appendEntry()` so it survives session restarts. The state tracks:

- Current phase
- Repo profile
- Candidate ideas
- Selected goal & constraints
- Plan with steps
- Step results & review verdicts
- Retry counts

## Extending

The architecture supports adding new phases by registering additional tools:

```typescript
pi.registerTool({
  name: "orch_security_review",
  description: "Security-focused review of implementation",
  // ...
});
```

And updating the orchestrator system prompt to include the new tool in the workflow.

## License

MIT
