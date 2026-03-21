import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext } from "../types.js";

export function registerMemoryTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_memory",
    label: "Memory",
    description:
      "Search and read CASS memory (learnings from prior orchestration runs). Use to recall past decisions, gotchas, and patterns.",
    promptSnippet: "Search CASS memory for learnings from prior orchestrations",
    parameters: Type.Object({
      action: StringEnum(["stats", "search", "list", "context", "mark"] as const, {
        description:
          "'stats' for summary, 'search' to find entries, 'list' to show all, " +
          "'context' to get task-relevant rules/anti-patterns, " +
          "'mark' to give feedback on a rule (helpful/harmful)",
      }),
      query: Type.Optional(
        Type.String({
          description:
            "Search query (required for 'search'), task description (required for 'context'), " +
            "or bullet ID (required for 'mark', e.g. 'b-8f3a2c')",
        })
      ),
      helpful: Type.Optional(
        Type.Boolean({
          description: "For 'mark' action: true = helpful, false = harmful. Default: true",
        })
      ),
      reason: Type.Optional(
        Type.String({
          description: "For 'mark' action: reason for the feedback (e.g. 'caused_bug', 'saved time')",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { listMemoryEntries, searchMemory, getMemoryStats, getContext, markRule } =
        await import("../memory.js");

      // ── stats ──
      if (params.action === "stats") {
        const stats = getMemoryStats(ctx.cwd);
        const statusLine = stats.overallStatus ? ` (${stats.overallStatus})` : "";
        const versionLine = stats.version ? ` · cm v${stats.version}` : "";
        const text =
          stats.entryCount === 0 && !stats.cassAvailable
            ? "No CASS memory available. Install cm CLI for enhanced memory."
            : `📊 CASS Memory: ${stats.entryCount} rules${statusLine}${versionLine}`;
        return {
          content: [{ type: "text", text }],
          details: { stats },
        };
      }

      // ── context ──
      if (params.action === "context") {
        if (!params.query) {
          return {
            content: [{ type: "text", text: "Error: 'query' parameter required — provide a task description." }],
            details: { error: true },
          };
        }
        const cassCtx = getContext(params.query, ctx.cwd);
        if (!cassCtx) {
          return {
            content: [{ type: "text", text: "CASS not available. Install cm CLI for contextual memory." }],
            details: { available: false },
          };
        }

        const parts: string[] = [];
        if (cassCtx.relevantBullets.length > 0) {
          parts.push("### Relevant Rules");
          for (const b of cassCtx.relevantBullets) {
            const score = b.score != null ? ` (${(b.score * 100).toFixed(0)}%)` : "";
            parts.push(`- **[${b.id}]**${score} ${b.text}`);
          }
        }
        if (cassCtx.antiPatterns.length > 0) {
          parts.push("\n### Anti-Patterns (avoid these)");
          for (const ap of cassCtx.antiPatterns) {
            parts.push(`- **[${ap.id}]** ${ap.text}`);
          }
        }
        if (cassCtx.historySnippets.length > 0) {
          parts.push("\n### History Snippets");
          for (const h of cassCtx.historySnippets) {
            parts.push(`- ${h.text}`);
          }
        }
        if (cassCtx.suggestedCassQueries.length > 0) {
          parts.push("\n### Suggested follow-up queries");
          for (const q of cassCtx.suggestedCassQueries) {
            parts.push(`- \`${q}\``);
          }
        }

        const text =
          parts.length === 0
            ? "No relevant context found for this task."
            : parts.join("\n");

        return {
          content: [{ type: "text", text }],
          details: { context: cassCtx },
        };
      }

      // ── mark ──
      if (params.action === "mark") {
        if (!params.query) {
          return {
            content: [{ type: "text", text: "Error: 'query' parameter required — provide a bullet ID (e.g. 'b-8f3a2c')." }],
            details: { error: true },
          };
        }
        const helpful = params.helpful !== false; // default true
        const ok = markRule(params.query, helpful, params.reason ?? undefined, ctx.cwd);
        if (!ok) {
          return {
            content: [{ type: "text", text: `Failed to mark rule ${params.query}. Is cm CLI available?` }],
            details: { error: true },
          };
        }
        const verb = helpful ? "helpful" : "harmful";
        const reasonText = params.reason ? ` (reason: ${params.reason})` : "";
        return {
          content: [{ type: "text", text: `✅ Marked ${params.query} as ${verb}${reasonText}.` }],
          details: { bulletId: params.query, helpful, reason: params.reason },
        };
      }

      // ── search ──
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
          .map((e) => `### [${e.index}] ${e.id} (${e.category})\n${e.content}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `Found ${results.length} matching entries:\n\n${text}` }],
          details: { results },
        };
      }

      // ── list ──
      const entries = listMemoryEntries(ctx.cwd);
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No memory entries yet." }],
          details: { entries: [] },
        };
      }
      const text = entries
        .map((e) => `### [${e.index}] ${e.id} (${e.category})\n${e.content}`)
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
        first.startsWith("No ") || first.startsWith("Error") || first.startsWith("Failed")
          ? theme.fg("warning", first)
          : theme.fg("success", first),
        0,
        0
      );
    },
  });
}
