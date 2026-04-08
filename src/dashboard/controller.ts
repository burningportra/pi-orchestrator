import type { OrchestratorState, Bead } from "../types.js";
import type { DashboardSnapshot } from "./types.js";
import { buildDashboardSnapshot } from "./model.js";

/** Active execution phases that use the fastest refresh cadence. */
const ACTIVE_PHASES = new Set(["implementing", "reviewing", "iterating"]);

/** Terminal phases where the controller should not schedule refreshes. */
const TERMINAL_PHASES = new Set(["idle", "complete"]);

export interface DashboardControllerOptions {
  readBeadsFn: () => Promise<Bead[]>;
  getUnblockedBeadsFn: () => Promise<string[]>;
  getState: () => OrchestratorState;
  getTenderSummary: () => string | undefined;
  onUpdate: (snapshot: DashboardSnapshot) => void;
  /** Refresh interval for active execution phases (ms). Default: 3000. */
  activeIntervalMs?: number;
}

/**
 * Dashboard refresh controller.
 *
 * Uses a self-rescheduling setTimeout (not setInterval) so the cadence
 * can adapt to phase, failure backoff, and invalidation requests.
 */
export class DashboardController {
  private readonly opts: Required<
    Pick<DashboardControllerOptions, "activeIntervalMs">
  > &
    DashboardControllerOptions;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingRefresh = false;
  private consecutiveFailures = 0;
  private disposed = false;
  private started = false;
  private staleBannerShown = false;
  private lastHealthyBeads: Bead[] = [];
  private lastHealthyUnblockedIds: string[] = [];
  private lastHealthyAtMs?: number;

  constructor(options: DashboardControllerOptions) {
    this.opts = {
      activeIntervalMs: 3000,
      ...options,
    };
  }

  /** Begin the refresh scheduling loop. Idempotent. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.scheduleNext();
  }

  /** Stop the scheduling loop. Idempotent. */
  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  /** Trigger an immediate refresh. Safe to call while another refresh is in flight. */
  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    await this.doRefresh();
  }

  /** Mark current data as stale and schedule a near-immediate refresh. */
  invalidate(): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.pendingRefresh = true;
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => this.doRefresh(), 0);
  }

  /** Stop and prevent all future refreshes. */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  // ─── Internal ────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private getIntervalMs(): number {
    // Backoff after 3 consecutive failures
    if (this.consecutiveFailures >= 3) return 30_000;

    const phase = this.opts.getState().phase;
    if (TERMINAL_PHASES.has(phase)) return 0; // don't schedule
    if (ACTIVE_PHASES.has(phase)) return this.opts.activeIntervalMs;
    return this.opts.activeIntervalMs * 2; // slower for non-active phases
  }

  private scheduleNext(): void {
    if (this.disposed || !this.started) return;
    this.clearTimer();

    const interval = this.getIntervalMs();
    if (interval <= 0) return; // terminal phase — don't schedule

    this.timer = setTimeout(() => this.doRefresh(), interval);
  }

  private async doRefresh(): Promise<void> {
    if (this.disposed) return;

    // In-flight guard: coalesce to one pending refresh
    if (this.inFlight) {
      this.pendingRefresh = true;
      return;
    }

    this.inFlight = true;
    try {
      const state = this.opts.getState();
      const tenderSummary = this.opts.getTenderSummary();

      let beads: Bead[] = [];
      let unblockedIds: string[] = [];
      let readsFailed = false;

      try {
        [beads, unblockedIds] = await Promise.all([
          this.opts.readBeadsFn(),
          this.opts.getUnblockedBeadsFn(),
        ]);
        this.consecutiveFailures = 0; // reset on success
      } catch {
        readsFailed = true;
        this.consecutiveFailures++;
        // Fall through — buildDashboardSnapshot handles empty beads gracefully
      }

      const expectedActiveBeads = Array.isArray(state.activeBeadIds) && state.activeBeadIds.length > 0;
      const staleRead = readsFailed || (expectedActiveBeads && beads.length === 0);
      const canReuseHealthyData = staleRead && this.lastHealthyBeads.length > 0;

      if (canReuseHealthyData) {
        beads = this.lastHealthyBeads;
        unblockedIds = this.lastHealthyUnblockedIds;
      }

      const unblockedSet = new Set(unblockedIds);
      const snapshot = buildDashboardSnapshot(
        state,
        beads,
        unblockedSet,
        tenderSummary,
      );

      if (staleRead) {
        snapshot.staleData = true;
        snapshot.staleSnapshotAgeMs = this.lastHealthyAtMs
          ? Math.max(0, Date.now() - this.lastHealthyAtMs)
          : undefined;
        snapshot.alerts = [];
      } else {
        this.lastHealthyBeads = beads;
        this.lastHealthyUnblockedIds = unblockedIds;
        this.lastHealthyAtMs = Date.now();
        snapshot.staleSnapshotAgeMs = undefined;
      }

      // Only show the stale indicator once per stale transition.
      // Suppress repeated stale notes until data recovers.
      if (snapshot.staleData) {
        if (this.staleBannerShown) {
          snapshot.staleData = false;
          snapshot.staleSnapshotAgeMs = undefined;
        } else {
          this.staleBannerShown = true;
        }
      } else {
        this.staleBannerShown = false; // reset when data recovers
      }

      this.opts.onUpdate(snapshot);
    } catch {
      // Never let a refresh crash the controller
    } finally {
      this.inFlight = false;

      // Handle coalesced pending refresh
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        // Use setTimeout(0) to avoid stack overflow on rapid invalidations
        if (!this.disposed && this.started) {
          this.timer = setTimeout(() => this.doRefresh(), 0);
        }
      } else {
        this.scheduleNext();
      }
    }
  }
}
