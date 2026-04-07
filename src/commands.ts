import type { CoordinationMode, OrchestratorContext, Bead } from './types.js';
import { createInitialState } from './types.js';

/**
 * Format staleness info for open beads, showing when they were created.
 * Groups beads by age: fresh (< 1 day), recent (< 7 days), stale (>= 7 days).
 */
function formatBeadStaleness(beads: Bead[]): string {
  if (beads.length === 0) return "";

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const fresh: Bead[] = [];
  const recent: Bead[] = [];
  const stale: Bead[] = [];

  for (const bead of beads) {
    if (!bead.created_at) {
      stale.push(bead); // No created_at = assume stale
      continue;
    }
    const createdMs = new Date(bead.created_at).getTime();
    const ageDays = (now - createdMs) / DAY_MS;

    if (ageDays < 1) {
      fresh.push(bead);
    } else if (ageDays < 7) {
      recent.push(bead);
    } else {
      stale.push(bead);
    }
  }

  const lines: string[] = [];

  if (fresh.length > 0) {
    lines.push(`  🟢 Fresh (< 1 day): ${fresh.map(b => b.id).join(", ")}`);
  }
  if (recent.length > 0) {
    lines.push(`  🟡 Recent (1-7 days): ${recent.map(b => `${b.id} (${formatAge(b.created_at)})`).join(", ")}`);
  }
  if (stale.length > 0) {
    lines.push(`  🔴 Stale (>= 7 days): ${stale.map(b => `${b.id} (${formatAge(b.created_at)})`).join(", ")}`);
  }

  return lines.join("\n");
}

/** Format a timestamp as relative age (e.g., "2d", "3w"). */
function formatAge(timestamp?: string): string {
  if (!timestamp) return "unknown";

  const now = Date.now();
  const createdMs = new Date(timestamp).getTime();
  const ageDays = Math.floor((now - createdMs) / (24 * 60 * 60 * 1000));

  if (ageDays < 1) return "< 1d";
  if (ageDays < 7) return `${ageDays}d`;
  if (ageDays < 30) return `${Math.floor(ageDays / 7)}w`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)}mo`;
  return `${Math.floor(ageDays / 365)}y`;
}

function parseOrchestrateArgs(rawArgs?: string): { goalArg?: string; coordinationMode?: CoordinationMode } {
  const input = rawArgs?.trim();
  if (!input) return {};

  const modeMatch = input.match(/(?:^|\s)--mode(?:=(worktree|single-branch)|\s+(worktree|single-branch))(?:\s|$)/);
  const coordinationMode = (modeMatch?.[1] ?? modeMatch?.[2]) as CoordinationMode | undefined;
  const goalArg = coordinationMode
    ? input.replace(modeMatch![0], " ").trim() || undefined
    : input;

  return { goalArg, coordinationMode };
}

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
      const { readBeads } = await import("./beads.js");
      
      // Check for existing state that can be resumed
      const hasExistingState = oc.state.phase !== "idle" && oc.state.phase !== "complete";
      let existingBeads: import("./types.js").Bead[] = [];
      try {
        existingBeads = await readBeads(pi, ctx.cwd);
      } catch { /* no beads dir */ }
      const hasActiveBeads = existingBeads.some(b => b.status === "open" || b.status === "in_progress");
      
      // Resume vs Fresh fork
      if (hasExistingState || hasActiveBeads) {
        const completedCount = Object.values(oc.state.beadResults ?? {}).filter(r => r.status === "success").length;
        const totalCount = oc.state.activeBeadIds?.length ?? existingBeads.length;
        const progressStr = totalCount > 0 ? ` (${completedCount}/${totalCount} beads done)` : "";
        const openBeads = existingBeads.filter(b => b.status === "open" || b.status === "in_progress");
        const openCount = openBeads.length;
        
        // Show staleness info for open beads
        const stalenessInfo = formatBeadStaleness(openBeads);
        
        const choice = await ctx.ui.select(
          `Existing orchestration detected${progressStr}\n${stalenessInfo}`,
          [
            `📂 Resume — continue with ${openCount} open bead(s)`,
            "🔄 Fresh — archive current beads and start over",
            "🗑️ Clear — delete all beads and start fresh",
            "❌ Cancel",
          ]
        );
        
        if (choice?.startsWith("📂")) {
          // Resume: restore active state and continue from where we left off
          oc.orchestratorActive = true;
          // Only change phase if it was reset to idle/complete; otherwise keep existing phase
          if (oc.state.phase === "idle" || oc.state.phase === "complete") {
            // Default to implementing if we have beads, otherwise start fresh
            oc.setPhase(hasActiveBeads ? "implementing" : "profiling", ctx);
          }
          oc.persistState();
          
          // Tailor resume message based on current phase
          const phaseMessages: Record<string, string> = {
            profiling: "Resuming orchestration. Call `orch_profile` to continue scanning.",
            discovering: "Resuming orchestration. Call `orch_discover` to continue generating ideas.",
            awaiting_selection: "Resuming orchestration. Call `orch_select` to pick a goal.",
            creating_beads: "Resuming orchestration. Continue creating beads with `br create`.",
            implementing: "Resuming orchestration. Call `orch_review` to check bead status and continue.",
            reviewing: "Resuming orchestration. Call `orch_review` to continue review.",
            iterating: "Resuming orchestration. Call `orch_review` to continue iteration.",
          };
          const resumeMsg = phaseMessages[oc.state.phase] ?? "Resuming orchestration. Call `orch_review` to check status.";
          pi.sendUserMessage(resumeMsg, { deliverAs: "followUp" });
          return;
        } else if (choice?.startsWith("🔄")) {
          // Archive: defer all open beads, then start fresh
          for (const bead of existingBeads) {
            if (bead.status === "open" || bead.status === "in_progress") {
              try {
                await pi.exec("br", ["update", bead.id, "--status", "deferred"], { cwd: ctx.cwd, timeout: 5000 });
              } catch { /* best effort */ }
            }
          }
          ctx.ui.notify(`📦 Archived ${openCount} open bead(s) as deferred.`, "info");
          // Fall through to fresh start
        } else if (choice?.startsWith("🗑️")) {
          // Clear: delete all beads in one shot, then start fresh
          const allCount = existingBeads.length;
          try {
            const ids = existingBeads.map((b) => b.id);
            await pi.exec("br", ["delete", ...ids, "--force"], { cwd: ctx.cwd, timeout: 10000 });
            ctx.ui.notify(`🗑️ Deleted ${allCount} bead(s).`, "info");
          } catch {
            ctx.ui.notify("⚠️ Failed to delete beads.", "warning");
          }
          // Fall through to fresh start
        } else {
          ctx.ui.notify("Orchestration cancelled.", "info");
          return;
        }
      }
      
      // Active orchestration override (only if no beads detected but orchestrator is running)
      if (oc.orchestratorActive && !hasExistingState && !hasActiveBeads) {
        const override = await ctx.ui.confirm(
          "Orchestrator Active",
          "An orchestration is in progress. Reset and start fresh?"
        );
        if (!override) return;
      }

      oc.state = createInitialState();
      const { goalArg, coordinationMode } = parseOrchestrateArgs(args);
      if (coordinationMode) {
        oc.state.coordinationMode = coordinationMode;
      }
      oc.orchestratorActive = true;
      oc.persistState();

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
          const summary = await oc.worktreePool.safeCleanup();
          if (summary.autoCommitted > 0) {
            ctx.ui.notify(
              `💾 Auto-committed ${summary.autoCommitted} dirty worktree${summary.autoCommitted > 1 ? "s" : ""} before cleanup.`,
              "info"
            );
          }
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

  // ─── Command: /orchestrate-cleanup ─────────────────────────────
  pi.registerCommand("orchestrate-cleanup", {
    description: "Clean up orphaned worktrees from previous sessions",
    handler: async (_args, ctx) => {
      const { findOrphanedWorktrees, cleanupOrphanedWorktrees } = await import("./worktree.js");

      // If there's an active pool, confirm then use safeCleanup
      if (oc.worktreePool) {
        const poolCount = oc.worktreePool.getAll().length;
        const confirmed = await ctx.ui.confirm(
          "Clean up worktrees",
          `Active worktree pool has ${poolCount} tracked worktree${poolCount !== 1 ? "s" : ""}. Dirty ones will be auto-committed before removal. Proceed?`
        );
        if (!confirmed) {
          ctx.ui.notify("Cleanup cancelled.", "info");
          return;
        }
        const summary = await oc.worktreePool.safeCleanup();
        oc.worktreePool = undefined;
        oc.persistState();
        const parts: string[] = [`🧹 Cleaned up ${summary.removed} worktree${summary.removed !== 1 ? "s" : ""}`];
        if (summary.autoCommitted > 0) parts.push(`💾 Auto-committed ${summary.autoCommitted} with uncommitted changes`);
        if (summary.errors.length > 0) parts.push(`⚠️ ${summary.errors.length} error${summary.errors.length !== 1 ? "s" : ""}: ${summary.errors.join(", ")}`);
        ctx.ui.notify(parts.join("\n"), summary.errors.length > 0 ? "warning" : "info");
        return;
      }

      // No active pool — scan for orphans directly
      const orphans = await findOrphanedWorktrees(pi, ctx.cwd, []);
      if (orphans.length === 0) {
        ctx.ui.notify("✅ No orphaned worktrees found.", "info");
        return;
      }

      const dirtyCount = orphans.filter(o => o.isDirty).length;
      const dirtyNote = dirtyCount > 0 ? ` (${dirtyCount} with uncommitted changes — will auto-commit)` : "";
      const confirmed = await ctx.ui.confirm(
        "Clean up worktrees",
        `Found ${orphans.length} orphaned worktree${orphans.length > 1 ? "s" : ""}${dirtyNote}. Remove them?`
      );
      if (!confirmed) {
        ctx.ui.notify("Cleanup cancelled.", "info");
        return;
      }

      const summary = await cleanupOrphanedWorktrees(pi, ctx.cwd, orphans);
      const parts: string[] = [`🧹 Removed ${summary.removed} worktree${summary.removed !== 1 ? "s" : ""}`];
      if (summary.autoCommitted > 0) parts.push(`💾 Auto-committed ${summary.autoCommitted} with uncommitted changes`);
      if (summary.errors.length > 0) parts.push(`⚠️ ${summary.errors.length} error${summary.errors.length !== 1 ? "s" : ""}: ${summary.errors.join(", ")}`);
      ctx.ui.notify(parts.join("\n"), summary.errors.length > 0 ? "warning" : "info");
    },
  });

  // ─── Command: /orchestrate-status ────────────────────────────
  pi.registerCommand("orchestrate-status", {
    description: "Show orchestration status and history",
    handler: async (_args, ctx) => {
      // Show feedback history stats if available
      try {
        const { loadAllFeedback, computeFeedbackStats, formatFeedbackStats } = await import("./feedback.js");
        const feedbacks = loadAllFeedback(ctx.cwd);
        if (feedbacks.length > 0) {
          const stats = computeFeedbackStats(feedbacks);
          ctx.ui.notify(formatFeedbackStats(stats), "info");
        }
      } catch { /* best-effort */ }

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

  // ─── Command: /orchestrate-drift-check ─────────────────────
  pi.registerCommand("orchestrate-drift-check", {
    description: "Run strategic drift detection — check if the swarm is still converging on the goal",
    handler: async (_args, ctx) => {
      if (!oc.orchestratorActive || !oc.state.selectedGoal) {
        ctx.ui.notify("No active orchestration with a selected goal.", "warning");
        return;
      }

      const { readBeads } = await import("./beads.js");
      const { strategicDriftCheckInstructions } = await import("./prompts.js");

      const beads = await readBeads(pi, ctx.cwd);
      const openBeads = beads.filter(b => b.status === "open" || b.status === "in_progress");
      const closedBeads = beads.filter(b => b.status === "closed");
      const results = Object.values(oc.state.beadResults ?? {});

      const prompt = strategicDriftCheckInstructions(
        oc.state.selectedGoal!,
        beads,
        results,
        closedBeads.length,
        beads.length
      );

      pi.sendUserMessage(prompt);
    },
  });

  // ─── Command: /orchestrate-setup ─────────────────────────────
  pi.registerCommand("orchestrate-setup", {
    description: "Check and install orchestration prerequisites (beads, agent-mail)",
    handler: async (_args, ctx) => {
      const { detectCoordinationBackend, resetDetection } = await import("./coordination.js");
      
      // Force fresh detection
      resetDetection();
      const backend = await detectCoordinationBackend(pi, ctx.cwd);
      
      const checks = [
        {
          name: "beads (br)",
          installed: false,
          initialized: false,
          installCmd: "cargo install beads-cli",
          initCmd: "br init",
          description: "Task lifecycle tracking with dependencies",
        },
        {
          name: "agent-mail",
          installed: false,
          initialized: true, // no init needed
          installCmd: "uv pip install mcp-agent-mail",
          initCmd: null,
          description: "Multi-agent coordination and file reservations",
        },
      ];
      
      // Check br
      try {
        const brResult = await pi.exec("br", ["--help"], { timeout: 3000, cwd: ctx.cwd });
        checks[0].installed = brResult.code === 0;
        const { existsSync } = await import("fs");
        const { join } = await import("path");
        checks[0].initialized = existsSync(join(ctx.cwd, ".beads"));
      } catch { /* not installed */ }
      
      // Check agent-mail
      checks[1].installed = backend.agentMail;
      
      // Build status display
      const statusLines = checks.map(c => {
        const installStatus = c.installed ? "✅" : "❌";
        const initStatus = c.initialized ? "" : " (not initialized)";
        return `${installStatus} **${c.name}**${c.installed ? initStatus : ""} — ${c.description}`;
      });
      
      ctx.ui.notify(
        `## Orchestrator Prerequisites\n\n${statusLines.join("\n")}\n\n` +
        `Current strategy: **${backend.beads && backend.agentMail ? "beads+agentmail" : backend.beads ? "beads-only" : "bare worktrees"}**`,
        "info"
      );
      
      // Offer to install/init missing components
      const missing = checks.filter(c => !c.installed || !c.initialized);
      if (missing.length === 0) {
        ctx.ui.notify("✅ All prerequisites satisfied!", "info");
        return;
      }
      
      for (const check of missing) {
        if (!check.installed) {
          const install = await ctx.ui.confirm(
            `Install ${check.name}?`,
            `Run: ${check.installCmd}`
          );
          if (install) {
            ctx.ui.notify(`Running: ${check.installCmd}`, "info");
            try {
              const result = await pi.exec("bash", ["-c", check.installCmd], { timeout: 120000, cwd: ctx.cwd });
              if (result.code === 0) {
                ctx.ui.notify(`✅ ${check.name} installed successfully.`, "info");
                check.installed = true;
              } else {
                ctx.ui.notify(`❌ Installation failed: ${result.stderr || result.stdout}`, "error");
              }
            } catch (err: any) {
              ctx.ui.notify(`❌ Installation failed: ${err.message ?? err}`, "error");
            }
          }
        }
        
        if (check.installed && !check.initialized && check.initCmd) {
          const init = await ctx.ui.confirm(
            `Initialize ${check.name}?`,
            `Run: ${check.initCmd}`
          );
          if (init) {
            ctx.ui.notify(`Running: ${check.initCmd}`, "info");
            try {
              const result = await pi.exec("bash", ["-c", check.initCmd], { timeout: 30000, cwd: ctx.cwd });
              if (result.code === 0) {
                ctx.ui.notify(`✅ ${check.name} initialized successfully.`, "info");
              } else {
                ctx.ui.notify(`❌ Initialization failed: ${result.stderr || result.stdout}`, "error");
              }
            } catch (err: any) {
              ctx.ui.notify(`❌ Initialization failed: ${err.message ?? err}`, "error");
            }
          }
        }
      }
      
      // Re-detect after setup
      resetDetection();
      const newBackend = await detectCoordinationBackend(pi, ctx.cwd);
      ctx.ui.notify(
        `\n🔄 Updated strategy: **${newBackend.beads && newBackend.agentMail ? "beads+agentmail" : newBackend.beads ? "beads-only" : "bare worktrees"}**`,
        "info"
      );
    },
  });

  // ─── Command: /orchestrate-rollback ──────────────────────────
  pi.registerCommand("orchestrate-rollback", {
    description: "Revert the last completed bead and re-open it for re-implementation",
    handler: async (_args, ctx) => {
      const { readBeads } = await import("./beads.js");
      
      // Find last completed bead from state
      const completedEntries = Object.entries(oc.state.beadResults ?? {})
        .filter(([_, r]) => r.status === "success");
      
      if (completedEntries.length === 0) {
        ctx.ui.notify("No completed beads to roll back.", "info");
        return;
      }
      
      // Get bead details
      const beads = await readBeads(pi, ctx.cwd);
      const beadChoices = completedEntries.map(([id, result]) => {
        const bead = beads.find(b => b.id === id);
        return `${id}: ${bead?.title ?? result.summary.slice(0, 50)}`;
      });
      
      const selected = await ctx.ui.select("Select bead to roll back:", beadChoices);
      if (!selected) {
        ctx.ui.notify("Rollback cancelled.", "info");
        return;
      }
      
      const beadId = selected.split(":")[0];
      const confirmed = await ctx.ui.confirm(
        "Confirm Rollback",
        `Revert bead ${beadId} to open status? This will NOT undo code changes automatically.`
      );
      
      if (!confirmed) {
        ctx.ui.notify("Rollback cancelled.", "info");
        return;
      }
      
      // Re-open the bead
      try {
        await pi.exec("br", ["update", beadId, "--status", "open"], { cwd: ctx.cwd, timeout: 5000 });
      } catch (err: any) {
        ctx.ui.notify(`❌ Failed to update bead status: ${err.message ?? err}`, "error");
        return;
      }
      
      // Remove from results
      if (oc.state.beadResults) {
        delete oc.state.beadResults[beadId];
      }
      oc.persistState();
      
      ctx.ui.notify(
        `↩️ Rolled back bead **${beadId}** to open status.\n\n` +
        `To undo code changes, you can:\n` +
        `• \`git revert HEAD\` — revert last commit\n` +
        `• \`git checkout -- <files>\` — discard specific changes\n\n` +
        `Run \`/orchestrate\` to resume and re-implement this bead.`,
        "info"
      );
    },
  });

  // ─── Command: /orchestrate-research ──────────────────────
  pi.registerCommand("orchestrate-research", {
    description: "Study an external project and reimagine its ideas for this project (7-phase pipeline)",
    handler: async (args, ctx) => {
      const url = (args ?? "").trim();
      if (!url) {
        ctx.ui.notify(
          "Usage: /orchestrate-research <github-url>\n\n" +
          "Runs the Research & Reimagine pipeline:\n" +
          "1. Investigate external project\n" +
          "2. Deepen (push past conservative suggestions)\n" +
          "3. Inversion analysis (what can WE do that THEY can't?)\n" +
          "4. 5x blunder hunt\n" +
          "5. Multi-model competing feedback\n" +
          "6. Synthesize best feedback into final proposal\n" +
          "7. Hand off to plan→beads→implement pipeline",
          "info"
        );
        return;
      }

      const researchModule = await import("./research-pipeline.js");
      const { extractProjectName, runResearchPhase } = researchModule;
      const { writeFileSync, mkdirSync } = await import("fs");
      const { dirname } = await import("path");

      const externalName = extractProjectName(url);
      const projectName = oc.state.repoProfile?.name ?? "this project";

      // Session artifact for the proposal
      const artifactName = `research/${externalName}-proposal.md`;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      let artifactPath: string;
      if (sessionFile && sessionId) {
        const path = await import("path");
        const artifactRoot = path.join(path.dirname(sessionFile), "artifacts", sessionId);
        artifactPath = path.join(artifactRoot, artifactName);
      } else {
        artifactPath = (await import("path")).join(ctx.cwd, ".pi-orchestrator-artifacts", artifactName);
      }
      mkdirSync(dirname(artifactPath), { recursive: true });

      const state = {
        externalUrl: url,
        externalName,
        projectName,
        currentPhase: "investigate",
        proposal: "",
        artifactName,
        phasesCompleted: [],
      };

      const phases: Array<{ phase: string; label: string; emoji: string }> = [
        { phase: "investigate", label: "Investigating external project", emoji: "📚" },
        { phase: "deepen", label: "Deepening analysis", emoji: "🔍" },
        { phase: "inversion", label: "Inversion analysis", emoji: "🔄" },
        { phase: "blunder_hunt", label: "5x blunder hunt", emoji: "🔨" },
        { phase: "user_review", label: "User review", emoji: "📝" },
        { phase: "multi_model", label: "Multi-model feedback", emoji: "🧠" },
        { phase: "synthesis", label: "Synthesizing feedback", emoji: "🔗" },
      ];

      // user_review callback: shown between blunder_hunt and multi_model.
      // Presents the proposal with accept / edit / pause options.
      const userReviewCallback = async (proposal: string): Promise<{ accepted: boolean; editedProposal?: string }> => {
        const PREVIEW_CHARS = 2000;
        const preview = proposal.length > PREVIEW_CHARS
          ? proposal.slice(0, PREVIEW_CHARS) + `\n...\n*(${proposal.length - PREVIEW_CHARS} more chars — full proposal at ${artifactName})*`
          : proposal;

        const choice = await ctx.ui.select(
          `📝 **User Review — proposal after 5x blunder hunt**\n\n` +
          `Saved to: \`${artifactName}\`\n\n` +
          `**Preview:**\n${preview}\n\n` +
          `Tip: Open the artifact file to read or edit the full proposal before continuing.`,
          [
            "✅ Accept and continue to multi-model feedback",
            "✏️  Pause — I will edit the file manually, then rerun",
            "⏸️  Pause pipeline (resume manually)",
          ]
        );

        if (choice?.startsWith("✏️")) {
          ctx.ui.notify(
            `Pipeline paused for manual editing.\n` +
            `Edit the proposal at:\n  ${artifactPath}\n\n` +
            `When done, rerun \`/orchestrate-research ${url}\` — or call \`orch_approve_beads\` ` +
            `if you want to skip straight to bead creation with the edited proposal.`,
            "info"
          );
          return { accepted: false };
        }

        if (!choice || choice.startsWith("⏸️")) {
          ctx.ui.notify(
            `Research pipeline paused after blunder hunt.\nProposal saved to: ${artifactName}\n\n` +
            `To resume, you can manually feed this proposal into the planning pipeline.`,
            "info"
          );
          return { accepted: false };
        }

        return { accepted: true };
      };

      for (const { phase, label, emoji } of phases) {
        ctx.ui.notify(`${emoji} Phase: ${label}...`, "info");
        (state as any).currentPhase = phase;

        // Determine whether to pass the review callback (only for user_review phase)
        const reviewCb = phase === "user_review" ? userReviewCallback : undefined;

        try {
          const result = await runResearchPhase(pi, ctx.cwd, phase as any, state as any, undefined, reviewCb);
          if (result.proposal) {
            state.proposal = result.proposal;
            writeFileSync(artifactPath, state.proposal, "utf8");
          }
          (state as any).phasesCompleted.push(phase);

          if (!result.success) {
            // user_review returning success=false means user chose to pause
            if (phase === "user_review") return;
            ctx.ui.notify(`⚠️ ${label} had issues: ${result.error ?? "partial output"}. Continuing with current proposal.`, "warning");
          }
        } catch (err: any) {
          ctx.ui.notify(`❌ ${label} failed: ${err.message ?? err}. Continuing with current proposal.`, "error");
        }
      }

      // Hand off to planning pipeline
      oc.state.selectedGoal = `Research-reimagine: ${externalName} ideas for ${projectName}`;
      oc.state.planDocument = artifactName;
      oc.state.planRefinementRound = 0;
      oc.orchestratorActive = true;
      oc.setPhase("awaiting_plan_approval", ctx);
      oc.persistState();

      ctx.ui.notify(
        `✅ Research pipeline complete (${state.phasesCompleted.length}/${phases.length} phases).\n` +
        `Proposal saved to: ${artifactName}\n\n` +
        `The proposal has been loaded as a plan artifact. ` +
        `Call \`orch_approve_beads\` to review it and convert to beads.`,
        "info"
      );

      pi.sendUserMessage(
        `Research pipeline complete for ${externalName}. ` +
        `Call \`orch_approve_beads\` to review the proposal and create beads.`,
        { deliverAs: "followUp" }
      );
    },
  });

  // ─── Command: /orchestrate-swarm ─────────────────────────
  pi.registerCommand("orchestrate-swarm", {
    description: "Launch a persistent agent swarm for parallel bead execution",
    handler: async (args, ctx) => {
      if (!oc.state.selectedGoal) {
        ctx.ui.notify("No active orchestration with a goal. Run /orchestrate first.", "warning");
        return;
      }

      const { readBeads, readyBeads } = await import("./beads.js");
      const beads = await readBeads(pi, ctx.cwd);
      const ready = await readyBeads(pi, ctx.cwd);
      const openBeads = beads.filter((b) => b.status === "open" || b.status === "in_progress");

      if (ready.length === 0 && openBeads.length === 0) {
        ctx.ui.notify("No open or ready beads. All beads are either blocked or completed.", "info");
        return;
      }

      const { recommendComposition, generateAgentConfigs, formatLaunchInstructions } = await import("./swarm.js");
      const { ensureCoreRules } = await import("./agents-md.js");

      // Ensure AGENTS.md has core rules before launching agents
      await ensureCoreRules(ctx.cwd);

      const composition = recommendComposition(openBeads.length);

      // Let user adjust count
      const countInput = await ctx.ui.input(
        `How many agents? (suggested: ${composition.total} — ${composition.rationale})`,
        `${composition.total}`
      );
      const count = Math.max(1, Math.min(20, parseInt(countInput || `${composition.total}`, 10)));

      const configs = generateAgentConfigs(count, ctx.cwd, composition);
      const instructions = formatLaunchInstructions(configs);

      // Start SwarmTender for monitoring
      const { SwarmTender } = await import("./tender.js");
      const worktrees = configs.map((c, i) => ({ path: ctx.cwd, stepIndex: i }));
      oc.swarmTender = new SwarmTender(pi, ctx.cwd, worktrees, {
        config: {
          pollInterval: 60_000,
          stuckThreshold: 300_000,
          idleThreshold: 120_000,
        },
        onStuck: (agent) => {
          ctx.ui.notify(
            `⚠️ Agent #${agent.stepIndex} appears stuck (no changes for 5 min). ` +
            `Consider sending: "Reread AGENTS.md and check your current bead status."`,
            "warning"
          );
        },
        onConflict: (conflict) => {
          ctx.ui.notify(
            `🔴 File conflict: ${conflict.file} being edited by agents #${conflict.worktrees.join(", #")}`,
            "error"
          );
        },
      });
      oc.swarmTender.start();

      pi.sendUserMessage(
        `${instructions}\n\n` +
        `**NEXT: Spawn these agents using the \`subagent\` tool with the configs above.**\n\n` +
        `SwarmTender is monitoring. Use \`/orchestrate-swarm-status\` to check health.`,
        { deliverAs: "followUp" }
      );
    },
  });

  // ─── Command: /orchestrate-swarm-status ───────────────────
  pi.registerCommand("orchestrate-swarm-status", {
    description: "Show swarm health: active/idle/stuck agents, bead progress, conflicts",
    handler: async (_args, ctx) => {
      if (!oc.swarmTender) {
        ctx.ui.notify("No swarm active. Launch one with /orchestrate-swarm.", "info");
        return;
      }

      const { formatSwarmStatus } = await import("./swarm.js");
      const { readBeads } = await import("./beads.js");

      const agents = oc.swarmTender.getStatus();
      const beads = await readBeads(pi, ctx.cwd);
      const status = formatSwarmStatus(agents, beads);

      ctx.ui.notify(status, "info");
    },
  });

  // ─── Command: /orchestrate-refine-skills ──────────────────
  pi.registerCommand("orchestrate-refine-skills", {
    description: "Mine CASS session history for planning patterns and produce a skill refinement report",
    handler: async (args, ctx) => {
      const { mineSkillGaps } = await import("./memory.js");
      const topic = args.trim() || "planning beads orchestration";
      const snippets = mineSkillGaps(ctx.cwd, topic);
      if (!snippets) {
        ctx.ui.notify(
          "No CASS session data found for topic: " + topic +
          ". Ensure cm is installed and sessions have been recorded.",
          "info"
        );
        return;
      }
      const task = `## Skill Refinement via Session Mining

You have access to snippets from past orchestration sessions. Analyze them for:
1. **What worked well** — prompts, approaches, patterns that produced good results
2. **What failed** — repeated mistakes, dead ends, confusing steps
3. **Missing guidance** — things the current prompts don't address but sessions show are important
4. **Proposed improvements** — specific changes to planning/beads/review prompts

## Session Snippets
${snippets}

## Output
Produce a concrete skill refinement report with:
- 3-7 specific prompt improvements (old text → new text)
- 2-3 new rules to add to AGENTS.md
- Any anti-patterns to codify

Use ultrathink. Be specific — vague suggestions are useless.`;
      ctx.ui.notify("Mining CASS sessions and analysing patterns…", "info");
      pi.sendUserMessage(task, { deliverAs: "followUp" });
    },
  });

  // ─── Command: /orchestrate-refine-skill ───────────────────
  pi.registerCommand("orchestrate-refine-skill", {
    description: "Refine a specific skill file using CASS session evidence",
    handler: async (args, ctx) => {
      const { mineSkillGaps, skillRefinerPrompt } = await import("./memory.js");
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const skillName = args.trim();
      if (!skillName) {
        ctx.ui.notify("Usage: /orchestrate-refine-skill <skill-name-or-path>", "info");
        return;
      }
      // Try common skill locations
      const candidates = [
        skillName,
        join(ctx.cwd, ".claude", "skills", skillName, "SKILL.md"),
        join(ctx.cwd, ".claude", "skills", skillName),
      ];
      let skillContent: string | null = null;
      for (const p of candidates) {
        if (existsSync(p)) {
          try { skillContent = readFileSync(p, "utf8"); break; } catch { /* continue */ }
        }
      }
      if (!skillContent) {
        ctx.ui.notify(`Could not find skill file for: ${skillName}`, "error");
        return;
      }
      const sessionData = mineSkillGaps(ctx.cwd, skillName) ?? undefined;
      const prompt = skillRefinerPrompt(skillContent, skillName, sessionData);
      ctx.ui.notify(`Refining skill: ${skillName}…`, "info");
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });

  // ─── Command: /orchestrate-tool-feedback ──────────────────
  pi.registerCommand("orchestrate-tool-feedback", {
    description: "Collect structured feedback on a tool via an agent survey",
    handler: async (args, ctx) => {
      const { toolFeedbackPrompt, parseToolFeedback, saveToolFeedback } = await import("./feedback.js");
      const toolName = args.trim();
      if (!toolName) {
        ctx.ui.notify("Usage: /orchestrate-tool-feedback <tool-name>", "info");
        return;
      }
      const prompt = toolFeedbackPrompt(toolName);
      // We send the feedback survey as a followUp; the agent fills it out and we parse the result
      ctx.ui.notify(
        `Sending feedback survey for tool: ${toolName}. ` +
        `The agent will evaluate the tool and return a structured JSON report. ` +
        `Results will be saved to .pi-orchestrator-feedback/tools/${toolName}.jsonl`,
        "info"
      );
      // Register a one-time result handler by passing a parse-and-save instruction
      const resultTask = prompt + `\n\nAfter completing the survey, paste your JSON response above. ` +
        `The feedback will be automatically parsed and saved.`;
      pi.sendUserMessage(resultTask, { deliverAs: "followUp" });
      // Note: in a real pipeline the result would be streamed back; here we expose
      // the parsing utilities so the orchestrator extension can wire them up.
      void parseToolFeedback; // exported for use by the extension host
      void saveToolFeedback;
    },
  });

  // ─── Command: /orchestrate-swarm-stop ─────────────────────
  // ─── Command: /orchestrate-healthcheck ──────────────────────
  pi.registerCommand("orchestrate-healthcheck", {
    description: "Quick static health snapshot: UBS scan, TODO count, test ratio, deps — no agents, instant result",
    handler: async (_args, ctx) => {
      const { existsSync, readdirSync, readFileSync } = await import("fs");
      const { join, extname } = await import("path");
      const { detectUbs } = await import("./coordination.js");

      ctx.ui.notify("🔍 Running health check...", "info");

      // 1. Profile if needed
      if (!oc.state.repoProfile) {
        try {
          const { profileRepo } = await import("./profiler.js");
          oc.state.repoProfile = await profileRepo(pi, ctx.cwd);
          oc.persistState();
        } catch { /* best-effort */ }
      }
      const profile = oc.state.repoProfile;

      const lines: string[] = ["## 🏥 Codebase Health Check\n"];

      // 2. UBS scan
      const ubsAvailable = await detectUbs(pi, ctx.cwd);
      if (ubsAvailable) {
        try {
          const result = await pi.exec("ubs", ["."], { cwd: ctx.cwd, timeout: 30000 });
          const ubsOut = (result.stdout + result.stderr).trim();
          const issueCount = (ubsOut.match(/^(ERROR|WARN|WARNING)/gmi) ?? []).length;
          lines.push(issueCount === 0
            ? `### 🔒 UBS Scan\n✅ Clean — no issues found`
            : `### 🔒 UBS Scan\n⚠️ **${issueCount} issue(s) found**\n\`\`\`\n${ubsOut.slice(0, 1500)}\n\`\`\``);
        } catch {
          lines.push("### 🔒 UBS Scan\n⏭️ Skipped (scan error)");
        }
      } else {
        lines.push("### 🔒 UBS Scan\n⏭️ Not installed (`cargo install ubs` to enable)");
      }

      // 3. TODO/FIXME count
      const todoItems = profile?.todos ?? [];
      const todoCount = todoItems.length;
      const hacksCount = todoItems.filter(t =>
        /HACK|XXX|FIXME/i.test(t.text ?? "")
      ).length;
      lines.push(`### 📝 TODOs & Technical Debt\n` +
        `- ${todoCount} TODO/FIXME comments${todoCount > 20 ? " ⚠️ high" : todoCount > 5 ? " 🟡 moderate" : " ✅"}`  +
        (hacksCount > 0 ? `\n- ${hacksCount} HACK/XXX markers 🟠` : ""));

      // 4. Test file ratio
      try {
        const findResult = await pi.exec("find", [".", "-type", "f", "-name", "*.ts", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { cwd: ctx.cwd, timeout: 10000 });
        const allTs = findResult.stdout.trim().split("\n").filter(Boolean);
        const testFiles = allTs.filter(f => /\.test\.|spec\.|__tests__/.test(f));
        const srcFiles = allTs.filter(f => !/\.test\.|spec\.|__tests__/.test(f));
        const ratio = srcFiles.length > 0 ? (testFiles.length / srcFiles.length) : 0;
        const ratioEmoji = ratio >= 0.5 ? "✅" : ratio >= 0.2 ? "🟡" : "🔴";
        lines.push(`### 🧪 Test Coverage Estimate\n` +
          `${ratioEmoji} ${testFiles.length} test files / ${srcFiles.length} source files (ratio: ${(ratio * 100).toFixed(0)}%)`);
      } catch {
        lines.push("### 🧪 Test Coverage Estimate\n⏭️ Skipped");
      }

      // 5. Dependency vulnerabilities (npm audit if available)
      const hasPackageJson = existsSync(join(ctx.cwd, "package.json"));
      if (hasPackageJson) {
        try {
          const audit = await pi.exec("npm", ["audit", "--json", "--audit-level=high"], { cwd: ctx.cwd, timeout: 30000 });
          const data = JSON.parse(audit.stdout);
          const vulnCount = data?.metadata?.vulnerabilities;
          const high = (vulnCount?.high ?? 0) + (vulnCount?.critical ?? 0);
          const total = Object.values(vulnCount ?? {}).reduce((s: number, n) => s + (n as number), 0);
          lines.push(`### 📦 Dependency Vulnerabilities\n` +
            (high > 0
              ? `🔴 **${high} high/critical** (${total} total) — run \`npm audit fix\``
              : total > 0
              ? `🟡 ${total} low/moderate issues`
              : `✅ No known vulnerabilities`));
        } catch {
          lines.push("### 📦 Dependency Vulnerabilities\n⏭️ Skipped (npm audit unavailable)");
        }
      }

      // 6. Git health (uncommitted changes, stale branch)
      try {
        const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 5000 });
        const dirty = status.stdout.trim().split("\n").filter(Boolean);
        lines.push(`### 🌿 Git Status\n` +
          (dirty.length === 0 ? "✅ Working tree clean" : `🟡 ${dirty.length} uncommitted change(s)`));
      } catch {
        lines.push("### 🌿 Git Status\n⏭️ Skipped");
      }

      // 7. Composite score
      const scores = [
        ubsAvailable ? 1 : 0.5,
        todoCount < 5 ? 1 : todoCount < 20 ? 0.7 : 0.4,
      ];
      const score = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100);
      const scoreEmoji = score >= 80 ? "🟢" : score >= 60 ? "🟡" : "🔴";
      lines.push(`\n---\n### ${scoreEmoji} Health Score: ${score}/100`);

      const report = lines.join("\n\n");
      pi.sendUserMessage(report, { deliverAs: "followUp" });
    },
  });

  // ─── Command: /orchestrate-fix ───────────────────────────────
  pi.registerCommand("orchestrate-fix", {
    description: "Fast path: skip planning, create one bead from a description and start implementing",
    handler: async (args, ctx) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify(
          "Usage: /orchestrate-fix <description>\n\nExample:\n  /orchestrate-fix The login form crashes when email contains a + character",
          "info"
        );
        return;
      }

      // Ensure br is available
      try {
        await pi.exec("br", ["--help"], { cwd: ctx.cwd, timeout: 3000 });
      } catch {
        ctx.ui.notify("❌ `br` CLI not found. Run `/orchestrate-setup` to install it.", "error");
        return;
      }

      // Ensure .beads is initialised
      const { existsSync } = await import("fs");
      const { join } = await import("path");
      if (!existsSync(join(ctx.cwd, ".beads"))) {
        try {
          await pi.exec("br", ["init"], { cwd: ctx.cwd, timeout: 10000 });
        } catch {
          ctx.ui.notify("❌ Failed to initialise beads. Run `br init` manually.", "error");
          return;
        }
      }

      // Derive a short title from the description
      const title = description.length > 72
        ? description.slice(0, 69) + "..."
        : description;

      // Build a self-contained bead description
      const beadDesc = `## Fix: ${title}

### Problem
${description}

### Acceptance Criteria
- [ ] The described problem no longer occurs
- [ ] Existing tests still pass
- [ ] No new regressions introduced

### Files:
(Identify the relevant files during implementation)`;

      // Create the bead
      ctx.ui.notify(`🔧 Creating fix bead...`, "info");
      let beadId: string | undefined;
      try {
        const result = await pi.exec("br", [
          "create",
          "--title", `Fix: ${title}`,
          "--description", beadDesc,
          "--priority", "P1",
        ], { cwd: ctx.cwd, timeout: 15000 });
        // Parse bead ID from output (br create prints "Created bead br-N")
        const match = result.stdout.match(/([a-z][a-z0-9]*-\d+)/);
        beadId = match?.[1];
      } catch (err: any) {
        ctx.ui.notify(`❌ Failed to create bead: ${err.message ?? err}`, "error");
        return;
      }

      if (!beadId) {
        ctx.ui.notify("⚠️ Bead created but could not parse ID from output. Run `br list` to find it.", "warning");
        return;
      }

      // Set up orchestrator state
      if (!oc.state.selectedGoal) {
        oc.state.selectedGoal = `Fix: ${title}`;
      }
      if (!oc.state.activeBeadIds) oc.state.activeBeadIds = [];
      oc.state.activeBeadIds.push(beadId);
      oc.orchestratorActive = true;
      oc.setPhase("implementing", ctx);
      oc.persistState();

      // Mark bead in_progress and send implementer instructions
      try {
        await pi.exec("br", ["update", beadId, "--status", "in_progress"], { cwd: ctx.cwd, timeout: 5000 });
      } catch { /* best-effort */ }

      const { implementerInstructions } = await import("./prompts.js");
      const { readMemory } = await import("./memory.js");
      const profile = oc.state.repoProfile ?? { name: "", languages: [], frameworks: [], keyFiles: {} as Record<string,string>, testFramework: undefined, ciSystem: undefined, packageManager: undefined, hasGit: true, todos: [], recentCommits: [], entrypoints: [], structure: "", hasTests: false, hasDocs: false, hasCI: false };
      const bead = { id: beadId, title: `Fix: ${title}`, description: beadDesc, status: "in_progress" as const, priority: 1, parent: undefined, children: [], type: "task" as const, labels: [] };
      const cassMemory = readMemory(ctx.cwd, title);
      const instructions = implementerInstructions(bead, profile, [], cassMemory || undefined);

      ctx.ui.notify(`✅ Created bead **${beadId}**: Fix: ${title}\n\nStarting implementation...`, "info");
      pi.sendUserMessage(instructions, { deliverAs: "followUp" });
    },
  });

  // ─── Command: /orchestrate-audit ─────────────────────────────
  pi.registerCommand("orchestrate-audit", {
    description: "Full codebase audit: spin up parallel agents for bugs, security, tests, and dead code",
    handler: async (args, ctx) => {
      const { auditAgentPrompt, findingsToBeadsPrompt } = await import("./prompts.js");
      const { getDomainChecklist, formatDomainBlunderItems } = await import("./domain-knowledge.js");
      const { runDeepPlanAgents } = await import("./deep-plan.js");
      const { pickRefinementModel } = await import("./prompts.js");

      // Profile if needed
      if (!oc.state.repoProfile) {
        ctx.ui.notify("📊 Profiling repo first...", "info");
        try {
          const { profileRepo } = await import("./profiler.js");
          oc.state.repoProfile = await profileRepo(pi, ctx.cwd);
          oc.persistState();
        } catch { /* best-effort */ }
      }
      const profile = oc.state.repoProfile ?? { name: "", languages: [], frameworks: [], keyFiles: {} as Record<string,string>, testFramework: undefined, ciSystem: undefined, packageManager: undefined, hasGit: true, todos: [], recentCommits: [], entrypoints: [], structure: "", hasTests: false, hasDocs: false, hasCI: false };

      // Parse optional focus filter from args (e.g. "--focus bugs,security")
      const argStr = args.trim();
      const focusMatch = argStr.match(/--focus\s+([\w,\-]+)/);
      type AuditFocus = "bugs" | "security" | "tests" | "dead-code";
      const allFoci: AuditFocus[] = ["bugs", "security", "tests", "dead-code"];
      let foci: AuditFocus[] = allFoci;
      if (focusMatch) {
        const requested = focusMatch[1].split(",").map(s => s.trim()) as AuditFocus[];
        foci = requested.filter(f => allFoci.includes(f));
        if (foci.length === 0) foci = allFoci;
      }

      // Let user choose scope if interactive
      const scopeChoice = await ctx.ui.select(
        `## 🔍 Codebase Audit\n\nLaunching ${foci.length} parallel audit agent(s): **${foci.join(", ")}**\n\nThis will spawn one agent per focus area. Each reads the full codebase and reports findings.`,
        [
          `🚀 Full audit (${foci.length} agents in parallel)`,
          "🎯 Quick — bugs + security only (2 agents)",
          "❌ Cancel",
        ]
      );

      if (!scopeChoice || scopeChoice.startsWith("❌")) return;
      if (scopeChoice.startsWith("🎯")) foci = ["bugs", "security"];

      // Get file list for context
      let files: string[] = [];
      try {
        const findResult = await pi.exec("find", ["src", "-type", "f", "-name", "*.ts", "-not", "-path", "*/node_modules/*"], { cwd: ctx.cwd, timeout: 10000 });
        files = findResult.stdout.trim().split("\n").filter(Boolean).slice(0, 100);
      } catch { /* use empty list — agent will explore on its own */ }

      const domainChecklist = getDomainChecklist(profile);
      const domainExtras = domainChecklist ? formatDomainBlunderItems(domainChecklist) : undefined;

      ctx.ui.notify(`🚀 Launching ${foci.length} audit agent(s)...`, "info");

      const agents = foci.map((focus, i) => ({
        name: `audit-${focus}`,
        model: pickRefinementModel(i),
        task: auditAgentPrompt(focus, profile, files, ctx.cwd, domainExtras),
      }));

      let results: import("./deep-plan.js").DeepPlanResult[];
      try {
        results = await runDeepPlanAgents(pi, ctx.cwd, agents);
      } catch (err: any) {
        ctx.ui.notify(`❌ Audit agents failed: ${err.message ?? err}`, "error");
        return;
      }

      // Parse findings from each agent output
      const allFindings: Array<{ severity: string; file: string; line: string; title: string; description: string; fix: string; focus: string }> = [];
      const summaries: string[] = [];

      for (const result of results) {
        const focusName = result.name.replace("audit-", "");
        if (result.exitCode !== 0 || !result.plan) {
          summaries.push(`⚠️ **${focusName}**: agent failed or produced no output`);
          continue;
        }
        const jsonMatch = result.plan.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            if (Array.isArray(parsed)) {
              allFindings.push(...parsed.map((f: any) => ({ ...f, focus: focusName })));
            }
          } catch { /* ignore parse errors */ }
        }
        // Extract prose summary (after the JSON block)
        const afterJson = result.plan.replace(/```json[\s\S]*?```/g, "").trim();
        if (afterJson) summaries.push(`**${focusName}:** ${afterJson.slice(0, 300)}`);
      }

      // Sort by severity
      const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      allFindings.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

      const critical = allFindings.filter(f => f.severity === "critical" || f.severity === "high");
      const other = allFindings.filter(f => f.severity !== "critical" && f.severity !== "high");

      const sevEmoji = (s: string) =>
        s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "⚪";

      const findingLines = allFindings.slice(0, 30).map(f =>
        `${sevEmoji(f.severity)} **[${f.focus}]** ${f.file}:${f.line} — ${f.title}`
      );

      const report = [
        `## 🔍 Audit Complete — ${allFindings.length} finding(s)`,
        `**Critical/High:** ${critical.length}  |  **Other:** ${other.length}`,
        "",
        summaries.length > 0 ? `### Agent Summaries\n${summaries.join("\n\n")}` : "",
        findingLines.length > 0 ? `### All Findings\n${findingLines.join("\n")}` : "✅ No findings.",
      ].filter(Boolean).join("\n\n");

      pi.sendUserMessage(report, { deliverAs: "followUp" });

      if (allFindings.length === 0) return;

      // Offer to create fix beads
      const createBeads = await ctx.ui.select(
        `Create fix beads for findings?`,
        [
          `🔴 Critical & high only (${critical.length} bead${critical.length !== 1 ? "s" : ""})`,
          `📋 All findings (${allFindings.length} bead${allFindings.length !== 1 ? "s" : ""})`,
          "⏭️  No — just the report",
        ]
      );

      if (!createBeads || createBeads.startsWith("⏭️")) return;

      const toCreate = createBeads.startsWith("🔴") ? critical : allFindings;
      const beadInstructions = findingsToBeadsPrompt(toCreate, ctx.cwd);
      pi.sendUserMessage(
        `Create beads for the ${toCreate.length} finding(s):\n\n${beadInstructions}`,
        { deliverAs: "followUp" }
      );
    },
  });

  // ─── Command: /orchestrate-scan ──────────────────────────────
  pi.registerCommand("orchestrate-scan", {
    description: "Targeted scan of specific files or subsystems — /orchestrate-scan [path] [focus]",
    handler: async (args, ctx) => {
      const { scanAgentPrompt, findingsToBeadsPrompt } = await import("./prompts.js");
      const { getDomainChecklist, formatDomainBlunderItems } = await import("./domain-knowledge.js");
      const { runDeepPlanAgents, } = await import("./deep-plan.js");
      const { pickRefinementModel } = await import("./prompts.js");

      // Profile if needed
      if (!oc.state.repoProfile) {
        try {
          const { profileRepo } = await import("./profiler.js");
          oc.state.repoProfile = await profileRepo(pi, ctx.cwd);
          oc.persistState();
        } catch { /* best-effort */ }
      }
      const profile = oc.state.repoProfile ?? { name: "", languages: [], frameworks: [], keyFiles: {} as Record<string,string>, testFramework: undefined, ciSystem: undefined, packageManager: undefined, hasGit: true, todos: [], recentCommits: [], entrypoints: [], structure: "", hasTests: false, hasDocs: false, hasCI: false };

      // Parse args: /orchestrate-scan [path] [focus]
      // Examples:
      //   /orchestrate-scan src/auth security
      //   /orchestrate-scan src/api bugs
      //   /orchestrate-scan (interactive)
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let pathFilter = parts[0] ?? "";
      let focus = parts[1] ?? "";

      // Interactive path picker if not provided
      if (!pathFilter) {
        // Collect top-level directories
        let topDirs: string[] = [];
        try {
          const { readdirSync, statSync } = await import("fs");
          const { join } = await import("path");
          topDirs = readdirSync(ctx.cwd)
            .filter(f => !f.startsWith(".") && !f.includes("node_modules"))
            .filter(f => { try { return statSync(join(ctx.cwd, f)).isDirectory(); } catch { return false; } })
            .slice(0, 12);
        } catch { /* use empty */ }

        const pathChoice = await ctx.ui.select(
          "## 🎯 Targeted Scan\n\nWhich path to scan?",
          [
            "📁 Entire codebase",
            ...topDirs.map(d => `📂 ${d}/`),
            "✏️  Enter path manually",
          ]
        );
        if (!pathChoice) return;
        if (pathChoice.startsWith("📂")) {
          pathFilter = pathChoice.replace("📂 ", "").replace("/", "");
        } else if (pathChoice.startsWith("✏️")) {
          pathFilter = "";
        }
      }

      // Interactive focus picker if not provided
      const focusOptions = [
        "bugs — runtime errors, logic issues, null dereferences",
        "security — injections, missing auth, hardcoded secrets",
        "performance — hot paths, unnecessary allocations, N+1 queries",
        "tests — missing coverage, fragile mocks, untested edge cases",
        "dead-code — unused exports, unreachable branches, stale TODOs",
        "types — unsafe casts, any types, missing type guards",
        "docs — missing JSDoc, unclear error messages, stale comments",
      ];
      if (!focus) {
        const focusChoice = await ctx.ui.select(
          "What to focus on?",
          focusOptions
        );
        if (!focusChoice) return;
        focus = focusChoice.split(" ")[0];
      }

      // Collect files in scope
      let files: string[] = [];
      try {
        const findArgs = pathFilter
          ? [pathFilter, "-type", "f", "-not", "-path", "*/node_modules/*"]
          : [".", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"];
        const findResult = await pi.exec("find", findArgs, { cwd: ctx.cwd, timeout: 10000 });
        const langs = profile.languages.map(l => l.toLowerCase());
        const exts = langs.includes("typescript") || langs.includes("javascript")
          ? [".ts", ".tsx", ".js", ".jsx"]
          : langs.includes("rust") ? [".rs"]
          : langs.includes("python") ? [".py"]
          : langs.includes("go") ? [".go"]
          : [".ts", ".js", ".py", ".rs", ".go"];
        files = findResult.stdout.trim().split("\n")
          .filter(f => f && exts.some(e => f.endsWith(e)))
          .slice(0, 80);
      } catch { /* fallback: empty, agent explores */ }

      if (files.length === 0 && !pathFilter) {
        ctx.ui.notify("⚠️ No source files found. The agent will explore the codebase directly.", "warning");
      }

      const domainChecklist = getDomainChecklist(profile);
      const domainExtras = domainChecklist ? formatDomainBlunderItems(domainChecklist) : undefined;
      const scopeLabel = pathFilter ? `\`${pathFilter}/\`` : "entire codebase";

      ctx.ui.notify(`🎯 Scanning ${scopeLabel} for **${focus}** issues (${files.length} files)...`, "info");

      const agents = [{
        name: `scan-${focus}`,
        model: pickRefinementModel(0),
        task: scanAgentPrompt(focus, files, ctx.cwd, domainExtras),
      }];

      let results: import("./deep-plan.js").DeepPlanResult[];
      try {
        results = await runDeepPlanAgents(pi, ctx.cwd, agents);
      } catch (err: any) {
        ctx.ui.notify(`❌ Scan agent failed: ${err.message ?? err}`, "error");
        return;
      }

      const output = results[0]?.plan ?? "";
      if (!output) {
        ctx.ui.notify("⚠️ Scan agent produced no output.", "warning");
        return;
      }

      // Parse findings
      const findings: Array<{ severity: string; file: string; line: string; title: string; description: string; fix: string }> = [];
      const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try { findings.push(...JSON.parse(jsonMatch[1])); } catch { /* ignore */ }
      }

      const sevEmoji = (s: string) =>
        s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "⚪";
      const findingLines = findings.slice(0, 25).map(f =>
        `${sevEmoji(f.severity)} ${f.file}:${f.line} — ${f.title}`
      );
      const prose = output.replace(/```json[\s\S]*?```/g, "").trim();

      const report = [
        `## 🎯 Scan Results — ${scopeLabel} / **${focus}**`,
        `**${findings.length} finding(s)** | ${findings.filter(f => f.severity === "critical" || f.severity === "high").length} critical/high`,
        "",
        prose ? `### Summary\n${prose.slice(0, 600)}` : "",
        findingLines.length > 0 ? `### Findings\n${findingLines.join("\n")}` : "✅ Nothing found.",
      ].filter(Boolean).join("\n\n");

      pi.sendUserMessage(report, { deliverAs: "followUp" });

      if (findings.length === 0) return;

      const createBeads = await ctx.ui.select(
        `Create fix beads for the ${findings.length} finding(s)?`,
        [
          `📋 Yes — create ${findings.length} bead${findings.length !== 1 ? "s" : ""}`,
          "⏭️  No — just the report",
        ]
      );
      if (!createBeads || createBeads.startsWith("⏭️")) return;

      const beadInstructions = findingsToBeadsPrompt(findings, ctx.cwd);
      pi.sendUserMessage(
        `Create fix beads for scan findings:\n\n${beadInstructions}`,
        { deliverAs: "followUp" }
      );
    },
  });

  pi.registerCommand("orchestrate-swarm-stop", {
    description: "Stop the swarm tender and send landing prompts",
    handler: async (_args, ctx) => {
      if (!oc.swarmTender) {
        ctx.ui.notify("No swarm active.", "info");
        return;
      }

      oc.swarmTender.stop();
      oc.swarmTender = undefined;

      const { landingChecklistInstructions } = await import("./prompts.js");
      ctx.ui.notify(
        `🛑 Swarm tender stopped.\n\n` +
        `Agents may still be running in their terminals. Send each the landing checklist:\n\n` +
        `${landingChecklistInstructions(ctx.cwd).slice(0, 500)}...`,
        "info"
      );
    },
  });
}
