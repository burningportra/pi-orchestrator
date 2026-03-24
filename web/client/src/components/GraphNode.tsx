import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";

const STATUS_BORDER: Record<string, string> = {
  open: "#6b7280",
  in_progress: "#3b82f6",
  closed: "#22c55e",
  deferred: "#eab308",
  blocked: "#ef4444",
};

interface GraphNodeData {
  id: string;
  title: string;
  status: string;
  isBottleneck?: boolean;
  [key: string]: unknown;
}

function GraphNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData;
  const borderColor = STATUS_BORDER[nodeData.status] ?? "#6b7280";

  return (
    <div
      className="relative bg-surface-1 rounded-lg px-3 py-2 min-w-[120px] max-w-[180px] shadow-lg"
      style={{ border: `2px solid ${borderColor}` }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-surface-3 !border-gray-600 !w-2 !h-2"
      />

      {nodeData.isBottleneck && (
        <div className="absolute -top-2 -right-2 bg-yellow-500 rounded-full p-0.5">
          <AlertTriangle size={10} className="text-black" />
        </div>
      )}

      <div className="text-[10px] font-mono text-gray-500 mb-0.5">
        {nodeData.id}
      </div>
      <div className="text-xs text-gray-200 font-medium leading-tight truncate">
        {nodeData.title}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-surface-3 !border-gray-600 !w-2 !h-2"
      />
    </div>
  );
}

export default memo(GraphNodeComponent);
