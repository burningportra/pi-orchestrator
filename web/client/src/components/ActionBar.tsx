import React from "react";
import { Play, Square, CheckCircle, Send, Loader2 } from "lucide-react";
import { triggerCommand } from "../api";

interface ActionBarProps {
  phase: string;
  loading?: boolean;
}

interface ActionButton {
  label: string;
  icon: React.ElementType;
  command: string;
  enabledPhases: string[];
  variant?: "primary" | "danger" | "default";
}

const ACTIONS: ActionButton[] = [
  {
    label: "Start Orchestration",
    icon: Play,
    command: "start",
    enabledPhases: ["", "scan", "done"],
    variant: "primary",
  },
  {
    label: "Stop",
    icon: Square,
    command: "stop",
    enabledPhases: [
      "scan",
      "discover",
      "select",
      "plan",
      "build",
      "review",
    ],
    variant: "danger",
  },
  {
    label: "Approve Beads",
    icon: CheckCircle,
    command: "approve",
    enabledPhases: ["select", "plan"],
  },
  {
    label: "Submit Review",
    icon: Send,
    command: "review",
    enabledPhases: ["review"],
  },
];

const VARIANT_CLASSES: Record<string, string> = {
  primary:
    "bg-accent hover:bg-accent-hover text-white disabled:bg-accent/30",
  danger:
    "bg-red-600/80 hover:bg-red-600 text-white disabled:bg-red-600/20",
  default:
    "bg-surface-2 hover:bg-surface-3 text-gray-200 disabled:bg-surface-2/50 disabled:text-gray-600",
};

export default function ActionBar({ phase, loading }: ActionBarProps) {
  const normalizedPhase = phase.toLowerCase();

  const handleAction = async (command: string) => {
    try {
      await triggerCommand(command);
    } catch (err) {
      console.error("Command failed:", err);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {ACTIONS.map((action) => {
        const enabled = action.enabledPhases.includes(normalizedPhase);
        const classes = VARIANT_CLASSES[action.variant ?? "default"];

        return (
          <button
            key={action.command}
            onClick={() => handleAction(action.command)}
            disabled={!enabled || loading}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${classes}`}
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <action.icon size={16} />
            )}
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
