import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronUp, Terminal } from "lucide-react";

interface TerminalOutputProps {
  lines: string[];
  maxVisible?: number;
  title?: string;
}

export default function TerminalOutput({
  lines,
  maxVisible = 20,
  title = "Output",
}: TerminalOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLPreElement>(null);

  const visibleLines = expanded ? lines : lines.slice(-maxVisible);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleLines]);

  return (
    <div className="bg-surface-0 border border-surface-3 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-1 border-b border-surface-3">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Terminal size={12} />
          <span>{title}</span>
          <span className="text-gray-600">({lines.length} lines)</span>
        </div>
        {lines.length > maxVisible && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp size={12} /> Collapse
              </>
            ) : (
              <>
                <ChevronDown size={12} /> Show all
              </>
            )}
          </button>
        )}
      </div>

      {/* Content */}
      <pre
        ref={scrollRef}
        className={`p-3 text-xs font-mono text-gray-400 overflow-auto ${
          expanded ? "max-h-96" : "max-h-48"
        }`}
      >
        {visibleLines.length === 0 ? (
          <span className="text-gray-600">No output</span>
        ) : (
          visibleLines.join("\n")
        )}
      </pre>
    </div>
  );
}
