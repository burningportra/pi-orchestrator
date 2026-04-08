# Agent Mail Integration

pi-orchestrator uses [Agent Mail](https://github.com/nicobailon/agent-mail) — a local MCP server at `http://127.0.0.1:8765` — to coordinate parallel sub-agents. It provides file reservations, threaded messaging, build-slot advisory locks, and pre-commit guards so that multiple agents can work on the same codebase without stepping on each other.

All Agent Mail functions live in `src/agent-mail.ts`. The pre-commit guard scaffolding lives in `src/coordination.ts`.

---

## RPC Layer

Two low-level transport functions handle all communication with the Agent Mail server:

### `agentMailRPC(exec, toolName, args)`

Calls an MCP tool via JSON-RPC over HTTP. Builds a `tools/call` request, sends it with `curl` (5s `--max-time`, 8s process timeout), and returns the `structuredContent` from the response. Returns `null` on parse failure or timeout.

### `agentMailReadResource(exec, uri)`

Reads an MCP resource via `resources/read`. Used for querying reservation state (e.g. `resource://file_reservations/<slug>?active_only=true`). Parses the nested `contents[0].text` JSON envelope. Returns `null` on failure.

Both functions use the `ExecFn` signature `(cmd, args, opts?) => Promise<{code, stdout, stderr}>` to decouple from the full extension API.

---

## File Reservations

File reservations prevent two agents from editing the same files simultaneously. All reservations are exclusive by default with a 1-hour TTL.

### Lifecycle

| Function | MCP Tool | Purpose |
|----------|----------|---------|
| `reserveFileReservations(exec, cwd, agentName, files, reason?)` | `file_reservation_paths` | Reserve files before an agent starts work |
| `checkFileReservations(exec, cwd, files, agentName?)` | `resource://file_reservations/<slug>` | Check if files are reserved by *another* agent |
| `renewFileReservations(exec, cwd, agentName, extendSeconds=1800)` | `renew_file_reservations` | Extend TTL when work runs long |
| `releaseFileReservations(exec, cwd, agentName, files?)` | `release_file_reservations` | Release reservations on completion (omit `files` to release all) |
| `forceReleaseFileReservation(exec, cwd, agentName, reservationId, note?, notifyPrevious=true)` | `force_release_file_reservation` | Reclaim a stale reservation from a crashed agent |

### Reservation Checking

`checkFileReservations` reads the active reservation list via `agentMailReadResource`, then filters to reservations that:
1. Are still active
2. Belong to a **different** agent (self-reservations are excluded)
3. Match any of the requested files via `matchesReservationPath`

Path matching supports exact matches, single-glob (`src/*.ts`), and recursive-glob (`src/**`).

---

## Messaging

Threaded messaging lets agents announce progress, request help, and coordinate handoffs.

### Functions

| Function | MCP Tool | Key Parameters |
|----------|----------|---------------|
| `sendMessage(exec, cwd, senderName, to, subject, body, options?)` | `send_message` | `to`: array of agent names; `options.threadId`, `options.importance` ("low"/"normal"/"high"/"urgent"), `options.ackRequired`, `options.cc` |
| `replyMessage(exec, cwd, messageId, senderName, body)` | `reply_message` | Replies in-thread to a specific message |
| `acknowledgeMessage(exec, cwd, agentName, messageId)` | `acknowledge_message` | Marks a message as read+acknowledged |
| `fetchInbox(exec, cwd, agentName, options?)` | `fetch_inbox` | `options.limit` (default 20), `options.urgentOnly`, `options.includeBodies` (default true) |
| `searchMessages(exec, cwd, query, limit=20)` | `search_messages` | FTS5 full-text search across all messages |
| `summarizeThread(exec, cwd, threadId)` | `summarize_thread` | LLM-powered thread summary with `include_examples: true` and `llm_mode: true` |
| `whoisAgent(exec, cwd, agentName)` | `whois` | Agent profile + last 5 commits |

### Conventions

- **Thread ID = bead ID** (e.g. `"bead-abc"`). Cross-bead coordination uses thread `"general"`.
- Agents announce start and completion in their bead thread.
- Messages with `ack_required: true` must be acknowledged by the recipient.

---

## Build Slots

Advisory locks that prevent multiple agents from running conflicting long-lived processes (dev servers, watchers, builds).

| Function | MCP Tool | Key Parameters |
|----------|----------|---------------|
| `acquireBuildSlot(exec, cwd, agentName, slot, ttlSeconds=3600, exclusive=true)` | `acquire_build_slot` | `slot`: named resource (e.g. `"dev-server"`, `"build"`) |
| `renewBuildSlot(exec, cwd, agentName, slot, extendSeconds=1800)` | `renew_build_slot` | Extend the slot TTL |
| `releaseBuildSlot(exec, cwd, agentName, slot)` | `release_build_slot` | Release when done |

Slots are exclusive by default. If another agent holds the slot, acquisition will fail.

---

## Macros

Higher-level operations that combine multiple Agent Mail primitives:

### `ensureAgentMailProject(exec, cwd)`

Calls `ensure_project` with `human_key: cwd`. Called once during `orch_profile` to register the project.

### `prepareThread(exec, cwd, agentName, threadId)`

Calls `macro_prepare_thread`. Joins an existing thread and receives a context summary. Used when spawning review agents that need to participate in an ongoing bead discussion.

### `fileReservationCycle(exec, cwd, agentName, files, reason?)`

Calls `macro_file_reservation_cycle`. Reserves files with a 1-hour exclusive TTL. Designed for atomic reserve→work→release patterns where the server manages cleanup.

### `contactHandshake(exec, cwd, fromAgent, toAgent)`

Calls `macro_contact_handshake`. Establishes a cross-agent contact for direct messaging between two specific agents.

---

## Sub-Agent Preamble

`agentMailTaskPreamble()` generates the complete Agent Mail bootstrap instructions that get injected into every parallel sub-agent's task prompt.

### Signature

```typescript
agentMailTaskPreamble(
  cwd: string,
  agentName: string,
  stepDesc: string,
  artifacts: string[],     // files the agent will edit
  threadId: string,
  mode: "worktree" | "single-branch" = "worktree"
): string
```

### What It Generates

The returned string is a markdown section (`## Agent Mail Coordination — MANDATORY`) containing 7 steps:

1. **Bootstrap** — runs `macro_start_session` via curl to register the sub-agent and get a unique agent name
2. **Helper functions** — a sourced bash script with all coordination functions baked in
3. **Announce start** — `am_send` with the step description
4. **Check inbox** — `am_inbox_urgent` then `am_inbox`, with instructions to acknowledge and reply
5. **Do work** — placeholder for the agent's actual implementation
6. **Check inbox again** — re-check before finishing
7. **Completion** — `am_send` summary + `am_release`

When `mode` is `"single-branch"`, an additional git workflow section is injected between steps 4 and 5, requiring `git pull --rebase` before editing and `git push` after committing. Agents are instructed to stop on conflicts rather than force-push.

### Helper Functions

The generated bash script (`amHelperScript`) provides these functions, all pre-configured with the project key and thread ID:

| Function | Purpose |
|----------|---------|
| `am_rpc` | Low-level JSON-RPC call to Agent Mail |
| `am_send` | Send a message to the current thread |
| `am_dm` | Direct message to a specific agent |
| `am_inbox` | Fetch inbox (all messages) |
| `am_inbox_urgent` | Fetch urgent messages only |
| `am_ack` | Acknowledge a message by ID |
| `am_reply` | Reply in-thread to a message by ID |
| `am_search` | FTS5 search past messages |
| `am_release` | Release all file reservations |
| `am_renew` | Extend reservation TTL (default 1800s) |
| `am_whois` | Get agent profile + recent commits |
| `am_join_thread` | Join an existing thread via `macro_prepare_thread` |
| `am_summarize_thread` | Get LLM summary of a thread |

### Utility: `amRpcCmd(tool, args)`

Builds a raw curl command string for a single Agent Mail RPC call. Used internally by `agentMailTaskPreamble` for the bootstrap step and available for ad-hoc command construction.

---

## Health & Guards

### `healthCheck(exec)`

Calls the `health_check` MCP tool. Returns `{ status: "healthy" }` on success, `null` if the server is unreachable. Used during startup to detect whether Agent Mail is available.

### `installPreCommitGuardViaMCP(exec, cwd)`

Calls `install_precommit_guard` via MCP. This is the **preferred** method — it lets the Agent Mail server install the hook with its own logic.

### `scaffoldPreCommitGuard(exec, cwd)` *(in `src/coordination.ts`)*

Fallback that directly writes `.git/hooks/pre-commit`. The hook:
1. Checks if `$AGENT_NAME` is set
2. Calls `check_commit_conflicts` via curl
3. Blocks the commit if any files are exclusively reserved by another agent
4. Silently allows the commit if Agent Mail is unreachable (graceful degradation)

The hook is made executable (`chmod 755`).

### `checkPreCommitGuard(exec, cwd)` *(in `src/coordination.ts`)*

Returns `true` if `.git/hooks/pre-commit` exists and contains `"AGENT_NAME"` or `"agent-mail"`. Used by the coordination layer to warn when Agent Mail is available but the guard is not installed.

---

## Architecture Notes

- All RPC calls have a 5-second HTTP timeout and 8-second process timeout — Agent Mail is never on the critical path.
- `ExecFn` abstraction means the module can be tested without the full pi extension API.
- Reservation path matching handles exact paths, single globs (`*.ts`), and recursive globs (`src/**`).
- The helper script approach means sub-agents get working bash functions without needing to understand JSON-RPC.
