import React, { useState } from "react";
import {
  Loader2,
  AlertCircle,
  Check,
  Play,
  SkipForward,
  RotateCcw,
} from "lucide-react";
import { useOrchestratorState } from "../hooks/useOrchestratorState";
import { triggerCommand } from "../api";
import TerminalOutput from "../components/TerminalOutput";

interface GateDef {
  emoji: string;
  key: string;
  label: string;
  description: string;
}

const GATES: GateDef[] = [
  {
    emoji: "🔍",
    key: "self-review",
    label: "Fresh self-review",
    description: "Re-read every changed file with fresh eyes",
  },
  {
    emoji: "👥",
    key: "peer-review",
    label: "Peer review",
    description: "Have another agent review the changes",
  },
  {
    emoji: "✅",
    key: "test-coverage",
    label: "Test coverage",
    description: "Ensure adequate test coverage for changes",
  },
  {
    emoji: "🧹",
    key: "de-slopify",
    label: "De-slopify",
    description: "Clean up any sloppy code, naming, formatting",
  },
  {
    emoji: "📦",
    key: "commit",
    label: "Commit",
    description: "Create well-structured atomic commits",
  },
  {
    emoji: "🚀",
    key: "ship-it",
    label: "Ship it",
    description: "Push changes and open PR if needed",
  },
  {
    emoji: "📋",
    key: "landing-checklist",
    label: "Landing checklist",
    description: "Final verification before merge",
  },
];

export default function GatesPanel() {
  const { data: state, isLoading, error } = useOrchestratorState();
  const [output, setOutput] = useState<string[]>([]);
  const [runningGate, setRunningGate] = useState<string | null>(null);

  const gateStatuses = state?.gates ?? [];
  const getGateStatus = (key: string) =>
    gateStatuses.find((g) => g.name === key);

  // Determine current gate index
  const currentGateIdx = GATES.findIndex((g) => {
    const gs = getGateStatus(g.key);
    return !gs || gs.status === "pending";
  });

  const handleExecute = async (gateKey: string) => {
    setRunningGate(gateKey);
    try {
      const result = await triggerCommand("gate", {
        gate: gateKey,
        action: "execute",
      });
      const out =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      setOutput((prev) => [
        ...prev,
        `[${gateKey}] Executed`,
        ...out.split("\n"),
      ]);
    } catch (err) {
      setOutput((prev) => [
        ...prev,
        `[${gateKey}] Error: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    } finally {
      setRunningGate(null);
    }
  };

  const handleSkip = async (gateKey: string) => {
    try {
      await triggerCommand("gate", { gate: gateKey, action: "skip" });
      setOutput((prev) => [...prev, `[${gateKey}] Skipped`]);
    } catch (err) {
      setOutput((prev) => [
        ...prev,
        `[${gateKey}] Skip failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-accent" size={24} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-red-400 bg-red-900/20 p-4 rounded-lg">
        <AlertCircle size={18} />
        <span>Failed to load state</span>
      </div>
    );
  }

  // Count completed rounds
  const completedGates = GATES.filter((g) => {
    const gs = getGateStatus(g.key);
    return gs && (gs.status === "passed" || gs.status === "skipped");
  }).length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Review Gates</h1>
        <span className="text-xs text-gray-400 bg-surface-2 px-2 py-1 rounded">
          {completedGates} / {GATES.length} completed
        </span>
      </div>

      {/* Gate list */}
      <div className="space-y-2">
        {GATES.map((gate, i) => {
          const gs = getGateStatus(gate.key);
          const isPassed = gs?.status === "passed";
          const isSkipped = gs?.status === "skipped";
          const isFailed = gs?.status === "failed";
          const isCurrent = i === currentGateIdx;
          const isRunning = runningGate === gate.key;

          return (
            <div
              key={gate.key}
              className={`flex items-center gap-4 bg-surface-1 border rounded-lg p-4 transition-colors ${
                isCurrent
                  ? "border-accent/50"
                  : isPassed
                    ? "border-green-900/30"
                    : "border-surface-3"
              }`}
            >
              {/* Status indicator */}
              <div className="text-2xl shrink-0">
                {isPassed ? (
                  <div className="w-8 h-8 flex items-center justify-center rounded-full bg-green-900/30 text-green-400">
                    <Check size={16} />
                  </div>
                ) : isSkipped ? (
                  <div className="w-8 h-8 flex items-center justify-center rounded-full bg-yellow-900/30 text-yellow-400">
                    <SkipForward size={16} />
                  </div>
                ) : isFailed ? (
                  <div className="w-8 h-8 flex items-center justify-center rounded-full bg-red-900/30 text-red-400">
                    <AlertCircle size={16} />
                  </div>
                ) : (
                  <span className="w-8 h-8 flex items-center justify-center">
                    {gate.emoji}
                  </span>
                )}
              </div>

              {/* Label + description */}
              <div className="flex-1 min-w-0">
                <h3
                  className={`text-sm font-medium ${
                    isCurrent ? "text-accent" : "text-gray-200"
                  }`}
                >
                  {gate.label}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {gate.description}
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleExecute(gate.key)}
                  disabled={isRunning || isPassed}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-md transition-colors disabled:opacity-30"
                >
                  {isRunning ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Play size={12} />
                  )}
                  Execute
                </button>
                <button
                  onClick={() => handleSkip(gate.key)}
                  disabled={isRunning || isPassed || isSkipped}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 text-gray-300 text-xs rounded-md transition-colors disabled:opacity-30"
                >
                  <SkipForward size={12} />
                  Skip
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Output area */}
      {output.length > 0 && (
        <TerminalOutput lines={output} title="Gate Output" />
      )}
    </div>
  );
}
