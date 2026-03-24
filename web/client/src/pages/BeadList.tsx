import React, { useState, useMemo } from "react";
import { Loader2, AlertCircle, Search, Inbox } from "lucide-react";
import { useBeads } from "../hooks/useBeads";
import BeadCard from "../components/BeadCard";
import type { Bead } from "../api";

const FILTERS = ["All", "Open", "In Progress", "Closed", "Deferred"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_STATUS: Record<Filter, string | null> = {
  All: null,
  Open: "open",
  "In Progress": "in_progress",
  Closed: "closed",
  Deferred: "deferred",
};

export default function BeadList() {
  const { data: beads, isLoading, error } = useBeads();
  const [filter, setFilter] = useState<Filter>("All");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let list = beads ?? [];
    const status = FILTER_STATUS[filter];
    if (status) list = list.filter((b) => b.status === status);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.id.toLowerCase().includes(q) ||
          b.type.toLowerCase().includes(q),
      );
    }
    return list;
  }, [beads, filter, search]);

  // Group by parent
  const grouped = useMemo(() => {
    const parents: Bead[] = [];
    const childrenMap: Record<string, Bead[]> = {};

    for (const b of filtered) {
      if (b.parent) {
        if (!childrenMap[b.parent]) childrenMap[b.parent] = [];
        childrenMap[b.parent].push(b);
      } else {
        parents.push(b);
      }
    }
    return { parents, childrenMap };
  }, [filtered]);

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
    <div className="space-y-4 max-w-5xl">
      <h1 className="text-lg font-semibold text-gray-100">Beads</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex bg-surface-1 rounded-lg border border-surface-3 overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f
                  ? "bg-accent/15 text-accent"
                  : "text-gray-400 hover:text-gray-200 hover:bg-surface-2"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
          />
          <input
            type="text"
            placeholder="Search beads…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-surface-1 border border-surface-3 rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-accent/50"
          />
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-gray-500">
          <Inbox size={32} className="mb-3" />
          <p className="text-sm">No beads found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {grouped.parents.map((bead) => (
            <div key={bead.id} className="space-y-2">
              <BeadCard bead={bead} />
              {grouped.childrenMap[bead.id]?.map((child) => (
                <div key={child.id} className="ml-4">
                  <BeadCard bead={child} />
                </div>
              ))}
            </div>
          ))}
          {/* Orphan children (parent not in current filter) */}
          {Object.entries(grouped.childrenMap)
            .filter(([parentId]) => !grouped.parents.some((p) => p.id === parentId))
            .flatMap(([, children]) => children)
            .map((child) => (
              <BeadCard key={child.id} bead={child} />
            ))}
        </div>
      )}
    </div>
  );
}
