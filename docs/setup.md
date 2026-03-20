# Setup & Configuration

## Prerequisites

| Requirement | Version | Why |
|-------------|---------|-----|
| [pi](https://github.com/badlogic/pi-mono) | Latest | The coding agent harness this extension runs inside |
| Node.js | ≥ 18 | Required by pi and this extension |
| git | ≥ 2.20 | Worktree support (`git worktree add`) for parallel execution |

## Installation

```bash
pi install git:github.com/burningportra/pi-orchestrator
```

Verify it loaded:

```bash
pi
# Then type: /orchestrate-status
# Expected output: "Phase: idle" (no active session)
```

## Subscription Setup (Multi-Model Features)

Parallel agent features (deep planning, creative brainstorm) require access to multiple model providers.

### What a subscription unlocks

| Feature | What happens | Models needed |
|---------|-------------|---------------|
| **Deep planning** | 3 competing plans from different models, then synthesis | 3 models (e.g. Gemini + GPT + Claude) |
| **Creative brainstorm** | 3 parallel agents (innovator / hardener / simplifier) | 3 models |
| **Peer review** | 4 parallel review agents with different focuses | Works with 1 model, better with variety |

### How to enable

1. **Check available models** — in pi, run `/models` to see what's configured
2. **Add providers** — follow [pi's model docs](https://github.com/badlogic/pi-mono) to add API keys for providers you want (OpenAI, Google, Anthropic, etc.)
3. **During deep planning** — the orchestrator shows available models sorted by context window; pick any 3

> **No subscription?** Everything still works — use "Standard" planning (single model) instead of "Deep plan". Reviews run with your default model.

## Sophia Integration (Optional)

[Sophia](https://github.com/sophialab/sophia) adds structured change tracking on top of git. When detected, pi-orchestrator automatically creates Change Requests (CRs) with task contracts.

### What Sophia adds

- **Plan → CR mapping**: each approved plan becomes a Sophia CR with formal task contracts (intent, acceptance criteria, scope)
- **Task checkpointing**: `orch_review` marks tasks done via `sophia cr task done`
- **Validation on completion**: runs `sophia cr validate` + `sophia cr review` at the end
- **Session restore**: re-detects Sophia state and rebuilds CR context if you resume a session

### How to enable

1. **Install Sophia**:
   ```bash
   pip install sophia-cli
   ```

2. **Initialize in your repo**:
   ```bash
   cd your-project
   sophia init
   ```

3. **Run `/orchestrate`** — the extension auto-detects Sophia and uses it. No extra flags needed.

> **No Sophia?** CR tracking is skipped. Everything else works the same.

## Optional Configuration

### Compound memory

The orchestrator stores learnings from each session (gotchas, patterns, decisions) in `.pi-orchestrator/memory.md` inside your project. This file is automatically read at the start of every future session so the orchestrator avoids repeating mistakes. No setup required — it creates itself on first use.

To reset accumulated learnings:

```bash
rm .pi-orchestrator/memory.md
```

### Development mode

To hack on the extension itself:

```bash
git clone https://github.com/burningportra/pi-orchestrator.git
cd pi-orchestrator && npm install

# Run pi with the local extension
pi -e ./src/index.ts
```
