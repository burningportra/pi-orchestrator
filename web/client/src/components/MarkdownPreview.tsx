import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

export default function MarkdownPreview({
  content,
  className = "",
}: MarkdownPreviewProps) {
  return (
    <div
      className={`prose prose-invert prose-sm max-w-none
        prose-headings:text-gray-200 prose-headings:border-b prose-headings:border-surface-3 prose-headings:pb-2
        prose-p:text-gray-300
        prose-a:text-accent hover:prose-a:text-accent-hover
        prose-strong:text-gray-200
        prose-code:text-accent prose-code:bg-surface-2 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
        prose-pre:bg-surface-0 prose-pre:border prose-pre:border-surface-3 prose-pre:rounded-lg
        prose-table:border-collapse
        prose-th:bg-surface-2 prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-gray-300 prose-th:text-xs
        prose-td:px-3 prose-td:py-2 prose-td:border-t prose-td:border-surface-3 prose-td:text-gray-400 prose-td:text-sm
        prose-li:text-gray-300
        prose-hr:border-surface-3
        ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
