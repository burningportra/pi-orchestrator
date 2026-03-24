import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, Save, Eye, EyeOff, Check, AlertCircle } from "lucide-react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
import { usePlan, useSavePlan } from "../hooks/usePlan";
import MarkdownPreview from "../components/MarkdownPreview";

export default function PlanEditor() {
  const { data: planData, isLoading, error } = usePlan();
  const savePlan = useSavePlan();

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [content, setContent] = useState("");
  const [showPreview, setShowPreview] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Debounced preview content
  const [previewContent, setPreviewContent] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleSave = useCallback(() => {
    if (viewRef.current) {
      const text = viewRef.current.state.doc.toString();
      savePlan.mutate(text, {
        onSuccess: () => setDirty(false),
      });
    }
  }, [savePlan]);

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current || initialized) return;

    const initialContent = planData?.content ?? "";
    setContent(initialContent);
    setPreviewContent(initialContent);

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        basicSetup,
        markdown(),
        oneDark,
        EditorView.lineWrapping,
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              handleSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            setContent(text);
            setDirty(true);

            clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
              setPreviewContent(text);
            }, 300);
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { fontFamily: "monospace" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;
    setInitialized(true);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [planData, initialized, handleSave]);

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
        <span>Failed to load plan</span>
      </div>
    );
  }

  if (!planData) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <FileEmpty />
        <p className="mt-3 text-sm">No plan document yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Plan Editor</h1>
        <div className="flex items-center gap-2">
          {/* Status indicator */}
          <span className="text-xs text-gray-500 flex items-center gap-1">
            {savePlan.isPending ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Saving…
              </>
            ) : dirty ? (
              <span className="text-yellow-400">● Unsaved</span>
            ) : (
              <>
                <Check size={12} className="text-green-400" /> Saved
              </>
            )}
          </span>

          <button
            onClick={() => setShowPreview(!showPreview)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 text-gray-300 text-xs rounded-md transition-colors"
          >
            {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
            {showPreview ? "Hide Preview" : "Show Preview"}
          </button>

          <button
            onClick={handleSave}
            disabled={!dirty || savePlan.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-md transition-colors disabled:opacity-40"
          >
            <Save size={14} />
            Save
          </button>
        </div>
      </div>

      {/* Editor + Preview */}
      <div className="flex gap-4 flex-1 min-h-0" style={{ height: "calc(100vh - 180px)" }}>
        {/* Editor */}
        <div
          ref={editorRef}
          className={`bg-surface-1 border border-surface-3 rounded-lg overflow-hidden ${
            showPreview ? "w-1/2" : "w-full"
          }`}
        />

        {/* Preview */}
        {showPreview && (
          <div className="w-1/2 bg-surface-1 border border-surface-3 rounded-lg overflow-y-auto p-5">
            <MarkdownPreview content={previewContent} />
          </div>
        )}
      </div>
    </div>
  );
}

function FileEmpty() {
  return (
    <svg
      className="w-12 h-12 text-gray-600"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}
