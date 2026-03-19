# pi-orchestrator

A repo-aware, multi-agent meta-orchestrator extension for [pi](https://github.com/badlogic/pi-mono).

Takes a code repository as context, proposes high-leverage improvements, then runs a **Planner → Implementer → Reviewer** loop to execute them with minimal user input.

## Architecture

```
┌─────────────┐     ┌───────────────┐     ┌──────────┐
│ Repo Profiler│ ──► │ Discovery Agent│ ──► │ User Pick│
└─────────────┘     └───────────────┘     └────┬─────┘
                                               │
                    ┌──────────────┐           │
                    │ Planner Agent │ ◄─────────┘
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │   Implementation Loop   │
              │  ┌────────┐ ┌────────┐  │
              │  │Implement│►│ Review │  │
              │  └────────┘ └───┬────┘  │
              │       ▲         │       │
              │       └─────────┘       │
              │     (retry if needed)   │
              └─────────────────────────┘
                           │
                    ┌──────▼───────┐
                    │   Summary    │
                    └──────────────┘
```

## Usage

### Install

```bash
# Clone into pi extensions directory
cd ~/.pi/agent/extensions/
git clone <this-repo> pi-orchestrator
cd pi-orchestrator
npm install
```

### Commands

| Command | Description |
|---------|-------------|
| `/orchestrate` | Start the full orchestration workflow |
| `/orchestrate-stop` | Cancel a running orchestration |
| `/orchestrate-status` | Show current phase and progress |

### LLM Tool

The LLM can also invoke `orchestrate_repo` directly:
- Without args: runs full discovery flow
- With `goal`: skips discovery, plans and implements the given goal

### Quick Test

```bash
cd /path/to/any/repo
pi -e ~/.pi/agent/extensions/pi-orchestrator/src/index.ts
# Then type: /orchestrate
```

## Flow

1. **Profile** — Scans file tree, commits, key files, TODOs
2. **Discover** — LLM suggests 3–7 high-leverage project ideas
3. **Select** — User picks an idea or enters a custom goal
4. **Plan** — LLM creates a step-by-step plan with acceptance criteria
5. **Implement** — LLM executes each step using code tools
6. **Review** — LLM validates each step; retries if needed (max 3)
7. **Summary** — Final report of what changed and how to use it

## Project Structure

```
src/
├── index.ts        # Extension entry: commands, tool, events
├── orchestrator.ts # Core orchestration loop
├── profiler.ts     # Repo signal collection (git, find, grep)
├── prompts.ts      # All agent prompt templates
└── types.ts        # TypeScript types for all data structures
```

## License

MIT
