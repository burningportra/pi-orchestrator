# pi-mempalace

Episodic memory for every pi session. On each agent turn, searches past session transcripts for context relevant to your current prompt and injects it into the system prompt automatically. At the end of every session, mines the transcript into MemPalace so future sessions can recall it.

## How it works

```
User prompt
    │
    ▼
before_agent_start
    │  search MemPalace for past excerpts matching the prompt
    │  inject "## Past Session Context" into system prompt
    ▼
Agent responds (with memory of past sessions)
    │
    ▼
session_shutdown
    │  mine current session transcript into MemPalace
    ▼
Next session has access to this session's knowledge
```

## Requirements

```bash
pip install mempalace
python3 -m mempalace init <your-project-dir>
```

The palace lives at `~/.mempalace/palace` by default. Each project gets its own **wing** named after the project directory (e.g. `pi-orchestrator`).

## Install

### Global (all projects)
```bash
cp -r extensions/pi-mempalace ~/.pi/agent/extensions/pi-mempalace
```

### Project-local
```bash
cp -r extensions/pi-mempalace .pi/extensions/pi-mempalace
```

Then start pi normally — the extension loads automatically from those directories.

## What gets injected

For each user prompt, the extension searches for the top-3 most relevant past session excerpts within the current project's wing and appends them to the system prompt as:

```
## Past Session Context

Relevant excerpts from past sessions in this project:

[pi-orchestrator / src] (sim=0.91)
  We chose to use CLI wrapper because ...

[pi-orchestrator / decisions] (sim=0.87)
  The bead approval flow was refactored to ...
```

Nothing is injected if MemPalace is not installed or returns no results.

## Relationship to pi-orchestrator

pi-orchestrator already injects episodic context into individual sub-agent task prompts (implementers, reality-check reviewers). This extension complements that by giving the **orchestrating agent itself** memory of past sessions — useful for planning, goal refinement, and cross-session continuity.
