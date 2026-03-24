import React, { useState } from "react";
import {
  Loader2,
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  GitBranch,
} from "lucide-react";
import { useOrchestratorState } from "../hooks/useOrchestratorState";
import type { SophiaCR } from "../api";

const STATUS_COLORS: Record<string, string> = {
  open: "text-blue-400",
  merged: "text-green-400",
  closed: "text-red-400",
  draft: "text-yellow-400",
};

export default function SophiaPanel() {
  const { data: state, isLoading, error } = useOrchestratorState();
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const crs = state?.sophia ?? [];

  if (crs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <Bot size={32} className="mb-3" />
        <p className="text-sm">Sophia not detected</p>
        <p className="text-xs text-gray-600 mt-1">
          Sophia CRs will appear here when active
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-semibold text-gray-100">Sophia CRs</h1>

      <div className="bg-surface-1 border border-surface-3 rounded-lg overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_2fr_1fr_1fr] gap-4 px-4 py-2 border-b border-surface-3 text-xs text-gray-500 font-medium">
          <span>ID</span>
          <span>Title</span>
          <span>Branch</span>
          <span>Status</span>
        </div>

        {/* Rows */}
        {crs.map((cr) => (
          <CRRow
            key={cr.id}
            cr={cr}
            isExpanded={expandedId === cr.id}
            onToggle={() =>
              setExpandedId(expandedId === cr.id ? null : cr.id)
            }
          />
        ))}
      </div>
    </div>
  );
}

function CRRow({
  cr,
  isExpanded,
  onToggle,
}: {
  cr: SophiaCR;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-surface-3 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-[1fr_2fr_1fr_1fr] gap-4 px-4 py-3 hover:bg-surface-2 transition-colors text-left"
      >
        <span className="text-xs font-mono text-gray-400 flex items-center gap-1">
          {isExpanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
          {cr.id}
        </span>
        <span className="text-sm text-gray-200 truncate">{cr.title}</span>
        <span className="text-xs text-gray-400 flex items-center gap-1 truncate">
          <GitBranch size={12} />
          {cr.branch}
        </span>
        <span
          className={`text-xs font-medium ${STATUS_COLORS[cr.status] ?? "text-gray-400"}`}
        >
          {cr.status}
        </span>
      </button>

      {isExpanded && (
        <div className="px-4 pb-3 ml-6 text-xs text-gray-500 space-y-1">
          <div>
            <span className="text-gray-600">ID: </span>
            {cr.id}
          </div>
          <div>
            <span className="text-gray-600">Branch: </span>
            <code className="bg-surface-2 px-1 py-0.5 rounded text-gray-400">
              {cr.branch}
            </code>
          </div>
          <div>
            <span className="text-gray-600">Status: </span>
            {cr.status}
          </div>
        </div>
      )}
    </div>
  );
}
