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
- **4-agent review** — Fresh-eyes, polish, ergonomics, and reality-check reviewers run in parallel
- **CASS memory** — Procedural memory via [cm CLI](https://github.com/Dicklesworthstone/cass_memory_system) — relevance-scored rules, anti-patterns, and cross-session learning
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
| `/orchestrate` | Full workflow — scan, plan, implement, review |
| `/orchestrate [goal]` | Skip discovery, plan a specific goal directly |
| `/orchestrate-stop` | Cancel and clean up worktrees |
| `/orchestrate-status` | Show current phase and progress |

## Learn more

- [Setup & Configuration](docs/setup.md) — prerequisites, ccc, subscriptions, Sophia
- [Architecture](docs/architecture.md) — scan pipeline, context priority, and workflow internals

## Development

```bash
git clone https://github.com/burningportra/pi-orchestrator.git
cd pi-orchestrator && npm install
pi -e ./src/index.ts
```

## License

MIT
