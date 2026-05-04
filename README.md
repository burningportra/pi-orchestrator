# pi-orchestrator

Type `/orchestrate` in any repo. It scans your codebase with ccc when available, falls back gracefully to the built-in profiler when it is not, proposes improvements, plans the work, implements in parallel, and reviews — all in one command.

## Install

```bash
pi install git:github.com/burningportra/pi-orchestrator
```

Then open any project and type `/orchestrate`.

## What happens

```
You: /orchestrate

→ Scans your repo (ccc codebase analysis first, profile/commits/history second)
→ Proposes 3–7 improvements ranked by impact
→ You pick one (or type your own goal)
→ LLM creates beads (tasks) via br CLI with dependencies
→ You approve beads (with optional refinement passes)
→ Implements ready beads in dependency order
→ Reviews each bead, iterates until passing
→ Done. Learnings saved for next time.
```

## Key features

- **Multi-model planning** — Have 3 different AI models compete on your plan, then synthesize the best parts
- **Bead-based execution** — Tasks created as beads with dependency tracking via br CLI
- **Resilient CLI recovery** — `br`, `bv`, `git`, `find`, `npm`, `ubs`, and coordination probes now run through a structured exec layer with retry for transient failures and graceful degradation when tools disappear mid-session
- **Bead template library** — Optional scaffolds for common bead shapes: `add-api-endpoint`, `refactor-module`, and `add-tests`
- **4-agent review** — Fresh-eyes, polish, ergonomics, and reality-check reviewers run in parallel
- **CASS memory** — Procedural memory via [cm CLI](https://github.com/Dicklesworthstone/cass_memory_system) — relevance-scored rules, anti-patterns, and cross-session learning
- **Crash recovery** — Orchestration state is checkpointed to disk after every phase transition. If your session crashes, `/orchestrate` will offer to resume from the last checkpoint
- **Coordination backends** — Beads (br CLI), Sophia, and agent-mail for multi-agent coordination

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed
- Node.js ≥ 18, git ≥ 2.20
- Optional but recommended: [ccc](https://github.com/cocoindex-io/cocoindex-code) for richer codebase scanning

Multi-model planning requires a pi subscription. Sophia and ccc are optional.
If ccc is unavailable, `/orchestrate` falls back to the built-in profiler and keeps the same workflow.
See [docs/setup.md](docs/setup.md) for detailed configuration.

## Commands

| Command | Description |
|---------|-------------|
| `/orchestrate` / `/flywheel-start` | Full workflow — scan, plan, implement, review |
| `/orchestrate [goal]` / `/flywheel-start [goal]` | Skip discovery, plan a specific goal directly |
| `/orchestrate-stop` / `/flywheel-stop` | Cancel and clean up worktrees |
| `/orchestrate-status` / `/flywheel-status` | Show current phase and progress |
| `/flywheel-doctor` | Read-only diagnostic for git, Node, br/bv, ntm, cm, agent-mail, checkpoint, and orphaned worktrees |
| `/orchestrate-cleanup` / `/flywheel-cleanup` | Safely remove orphaned worktrees |
| `/orchestrate-swarm-status` / `/flywheel-swarm-status` | Show active swarm health |
| `/orchestrate-swarm-stop` / `/flywheel-swarm-stop` | Stop swarm monitoring and show landing guidance |

For Claude agent-flywheel parity, the pi tools are also registered under `flywheel_*` names in addition to the legacy `orch_*` names: `flywheel_profile`, `flywheel_discover`, `flywheel_select`, `flywheel_plan`, `flywheel_approve_beads`, `flywheel_review`, `flywheel_memory`, and `flywheel_verify_beads`.

## Learn more

- [Setup & Configuration](docs/setup.md) — prerequisites, ccc, subscriptions, Sophia
- [Architecture](docs/architecture.md) — scan pipeline, context priority, bead templates, and workflow internals

## Bead template library

The planner includes a small built-in bead template library to speed up drafting common tasks. It exists to give the LLM a reliable starting structure for recurring work without making templates mandatory.

Built-in templates:
- `add-api-endpoint`
- `refactor-module`
- `add-tests`

Templates are optional scaffolds. They help shape a first draft, but the final bead must be fully expanded and self-contained before it is created. Final beads should carry forward the real rationale, acceptance criteria, and `### Files:` scope directly in the description.

Correct usage example:

```txt
Start from template add-api-endpoint with placeholders:
- {{endpointPath}} = /api/users
- {{moduleName}} = user-management
- {{endpointPurpose}} = return a filtered user list
- {{httpMethod}} = GET
- {{implementationFile}} = src/api/users.ts
- {{testFile}} = src/api/users.test.ts

Final bead id: add-users-endpoint
Final bead title: Add users endpoint
```

That placeholder syntax is only for drafting. The bead that gets created must resolve every `{{placeholderName}}` and must not contain template shorthand like `[Use template: ...]` or `see template`.

Validation in `src/beads.ts` enforces this hygiene. Open beads fail validation if they still contain unresolved template artifacts such as `[Use template: ...]`, `see template`, or raw `{{placeholderName}}` markers.

## Development

```bash
git clone https://github.com/burningportra/pi-orchestrator.git
cd pi-orchestrator && npm install
npm run build
npm test
pi -e ./src/index.ts
```

When changing orchestration internals, prefer the shared CLI wrapper layer in `src/cli-exec.ts` instead of adding new raw `pi.exec(...)` calls. The wrapper gives you structured failures, transient retry where appropriate, and predictable fallback behavior for user-facing flows.

## License

MIT
