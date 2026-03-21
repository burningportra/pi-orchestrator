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
→ Creates a step-by-step plan
→ Implements each step with self-review
→ You approve, request changes, or run parallel reviews
→ Done. Learnings saved for next time.
```

## Key features

- **Multi-model planning** — Have 3 different AI models compete on your plan, then synthesize the best parts
- **Parallel execution** — Independent steps run simultaneously in git worktrees
- **4-agent review** — Fresh-eyes, polish, ergonomics, and reality-check reviewers run in parallel
- **Compound memory** — Each run learns from previous runs in the same repo
- **Sophia integration** — Optional change request tracking with contracts and validation

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
