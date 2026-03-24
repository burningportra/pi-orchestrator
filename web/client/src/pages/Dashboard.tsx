import React from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { useOrchestratorState } from "../hooks/useOrchestratorState";
import { useBeads } from "../hooks/useBeads";
import PhaseIndicator from "../components/PhaseIndicator";
import ActionBar from "../components/ActionBar";
import LiveLog from "../components/LiveLog";
import ConvergenceChart from "../components/ConvergenceChart";

const STATUS_BADGES: Record<string, { label: string; color: string }> = {
  total: { label: "Total", color: "bg-gray-600" },
  open: { label: "Open", color: "bg-bead-open" },
  in_progress: { label: "In Progress", color: "bg-bead-progress" },
  closed: { label: "Closed", color: "bg-bead-closed" },
};

export default function Dashboard() {
  const { data: state, isLoading: stateLoading, error: stateError } = useOrchestratorState();
  const { data: beads, isLoading: beadsLoading } = useBeads();

  if (stateLoading || beadsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-accent" size={24} />
      </div>
    );
  }

  if (stateError) {
    return (
      <div className="flex items-center gap-2 text-red-400 bg-red-900/20 p-4 rounded-lg">
        <AlertCircle size={18} />
        <span>Failed to load orchestrator state</span>
      </div>
    );
  }

  const phase = state?.phase ?? "";
  const allBeads = beads ?? [];
  const total = allBeads.length;
  const open = allBeads.filter((b) => b.status === "open").length;
  const inProgress = allBeads.filter((b) => b.status === "in_progress").length;
  const closed = allBeads.filter((b) => b.status === "closed").length;
  const completionPct = total > 0 ? Math.round((closed / total) * 100) : 0;

  const polishRounds = state?.polishRounds ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Phase Indicator */}
      <PhaseIndicator currentPhase={phase} />

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { key: "total", value: total },
          { key: "open", value: open },
          { key: "in_progress", value: inProgress },
          { key: "closed", value: closed },
        ].map(({ key, value }) => {
          const badge = STATUS_BADGES[key]!;
          return (
            <div
              key={key}
              className="bg-surface-1 rounded-lg p-4 border border-surface-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2.5 h-2.5 rounded-full ${badge.color}`} />
                <span className="text-xs text-gray-400">{badge.label}</span>
              </div>
              <span className="text-2xl font-semibold text-gray-100">
                {value}
              </span>
            </div>
          );
        })}
      </div>

      {/* Progress Bar */}
      {total > 0 && (
        <div className="bg-surface-1 rounded-lg p-4 border border-surface-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-400">Completion</span>
            <span className="text-sm font-medium text-gray-200">
              {completionPct}%
            </span>
          </div>
          <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500"
              style={{ width: `${completionPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Convergence Chart */}
      {polishRounds.length > 0 && (
        <div className="bg-surface-1 rounded-lg p-4 border border-surface-3">
          <h3 className="text-sm font-medium text-gray-300 mb-3">
            Polish Convergence
          </h3>
          <ConvergenceChart data={polishRounds} width={400} height={100} />
        </div>
      )}

      {/* Action Bar */}
      <ActionBar phase={phase} />

      {/* Live Log */}
      <LiveLog />
    </div>
  );
}
