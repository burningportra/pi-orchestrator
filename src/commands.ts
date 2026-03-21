import type { OrchestratorContext } from './types.js';
import { createInitialState } from './types.js';

/**
 * Register all slash-commands (/orchestrate, /orchestrate-stop,
 * /orchestrate-status, /memory) on the pi extension API.
 */
export function registerCommands(oc: OrchestratorContext) {
  const { pi } = oc;

  // ─── Command: /orchestrate ───────────────────────────────────
  pi.registerCommand("orchestrate", {
    description:
      "Start the repo-aware multi-agent orchestrator",
    handler: async (args, ctx) => {
      if (oc.orchestratorActive) {
        const override = await ctx.ui.confirm(
          "Orchestrator Active",
          "An orchestration is in progress. Reset and start fresh?"
        );
        if (!override) return;
      }

      oc.state = createInitialState();
      oc.orchestratorActive = true;
      oc.persistState();

      const goalArg = args?.trim();
      if (goalArg) {
        pi.sendUserMessage(
          `Start the orchestrator workflow for this repo. I want to: ${goalArg}\n\nBegin by calling \`orch_profile\` to scan the repo, then skip discovery and go straight to creating beads with my stated goal.`,
          { deliverAs: "followUp" }
        );
      } else {
        pi.sendUserMessage(
          "Start the orchestrator workflow for this repo. Begin by calling `orch_profile` to scan the repository.",
          { deliverAs: "followUp" }
        );
      }
    },
  });

  // ─── Command: /orchestrate-stop ──────────────────────────────
  pi.registerCommand("orchestrate-stop", {
    description: "Stop the current orchestration",
    handler: async (_args, ctx) => {
      if (oc.orchestratorActive) {
        if (oc.worktreePool) {
          await oc.worktreePool.cleanup();
          oc.worktreePool = undefined;
        }
        if (oc.swarmTender) { oc.swarmTender.stop(); oc.swarmTender = undefined; }
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        ctx.ui.notify("🛑 Orchestration stopped.", "warning");
      } else {
        ctx.ui.notify("No orchestration in progress.", "info");
      }
    },
  });

  // ─── Command: /orchestrate-status ────────────────────────────
  pi.registerCommand("orchestrate-status", {
    description: "Show orchestration status",
    handler: async (_args, ctx) => {
      if (!oc.orchestratorActive && oc.state.phase === "idle") {
        ctx.ui.notify("No orchestration session active.", "info");
        return;
      }
      oc.updateWidget(ctx);
    },
  });

  // ─── Command: /memory ──────────────────────────────────────────
  pi.registerCommand("memory", {
    description: "Manage CASS memory: stats, view, search, add, mark harmful",
    handler: async (args, ctx) => {
      const { listMemoryEntries, searchMemory, getMemoryStats, appendMemory, markRule } = await import("./memory.js");
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "stats";

      // ── /memory stats (default) ──
      if (subcommand === "stats" || subcommand === "") {
        const stats = getMemoryStats(ctx.cwd);
        if (stats.entryCount === 0) {
          ctx.ui.notify("📭 No memory entries yet. Use `/memory add <text>` to create one.", "info");
          return;
        }
        const statusLine = stats.overallStatus ? ` (${stats.overallStatus})` : "";
        const versionLine = stats.version ? ` · cm v${stats.version}` : "";
        ctx.ui.notify(
          `🧠 CASS Memory: ${stats.entryCount} rules${statusLine}${versionLine}`,
          "info"
        );
        return;
      }

      // ── /memory view ──
      if (subcommand === "view") {
        const entries = listMemoryEntries(ctx.cwd);
        if (entries.length === 0) {
          ctx.ui.notify("📭 No memory entries to view.", "info");
          return;
        }
        const choices = entries.map((e) =>
          `${e.index}: [${e.id}] (${e.category}) ${e.content.slice(0, 60).replace(/\n/g, " ")}${e.content.length > 60 ? "…" : ""}`
        );
        const selected = await ctx.ui.select("Select a memory entry to view:", choices);
        if (selected == null) return;
        const idx = parseInt(selected, 10);
        const entry = entries.find((e) => e.index === idx);
        if (entry) {
          ctx.ui.notify(`## ${entry.id} (${entry.category})\n\n${entry.content}`, "info");
        }
        return;
      }

      // ── /memory search <query> ──
      if (subcommand === "search") {
        const query = parts.slice(1).join(" ").trim();
        if (!query) {
          ctx.ui.notify("Usage: `/memory search <query>`", "warning");
          return;
        }
        const results = searchMemory(ctx.cwd, query);
        if (results.length === 0) {
          ctx.ui.notify(`No memory entries matching "${query}".`, "info");
          return;
        }
        const summary = results
          .map((e) => `**[${e.id}]** (${e.category}) ${e.content.slice(0, 80).replace(/\n/g, " ")}${e.content.length > 80 ? "…" : ""}`)
          .join("\n");
        ctx.ui.notify(`🔍 ${results.length} match(es) for "${query}":\n\n${summary}`, "info");
        return;
      }

      // ── /memory add <text> ──
      if (subcommand === "add") {
        const text = parts.slice(1).join(" ").trim();
        if (!text) {
          ctx.ui.notify("Usage: `/memory add <text>`", "warning");
          return;
        }
        const ok = appendMemory(ctx.cwd, text);
        if (ok) {
          ctx.ui.notify("✅ Memory entry added.", "info");
        } else {
          ctx.ui.notify("❌ Failed to write memory entry.", "error");
        }
        return;
      }

      // ── /memory prune ──
      if (subcommand === "prune") {
        const entries = listMemoryEntries(ctx.cwd);
        if (entries.length === 0) {
          ctx.ui.notify("📭 No memory entries to prune.", "info");
          return;
        }
        const choices = entries.map((e) =>
          `${e.index}: [${e.id}] (${e.category}) ${e.content.slice(0, 60).replace(/\n/g, " ")}${e.content.length > 60 ? "…" : ""}`
        );
        const selected = await ctx.ui.select("Select entry to mark as harmful:", choices);
        if (selected == null) {
          ctx.ui.notify("Prune cancelled.", "info");
          return;
        }
        const idx = parseInt(selected, 10);
        const entry = entries.find((e) => e.index === idx);
        if (!entry) { ctx.ui.notify("Entry not found.", "warning"); return; }
        const confirmed = await ctx.ui.confirm(
          "Confirm Mark Harmful",
          `Mark rule ${entry.id} as harmful? This downgrades the rule.`
        );
        if (!confirmed) {
          ctx.ui.notify("Prune cancelled.", "info");
          return;
        }
        const ok = markRule(entry.id, false, "pruned via /memory command", ctx.cwd);
        ctx.ui.notify(ok ? `🗑️ Marked ${entry.id} as harmful.` : "❌ Failed to mark rule.", ok ? "info" : "error");
        return;
      }

      // ── Unknown subcommand → help ──
      ctx.ui.notify(
        "**Memory commands:**\n" +
        "• `/memory` or `/memory stats` — show stats\n" +
        "• `/memory view` — browse entries\n" +
        "• `/memory search <query>` — search entries\n" +
        "• `/memory add <text>` — add an entry\n" +
        "• `/memory prune` — delete entries",
        "info"
      );
    },
  });
}
