import React from "react";
import { Check } from "lucide-react";

const PHASES = [
  "Scan",
  "Discover",
  "Select",
  "Plan",
  "Build",
  "Review",
  "Done",
] as const;

type Phase = (typeof PHASES)[number];

interface PhaseIndicatorProps {
  currentPhase: string;
}

export default function PhaseIndicator({ currentPhase }: PhaseIndicatorProps) {
  const currentIdx = PHASES.findIndex(
    (p) => p.toLowerCase() === currentPhase.toLowerCase(),
  );

  return (
    <div className="flex items-center gap-1 w-full overflow-x-auto py-2">
      {PHASES.map((phase, i) => {
        const isCompleted = i < currentIdx;
        const isCurrent = i === currentIdx;

        return (
          <React.Fragment key={phase}>
            {/* Connector line */}
            {i > 0 && (
              <div
                className={`h-0.5 flex-1 min-w-4 transition-colors ${
                  i <= currentIdx ? "bg-accent" : "bg-surface-3"
                }`}
              />
            )}

            {/* Phase dot + label */}
            <div className="flex flex-col items-center gap-1 shrink-0">
              <div
                className={`flex items-center justify-center w-7 h-7 rounded-full border-2 transition-colors text-xs font-medium ${
                  isCompleted
                    ? "bg-accent border-accent text-white"
                    : isCurrent
                      ? "border-accent text-accent bg-accent/10"
                      : "border-surface-3 text-gray-500 bg-surface-1"
                }`}
              >
                {isCompleted ? <Check size={14} /> : i + 1}
              </div>
              <span
                className={`text-xs transition-colors hidden sm:block ${
                  isCurrent
                    ? "text-accent font-medium"
                    : isCompleted
                      ? "text-gray-400"
                      : "text-gray-600"
                }`}
              >
                {phase}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
