# Orchestrator TUI Dashboard Plan

## 1. Architecture Overview
The dashboard will be built as an overlay TUI component using `pi-tui`'s `ctx.ui.custom({ overlay: true })`. To ensure high agent ergonomics and maintainability, the architecture separates state gathering from presentation:
- **`DashboardStore`**: A reactive data class that polls `br` (for beads) and `agent-mail` (for inbox/status) on a low-frequency interval (e.g., 3s). It computes the derived state (unblocked vs blocked) and emits `update` events.
- **`DashboardComponent`**: A read-only `pi-tui` component that listens to the store. When the store updates, the component calls `invalidate()` and requests a render.
- **`SplitPane` Component**: A new layout primitive to render a two-column view (Left: Beads, Right: Swarm/Mail) safely within terminal width limits.

## 2. User Workflows
- **Launch**: The user runs `/orchestrate-dashboard` (or triggers it via a TUI shortcut). 
- **View**: An overlay dialog appears (90% width, 80% height).
  - *Left Column*: Lists beads grouped by status (`Unblocked` / `Active` / `Blocked`).
  - *Right Column*: Lists active agent status and the most recent `agent-mail` activity.
- **Interact**: The dashboard is primarily informational. Users can press `esc` to close it and return to the main orchestration loop or chat without losing context.
- **Auto-Refresh**: While open, the dashboard updates automatically without user intervention.

## 3. Data Model / Types
```typescript
export interface DashboardState {
  beads: {
    unblocked: Bead[];
    active: Bead[];
    blocked: Bead[];     // Computed: (Open || Deferred) - Unblocked
    completed: Bead[];
  };
  swarm: {
    agents: AgentStatus[];
    recentMail: MailMessage[];
  };
  errors: string[];      // For graceful degradation
}

export interface AgentStatus {
  name: string;
  status: "idle" | "working";
  currentTask?: string;
}

export interface MailMessage {
  id: string;
  sender: string;
  subject: string;
  timestamp: string;
}
```

## 4. API Surface
- **`src/dashboard.ts`**:
  - `export function openDashboard(ctx: ExtensionContext): Promise<void>`
  - `class DashboardStore` with `start()`, `stop()`, and `getState(): DashboardState`
- **`src/agent-mail.ts`**:
  - `export async function fetchOrchestratorInbox(exec: ExecFn, cwd: string, limit?: number): Promise<MailMessage[]>`
- **`src/tui/SplitPane.ts`** (New):
  - `export class SplitPane implements Component` - takes two child components and renders them side-by-side using `truncateToWidth`.

## 5. Testing Strategy
- **Data Layer (Unit)**: Mock `pi.exec` and `agent-mail` RPC responses to test the `DashboardStore`. Verify that blocked beads are correctly deduced by subtracting `readyBeads()` results from all `open` beads.
- **UI Render (Unit)**: Test the `SplitPane` and `DashboardComponent` render functions with extremely narrow widths (e.g., 40 columns) to prove `truncateToWidth` prevents string wrapping panics.
- **Resilience (Integration)**: Simulate a missing `br` CLI or unreachable `agent-mail` port to ensure the dashboard renders error states (via `errors` array) instead of crashing the process.

## 6. Edge Cases & Failure Modes
- **Terminal Resizing**: `pi-tui` components receive a dynamic `width` in their `render(width)` method. The `SplitPane` must dynamically allocate `Math.floor(width / 2)` to each column and re-wrap text accordingly.
- **Agent-Mail Downtime**: The orchestrator might be running without `agent-mail`. The store must catch network exceptions gracefully and set `errors.push("Agent Mail offline")`. The UI will display this as a muted warning.
- **Stale State on First Render**: The `DashboardStore` must execute an immediate synchronous (or fast async) initial fetch before showing the UI, or the UI must display a standard `BorderedLoader` until the first state payload arrives.

## 7. File Structure
- `src/dashboard.ts`: The central orchestration store and `openDashboard` command implementation.
- `src/tui/split-pane.ts`: The reusable two-column TUI layout primitive.
- `src/tui/dashboard-ui.ts`: The `DashboardComponent` class and internal styling.
- `src/dashboard.test.ts`: Tests for store logic and state derivations.
- `src/agent-mail.ts` (modified): Adding the inbox fetch helper.

## 8. Sequencing
1. **Foundation (State)**: Build `DashboardStore` and integrate `br list`, `br ready`, and `agent-mail` fetch endpoints. (Low risk, isolated).
2. **Foundation (Layout)**: Build and test the `SplitPane` layout component to handle side-by-side string rendering safely. (Moderate risk, requires careful string math).
3. **Integration**: Build `DashboardComponent` utilizing `SplitPane` and hook it to the `DashboardStore` event emitter. 
4. **Command Surface**: Register `/orchestrate-dashboard` in `src/commands.ts` and add keyboard shortcut hints in the primary orchestration widget.
