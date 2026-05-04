import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type {
  OrchestratorState,
  OrchestratorPhase,
  OrchestratorContext,
} from "./types.js";
import { createInitialState } from "./types.js";
import { registerCommands } from "./commands.js";
import { orchestratorSystemPrompt } from "./prompts.js";
import { type PlanToCRResult } from "./sophia.js";
import {
  detectCoordinationBackend,
  selectMode,
  selectStrategy,
  resetDetection,
} from "./coordination.js";
import { WorktreePool } from "./worktree.js";
import {
  agentMailRPC as _agentMailRPC,
  ensureAgentMailProject as _ensureAgentMailProject,
  type ExecFn,
} from "./agent-mail.js";
import { registerProfileTool } from "./tools/profile.js";
import { registerDiscoverTool } from "./tools/discover.js";
import { registerSelectTool } from "./tools/select.js";
import { registerPlanTool } from "./tools/plan.js";
import { registerApproveTool } from "./tools/approve.js";
import { registerReviewTool } from "./tools/review.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerVerifyBeadsTool } from "./tools/verify-beads.js";
import { DashboardController, renderDashboardLines, PHASE_EMOJI } from "./dashboard/index.js";
import { readBeads } from "./beads.js";
import { writeCheckpoint, clearCheckpoint, readCheckpoint } from "./checkpoint.js";
import { brExecJson } from "./cli-exec.js";

export default function (pi: ExtensionAPI) {
  // Log version at startup so stale code is immediately obvious
  const ORCHESTRATOR_VERSION = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  ).version as string;
  console.log(`[pi-orchestrator] v${ORCHESTRATOR_VERSION} loaded`);

  let state: OrchestratorState = createInitialState();
  let orchestratorActive = false;

  // Stored cwd for persistState() which doesn't receive ctx
  let currentCwd: string | undefined;

  // Dashboard widget state (single instance to prevent flashing)
  let dashboardWidgetRegistered = false;
  let currentDashboardSnapshot: import("./dashboard/types.js").DashboardSnapshot | null = null;
  let lastRenderLines: string[] | null = null;
  let lastRenderWidth: number | null = null;
  let lastSnapshotKey: string | null = null;

  function snapshotKey(s: import("./dashboard/types.js").DashboardSnapshot): string {
    const alertKey = s.alerts.map((a) => `${a.level}:${a.message}`).join("||");
    const staleAgeKey = s.staleSnapshotAgeMs !== undefined ? Math.round(s.staleSnapshotAgeMs / 1000) : "";
    return `${s.phase}|${s.completedCount}|${s.totalCount}|${s.staleData ? 1 : 0}|${staleAgeKey}|${alertKey}|${s.tenderSummary ?? ""}|${s.beads.map(b => `${b.id}:${b.status}:${b.reviewPasses}`).join(",")}`;
  }

  // Helper: spawn hit-me review agents inline via pi.exec (like deep-plan.ts)
  interface HitMeResult {
    text: string;
    diff: string;
  }

  async function runHitMeAgents(
    agentConfigs: { name: string; task: string }[],
    cwd: string,
    ctx: ExtensionContext
  ): Promise<HitMeResult> {
    const outputDir = join(tmpdir(), `pi-hit-me-${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });

    ctx.ui.notify(`🔥 Spawning ${agentConfigs.length} review agents...`, "info");

    const promises = agentConfigs.map(async (agent) => {
      const taskFile = join(outputDir, `${agent.name}-task.md`);
      writeFileSync(taskFile, agent.task, "utf8");

      const args = [
        "--print",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--tools", "read,bash,grep,find,ls,edit,write",
        `@${taskFile}`,
      ];

      try {
        const result = await pi.exec("pi", args, {
          timeout: 120000,
          cwd,
        });
        return { name: agent.name, output: result.stdout.trim(), ok: result.code === 0 };
      } catch (err: any) {
        return { name: agent.name, output: `ERROR: ${err.message ?? err}`, ok: false };
      }
    });

    const results = await Promise.all(promises);

    // Format combined output
    const sections = results.map((r) => {
      const status = r.ok ? "✅" : "⚠️";
      return `### ${status} ${r.name}\n\n${r.output || "(no output)"}\n`;
    });
    const text = sections.join("\n---\n\n");

    // Capture git diff — agents' edits persist to disk in --print mode
    let diff = "";
    try {
      const diffResult = await pi.exec("git", ["diff"], { timeout: 5000, cwd });
      diff = diffResult.stdout.trim();
    } catch {
      // ignore — no diff available
    }

    ctx.ui.notify(
      diff
        ? `✅ Review agents completed — ${diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).length} lines changed`
        : `✅ Review agents completed — no file changes`,
      "info"
    );

    return { text, diff };
  }

  // ─── Agent Mail helpers (imported from ./agent-mail.ts) ─────
  const agentMailRPC = (toolName: string, args: Record<string, unknown>) =>
    _agentMailRPC(pi.exec.bind(pi) as ExecFn, toolName, args);
  const ensureAgentMailProject = (cwd: string) =>
    _ensureAgentMailProject(pi.exec.bind(pi) as ExecFn, cwd);

  let sophiaCRResult: PlanToCRResult | undefined;
  let worktreePool: WorktreePool | undefined;
  let swarmTender: import("./tender.js").SwarmTender | undefined;
  let dashboardController: DashboardController | undefined;

  // ─── Fallback widget (preserves original 4-line output) ──────
  function renderFallbackWidget(): string[] {
    const lines: string[] = [
      `${PHASE_EMOJI[state.phase]} Phase: ${state.phase}`,
    ];
    if (state.repoProfile) {
      const scanBadge = state.scanResult?.source ? ` (${state.scanResult.source})` : "";
      lines.push(`📁 Repo: ${state.repoProfile.name}${scanBadge}`);
    }
    if (state.selectedGoal)
      lines.push(
        `🎯 Goal: ${state.selectedGoal.length > 60 ? state.selectedGoal.slice(0, 57) + "..." : state.selectedGoal}`
      );
    if (state.activeBeadIds && state.activeBeadIds.length > 0) {
      const done = Object.values(state.beadResults ?? {}).filter(r => r.status === "success").length;
      const total = state.activeBeadIds.length;
      lines.push(`📊 Progress: ${done}/${total} beads done`);
    }
    if (swarmTender) {
      lines.push(`🐝 Tender: ${swarmTender.getSummary()}`);
    }
    return lines;
  }

  // ─── Dashboard controller setup ──────────────────────────────
  function ensureDashboardController(ctx: ExtensionContext): DashboardController {
    if (dashboardController) return dashboardController;

    dashboardController = new DashboardController({
      readBeadsFn: () => readBeads(pi, ctx.cwd),
      getUnblockedBeadsFn: async () => {
        const readyResult = await brExecJson<{ issues?: { id: string }[] }>(pi, ["ready", "--json"], {
          cwd: ctx.cwd,
        });
        if (!readyResult.ok) {
          return [];
        }
        return (readyResult.value.issues ?? []).map((b) => b.id);
      },
      getState: () => state,
      getTenderSummary: () => swarmTender?.getSummary(),
      onUpdate: (snapshot) => {
        try {
          // Only invalidate the render cache when content actually changed
          const key = snapshotKey(snapshot);
          const changed = key !== lastSnapshotKey;
          currentDashboardSnapshot = snapshot;
          lastSnapshotKey = key;
          if (changed) lastRenderLines = null;
          
          // Only call setWidget ONCE when first registering the widget
          if (!dashboardWidgetRegistered) {
            ctx.ui.setWidget("orchestrator", (tui: any, theme: any) => ({
              render(width: number): string[] {
                if (!currentDashboardSnapshot) return [];
                if (lastRenderWidth === width && lastRenderLines) return lastRenderLines;
                lastRenderLines = renderDashboardLines(currentDashboardSnapshot, theme, width);
                lastRenderWidth = width;
                return lastRenderLines;
              },
              invalidate() {
                lastRenderLines = null;
                lastRenderWidth = null;
              },
            }));
            dashboardWidgetRegistered = true;
          }
        } catch {
          // Fallback to simple string array
          ctx.ui.setWidget("orchestrator", renderFallbackWidget());
        }
      },
    });

    return dashboardController;
  }

  function setPhase(phase: OrchestratorPhase, ctx: ExtensionContext) {
    state.phase = phase;
    state.phaseStartedAt = Date.now();

    // Checkpoint persistence: write for active phases, clear for terminal
    if (phase !== "idle" && phase !== "complete") {
      writeCheckpoint(ctx.cwd, state, ORCHESTRATOR_VERSION);
    } else {
      clearCheckpoint(ctx.cwd);
    }

    if (phase === "idle") {
      ctx.ui.setStatus("orchestrator", undefined);
      ctx.ui.setWidget("orchestrator", undefined);
      dashboardController?.stop();
      // Reset widget state for next orchestration
      dashboardWidgetRegistered = false;
      currentDashboardSnapshot = null;
      lastRenderLines = null;
      lastRenderWidth = null;
      lastSnapshotKey = null;
    } else if (phase === "complete") {
      ctx.ui.setStatus("orchestrator", "✅ Orchestrator: done");
      ctx.ui.setWidget("orchestrator", undefined);
      dashboardController?.stop();
      // Reset widget state for next orchestration
      dashboardWidgetRegistered = false;
      currentDashboardSnapshot = null;
      lastRenderLines = null;
      lastRenderWidth = null;
      lastSnapshotKey = null;
    } else {
      ctx.ui.setStatus(
        "orchestrator",
        `${PHASE_EMOJI[phase]} Orchestrator: ${phase}`
      );
      updateWidget(ctx);
    }
  }

  function updateWidget(ctx: ExtensionContext) {
    try {
      const controller = ensureDashboardController(ctx);
      controller.start();
      // Fire-and-forget immediate refresh
      controller.refreshNow().catch(() => {
        // On refresh failure, show fallback
        ctx.ui.setWidget("orchestrator", renderFallbackWidget());
      });
    } catch {
      // If dashboard controller fails entirely, use fallback
      ctx.ui.setWidget("orchestrator", renderFallbackWidget());
    }
  }

  // ─── Inject orchestrator system prompt when active ───────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!orchestratorActive) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + orchestratorSystemPrompt(state.coordinationBackend?.sophia ?? false, state.coordinationBackend),
    };
  });

  // ─── Restore state from session ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Find the LAST orchestrator-state entry (most recent)
    let lastStateEntry: OrchestratorState | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "orchestrator-state") {
        lastStateEntry = entry.data as OrchestratorState;
      }
    }
    // Store cwd for persistState() checkpoint writes
    currentCwd = ctx.cwd;

    // Checkpoint fallback: if session log is empty or stale (idle), try disk checkpoint
    if (!lastStateEntry || lastStateEntry.phase === "idle") {
      const checkpoint = readCheckpoint(ctx.cwd);
      if (checkpoint && checkpoint.envelope.state.phase !== "idle" && checkpoint.envelope.state.phase !== "complete") {
        lastStateEntry = checkpoint.envelope.state;
        console.log(`[pi-orchestrator] Restored from checkpoint: phase=${lastStateEntry.phase}${lastStateEntry.selectedGoal ? `, goal="${lastStateEntry.selectedGoal}"` : ""}`);
        for (const w of checkpoint.warnings) {
          console.warn(`[pi-orchestrator] checkpoint: ${w}`);
        }
      }
    }

    if (lastStateEntry) {
        state = lastStateEntry;

        // Use stage detection for a richer, phase-aware session-restore notification.
        // We don't have live bead data here (async read would be needed), so we
        // derive counts from the persisted state for now — the full live read
        // happens when the user runs /orchestrate.
        const { detectSessionStage, formatSessionContext } = await import("./session-state.js");
        // Build a lightweight bead array from persisted ids + results for stage detection
        const persistedBeads = (state.activeBeadIds ?? []).map(id => ({
          id,
          title: "",
          description: "",
          status: (state.beadResults?.[id]?.status === "success" ? "closed" : "open") as "open" | "closed" | "in_progress" | "deferred",
          priority: 0,
          type: "task",
          labels: [] as string[],
        }));
        // Mark the current bead as in_progress if known
        if (state.currentBeadId) {
          const cur = persistedBeads.find(b => b.id === state.currentBeadId);
          if (cur && cur.status === "open") cur.status = "in_progress";
        }
        const stage = detectSessionStage(state, persistedBeads);

        if (stage.phase !== "idle" && stage.phase !== "complete") {
          const isActivePhase = stage.phase === "implementing" || stage.phase === "reviewing" || stage.phase === "iterating";
          const stageCtx = formatSessionContext(stage);
          ctx.ui.notify(
            (isActivePhase ? "⚠️ Session interrupted" : "🔄 Previous session detected") +
            `\n\n${stageCtx}\n\n` +
            `Run \`/orchestrate\` to resume or \`/orchestrate-stop\` to reset.`,
            isActivePhase ? "warning" : "info"
          );
          // Don't auto-activate — let the user decide via /orchestrate
          orchestratorActive = false;
        } else {
          orchestratorActive = state.phase !== "idle" && state.phase !== "complete";
        }

        // Restore worktree pool only for explicit worktree mode.
        if (state.coordinationMode === "worktree" && state.worktreePoolState) {
          worktreePool = WorktreePool.fromState(pi, state.worktreePoolState);
        } else {
          worktreePool = undefined;
          state.worktreePoolState = undefined;
        }

        // Re-detect coordination backend to catch uninstalled tools
        if (state.coordinationBackend) resetDetection();
        const freshBackend = await detectCoordinationBackend(pi, ctx.cwd);
        state.coordinationBackend = freshBackend;
        state.coordinationStrategy = selectStrategy(freshBackend);
        state.coordinationMode ??= selectMode(freshBackend);
        if (state.sophiaCRId) {
          // Try to rebuild full CR state from sophia if available
          if (state.coordinationBackend?.sophia) {
            const { getCRStatus } = await import("./sophia.js");
            const crStatus = await getCRStatus(pi, ctx.cwd, state.sophiaCRId);
            if (crStatus.ok && crStatus.data) {
              sophiaCRResult = {
                cr: {
                  id: crStatus.data.id,
                  branch: crStatus.data.branch,
                  title: crStatus.data.title,
                },
                taskIds: new Map(),
              };
            } else {
              sophiaCRResult = {
                cr: { id: state.sophiaCRId, branch: state.sophiaCRBranch ?? "", title: state.sophiaCRTitle ?? "" },
                taskIds: new Map(),
              };
            }
          } else {
            sophiaCRResult = {
              cr: { id: state.sophiaCRId, branch: state.sophiaCRBranch ?? "", title: state.sophiaCRTitle ?? "" },
              taskIds: new Map(),
            };
          }
        }

        // Restore bead tracking — beads survive on disk in .beads/
        if (state.activeBeadIds && state.activeBeadIds.length > 0) {
          const done = Object.values(state.beadResults ?? {}).filter(r => r.status === "success").length;
          ctx.ui.notify(
            `Restored bead orchestration: ${done}/${state.activeBeadIds.length} beads complete. Run /orchestrate-status for details.`,
            "info"
          );
        }

        // Start dashboard controller for restored active sessions
        if (state.phase !== "idle" && state.phase !== "complete") {
          try {
            const controller = ensureDashboardController(ctx);
            controller.start();
            controller.refreshNow().catch(() => {});
          } catch {
            // Non-fatal — dashboard is advisory
          }
        }
    }

    // Detect stale/orphaned worktrees from previous crashed sessions
    try {
      const { findOrphanedWorktrees } = await import("./worktree.js");
      const tracked = worktreePool?.getAll() ?? [];
      const orphans = await findOrphanedWorktrees(pi, ctx.cwd, [...tracked]);
      if (orphans.length > 0) {
        const dirtyCount = orphans.filter(o => o.isDirty).length;
        const dirtyNote = dirtyCount > 0 ? ` (${dirtyCount} with uncommitted changes)` : "";
        ctx.ui.notify(
          `🧹 Found ${orphans.length} orphaned worktree${orphans.length > 1 ? "s" : ""} from a previous session${dirtyNote}. Run \`/orchestrate-cleanup\` to remove them.`,
          "warning"
        );
      }
    } catch {
      // Non-fatal — orphan detection is advisory only
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      if (worktreePool) {
        await worktreePool.safeCleanup();
      }
    } catch (err) {
      // Log but don't block shutdown — best-effort cleanup
      console.error(`[pi-orchestrator] worktree cleanup error on shutdown: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      worktreePool = undefined;
      if (swarmTender) { swarmTender.stop(); swarmTender = undefined; }
      if (dashboardController) { dashboardController.dispose(); dashboardController = undefined; }
      orchestratorActive = false;
    }
  });

  // ─── Helper: persist state ───────────────────────────────────
  function persistState() {
    // Sync ephemeral state into persisted state
    state.worktreePoolState = worktreePool?.getState();
    if (sophiaCRResult) {
      state.sophiaCRId = sophiaCRResult.cr.id;
      state.sophiaCRBranch = sophiaCRResult.cr.branch;
      state.sophiaCRTitle = sophiaCRResult.cr.title;
      // sophiaTaskIds removed — task mapping now lives in sophia CR
    }
    // Deep copy via JSON to create a true snapshot — prevents shared array
    // references between appended entries and the live in-memory state
    pi.appendEntry("orchestrator-state", JSON.parse(JSON.stringify(state)));

    // Also write checkpoint for sub-phase progress (bead results, gate index, etc.)
    if (currentCwd && state.phase !== "idle" && state.phase !== "complete") {
      writeCheckpoint(currentCwd, state, ORCHESTRATOR_VERSION);
    }
  }

  // ─── Orchestrator Context ──────────────────────────────────
  const oc: OrchestratorContext = {
    pi,
    get state() { return state; },
    set state(v) { state = v; },
    get orchestratorActive() { return orchestratorActive; },
    set orchestratorActive(v) { orchestratorActive = v; },
    version: ORCHESTRATOR_VERSION,
    get sophiaCRResult() { return sophiaCRResult; },
    set sophiaCRResult(v) { sophiaCRResult = v; },
    get worktreePool() { return worktreePool; },
    set worktreePool(v) { worktreePool = v; },
    get swarmTender() { return swarmTender; },
    set swarmTender(v) { swarmTender = v; },
    setPhase,
    persistState,
    updateWidget,
    runHitMeAgents,
    agentMailRPC,
    ensureAgentMailProject,
  };

  // ─── Commands (extracted to src/commands.ts) ─────────────────
  registerCommands(oc);

  // ─── Tools (extracted to src/tools/) ─────────────────────────
  registerProfileTool(oc);
  registerDiscoverTool(oc);
  registerSelectTool(oc);
  registerPlanTool(oc);
  registerApproveTool(oc);
  registerMemoryTool(oc);
  registerReviewTool(oc);
  registerDoctorTool(oc);
  registerVerifyBeadsTool(oc);
}
