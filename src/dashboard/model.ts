import type { OrchestratorPhase, OrchestratorState, Bead } from "../types.js";
import type { BeadSnapshot, DashboardSnapshot, DashboardAlert } from "./types.js";

/**
 * Phase emoji map — canonical source.
 * `src/index.ts` re-imports this via the dashboard barrel.
 */
export const PHASE_EMOJI: Record<OrchestratorPhase, string> = {
  idle: "⏸",
  profiling: "📊",
  discovering: "💡",
  awaiting_selection: "🎯",
  planning: "📝",
  awaiting_plan_approval: "📋",
  creating_beads: "🔨",
  refining_beads: "🔍",
  awaiting_bead_approval: "📋",
  implementing: "🔨",
  reviewing: "🔍",
  iterating: "🔄",
  complete: "✅",
};

/**
 * Build a render-ready dashboard snapshot from live orchestrator state and bead data.
 *
 * This function is pure and **never throws**. On any unexpected error it returns
 * a degraded but structurally valid snapshot with `staleData = true`.
 *
 * @param state           Current orchestrator session state.
 * @param beads           Full bead objects from the bead store; order is preserved as-is.
 * @param unblockedBeadIds Set of bead IDs that have no unresolved blockers.
 * @param tenderSummary   Optional one-line summary of currently tendered (in-flight) work.
 */
export function buildDashboardSnapshot(
  state: OrchestratorState,
  beads: Bead[],
  unblockedBeadIds: Set<string>,
  tenderSummary?: string,
): DashboardSnapshot {
  try {
    const alerts: DashboardAlert[] = [];

    // --- Phase ---
    const phase: OrchestratorPhase = state?.phase ?? "idle";
    const phaseEmoji = PHASE_EMOJI[phase] ?? "⏸";

    // --- Repo / scan / goal ---
    const repoName = state?.repoProfile?.name ?? "Unknown repo";
    const scanSource = state?.scanResult?.source ?? "unknown";
    const goal = state?.selectedGoal ?? "";

    // --- Counts ---
    const activeIds = state?.activeBeadIds;
    const totalCount = activeIds?.length ?? beads.length;

    let completedCount = 0;
    const results = state?.beadResults;
    if (results) {
      for (const r of Object.values(results)) {
        if (r.status === "success") completedCount++;
      }
    }

    // --- Stale-data detection ---
    const staleData =
      Array.isArray(activeIds) && activeIds.length > 0 && beads.length === 0;
    if (staleData) {
      alerts.push({
        level: "warning",
        message:
          "Bead data appears stale or unavailable — expected beads but received an empty list.",
      });
    }

    // --- Bead snapshots (preserve incoming order) ---
    const beadSnapshots: BeadSnapshot[] = beads.map((b) => {
      const reviewPassCount = state?.beadReviewPassCounts?.[b.id] ?? 0;
      const reviews = state?.beadReviews?.[b.id];
      const lastVerdict =
        Array.isArray(reviews) && reviews.length > 0
          ? reviews[reviews.length - 1].passed
          : undefined;

      return {
        id: b.id,
        title: b.title, // never truncate — that belongs in render
        status: b.status,
        priority: b.priority ?? 0,
        unblocked: unblockedBeadIds.has(b.id),
        reviewPasses: reviewPassCount,
        lastReviewVerdict: lastVerdict,
      };
    });

    return {
      phase,
      phaseEmoji,
      repoName,
      scanSource,
      goal,
      beads: beadSnapshots,
      completedCount,
      totalCount,
      tenderSummary,
      lastRefreshMs: Date.now(),
      staleData,
      alerts,
    };
  } catch (err: unknown) {
    // Degraded snapshot — structurally valid, clearly marked stale
    const safePhase: OrchestratorPhase =
      state && typeof state.phase === "string" && state.phase in PHASE_EMOJI
        ? state.phase
        : "idle";

    return {
      phase: safePhase,
      phaseEmoji: PHASE_EMOJI[safePhase] ?? "⏸",
      repoName: "Unknown repo",
      scanSource: "unknown",
      goal: "",
      beads: [],
      completedCount: 0,
      totalCount: 0,
      tenderSummary: undefined,
      lastRefreshMs: Date.now(),
      staleData: true,
      alerts: [
        {
          level: "error",
          message: `Dashboard snapshot build failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}
