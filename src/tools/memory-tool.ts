import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext } from "../types.js";

export function registerMemoryTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_memory",
    label: "Memory",
    description:
      "Search and read compound memory (learnings from prior orchestration runs). Use to recall past decisions, gotchas, and patterns.",
    promptSnippet: "Search compound memory for learnings from prior orchestrations",
    parameters: Type.Object({
      action: StringEnum(["stats", "search", "list"] as const, {
        description: "What to do: 'stats' for summary, 'search' to find entries, 'list' to show all",
      }),
      query: Type.Optional(
        Type.String({ description: "Search query (required for action 'search')" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { listMemoryEntries, searchMemory, getMemoryStats } = await import("../memory.js");

      if (params.action === "stats") {
        const stats = getMemoryStats(ctx.cwd);
        const sizeKB = (stats.totalBytes / 1024).toFixed(1);
        const text = stats.entryCount === 0
          ? "No memory entries yet."
          : `📊 Memory: ${stats.entryCount} entries, ${sizeKB} KB\n📅 ${stats.oldest} → ${stats.newest}`;
        return {
          content: [{ type: "text", text }],
          details: { stats },
        };
      }

      if (params.action === "search") {
        if (!params.query) {
          return {
            content: [{ type: "text", text: "Error: 'query' parameter required for search action." }],
            details: { error: true },
          };
        }
        const results = searchMemory(ctx.cwd, params.query);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No memory entries match "${params.query}".` }],
            details: { results: [] },
          };
        }
        const text = results
          .map((e) => `### [${e.index}] ${e.timestamp}\n${e.content}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `Found ${results.length} matching entries:\n\n${text}` }],
          details: { results },
        };
      }

      // action === "list"
      const entries = listMemoryEntries(ctx.cwd);
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No memory entries yet." }],
          details: { entries: [] },
        };
      }
      const text = entries
        .map((e) => `### [${e.index}] ${e.timestamp}\n${e.content}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: `${entries.length} memory entries:\n\n${text}` }],
        details: { entries },
      };
    },

    renderCall(args, theme) {
      const action = (args as any).action ?? "stats";
      const query = (args as any).query;
      let text = theme.fg("toolTitle", theme.bold("orch_memory "));
      text += theme.fg("muted", action);
      if (query) text += theme.fg("dim", ` "${query}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      const first = text?.type === "text" ? text.text.split("\n")[0] : "";
      return new Text(
        first.startsWith("No ") || first.startsWith("Error")
          ? theme.fg("warning", first)
          : theme.fg("success", first),
        0, 0
      );
    },
  });
}
