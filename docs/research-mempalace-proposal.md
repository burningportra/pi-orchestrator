# Research Proposal: Reimagining MemPalace Through pi-orchestrator

## 1. MemPalace Architecture Summary

**MemPalace** is a local-first AI memory system that stores conversation history and project knowledge in a navigable spatial metaphor. Its core architecture:

### Storage & Retrieval
- **ChromaDB** for vector storage of raw verbatim conversation text — no lossy summarization
- **Spatial hierarchy**: Wings (people/projects) → Halls (memory types: facts, events, discoveries, preferences, advice) → Rooms (named topics) → Closets (summaries) → Drawers (verbatim originals)
- **Tunnels**: Cross-wing links when the same room appears in multiple wings (e.g., "auth-migration" across person and project wings)
- Metadata filtering (wing + room) yields a **+34% retrieval improvement** over flat search

### Memory Stack (4-Layer)
- **L0** (~50 tokens): Static identity file — "who am I?"
- **L1** (~120 tokens): Auto-generated critical facts from top-weighted drawers
- **L2** (on-demand): Wing/room filtered retrieval when a topic arises
- **L3** (on-demand): Full semantic search via ChromaDB

### Knowledge Graph
- Temporal entity-relationship triples in SQLite (not Neo4j)
- Validity windows (`valid_from`, `valid_to`) — facts expire naturally
- Entity-first traversal with time filtering

### AAAK Compression (Experimental)
- Lossy abbreviation dialect using entity codes, structural markers, sentence truncation
- Designed for repeated entities at scale; currently regresses vs raw mode on benchmarks

### Specialist Agents
- Per-domain agents (reviewer, architect, ops) with their own wing + diary
- Agents build expertise by reading their own AAAK-compressed history

### MCP Server
- 19 tools exposed to any MCP-compatible AI (Claude, etc.)
- Palace protocol: verify before answering, diary after sessions, invalidate stale facts

---

## 2. Strongest Patterns and Design Decisions

### A. Spatial Navigation as Retrieval Strategy
The palace metaphor isn't cosmetic — it's a **retrieval optimization**. Wings + rooms reduce the search space before semantic similarity runs. This is fundamentally the same insight as database indexing, applied to conversational memory. The 34% improvement validates that structured metadata beats brute-force embedding search.

### B. Tiered Memory Loading (L0–L3)
The 4-layer stack is elegant: ~170 tokens on wake-up, semantic search only when needed. This is the opposite of "dump everything into context" — it's a **token budget protocol**. The AI knows its world cheaply and digs deeper on demand.

### C. Temporal Validity on Knowledge
Facts expire. `valid_from`/`valid_to` on triples means the graph doesn't lie about stale information. Dynamic tenure calculation ("Kai has been here 3 years") instead of hardcoded assertions.

### D. Store Everything, Summarize Nothing (for retrieval)
Raw verbatim storage in ChromaDB without LLM summarization achieves 96.6% recall. Summaries are optional navigation aids (closets), not the retrieval target. This respects the fact that summarization is lossy and opinionated.

### E. Agent Diaries as Persistent Specialist Memory
Each specialist agent maintains its own compressed diary. The agent reads its history to stay sharp in its domain — a form of **procedural memory** that doesn't pollute the global memory space.

---

## 3. Reimagined Through pi-orchestrator's Strengths

pi-orchestrator has capabilities MemPalace doesn't: multi-agent swarms, bead-based task graphs with dependency tracking, multi-model planning, 4-agent parallel review, coordination backends (beads + agent-mail), CASS procedural memory, and a research-reimagine pipeline. The combination creates things neither project could build alone.

### Proposal A: Orchestration Memory Palace — Spatial Navigation for Bead Graphs

**MemPalace insight**: Wings + rooms + tunnels turn flat search into navigable structure.

**Reimagined**: Apply the palace metaphor to the bead dependency graph itself. Right now, beads are a flat list with dependency edges. A palace-structured bead graph would organize beads into:

- **Wings** = major feature areas or architectural boundaries (auto-detected from file paths in `### Files:` sections)
- **Rooms** = specific concerns within a wing (e.g., "auth", "database", "api-surface")
- **Halls** = bead types: `hall_implementation`, `hall_tests`, `hall_refactor`, `hall_docs`
- **Tunnels** = cross-cutting beads that touch multiple wings (these are the integration risk hotspots)

**Why this matters**: When a swarm of 10 agents is running, the tender needs to answer "which bead should this idle agent take next?" Currently `bv --robot-next` uses a scoring heuristic. With palace structure, the tender could route agents to **wings** where they've built context (an agent that just finished `auth-login` should pick up `auth-logout`, not `billing-webhook`). Tunnels surface integration risks early — beads spanning multiple wings get flagged for senior-model agents.

**Implementation sketch**: New module `src/bead-palace.ts` that builds a palace graph from bead metadata at plan time. The `recommendComposition()` function in `swarm.ts` would use wing count to determine agent distribution. The tender would track which wing each agent is "in" and prefer same-wing assignment.

### Proposal B: Temporal Knowledge Graph for Cross-Session Orchestration Learning

**MemPalace insight**: Temporal triples with validity windows give facts expiration dates.

**Reimagined**: pi-orchestrator already has CASS for procedural memory (rules, anti-patterns). What it lacks is **structured factual memory about the project being orchestrated** that persists across sessions and ages gracefully.

Build an orchestration knowledge graph that records:
```
("src/api/users.ts", "owned_by_bead", "br-42", valid_from="2026-04-07")
("br-42", "blocked_by", "br-38", valid_from="2026-04-07", valid_to="2026-04-07T15:30")
("auth-module", "last_reviewed_by", "opus-agent-3", valid_from="2026-04-07")
("billing-webhook", "failed_review_count", "3", valid_from="2026-04-06")
("graphql-schema", "changed_in_session", "sess-abc123", valid_from="2026-04-07")
```

This creates a **project memory** that answers questions flat CASS rules can't:
- "Which files were recently modified?" → temporal query, not string search
- "Which modules have high review failure rates?" → aggregate over expired triples
- "Has this area been touched since the last review?" → staleness detection
- "Which agent last worked on this wing?" → context continuity

**Key difference from CASS**: CASS stores procedural patterns ("always run tests before review"). The knowledge graph stores **factual state** about the specific project ("br-42 is blocked", "auth module was last reviewed Tuesday"). They're complementary — CASS is the playbook, the KG is the scoreboard.

**Implementation sketch**: `src/orchestration-kg.ts` using SQLite (following MemPalace's approach — no Neo4j dependency). Populated automatically by the tender as beads transition states. Queried by `bv --robot-next` and the review pipeline.

### Proposal C: Layered Agent Context Stack (L0–L3 for Swarm Agents)

**MemPalace insight**: The 4-layer memory stack loads ~170 tokens on wake-up and searches only when needed.

**Reimagined**: When pi-orchestrator spawns swarm agents, each agent gets marching orders as a monolithic prompt blob. This is the "dump everything into context" approach MemPalace explicitly rejects. Apply the layered stack to agent context:

- **L0 — Agent Identity** (~50 tokens): "You are opus-agent-2, implementing bead br-42 in wing auth. Your coordinator is the tender."
- **L1 — Critical Project Facts** (~200 tokens): Auto-generated from the orchestration KG — tech stack, key conventions, recent decisions affecting this wing. Updated each session from the KG, not hardcoded.
- **L2 — Bead Context** (on-demand): Full bead description, dependency status, file contents loaded only when the agent starts work on that bead.
- **L3 — Deep Search** (on-demand): CASS memory search, agent-mail inbox scan, full codebase grep — only when the agent hits a question it can't answer from L0–L2.

**Why this matters**: Current swarm agents waste 30-50% of their context window on background information they may never need. A layered stack means agents start lean and deepen as needed. For a 10-agent swarm, this could mean the difference between agents running out of context mid-bead and completing cleanly.

**Implementation sketch**: Modify `generateAgentConfigs()` in `swarm.ts` to produce layered prompts. The L1 layer is generated from the orchestration KG (Proposal B). L2/L3 are tool-call patterns the agent learns from L0 instructions.

### Proposal D: Specialist Agent Diaries for Review Personas

**MemPalace insight**: Specialist agents maintain their own compressed diaries, building domain expertise across sessions.

**Reimagined**: pi-orchestrator's 4-agent review pipeline (fresh-eyes, polish, ergonomics, reality-check) currently starts from scratch each time. Give each review persona a persistent diary:

- **Fresh-eyes reviewer**: Diary records patterns of bugs it catches — "third time this month an off-by-one error appeared in pagination logic", "auth middleware was missing on 2 of last 5 API endpoints"
- **Polish reviewer**: Diary records style drift — "team started using early returns consistently after session 12", "error messages improved after the i18n bead"
- **Ergonomics reviewer**: Diary records API surface evolution — "broke backward compat twice in the billing module, users complained"
- **Reality-check reviewer**: Diary records prediction accuracy — "estimated 3 beads for auth, took 7", "testing bead was underscoped 4 out of 5 times"

Each diary is stored in the orchestration KG as temporal triples:
```
("reviewer-fresh-eyes", "observed_pattern", "off-by-one in pagination", valid_from="2026-04-07")
("reviewer-reality-check", "prediction_miss", "auth scope underestimate", valid_from="2026-04-06")
```

**Why this matters**: Reviews get sharper over time. A reality-check reviewer that knows "auth work is always underscoped" will flag optimistic auth beads. A fresh-eyes reviewer that knows "pagination is a bug magnet" will scrutinize pagination code harder. This is **institutional memory for code review** — something neither CASS rules nor MemPalace alone achieves.

### Proposal E: Tunnel-Aware Integration Risk Detection

**MemPalace insight**: Tunnels (rooms spanning multiple wings) are natural connection points worth highlighting.

**Reimagined**: In bead graphs, cross-cutting beads are integration risks. A bead that modifies files in both `src/api/` and `src/database/` spans two architectural wings. Currently pi-orchestrator treats all beads equally during review. Tunnel detection would:

1. **At plan time**: Flag beads whose `### Files:` sections span multiple detected wings. These get an automatic `integration-risk` label.
2. **At assignment time**: Tunnel beads are preferentially assigned to opus-class agents (strongest models), not haiku-class.
3. **At review time**: Tunnel beads get an extra **integration reviewer** (5th persona) that specifically checks: "Do the changes in wing A remain consistent with wing B? Are the interfaces still compatible?"
4. **At completion time**: When a tunnel bead closes, the tender broadcasts a summary to all agents working in either wing via agent-mail.

This leverages the spatial metaphor to surface the beads most likely to cause subtle bugs — the ones that cross architectural boundaries.

---

## 4. The Synthesis: Neither Project Could Build This Alone

MemPalace is brilliant at **storing and finding** memories for a single agent in a single session. pi-orchestrator is brilliant at **coordinating multiple agents** across a complex task graph. The synthesis is:

**A Memory-Navigable Multi-Agent Orchestration System** where:

1. The bead graph has spatial structure (wings, rooms, tunnels) that improves agent routing and risk detection
2. A temporal knowledge graph records project facts that expire naturally, giving the orchestrator institutional memory across sessions
3. Each agent in the swarm operates on a layered context stack, loading only what it needs
4. Review personas build persistent expertise through diaries, making reviews sharper over time
5. Cross-boundary work is automatically detected and handled with extra care

This isn't "MemPalace for multi-agent" or "pi-orchestrator with memory." It's a new thing: **spatially-aware orchestration with temporal institutional memory**. The palace metaphor stops being about finding old conversations and starts being about navigating and de-risking a live engineering operation.

The key architectural bet: **spatial structure improves coordination the same way it improves retrieval**. If wing+room filtering gives 34% better recall on conversations, wing-aware agent routing should give measurably better bead completion rates, fewer integration bugs, and more efficient context usage across a swarm.

---

## 5. Recommended Implementation Order

1. **Proposal B** (Orchestration KG) — foundational; other proposals depend on it
2. **Proposal A** (Bead Palace) — requires KG for persistence, unlocks spatial routing
3. **Proposal C** (Layered Agent Context) — requires bead palace for L1 generation
4. **Proposal D** (Review Diaries) — requires KG for storage, independent of A/C
5. **Proposal E** (Tunnel Risk Detection) — requires bead palace, enhances review pipeline

Estimated scope: Proposals A+B are each a single bead (~1 new module + tests). C requires modifying existing swarm code. D+E are enhancements to existing review pipeline. Total: 5-7 beads.

---

*Generated by the Research-Reimagine Pipeline, Phase 1: Investigate*
*Source: https://github.com/milla-jovovich/mempalace (v3.0.0, April 2026)*
*Target: pi-orchestrator*
