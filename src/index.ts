import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync } from "fs";
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

const PHASE_EMOJI: Record<OrchestratorPhase, string> = {
  idle: "⏸",
  profiling: "📊",
  discovering: "💡",
  awaiting_selection: "🎯",
  planning: "📝",
  awaiting_plan_approval: "📋",
  creating_beads: "🔨",
  refining_beads: "🔍",
  awaiting_bead_approval: "📋",
  implementing: "🔨",
  reviewing: "🔍",
  iterating: "🔄",
  complete: "✅",
};

export default function (pi: ExtensionAPI) {
  // Log version at startup so stale code is immediately obvious
  const ORCHESTRATOR_VERSION = '0.7.0';
  console.log(`[pi-orchestrator] v${ORCHESTRATOR_VERSION} loaded`);

  let state: OrchestratorState = createInitialState();
  let orchestratorActive = false;

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

  function setPhase(phase: OrchestratorPhase, ctx: ExtensionContext) {
    state.phase = phase;
    if (phase === "idle") {
      ctx.ui.setStatus("orchestrator", undefined);
      ctx.ui.setWidget("orchestrator", undefined);
    } else if (phase === "complete") {
      ctx.ui.setStatus("orchestrator", "✅ Orchestrator: done");
      ctx.ui.setWidget("orchestrator", undefined);
    } else {
      ctx.ui.setStatus(
        "orchestrator",
        `${PHASE_EMOJI[phase]} Orchestrator: ${phase}`
      );
      updateWidget(ctx);
    }
  }

  function updateWidget(ctx: ExtensionContext) {
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
    ctx.ui.setWidget("orchestrator", lines);
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
    if (lastStateEntry) {
      {
        state = lastStateEntry;

        // If a previous orchestration was mid-flight, reset it
        // (stale iterating/implementing state from a prior session)
        if (state.phase === "iterating" || state.phase === "implementing" || state.phase === "reviewing") {
          state.phase = "complete";
          state.currentGateIndex = 0;
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

        // Restore coordination backend — re-validate availability
        if (state.coordinationBackend) {
          // Re-detect to catch uninstalled tools
          resetDetection();
          const freshBackend = await detectCoordinationBackend(pi, ctx.cwd);
          state.coordinationBackend = freshBackend;
          state.coordinationStrategy = selectStrategy(freshBackend);
          state.coordinationMode ??= selectMode(freshBackend);
        } else {
          // Legacy state without coordination backend — detect fresh
          const freshBackend = await detectCoordinationBackend(pi, ctx.cwd);
          state.coordinationBackend = freshBackend;
          state.coordinationStrategy = selectStrategy(freshBackend);
          state.coordinationMode ??= selectMode(freshBackend);
        }
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
      }
    }
  });

  pi.on("session_shutdown", async () => {
    if (worktreePool) {
      await worktreePool.cleanup();
      worktreePool = undefined;
      if (swarmTender) { swarmTender.stop(); swarmTender = undefined; }
    }
    orchestratorActive = false;
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
}
