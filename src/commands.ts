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
    lines.push(`  🟡 Recent (1-7 days): ${recent.map(b => `${b.id} (${formatAge(recent.find(x => x.id === b.id)?.created_at)})`).join(", ")}`);
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
          // Clear: delete all beads, then start fresh
          const allCount = existingBeads.length;
          let deleted = 0;
          for (const bead of existingBeads) {
            try {
              await pi.exec("br", ["delete", bead.id, "--yes"], { cwd: ctx.cwd, timeout: 5000 });
              deleted++;
            } catch { /* best effort */ }
          }
          ctx.ui.notify(`🗑️ Deleted ${deleted}/${allCount} bead(s).`, "info");
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
        { phase: "multi_model", label: "Multi-model feedback", emoji: "🧠" },
        { phase: "synthesis", label: "Synthesizing feedback", emoji: "🔗" },
      ];

      for (const { phase, label, emoji } of phases) {
        ctx.ui.notify(`${emoji} Phase: ${label}...`, "info");
        (state as any).currentPhase = phase;

        try {
          const result = await runResearchPhase(pi, ctx.cwd, phase as any, state as any);
          if (result.proposal) {
            state.proposal = result.proposal;
            writeFileSync(artifactPath, state.proposal, "utf8");
          }
          (state as any).phasesCompleted.push(phase);

          if (!result.success) {
            ctx.ui.notify(`⚠️ ${label} had issues: ${result.error ?? "partial output"}. Continuing with current proposal.`, "warning");
          }
        } catch (err: any) {
          ctx.ui.notify(`❌ ${label} failed: ${err.message ?? err}. Continuing with current proposal.`, "error");
        }

        // After blunder hunt, offer user review
        if (phase === "blunder_hunt") {
          ctx.ui.notify(
            `✅ Proposal refined through 5x blunder hunt.\nSaved to: ${artifactName}\n\nReview the proposal before multi-model feedback.`,
            "info"
          );
          const proceed = await ctx.ui.confirm(
            "Continue to multi-model feedback?",
            "The proposal will be sent to 3 competing models for critique."
          );
          if (!proceed) {
            ctx.ui.notify(
              `Research pipeline paused after blunder hunt.\nProposal saved to: ${artifactName}\n\n` +
              `To resume, you can manually feed this proposal into the planning pipeline.`,
              "info"
            );
            return;
          }
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
        `✅ Research pipeline complete (${state.phasesCompleted.length}/6 phases).\n` +
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

  // ─── Command: /orchestrate-swarm-stop ─────────────────────
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
