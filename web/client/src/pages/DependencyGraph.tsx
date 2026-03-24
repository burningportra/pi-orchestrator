import React, { useState, useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Loader2,
  AlertCircle,
  GitFork,
  List,
  Maximize,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { useBeads } from "../hooks/useBeads";
import { useInsights } from "../hooks/useOrchestratorState";
import GraphNode from "../components/GraphNode";
import type { Bead } from "../api";

const nodeTypes: NodeTypes = {
  bead: GraphNode,
};

type ViewMode = "dag" | "tree";

export default function DependencyGraph() {
  const { data: beads, isLoading, error } = useBeads();
  const { data: insights } = useInsights();
  const [view, setView] = useState<ViewMode>("dag");
  const [selectedBead, setSelectedBead] = useState<Bead | null>(null);

  const bottleneckIds = useMemo(
    () => new Set(insights?.bottlenecks ?? []),
    [insights],
  );

  // Build nodes and edges for DAG view
  const { nodes, edges } = useMemo(() => {
    if (!beads) return { nodes: [], edges: [] };

    const n: Node[] = beads.map((b, i) => ({
      id: b.id,
      type: "bead",
      position: { x: (i % 4) * 220 + 50, y: Math.floor(i / 4) * 120 + 50 },
      data: {
        id: b.id,
        title: b.title,
        status: b.status,
        isBottleneck: bottleneckIds.has(b.id),
      },
    }));

    const e: Edge[] = [];
    for (const b of beads) {
      for (const dep of b.dependencies) {
        e.push({
          id: `${dep}->${b.id}`,
          source: dep,
          target: b.id,
          style: { stroke: "#242432" },
          animated: b.status === "in_progress",
        });
      }
    }

    return { nodes: n, edges: e };
  }, [beads, bottleneckIds]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const bead = beads?.find((b) => b.id === node.id) ?? null;
      setSelectedBead(bead);
    },
    [beads],
  );

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
        <span>Failed to load beads</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">
          Dependency Graph
        </h1>
        <div className="flex bg-surface-1 rounded-lg border border-surface-3 overflow-hidden">
          <button
            onClick={() => setView("dag")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "dag"
                ? "bg-accent/15 text-accent"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <GitFork size={14} /> DAG
          </button>
          <button
            onClick={() => setView("tree")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "tree"
                ? "bg-accent/15 text-accent"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <List size={14} /> Tree
          </button>
        </div>
      </div>

      {view === "dag" ? (
        <div className="flex gap-4">
          <div
            className="flex-1 bg-surface-1 rounded-lg border border-surface-3 overflow-hidden"
            style={{ height: "calc(100vh - 200px)" }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#242432" gap={20} />
              <Controls
                className="!bg-surface-2 !border-surface-3 !rounded-lg [&>button]:!bg-surface-2 [&>button]:!border-surface-3 [&>button]:!text-gray-400 [&>button:hover]:!bg-surface-3"
              />
            </ReactFlow>
          </div>

          {/* Sidebar info panel */}
          {selectedBead && (
            <div className="w-72 bg-surface-1 rounded-lg border border-surface-3 p-4 space-y-3 shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-gray-500">
                  {selectedBead.id}
                </span>
                <button
                  onClick={() => setSelectedBead(null)}
                  className="text-gray-500 hover:text-gray-300 text-xs"
                >
                  ✕
                </button>
              </div>
              <h3 className="text-sm font-medium text-gray-200">
                {selectedBead.title}
              </h3>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="bg-surface-2 text-gray-400 px-2 py-0.5 rounded">
                  {selectedBead.status.replace("_", " ")}
                </span>
                <span className="bg-surface-2 text-gray-400 px-2 py-0.5 rounded">
                  P{selectedBead.priority}
                </span>
                <span className="bg-surface-2 text-gray-400 px-2 py-0.5 rounded">
                  {selectedBead.type}
                </span>
              </div>
              {selectedBead.description && (
                <p className="text-xs text-gray-400 line-clamp-4">
                  {selectedBead.description}
                </p>
              )}
              {selectedBead.files.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Files</p>
                  {selectedBead.files.slice(0, 5).map((f) => (
                    <div
                      key={f}
                      className="text-[10px] font-mono text-gray-500 truncate"
                    >
                      {f}
                    </div>
                  ))}
                  {selectedBead.files.length > 5 && (
                    <span className="text-[10px] text-gray-600">
                      +{selectedBead.files.length - 5} more
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <TreeView beads={beads ?? []} bottleneckIds={bottleneckIds} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree / List View
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<string, string> = {
  open: "bg-bead-open",
  in_progress: "bg-bead-progress",
  closed: "bg-bead-closed",
  deferred: "bg-bead-deferred",
  blocked: "bg-bead-blocked",
};

function TreeView({
  beads,
  bottleneckIds,
}: {
  beads: Bead[];
  bottleneckIds: Set<string>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const parents = beads.filter((b) => !b.parent);
  const childrenMap: Record<string, Bead[]> = {};
  for (const b of beads) {
    if (b.parent) {
      if (!childrenMap[b.parent]) childrenMap[b.parent] = [];
      childrenMap[b.parent].push(b);
    }
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (bead: Bead, depth: number) => {
    const children = childrenMap[bead.id] ?? [];
    const hasChildren = children.length > 0;
    const isExpanded = expanded.has(bead.id);

    return (
      <div key={bead.id}>
        <div
          className="flex items-center gap-2 py-1.5 px-2 hover:bg-surface-2 rounded cursor-pointer"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
          onClick={() => hasChildren && toggle(bead.id)}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown size={12} className="text-gray-500 shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-gray-500 shrink-0" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[bead.status] ?? "bg-gray-500"}`}
          />
          <span className="text-xs font-mono text-gray-500">{bead.id}</span>
          <span className="text-sm text-gray-200 truncate">{bead.title}</span>
          <span className="text-xs text-gray-500 ml-auto shrink-0">
            {bead.status.replace("_", " ")}
          </span>
        </div>
        {isExpanded &&
          children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="bg-surface-1 rounded-lg border border-surface-3 divide-y divide-surface-3">
      {parents.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">
          No beads to display
        </p>
      ) : (
        parents.map((p) => renderNode(p, 0))
      )}
    </div>
  );
}
