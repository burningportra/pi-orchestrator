import React from "react";
import { useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import type { Bead } from "../api";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-bead-open",
  in_progress: "bg-bead-progress",
  closed: "bg-bead-closed",
  deferred: "bg-bead-deferred",
  blocked: "bg-bead-blocked",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  closed: "Closed",
  deferred: "Deferred",
  blocked: "Blocked",
};

const PRIORITY_STYLES: Record<number, string> = {
  1: "border-red-500/40",
  2: "border-orange-400/30",
  3: "border-yellow-400/20",
  4: "border-surface-3",
};

interface BeadCardProps {
  bead: Bead;
}

export default function BeadCard({ bead }: BeadCardProps) {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate(`/beads/${bead.id}`)}
      className={`w-full text-left bg-surface-1 border-l-2 ${
        PRIORITY_STYLES[bead.priority] ?? "border-surface-3"
      } rounded-lg p-3 hover:bg-surface-2 transition-colors group`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-mono text-gray-500 bg-surface-2 px-1.5 py-0.5 rounded">
          {bead.id}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${STATUS_COLORS[bead.status] ?? "bg-gray-500"}`}
          />
          <span className="text-xs text-gray-400">
            {STATUS_LABELS[bead.status] ?? bead.status}
          </span>
        </div>
      </div>

      {/* Title */}
      <h3 className="text-sm font-medium text-gray-200 group-hover:text-white truncate mb-2">
        {bead.title}
      </h3>

      {/* Footer */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        {bead.type && (
          <span className="bg-surface-2 px-1.5 py-0.5 rounded">{bead.type}</span>
        )}
        {bead.files.length > 0 && (
          <span className="flex items-center gap-1">
            <FileText size={12} />
            {bead.files.length}
          </span>
        )}
      </div>
    </button>
  );
}
