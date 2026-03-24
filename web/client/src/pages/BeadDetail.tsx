import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  FileText,
  GitBranch,
  Send,
} from "lucide-react";
import { useBead, useBeadDeps, useUpdateBeadStatus } from "../hooks/useBeads";
import { submitReview, type ReviewData } from "../api";
import MarkdownPreview from "../components/MarkdownPreview";

const STATUS_OPTIONS = ["open", "in_progress", "closed", "deferred", "blocked"];

const STATUS_COLORS: Record<string, string> = {
  open: "bg-bead-open",
  in_progress: "bg-bead-progress",
  closed: "bg-bead-closed",
  deferred: "bg-bead-deferred",
  blocked: "bg-bead-blocked",
};

export default function BeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: bead, isLoading, error } = useBead(id ?? "");
  const { data: deps } = useBeadDeps(id ?? "");
  const updateStatus = useUpdateBeadStatus();

  const [verdict, setVerdict] = useState<ReviewData["verdict"]>("approve");
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-accent" size={24} />
      </div>
    );
  }

  if (error || !bead) {
    return (
      <div className="flex items-center gap-2 text-red-400 bg-red-900/20 p-4 rounded-lg">
        <AlertCircle size={18} />
        <span>Bead not found</span>
      </div>
    );
  }

  const handleStatusChange = (newStatus: string) => {
    updateStatus.mutate({ id: bead.id, status: newStatus });
  };

  const handleSubmitReview = async () => {
    setSubmitting(true);
    try {
      await submitReview({ beadId: bead.id, verdict, feedback });
      setFeedback("");
    } catch (err) {
      console.error("Review submit failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Back button */}
      <button
        onClick={() => navigate("/beads")}
        className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
      >
        <ArrowLeft size={14} />
        Back to beads
      </button>

      {/* Header */}
      <div className="bg-surface-1 rounded-lg p-5 border border-surface-3">
        <div className="flex items-start justify-between mb-3">
          <div>
            <span className="text-xs font-mono text-gray-500 bg-surface-2 px-2 py-0.5 rounded">
              {bead.id}
            </span>
            <h1 className="text-xl font-semibold text-gray-100 mt-2">
              {bead.title}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[bead.status] ?? "bg-gray-500"}`}
            />
            <select
              value={bead.status}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="bg-surface-2 border border-surface-3 text-sm text-gray-200 rounded px-2 py-1 focus:outline-none focus:border-accent/50"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="bg-surface-2 text-gray-400 px-2 py-0.5 rounded">
            Priority: {bead.priority}
          </span>
          <span className="bg-surface-2 text-gray-400 px-2 py-0.5 rounded">
            Type: {bead.type}
          </span>
          {bead.labels.map((l) => (
            <span
              key={l}
              className="bg-accent/10 text-accent px-2 py-0.5 rounded"
            >
              {l}
            </span>
          ))}
        </div>
      </div>

      {/* Description */}
      {bead.description && (
        <div className="bg-surface-1 rounded-lg p-5 border border-surface-3">
          <h2 className="text-sm font-medium text-gray-300 mb-3">
            Description
          </h2>
          <MarkdownPreview content={bead.description} />
        </div>
      )}

      {/* Files */}
      {bead.files.length > 0 && (
        <div className="bg-surface-1 rounded-lg p-5 border border-surface-3">
          <h2 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
            <FileText size={14} />
            Files ({bead.files.length})
          </h2>
          <div className="space-y-1">
            {bead.files.map((f) => (
              <div
                key={f}
                className="text-xs font-mono text-gray-400 bg-surface-0 px-2 py-1 rounded"
              >
                {f}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dependencies */}
      {((bead.dependencies?.length ?? 0) > 0 || (deps?.length ?? 0) > 0) && (
        <div className="bg-surface-1 rounded-lg p-5 border border-surface-3">
          <h2 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
            <GitBranch size={14} />
            Dependencies
          </h2>
          {bead.dependencies.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-gray-500 mb-1">Upstream</p>
              <div className="flex flex-wrap gap-1">
                {bead.dependencies.map((d) => (
                  <button
                    key={d}
                    onClick={() => navigate(`/beads/${d}`)}
                    className="text-xs font-mono bg-surface-2 text-accent hover:bg-surface-3 px-2 py-0.5 rounded transition-colors"
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
          {deps && deps.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Downstream</p>
              <div className="flex flex-wrap gap-1">
                {deps.map((d) => (
                  <button
                    key={d}
                    onClick={() => navigate(`/beads/${d}`)}
                    className="text-xs font-mono bg-surface-2 text-accent hover:bg-surface-3 px-2 py-0.5 rounded transition-colors"
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Review Form */}
      <div className="bg-surface-1 rounded-lg p-5 border border-surface-3">
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Submit Review
        </h2>
        <div className="space-y-3">
          <select
            value={verdict}
            onChange={(e) =>
              setVerdict(e.target.value as ReviewData["verdict"])
            }
            className="w-full bg-surface-2 border border-surface-3 text-sm text-gray-200 rounded px-3 py-2 focus:outline-none focus:border-accent/50"
          >
            <option value="approve">Approve</option>
            <option value="request_changes">Request Changes</option>
            <option value="comment">Comment</option>
          </select>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Review feedback…"
            rows={4}
            className="w-full bg-surface-2 border border-surface-3 text-sm text-gray-200 rounded px-3 py-2 focus:outline-none focus:border-accent/50 resize-y placeholder-gray-600"
          />
          <button
            onClick={handleSubmitReview}
            disabled={submitting}
            className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium px-4 py-2 rounded-md transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            Submit Review
          </button>
        </div>
      </div>
    </div>
  );
}
