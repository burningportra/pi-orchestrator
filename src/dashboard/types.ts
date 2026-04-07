/**
 * Dashboard data types.
 *
 * These are render-ready value objects produced by `model.ts`.
 * They intentionally duplicate a subset of orchestrator/bead fields so the
 * view layer never depends on mutable runtime state.
 */
import type { OrchestratorPhase } from "../types.js";

/** Immutable snapshot of a single bead for display purposes. */
export interface BeadSnapshot {
  id: string;
  title: string;
  status: "open" | "in_progress" | "closed" | "deferred";
  priority: number;
  unblocked: boolean;
  reviewPasses: number;
  lastReviewVerdict: boolean | undefined;
}

/** A dashboard alert shown to the user. */
export interface DashboardAlert {
  level: "info" | "warning" | "error";
  message: string;
}

/** Complete dashboard data — rebuilt on every refresh cycle. */
export interface DashboardSnapshot {
  phase: OrchestratorPhase;
  phaseEmoji: string;
  repoName: string;
  scanSource: string;
  goal: string;
  beads: BeadSnapshot[];
  completedCount: number;
  totalCount: number;
  tenderSummary: string | undefined;
  lastRefreshMs: number;
  staleData: boolean;
  alerts: DashboardAlert[];
}
