import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useWebSocket, type WSMessage } from "../hooks/useWebSocket";

interface LogEntry {
  id: number;
  type: "info" | "warning" | "error" | "success";
  message: string;
  timestamp: string;
  detail?: string;
}

const TYPE_COLORS: Record<string, string> = {
  info: "text-gray-400",
  warning: "text-yellow-400",
  error: "text-red-400",
  success: "text-green-400",
};

let entryId = 0;

export default function LiveLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const { subscribe, status } = useWebSocket();

  useEffect(() => {
    const unsub = subscribe("*", (msg: WSMessage) => {
      const entry: LogEntry = {
        id: ++entryId,
        type: (msg.type as LogEntry["type"]) || "info",
        message:
          typeof msg.payload === "string"
            ? msg.payload
            : JSON.stringify(msg.payload),
        timestamp: msg.timestamp || new Date().toISOString(),
        detail:
          typeof msg.payload === "object" && msg.payload
            ? JSON.stringify(msg.payload, null, 2)
            : undefined,
      };
      setEntries((prev) => [...prev.slice(-200), entry]);
    });
    return unsub;
  }, [subscribe]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col bg-surface-1 rounded-lg border border-surface-3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-3">
        <span className="text-xs font-medium text-gray-400">Live Log</span>
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${
            status === "connected"
              ? "bg-green-900/40 text-green-400"
              : status === "connecting"
                ? "bg-yellow-900/40 text-yellow-400"
                : "bg-red-900/40 text-red-400"
          }`}
        >
          {status}
        </span>
      </div>

      {/* Entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-2 space-y-0.5 font-mono text-xs max-h-64"
      >
        {entries.length === 0 && (
          <p className="text-gray-600 text-center py-4">
            No log entries yet…
          </p>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="group">
            <div
              className="flex items-start gap-1.5 hover:bg-surface-2 rounded px-1 py-0.5 cursor-pointer"
              onClick={() => entry.detail && toggleExpand(entry.id)}
            >
              {entry.detail ? (
                expandedIds.has(entry.id) ? (
                  <ChevronDown size={12} className="mt-0.5 text-gray-600 shrink-0" />
                ) : (
                  <ChevronRight size={12} className="mt-0.5 text-gray-600 shrink-0" />
                )
              ) : (
                <span className="w-3" />
              )}
              <span className="text-gray-600 shrink-0">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span className={TYPE_COLORS[entry.type] ?? "text-gray-400"}>
                {entry.message}
              </span>
            </div>
            {entry.detail && expandedIds.has(entry.id) && (
              <pre className="ml-6 mt-1 p-2 bg-surface-0 rounded text-gray-500 overflow-x-auto text-[10px]">
                {entry.detail}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
