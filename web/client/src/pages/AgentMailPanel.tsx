import React, { useState } from "react";
import { Loader2, AlertCircle, Mail, Check, Inbox } from "lucide-react";
import { useAgentMailThreads } from "../hooks/useAgentMail";
import { triggerCommand, type AgentMailMessage } from "../api";

const IMPORTANCE_COLORS: Record<string, string> = {
  low: "bg-gray-700 text-gray-300",
  normal: "bg-surface-3 text-gray-300",
  high: "bg-yellow-900/40 text-yellow-400",
  critical: "bg-red-900/40 text-red-400",
};

export default function AgentMailPanel() {
  const { threads, messages, isLoading, error } = useAgentMailThreads();
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  const threadIds = Object.keys(threads).sort((a, b) => {
    if (a === "general") return -1;
    if (b === "general") return 1;
    return a.localeCompare(b);
  });

  const activeThread = selectedThread ?? threadIds[0] ?? null;
  const threadMessages = activeThread ? (threads[activeThread] ?? []) : [];

  const handleAcknowledge = async (msgId: string) => {
    setAcknowledging(msgId);
    try {
      await triggerCommand("ack-message", { messageId: msgId });
    } catch (err) {
      console.error("Acknowledge failed:", err);
    } finally {
      setAcknowledging(null);
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
        <span>Agent-mail not connected</span>
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <Inbox size={32} className="mb-3" />
        <p className="text-sm">No messages</p>
        <p className="text-xs text-gray-600 mt-1">
          Agent-mail messages will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 120px)" }}>
      {/* Thread list sidebar */}
      <div className="w-56 bg-surface-1 border border-surface-3 rounded-lg overflow-y-auto shrink-0">
        <div className="px-3 py-2 border-b border-surface-3">
          <h2 className="text-xs font-medium text-gray-400">Threads</h2>
        </div>
        <div className="py-1">
          {threadIds.map((tid) => {
            const count = threads[tid].length;
            const isActive = tid === activeThread;
            return (
              <button
                key={tid}
                onClick={() => setSelectedThread(tid)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-accent/15 text-accent"
                    : "text-gray-300 hover:bg-surface-2"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-mono text-xs">{tid}</span>
                  <span className="text-[10px] text-gray-500 ml-2 shrink-0">
                    {count}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Message timeline */}
      <div className="flex-1 bg-surface-1 border border-surface-3 rounded-lg overflow-y-auto">
        <div className="px-4 py-2 border-b border-surface-3">
          <h2 className="text-sm font-medium text-gray-300">
            {activeThread ?? "Select a thread"}
          </h2>
        </div>
        <div className="p-4 space-y-3">
          {threadMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onAcknowledge={handleAcknowledge}
              acknowledging={acknowledging === msg.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onAcknowledge,
  acknowledging,
}: {
  message: AgentMailMessage;
  onAcknowledge: (id: string) => void;
  acknowledging: boolean;
}) {
  return (
    <div className="bg-surface-2 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-200">
            {message.sender}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              IMPORTANCE_COLORS[message.importance] ?? "bg-surface-3 text-gray-400"
            }`}
          >
            {message.importance}
          </span>
        </div>
        <span className="text-[10px] text-gray-600">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {message.subject && (
        <h4 className="text-sm font-medium text-gray-200">
          {message.subject}
        </h4>
      )}

      <p className="text-xs text-gray-400 whitespace-pre-wrap">
        {message.body}
      </p>

      {!message.acknowledged && (
        <button
          onClick={() => onAcknowledge(message.id)}
          disabled={acknowledging}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {acknowledging ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Check size={10} />
          )}
          Acknowledge
        </button>
      )}
    </div>
  );
}
