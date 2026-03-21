import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type {
  OrchestratorState,
  CandidateIdea,
  Plan,
  PlanStep,
  StepResult,
  ReviewVerdict,
  OrchestratorPhase,
  ScanResult,
} from "./types.js";
import { createInitialState } from "./types.js";
import { scanRepo } from "./scan.js";
import {
  orchestratorSystemPrompt,
  formatRepoProfile,
  discoveryInstructions,
  beadCreationPrompt,
  implementerInstructions,
  reviewerInstructions,
  adversarialReviewInstructions,
  crossAgentReviewInstructions,
  polishInstructions,
  commitStrategyInstructions,
  skillExtractionInstructions,
  summaryInstructions,
  realityCheckInstructions,
  synthesisInstructions,
} from "./prompts.js";
import { runGoalRefinement, extractConstraints } from "./goal-refinement.js";
import {
  isSophiaAvailable,
  isSophiaInitialized,
  createCRFromPlan,
  analyzeParallelGroups,
  mergeWorktreeChanges,
  type PlanToCRResult,
  type ParallelAnalysis,
} from "./sophia.js";
import {
  detectCoordinationBackend,
  selectStrategy,
  resetDetection,
  type CoordinationBackend,
} from "./coordination.js";
import { WorktreePool } from "./worktree.js";
import { runDeepPlanAgents } from "./deep-plan.js";
import {
  AGENT_MAIL_URL,
  agentMailRPC as _agentMailRPC,
  ensureAgentMailProject as _ensureAgentMailProject,
  amRpcCmd,
  agentMailTaskPreamble,
  groupArtifactsAreDisjoint,
  type ExecFn,
} from "./agent-mail.js";

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
  const ORCHESTRATOR_VERSION = '0.6.0';
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

  let hasSophia = false;
  let sophiaCRResult: PlanToCRResult | undefined;
  let worktreePool: WorktreePool | undefined;
  let parallelAnalysis: ParallelAnalysis | undefined;
  /** Tracks which groups used same-dir mode (agent-mail reservations, no worktrees) */
  let sameDirGroups = new Set<number>();

  /** Check if a step belongs to a same-dir group (no worktree merge needed) */
  function isSameDirStep(stepIndex: number): boolean {
    if (!parallelAnalysis || sameDirGroups.size === 0) return false;
    for (const gi of sameDirGroups) {
      if (parallelAnalysis.groups[gi]?.includes(stepIndex)) return true;
    }
    return false;
  }
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
    if (state.plan) {
      const done = state.stepResults.length;
      const total = state.plan.steps.length;
      const passed = state.reviewVerdicts.filter((r) => r.passed).length;
      lines.push(`📊 Progress: ${done}/${total} steps (${passed} passed)`);
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
      systemPrompt: event.systemPrompt + "\n\n" + orchestratorSystemPrompt(hasSophia, state.coordinationBackend),
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

        // Restore worktree pool
        if (state.worktreePoolState) {
          worktreePool = WorktreePool.fromState(pi, state.worktreePoolState);
        }

        // Restore coordination backend — re-validate availability
        if (state.coordinationBackend) {
          // Re-detect to catch uninstalled tools
          resetDetection();
          const freshBackend = await detectCoordinationBackend(pi, ctx.cwd);
          state.coordinationBackend = freshBackend;
          state.coordinationStrategy = selectStrategy(freshBackend);
          hasSophia = freshBackend.sophia;
          state.hasSophia = hasSophia;
        } else {
          // Legacy state without coordination backend — use hasSophia flag
          hasSophia = state.hasSophia ?? false;
          if (hasSophia) {
            const stillAvailable = await isSophiaAvailable(pi, ctx.cwd);
            if (!stillAvailable) {
              hasSophia = false;
              state.hasSophia = false;
            }
          }
        }
        if (state.sophiaCRId && state.sophiaTaskIds) {
          // Try to rebuild full CR state from sophia if available
          if (hasSophia) {
            const { getCRStatus } = await import("./sophia.js");
            const crStatus = await getCRStatus(pi, ctx.cwd, state.sophiaCRId);
            if (crStatus.ok && crStatus.data) {
              sophiaCRResult = {
                cr: {
                  id: crStatus.data.id,
                  branch: crStatus.data.branch,
                  title: crStatus.data.title,
                },
                taskIds: new Map(
                  Object.entries(state.sophiaTaskIds).map(([k, v]) => [Number(k), v])
                ),
              };
            } else {
              // Fallback to persisted state
              sophiaCRResult = {
                cr: { id: state.sophiaCRId, branch: state.sophiaCRBranch ?? "", title: state.sophiaCRTitle ?? "" },
                taskIds: new Map(
                  Object.entries(state.sophiaTaskIds).map(([k, v]) => [Number(k), v])
                ),
              };
            }
          } else {
            // No sophia — use persisted values
            sophiaCRResult = {
              cr: { id: state.sophiaCRId, branch: state.sophiaCRBranch ?? "", title: state.sophiaCRTitle ?? "" },
              taskIds: new Map(
                Object.entries(state.sophiaTaskIds).map(([k, v]) => [Number(k), v])
              ),
            };
          }
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
    state.hasSophia = hasSophia;
    if (sophiaCRResult) {
      state.sophiaCRId = sophiaCRResult.cr.id;
      state.sophiaCRBranch = sophiaCRResult.cr.branch;
      state.sophiaCRTitle = sophiaCRResult.cr.title;
      state.sophiaTaskIds = Object.fromEntries(sophiaCRResult.taskIds) as Record<number, number>;
    }
    // Deep copy via JSON to create a true snapshot — prevents shared array
    // references between appended entries and the live in-memory state
    pi.appendEntry("orchestrator-state", JSON.parse(JSON.stringify(state)));
  }

  // ─── Command: /orchestrate ───────────────────────────────────
  pi.registerCommand("orchestrate", {
    description:
      "Start the repo-aware multi-agent orchestrator",
    handler: async (args, ctx) => {
      if (orchestratorActive) {
        const override = await ctx.ui.confirm(
          "Orchestrator Active",
          "An orchestration is in progress. Reset and start fresh?"
        );
        if (!override) return;
      }

      state = createInitialState();
      orchestratorActive = true;
      persistState();

      const goalArg = args?.trim();
      if (goalArg) {
        // Skip discovery, go straight with user's goal
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
      if (orchestratorActive) {
        if (worktreePool) {
          await worktreePool.cleanup();
          worktreePool = undefined;
        }
        if (swarmTender) { swarmTender.stop(); swarmTender = undefined; }
        orchestratorActive = false;
        setPhase("idle", ctx);
        persistState();
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
      if (!orchestratorActive && state.phase === "idle") {
        ctx.ui.notify("No orchestration session active.", "info");
        return;
      }
      updateWidget(ctx);
    },
  });

  // ─── Command: /memory ──────────────────────────────────────────
  pi.registerCommand("memory", {
    description: "Manage compound memory: stats, view, search, add, prune",
    handler: async (args, ctx) => {
      const { listMemoryEntries, searchMemory, pruneMemoryEntries, getMemoryStats, appendMemory } = await import("./memory.js");
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "stats";

      // ── /memory stats (default) ──
      if (subcommand === "stats" || subcommand === "") {
        const stats = getMemoryStats(ctx.cwd);
        if (stats.entryCount === 0) {
          ctx.ui.notify("📭 No memory entries yet. Use `/memory add <text>` to create one.", "info");
          return;
        }
        const sizeKB = (stats.totalBytes / 1024).toFixed(1);
        ctx.ui.notify(
          `🧠 Memory: ${stats.entryCount} entries, ${sizeKB} KB\n` +
          `📅 ${stats.oldest} → ${stats.newest}`,
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
          `${e.index}: [${e.timestamp}] ${e.content.slice(0, 60).replace(/\n/g, " ")}${e.content.length > 60 ? "…" : ""}`
        );
        const selected = await ctx.ui.select("Select a memory entry to view:", choices);
        if (selected == null) return;
        const idx = parseInt(selected, 10);
        const entry = entries.find((e) => e.index === idx);
        if (entry) {
          ctx.ui.notify(`## ${entry.timestamp}\n\n${entry.content}`, "info");
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
          .map((e) => `**[${e.timestamp}]** ${e.content.slice(0, 80).replace(/\n/g, " ")}${e.content.length > 80 ? "…" : ""}`)
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
          `${e.index}: [${e.timestamp}] ${e.content.slice(0, 60).replace(/\n/g, " ")}${e.content.length > 60 ? "…" : ""}`
        );
        const selected = await ctx.ui.select("Select entry to prune:", choices);
        if (selected == null) {
          ctx.ui.notify("Prune cancelled.", "info");
          return;
        }
        const indices = [parseInt(selected, 10)];
        const confirmed = await ctx.ui.confirm(
          "Confirm Prune",
          `Delete ${indices.length} memory entry/entries? This cannot be undone.`
        );
        if (!confirmed) {
          ctx.ui.notify("Prune cancelled.", "info");
          return;
        }
        const deleted = pruneMemoryEntries(ctx.cwd, indices);
        ctx.ui.notify(`🗑️ Pruned ${deleted} entry/entries.`, "info");
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

  // ─── Tool: orch_profile ──────────────────────────────────────
  pi.registerTool({
    name: "orch_profile",
    label: "Profile Repo",
    description:
      "Scan the current repository to collect its tech stack, structure, commits, TODOs, and key files. Returns a structured profile.",
    promptSnippet: "Profile the current repo (languages, frameworks, structure, commits, TODOs)",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      setPhase("profiling", ctx);
      ctx.ui.notify(`pi-orchestrator v${ORCHESTRATOR_VERSION}`, 'info');
      onUpdate?.({
        content: [{ type: "text", text: "Scanning repository..." }],
        details: {},
      });

      const scanResult: ScanResult = await scanRepo(pi, ctx.cwd, signal);
      const profile = scanResult.profile;
      state.scanResult = scanResult;
      state.repoProfile = profile;

      // Detect all coordination backends (beads, agent-mail, sophia)
      const coordBackend = await detectCoordinationBackend(pi, ctx.cwd);
      const coordStrategy = selectStrategy(coordBackend);
      state.coordinationBackend = coordBackend;
      state.coordinationStrategy = coordStrategy;
      hasSophia = coordBackend.sophia;
      persistState();

      setPhase("discovering", ctx);

      const formatted = formatRepoProfile(profile, scanResult);
      const scanSourceLine = scanResult.source === "ccc"
        ? "🔬 Scan: ccc"
        : `📊 Scan: built-in${scanResult.fallback ? ` (fallback from ${scanResult.fallback.from})` : ""}`;

      // Ensure AGENTS.md has agent-mail section when agent-mail is available
      if (coordBackend.agentMail) {
        const { ensureAgentMailSection } = await import("./agents-md.js");
        await ensureAgentMailSection(ctx.cwd);
        // Register project in agent-mail so sub-agents can use it
        await ensureAgentMailProject(ctx.cwd);
      }

      // Coordination backend summary
      const coordParts: string[] = [];
      if (coordBackend.beads) coordParts.push("beads");
      if (coordBackend.agentMail) coordParts.push("agent-mail");
      if (coordBackend.sophia) coordParts.push("sophia");
      const coordLine = coordParts.length > 0
        ? `🤝 Coordination: ${coordParts.join(" + ")} → strategy: **${coordStrategy}**`
        : "🤝 Coordination: bare worktrees (no beads/agent-mail/sophia detected)";

      // Read compound memory from prior orchestrations
      const { readMemory } = await import("./memory.js");
      const memory = readMemory(ctx.cwd);
      const memoryContext = memory
        ? `\n\n### Prior Context (compound memory; secondary to live codebase scan)\n${memory}`
        : "";

      const discoveryMode = await ctx.ui.select(
        "Discovery mode:",
        [
          "📋 Standard — 3-7 practical ideas",
          "🚀 Creative — think of 100, tell me your 7 best",
          "🧠 Idea Wizard — structured ideation with rubric scoring",
          "✏️  I know what I want — enter my own goal",
        ]
      );

      if (discoveryMode?.startsWith("✏️")) {
        const customGoal = await ctx.ui.input(
          "Enter your goal:",
          "e.g., Add API rate limiting with Redis"
        );
        if (!customGoal) {
          orchestratorActive = false;
          setPhase("idle", ctx);
          persistState();
          return {
            content: [{ type: "text", text: "No goal entered. Orchestration stopped." }],
            details: { profile, scanResult },
          };
        }

        // Refine the goal via LLM-generated questionnaire
        const refinement = await runGoalRefinement(customGoal, profile, pi, ctx);
        const goal = refinement.enrichedGoal;
        const constraints = refinement.skipped ? [] : extractConstraints(refinement.answers);

        // Skip discovery entirely — go straight to planning
        state.selectedGoal = goal;
        state.candidateIdeas = [];
        state.constraints = constraints;
        setPhase("creating_beads", ctx);
        persistState();

        const instructions = beadCreationPrompt(goal, formatted, constraints);

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Create beads for this goal using \`br create\` and \`br dep add\` in bash NOW.**\n\nGoal: "${goal}"\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}\n\n${formatted}${memoryContext}\n\n${instructions}`,
            },
          ],
          details: { profile, scanResult, customGoal: goal },
        };
      }

      const isCreative = discoveryMode?.startsWith("🚀");
      const isWizard = discoveryMode?.startsWith("🧠");
      const discoveryModeKey: "standard" | "wizard" | "creative" = isWizard ? "wizard" : isCreative ? "creative" : "standard";

      const modeInstructions = discoveryInstructions(profile, scanResult, discoveryModeKey);

      let discoveryPrompt: string;
      if (isWizard) {
        discoveryPrompt = `**NEXT: Call \`orch_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n🧠 Idea Wizard Mode: Use structured ideation with rubric scoring.\n\n${modeInstructions}`;
      } else if (isCreative) {
        discoveryPrompt = `**NEXT: Call \`orch_discover\` with your top 7 ideas NOW.**\n\n🚀 Creative Discovery Mode:\n\n${modeInstructions}`;
      } else {
        discoveryPrompt = `**NEXT: Call \`orch_discover\` to generate project ideas NOW.**\n\n${modeInstructions}`;
      }

      return {
        content: [
          {
            type: "text",
            text: `${discoveryPrompt}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}\n\n${formatted}${memoryContext}`,
          },
        ],
        details: { profile, scanResult, discoveryMode: discoveryModeKey },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_profile ")) +
          theme.fg("dim", "scanning repository..."),
        0, 0
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "📊 Scanning..."), 0, 0);
      const d = result.details as any;
      let text = theme.fg("success", "📊 Repository profiled");
      if (d?.scanResult?.source) {
        const sourceLabel = d.scanResult.source === "ccc" ? "ccc" : "built-in";
        text += theme.fg("dim", ` via ${sourceLabel}`);
      }
      if (d?.profile) {
        text += theme.fg("dim", ` — ${d.profile.name}`);
        text += theme.fg("dim", ` [${d.profile.languages?.join(", ")}]`);
      }
      if (expanded && d?.profile) {
        text += `\n  Frameworks: ${d.profile.frameworks?.join(", ") || "none"}`;
        text += `\n  Tests: ${d.profile.hasTests ? "yes" : "no"}`;
        text += `\n  TODOs: ${d.profile.todos?.length ?? 0}`;
      }
      return new Text(text, 0, 0);
    },
  });

  // ─── Tool: orch_discover ─────────────────────────────────────
  pi.registerTool({
    name: "orch_discover",
    label: "Discover Ideas",
    description:
      "Generate 3–7 high-leverage project ideas based on the repo profile. You must call orch_profile first. Returns ideas as structured data AND instructions for you to present them. After generating ideas, call orch_select to let the user choose.",
    promptSnippet: "Generate project ideas from the repo profile",
    parameters: Type.Object({
      ideas: Type.Array(
        Type.Object({
          id: Type.String({ description: "unique kebab-case identifier" }),
          title: Type.String({ description: "short title" }),
          description: Type.String({ description: "2-3 sentence description" }),
          category: StringEnum([
            "feature", "refactor", "docs", "dx",
            "performance", "reliability", "security", "testing",
          ] as const),
          effort: StringEnum(["low", "medium", "high"] as const),
          impact: StringEnum(["low", "medium", "high"] as const),
          rationale: Type.Optional(Type.String({ description: "why this idea beat other candidates — cite specific repo evidence" })),
          tier: Type.Optional(StringEnum(["top", "honorable"] as const)),
          sourceEvidence: Type.Optional(Type.Array(Type.String(), { description: "repo signals that prompted this idea" })),
          scores: Type.Optional(Type.Object({
            useful: Type.Number({ description: "1-5: solves a real, frequent pain" }),
            pragmatic: Type.Number({ description: "1-5: realistic to build in hours/days" }),
            accretive: Type.Number({ description: "1-5: clearly adds value beyond what exists" }),
            robust: Type.Number({ description: "1-5: handles edge cases, works reliably" }),
            ergonomic: Type.Number({ description: "1-5: reduces friction or cognitive load" }),
          })),
          risks: Type.Optional(Type.Array(Type.String(), { description: "known downsides" })),
          synergies: Type.Optional(Type.Array(Type.String(), { description: "ids of complementary ideas" })),
        }),
        { description: "3-7 project ideas based on the repo profile", minItems: 3, maxItems: 7 }
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.repoProfile) {
        throw new Error("No repo profile. Call orch_profile first.");
      }

      state.candidateIdeas = params.ideas as CandidateIdea[];
      setPhase("awaiting_selection", ctx);
      persistState();

      // Write full ideation results as a session artifact
      const topIdeas = state.candidateIdeas.filter((i) => i.tier === "top");
      const honorableIdeas = state.candidateIdeas.filter((i) => i.tier === "honorable" || !i.tier);
      const artifactLines: string[] = [
        `# Discovery Ideas — ${new Date().toISOString().slice(0, 10)}`,
        "",
      ];
      if (topIdeas.length > 0) {
        artifactLines.push("## Top Picks", "");
        for (const idea of topIdeas) {
          artifactLines.push(`### ${idea.title}`, `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`);
          artifactLines.push(`\n${idea.description}`);
          if (idea.rationale) artifactLines.push(`\n**Rationale:** ${idea.rationale}`);
          if (idea.sourceEvidence?.length) artifactLines.push(`\n**Evidence:** ${idea.sourceEvidence.join("; ")}`);
          if (idea.scores) artifactLines.push(`\n**Scores:** useful=${idea.scores.useful} pragmatic=${idea.scores.pragmatic} accretive=${idea.scores.accretive} robust=${idea.scores.robust} ergonomic=${idea.scores.ergonomic}`);
          if (idea.risks?.length) artifactLines.push(`\n**Risks:** ${idea.risks.join("; ")}`);
          if (idea.synergies?.length) artifactLines.push(`\n**Synergies:** ${idea.synergies.join(", ")}`);
          artifactLines.push("");
        }
      }
      if (honorableIdeas.length > 0) {
        artifactLines.push("## Honorable Mentions", "");
        for (const idea of honorableIdeas) {
          artifactLines.push(`### ${idea.title}`, `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`);
          artifactLines.push(`\n${idea.description}`);
          if (idea.rationale) artifactLines.push(`\n**Rationale:** ${idea.rationale}`);
          if (idea.sourceEvidence?.length) artifactLines.push(`\n**Evidence:** ${idea.sourceEvidence.join("; ")}`);
          artifactLines.push("");
        }
      }
      try {
        const artifactDir = join(tmpdir(), `pi-orchestrator-discovery`);
        mkdirSync(artifactDir, { recursive: true });
        const artifactPath = join(artifactDir, `ideas-${Date.now()}.md`);
        writeFileSync(artifactPath, artifactLines.join("\n"), "utf8");
      } catch { /* best-effort */ }

      const ideaList = state.candidateIdeas
        .map(
          (idea, i) => {
            let line = `${i + 1}. **[${idea.category}] ${idea.title}** (effort: ${idea.effort}, impact: ${idea.impact})${idea.tier === "honorable" ? " _(honorable mention)_" : ""}`;
            line += `\n   ${idea.description}`;
            if (idea.scores) {
              const s = idea.scores;
              const weighted = s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
              line += `\n   📊 **Score: ${weighted.toFixed(1)}/37.5** — useful=${s.useful} pragmatic=${s.pragmatic} accretive=${s.accretive} robust=${s.robust} ergonomic=${s.ergonomic}`;
            }
            if (idea.rationale) line += `\n   _${idea.rationale}_`;
            return line;
          }
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Call \`orch_select\` NOW to present these to the user.**\n\n---\n\nGenerated ${state.candidateIdeas.length} project ideas (${topIdeas.length} top, ${honorableIdeas.length} honorable):\n\n${ideaList}`,
          },
        ],
        details: { ideas: state.candidateIdeas },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_discover ")) +
          theme.fg("dim", `${(args as any).ideas?.length ?? "?"} ideas`),
        0, 0
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "💡 Generating ideas..."), 0, 0);
      const d = result.details as any;
      const ideas: any[] = d?.ideas ?? [];
      const topCount = ideas.filter((i: any) => i.tier === "top").length;
      const honorableCount = ideas.length - topCount;
      const tierInfo = honorableCount > 0 ? ` (${topCount} top, ${honorableCount} honorable)` : "";
      let text = theme.fg("success", `💡 ${ideas.length} ideas generated${tierInfo}`);
      if (expanded && ideas.length > 0) {
        for (const idea of ideas) {
          const scoreStr = idea.scores
            ? (() => {
                const avg = (idea.scores.useful * 2 + idea.scores.pragmatic * 2 + idea.scores.accretive * 1.5 + idea.scores.robust + idea.scores.ergonomic) / 7.5;
                const stars = "★".repeat(Math.round(avg)) + "☆".repeat(5 - Math.round(avg));
                return ` ${stars}`;
              })()
            : "";
          const tierMark = idea.tier === "honorable" ? theme.fg("dim", " (honorable)") : "";
          text += `\n  [${idea.category}] ${idea.title}${scoreStr}${tierMark}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // ─── Tool: orch_select ───────────────────────────────────────
  pi.registerTool({
    name: "orch_select",
    label: "Select Idea",
    description:
      "Present the discovered ideas to the user and let them select one (or enter a custom goal). Returns the selected goal string.",
    promptSnippet: "Present ideas to user for selection",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      if (!state.candidateIdeas || state.candidateIdeas.length === 0) {
        throw new Error("No ideas available. Call orch_discover first.");
      }

      // Group ideas by tier for display
      const topIdeas = state.candidateIdeas.filter((i) => i.tier === "top");
      const honorableIdeas = state.candidateIdeas.filter((i) => i.tier === "honorable" || !i.tier);
      const hasMixedTiers = topIdeas.length > 0 && honorableIdeas.length > 0;

      // Build display options — ideas in tier order, each with rationale subtitle
      const orderedIdeas = hasMixedTiers ? [...topIdeas, ...honorableIdeas] : state.candidateIdeas;
      const options: string[] = [];

      for (let i = 0; i < orderedIdeas.length; i++) {
        const idea = orderedIdeas[i];
        const rationaleSnippet = idea.rationale
          ? `\n     → ${idea.rationale.length > 120 ? idea.rationale.slice(0, 117) + "..." : idea.rationale}`
          : "";
        // Add tier header as a visual separator
        if (hasMixedTiers && i === 0) {
          options.push(`── Top Picks ──`);
        }
        if (hasMixedTiers && i === topIdeas.length) {
          options.push(`── Also Worth Considering ──`);
        }
        options.push(
          `[${idea.category}] ${idea.title} (effort: ${idea.effort}, impact: ${idea.impact})${rationaleSnippet}`
        );
      }
      options.push("✏️  Enter a custom goal");

      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(
          "🎯 Select a project idea to implement:",
          options
        );
      } catch (err) {
        ctx.ui.notify(`Select failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        orchestratorActive = false;
        setPhase("idle", ctx);
        persistState();
        return {
          content: [{ type: "text", text: `Selection dialog failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { selected: false, error: true },
        };
      }

      if (choice === undefined) {
        orchestratorActive = false;
        setPhase("idle", ctx);
        persistState();
        return {
          content: [
            { type: "text", text: "User cancelled selection. Orchestration stopped." },
          ],
          details: { selected: false },
        };
      }

      let goal: string;
      let refinementUsed = false;
      if (choice === "✏️  Enter a custom goal") {
        const custom = await ctx.ui.input(
          "Enter your goal:",
          "e.g., Add API rate limiting with Redis"
        );
        if (!custom) {
          orchestratorActive = false;
          setPhase("idle", ctx);
          persistState();
          return {
            content: [
              { type: "text", text: "No goal entered. Orchestration stopped." },
            ],
            details: { selected: false },
          };
        }

        // Refine the goal via LLM-generated questionnaire
        const refinement = await runGoalRefinement(custom, state.repoProfile!, pi, ctx);
        goal = refinement.enrichedGoal;
        refinementUsed = !refinement.skipped;

        if (refinementUsed) {
          state.constraints = extractConstraints(refinement.answers);
        }
      } else if (choice.startsWith("──")) {
        // User selected a tier header — treat as no selection, re-prompt would be ideal
        // but for simplicity, treat as cancelled
        orchestratorActive = false;
        setPhase("idle", ctx);
        persistState();
        return {
          content: [{ type: "text", text: "No idea selected. Orchestration stopped." }],
          details: { selected: false },
        };
      } else {
        // Map selected option back to the idea in orderedIdeas
        const choiceIndex = options.indexOf(choice);
        // Count how many tier headers precede this choice
        const headersBefore = options.slice(0, choiceIndex).filter((o) => o.startsWith("──")).length;
        const ideaIndex = choiceIndex - headersBefore;
        const idea = orderedIdeas[ideaIndex];
        goal = `${idea.title}: ${idea.description}`;

        // Offer to refine the system-provided idea
        const refineChoice = await ctx.ui.select(
          `🎯 Selected: ${idea.title}\n\nWould you like to refine this idea?`,
          [
            "▶️  Continue — use as-is",
            "🎯 Refine — answer clarifying questions to sharpen the goal",
          ]
        );

        if (refineChoice?.startsWith("🎯")) {
          const refinement = await runGoalRefinement(goal, state.repoProfile!, pi, ctx);
          goal = refinement.enrichedGoal;
          refinementUsed = !refinement.skipped;

          if (refinementUsed) {
            state.constraints = extractConstraints(refinement.answers);
          }
        }
      }

      state.selectedGoal = goal;
      setPhase("planning", ctx);
      persistState();

      // Ask for constraints only if refinement didn't already capture them
      if (!refinementUsed) {
        const constraintInput = await ctx.ui.input(
          "Any constraints? (comma-separated, or leave empty)",
          "e.g., no new dependencies, keep backward compat"
        );
        state.constraints = constraintInput
          ? constraintInput.split(",").map((c) => c.trim()).filter(Boolean)
          : [];
      }
      persistState();

      const repoContext = state.repoProfile ? formatRepoProfile(state.repoProfile) : "";
      const instructions = beadCreationPrompt(goal, repoContext, state.constraints);

      setPhase("creating_beads", ctx);

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Create beads for this goal using \`br create\` and \`br dep add\` in bash NOW.**\n\nGoal: "${goal}"${state.constraints.length > 0 ? `\nConstraints: ${state.constraints.join(", ")}` : ""}\n\n---\n\n${instructions}`,
          },
        ],
        details: { selected: true, goal, constraints: state.constraints },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_select ")) +
          theme.fg("dim", "awaiting user selection..."),
        0, 0
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d?.selected) return new Text(theme.fg("warning", "🚫 Selection cancelled"), 0, 0);
      return new Text(
        theme.fg("success", `🎯 Selected: `) +
          theme.fg("accent", d.goal?.slice(0, 80) ?? ""),
        0, 0
      );
    },
  });

  // ─── Tool: orch_approve_beads ─────────────────────────────────
  // Replaces orch_plan. Reads beads from br CLI, shows approval UI,
  // offers Phase 6 refinement, and launches execution on approval.
  pi.registerTool({
    name: "orch_approve_beads",
    label: "Approve Beads",
    description:
      "Read beads created via br CLI, present them for user approval. Offers refinement passes (Phase 6) before execution. Call after the LLM has created beads with br create.",
    promptSnippet: "Present beads for user approval before execution",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!state.selectedGoal) {
        throw new Error("No goal selected. Call orch_select first.");
      }

      const { readBeads, readyBeads, extractArtifacts, validateBeads, syncBeads, updateBeadStatus } = await import("./beads.js");
      const { beadRefinementPrompt } = await import("./prompts.js");

      // Read all beads from br CLI
      let beads = await readBeads(pi, ctx.cwd);
      // Filter to open beads only (ignore closed beads from prior sessions)
      beads = beads.filter((b) => b.status === "open" || b.status === "in_progress");

      if (beads.length === 0) {
        return {
          content: [{ type: "text", text: "No open beads found. Create beads with `br create` first, then call `orch_approve_beads`." }],
          details: { approved: false },
        };
      }

      // Store bead IDs in state
      state.activeBeadIds = beads.map((b) => b.id);
      setPhase("awaiting_bead_approval", ctx);
      persistState();

      // Validate — check for cycles
      const validation = await validateBeads(pi, ctx.cwd);

      // Format bead list for display
      const beadListText = beads.map((b) => {
        const files = extractArtifacts(b);
        return `**${b.id}: ${b.title}**\n   ${b.description.split("\n").slice(0, 3).join("\n   ")}\n   📄 ${files.length > 0 ? files.join(", ") : "(no files specified)"}`;
      }).join("\n\n");

      const validationWarning = !validation.ok
        ? `\n\n⚠️ Validation issues: ${validation.cycles ? "dependency cycles detected" : ""} ${validation.orphaned.length > 0 ? `orphaned: ${validation.orphaned.join(", ")}` : ""}`
        : "";

      // Interactive approval/refinement loop
      let polishing = true;
      while (polishing) {
        const choice = await ctx.ui.select(
          `${beads.length} beads ready for: ${state.selectedGoal}\n\n${beadListText}${validationWarning}`,
          [
            "▶️  Start implementing",
            "🔍 Refine — send beads back for LLM review (Phase 6)",
            "❌ Reject",
          ]
        );

        if (choice?.startsWith("🔍")) {
          setPhase("refining_beads", ctx);
          persistState();
          return {
            content: [
              {
                type: "text",
                text: `**NEXT: Review and refine the beads using br CLI, then call \`orch_approve_beads\` again.**\n\n${beadRefinementPrompt()}\n\n---\n\nCurrent beads:\n\n${beadListText}`,
              },
            ],
            details: { approved: false, refining: true, beadCount: beads.length },
          };
        }

        if (!choice || choice.startsWith("❌")) {
          orchestratorActive = false;
          setPhase("idle", ctx);
          persistState();
          return {
            content: [{ type: "text", text: "Beads rejected. Orchestration stopped." }],
            details: { approved: false },
          };
        }

        // "▶️ Start implementing" — break out of loop
        polishing = false;
      }

      // ── Approved — launch execution ──────────────────────────
      // Reset bead-centric implementation state
      state.beadResults = {};
      state.beadReviews = {};
      state.beadReviewPassCounts = {};
      state.beadHitMeTriggered = {};
      state.beadHitMeCompleted = {};
      state.iterationRound = 0;
      state.currentGateIndex = 0;
      setPhase("implementing", ctx);
      await syncBeads(pi, ctx.cwd);
      persistState();

      // Get first batch of ready beads (unblocked by dependencies)
      const ready = await readyBeads(pi, ctx.cwd);
      if (ready.length === 0) {
        return {
          content: [{ type: "text", text: "⚠️ No ready beads (all blocked by dependencies). Check `br dep cycles` and `br ready`." }],
          details: { approved: true, beadCount: beads.length, readyCount: 0 },
        };
      }

      // Determine if we can run in parallel
      const hasParallel = ready.length > 1;

      if (hasParallel) {
        // Check artifact overlap for same-dir vs worktree decision
        const allArtifactSets = ready.map((b) => new Set(extractArtifacts(b)));
        const allDisjoint = allArtifactSets.every((setA, i) =>
          allArtifactSets.every((setB, j) =>
            i === j || [...setA].every((f) => !setB.has(f))
          )
        );
        const canSameDir = allDisjoint && state.coordinationBackend?.agentMail;

        // Build parallel agent configs
        const agentConfigs = ready.map((bead) => {
          const artifacts = extractArtifacts(bead);
          const agentName = `bead-${bead.id}`;
          const preamble = state.coordinationBackend?.agentMail
            ? agentMailTaskPreamble(ctx.cwd, agentName, bead.title, artifacts, bead.id)
            : "";
          return {
            name: agentName,
            task: `${preamble}You are implementing bead ${bead.id}.\n\n## ${bead.title}\n\n${bead.description}\n\n⚠️ SCOPE CONSTRAINT: Only modify files listed in the bead. If additional files need changes, note them in your summary but DO NOT modify them.\n\n${canSameDir ? "🤝 **Same-dir mode**: Other agents are working in this directory. Your file reservations protect your files.\n\n" : ""}Implement the bead. When done, do a fresh-eyes review of all changes. Then COMMIT:\n\`\`\`bash\ngit add ${artifacts.map(f => '"' + f + '"').join(' ')} && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\n\`\`\`\n\nSummarize what you did and what the fresh-eyes review found.\n\ncd ${ctx.cwd}`,
          };
        });

        // Mark all as in_progress
        for (const bead of ready) {
          await updateBeadStatus(pi, ctx.cwd, bead.id, "in_progress");
        }
        await syncBeads(pi, ctx.cwd);

        state.currentBeadId = ready[0].id;
        persistState();

        const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
        const modeLabel = canSameDir
          ? "🤝 Same-dir mode — agents coordinate via agent-mail file reservations."
          : "🔄 Parallel execution via sub-agents.";

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`parallel_subagents\` NOW to launch ${ready.length} parallel beads.**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each bead with the sub-agent's summary.\n\n---\n\nBeads approved! ${beads.length} total, ${ready.length} ready now.\n\n${modeLabel}`,
            },
          ],
          details: { approved: true, beadCount: beads.length, readyCount: ready.length, parallel: true },
        };
      }

      // Sequential: start with first ready bead
      const firstBead = ready[0];
      await updateBeadStatus(pi, ctx.cwd, firstBead.id, "in_progress");
      await syncBeads(pi, ctx.cwd);
      state.currentBeadId = firstBead.id;
      persistState();

      const implInstr = implementerInstructions(
        firstBead,
        state.repoProfile!,
        Object.values(state.beadResults ?? {})
      );

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Implement bead ${firstBead.id} NOW, then call \`orch_review\` when done.**\n\nBeads approved! ${beads.length} total, starting with ${firstBead.id}.\n\n---\n\n${implInstr}`,
          },
        ],
        details: { approved: true, beadCount: beads.length, readyCount: ready.length, firstBead: firstBead.id },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_approve_beads ")) +
          theme.fg("dim", "reviewing beads..."),
        0, 0
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d?.approved) return new Text(theme.fg("warning", "📝 Beads rejected"), 0, 0);
      let text = theme.fg("success", `📝 Beads approved — ${d.beadCount} beads, ${d.readyCount} ready`);
      if (d.parallel) text += theme.fg("dim", " (parallel)");
      return new Text(text, 0, 0);
    },
  });

  // ─── Guided Gates (post-implementation review sequence) ──────
  // Extracted so both "all steps done" and sentinel re-entry use the same code.
  // This runs the sequential gate flow: self-review → peer review → test → commit → ship.
  async function runGuidedGates(
    st: OrchestratorState,
    ctx: ExtensionContext,
    extraInfo: string
  ): Promise<{ content: { type: "text"; text: string }[]; details: any }> {
    const allArtifacts = [...new Set(st.plan!.steps.flatMap((s) => s.artifacts))];
    const polish = polishInstructions(st.plan!.goal, allArtifacts);
    const summaryText = summaryInstructions(st.plan!.goal, st.plan!.steps, st.stepResults);

    st.iterationRound = (st.iterationRound ?? 0) + 1;
    const round = st.iterationRound;
    persistState();

    // Sequential guided flow — resume from saved gate index
    const gates = [
      { emoji: "🔍", label: "Fresh self-review", desc: "read all new code with fresh eyes" },
      { emoji: "👥", label: "Peer review", desc: "parallel agents review each other's work" },
      { emoji: "🧪", label: "Test coverage", desc: "check unit tests + e2e, create tasks for gaps" },
      { emoji: "📦", label: "Commit", desc: "logical groupings with detailed messages" },
      { emoji: "🚀", label: "Ship it", desc: "commit, tag, release, deploy, monitor CI" },
    ];

    // Agent-mail threading: if agentMail is active, sub-agents (peer review / hit-me) bootstrap
    // their own sessions via agentMailTaskPreamble() injected into their tasks.
    // The orchestrator itself doesn't have an agent-mail identity — it's the spawner,
    // not a participant. Sub-agents handle their own inbox checking via macro_start_session.
    // Thread IDs are gate-scoped (e.g. "peer-review-r1", "hit-me-r1").
    if (st.coordinationBackend?.agentMail) {
      // Agent-mail threading is active — sub-agents will coordinate via thread messages
    }

    let chosen: string | undefined;
    const startGate = st.currentGateIndex ?? 0;
    for (let i = startGate; i < gates.length; i++) {
      const gate = gates[i];
      const pick = await ctx.ui.select(
        `Round ${round} — ${gate.emoji} ${gate.label}`,
        [
          `${gate.emoji} ${gate.label} — ${gate.desc}`,
          "⏭️  Skip",
          "✅ Done — finish orchestration",
        ]
      );
      if (!pick || pick.startsWith("✅")) {
        chosen = "✅";
        break;
      }
      if (pick.startsWith("⏭️")) {
        st.currentGateIndex = i + 1;
        persistState();
        continue;
      }
      st.currentGateIndex = i + 1;
      persistState();
      chosen = pick;
      break;
    }

    if (!chosen) chosen = "✅";

    const stepCount = st.plan!.steps.length;
    const callbackHint = `\n\nAfter completing this, call \`orch_review\` with stepIndex ${stepCount + 1} and verdict "pass" for the next gate.`;

    if (chosen.startsWith("✅")) {
      orchestratorActive = false;
      st.currentGateIndex = 0;
      setPhase("complete", ctx);
      persistState();
      return {
        content: [
          { type: "text", text: `${summaryText}${extraInfo}\n\nOrchestration complete after ${round} round(s).\n\n---\n## 🧠 Compound Memory\n\nDistill the key decisions, gotchas, patterns, and architectural choices from this orchestration. What would a future agent need to know about this repo? Write 3-7 bullet points and append them to \`.pi-orchestrator/memory.md\` using the write or bash tool. Format as a timestamped markdown section.` },
        ],
        details: { complete: true, rounds: round },
      };
    }

    if (chosen.startsWith("🔍")) {
      return {
        content: [
          {
            type: "text",
            text: `## 🔍 Fresh Self-Review — Round ${round}\n\nCarefully read over ALL the new code you just wrote and any existing code you modified with "fresh eyes" looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Carefully fix anything you uncover.\n\nFiles changed:\n${allArtifacts.map((a) => `- ${a}`).join("\n")}${callbackHint}`,
          },
        ],
        details: { iterating: true, round, selfReview: true },
      };
    }

    if (chosen.startsWith("👥")) {
      const peerThreadId = `peer-review-r${round}`;
      const peerArtifacts = allArtifacts;
      const peerPreamble = (name: string) =>
        st.coordinationBackend?.agentMail
          ? agentMailTaskPreamble(ctx.cwd, name, `Peer review round ${round}`, peerArtifacts, peerThreadId)
          : "";
      const peerAgents = [
        {
          name: `peer-bugs-r${round}`,
          task: `${peerPreamble(`peer-bugs-r${round}`)}Peer reviewer (round ${round}). Review code written by your fellow agents. Check for issues, bugs, errors, inefficiencies, security problems, reliability issues. Diagnose root causes using first-principle analysis. Don't restrict to latest commits — cast a wider net and go super deep!\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-polish-r${round}`,
          task: `${peerPreamble(`peer-polish-r${round}`)}Polish reviewer (round ${round}). De-slopify the code. Remove AI slop, improve clarity, make it agent-friendly.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-ergonomics-r${round}`,
          task: `${peerPreamble(`peer-ergonomics-r${round}`)}Ergonomics reviewer (round ${round}). If you came in fresh with zero context, would you understand this code? Fix anything confusing.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-reality-r${round}`,
          task: `${peerPreamble(`peer-reality-r${round}`)}Reality checker (round ${round}).\n\n${realityCheckInstructions(st.plan!.goal, st.plan!.steps, st.stepResults)}\n\nDo NOT edit code. Just report findings.\n\ncd ${ctx.cwd}`,
        },
      ];
      const peerJson = JSON.stringify({ agents: peerAgents }, null, 2);
      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Call \`parallel_subagents\` NOW with the config below.**\n\n## 👥 Peer Review — Round ${round}\n\n\`\`\`json\n${peerJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` with stepIndex ${stepCount + 1} and verdict "pass".`,
          },
        ],
        details: { iterating: true, round, peerReview: true },
      };
    }

    if (chosen.startsWith("🧪")) {
      return {
        content: [
          {
            type: "text",
            text: `## 🧪 Test Coverage Check — Round ${round}\n\nDo we have full unit test coverage without using mocks or fake stuff? What about complete e2e integration test scripts with great, detailed logging?\n\nReview the current state:\n- Goal: ${st.plan!.goal}\n- Files: ${allArtifacts.join(", ")}\n\nIf test coverage is incomplete, create a comprehensive and granular set of tasks for all missing tests, with subtasks and dependency structure, with detailed comments so the whole thing is totally self-contained and self-documenting.\n\nFor unit tests: test real behavior, not mocked interfaces. For e2e: full integration scripts with detailed logging at each stage.${callbackHint}`,
          },
        ],
        details: { iterating: true, round, testCoverage: true },
      };
    }

    if (chosen.startsWith("📦")) {
      return {
        content: [
          {
            type: "text",
            text: `## 📦 Commit — Round ${round}\n\nBased on your knowledge of the project, commit all changed files now in a series of logically connected groupings with super detailed commit messages for each. Take your time to do it right.\n\nRules:\n- Group by logical change, NOT by file\n- Each commit should be independently understandable\n- Use conventional commit format: type(scope): description\n- First line ≤ 72 chars, then blank line, then detailed body\n- Body explains WHY, not just WHAT\n- Don't edit the code at all\n- Don't commit obviously ephemeral files\n- Push after committing${callbackHint}`,
          },
        ],
        details: { iterating: true, round, committing: true },
      };
    }

    if (chosen.startsWith("🚀")) {
      return {
        content: [
          {
            type: "text",
            text: `## 🚀 Ship It — Round ${round}\n\nDo all the GitHub stuff:\n1. **Commit** all remaining changes in logical groupings with detailed messages\n2. **Push** to remote\n3. **Create tag** with semantic version bump (based on changes: feat=minor, fix=patch)\n4. **Create GitHub release** with changelog from commits since last tag\n5. **Monitor CI** — check GitHub Actions status, wait for green\n6. **Compute checksums** if there are distributable artifacts\n7. **Bump version** in package.json if applicable\n\nDo each step and report status. If any step fails, stop and report why.${callbackHint}`,
          },
        ],
        details: { iterating: true, round, shipping: true },
      };
    }

    // "🔥 Hit me" — spawn 4 parallel review agents
    const hitMeThreadId = `hit-me-r${round}`;
    const hitMeArtifacts = allArtifacts;
    const hitMePreamble = (name: string) =>
      st.coordinationBackend?.agentMail
        ? agentMailTaskPreamble(ctx.cwd, name, `Hit me review round ${round}`, hitMeArtifacts, hitMeThreadId)
        : "";
    const agentConfigs = [
      {
        name: `fresh-eyes-r${round}`,
        task: `${hitMePreamble(`fresh-eyes-r${round}`)}Fresh-eyes reviewer round ${round}. NEVER seen this code.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `polish-r${round}`,
        task: `${hitMePreamble(`polish-r${round}`)}Polish/de-slopify reviewer round ${round}.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nMake targeted edits directly — don't just report.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `ergonomics-r${round}`,
        task: `${hitMePreamble(`ergonomics-r${round}`)}Agent-ergonomics reviewer round ${round}. Make this maximally intuitive for coding agents.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything that fails that test.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `reality-check-r${round}`,
        task: `${hitMePreamble(`reality-check-r${round}`)}Reality checker round ${round}.\n\n${realityCheckInstructions(st.plan!.goal, st.plan!.steps, st.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
      },
    ];

    const gateJson = JSON.stringify({ agents: agentConfigs }, null, 2);
    return {
      content: [
        {
          type: "text",
          text: `**NEXT: Call \`parallel_subagents\` NOW with the config below.**\n\n## 🔥 Hit me — Round ${round}\n\n\`\`\`json\n${gateJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` again.${callbackHint}`,
        },
      ],
      details: { iterating: true, round, agents: agentConfigs.map((a) => a.name) },
    };
  }

  // ─── Tool: orch_memory ──────────────────────────────────────
  pi.registerTool({
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
      const { listMemoryEntries, searchMemory, getMemoryStats } = await import("./memory.js");

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

  // ─── Tool: orch_review ───────────────────────────────────────
  pi.registerTool({
    name: "orch_review",
    label: "Review Step",
    description:
      "Submit your implementation work for review. Provide a summary of what you changed. The tool evaluates against acceptance criteria and returns pass/fail.",
    promptSnippet: "Submit implementation for review against acceptance criteria",
    parameters: Type.Object({
      stepIndex: Type.Number({ description: "which step you implemented (1-based)" }),
      summary: Type.String({ description: "brief summary of changes made" }),
      verdict: StringEnum(["pass", "fail"] as const, {
        description: "your self-assessment: did you meet all acceptance criteria?",
      }),
      feedback: Type.String({
        description: "explanation of what was done and how it meets (or doesn't meet) criteria",
      }),
      revisionInstructions: Type.Optional(
        Type.String({
          description: "if verdict is fail, specific instructions for fixing",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.plan) {
        throw new Error("No plan exists. Call orch_plan first.");
      }

      const step = state.plan.steps.find((s) => s.index === params.stepIndex);

      // Sentinel: orch_review with stepIndex = steps.length + 1 while iterating = show next gate
      // Only accept exactly steps.length + 1 to prevent manipulation via arbitrary high values
      if (state.phase === "iterating" && params.stepIndex === state.plan.steps.length + 1) {
        return await runGuidedGates(state, ctx, "");
      }

      if (!step) {
        throw new Error(`Step ${params.stepIndex} not found in plan (valid range: 1-${state.plan.steps.length}).`);
      }

      // Guard: reject re-review of already-completed steps (prevents re-triggering merge/review flow)
      const alreadyCompleted = state.stepResults.find(
        (r) => r.stepIndex === params.stepIndex && r.status === "success"
      );
      if (alreadyCompleted && params.verdict === "pass") {
        return {
          content: [
            { type: "text", text: `Step ${params.stepIndex} already completed. Move to the next step or call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} for guided gates.` },
          ],
          details: { review: { stepIndex: params.stepIndex, passed: true }, alreadyDone: true },
        };
      }

      // Record the step result
      const stepResult: StepResult = {
        stepIndex: params.stepIndex,
        status: params.verdict === "pass" ? "success" : "partial",
        summary: params.summary,
      };

      // Update or add
      const existingIdx = state.stepResults.findIndex(
        (r) => r.stepIndex === params.stepIndex
      );
      if (existingIdx >= 0) {
        state.stepResults[existingIdx] = stepResult;
      } else {
        state.stepResults.push(stepResult);
      }

      const review: ReviewVerdict = {
        stepIndex: params.stepIndex,
        passed: params.verdict === "pass",
        feedback: params.feedback,
        revisionInstructions: params.revisionInstructions,
      };

      // Always push (don't overwrite) so we can count passes per step
      state.reviewVerdicts.push(review);

      persistState();

      if (params.verdict === "pass") {
        // Update bead status to closed if beads coordination is active
        const passBeadId = state.beadIds?.[params.stepIndex];
        if (passBeadId) {
          const { updateBeadStatus, syncBeads } = await import("./beads.js");
          await updateBeadStatus(pi, ctx.cwd, passBeadId, "closed");
          await syncBeads(pi, ctx.cwd);
        }

        // Checkpoint via sophia if available
        if (hasSophia && sophiaCRResult) {
          const taskId = sophiaCRResult.taskIds.get(params.stepIndex);
          if (taskId) {
            const { checkpointTask } = await import("./sophia.js");
            const cpResult = await checkpointTask(
              pi,
              ctx.cwd,
              sophiaCRResult.cr.id,
              taskId
            );
            if (!cpResult.ok) {
              ctx.ui.notify(
                `⚠️ Sophia checkpoint failed: ${cpResult.error}`,
                "warning"
              );
            }
          }
        }

        // Merge worktree changes back if this step used a worktree
        // (same-dir steps commit directly to the main branch — no merge needed)
        if (worktreePool && !isSameDirStep(params.stepIndex)) {
          const wtBranch = worktreePool.getBranch(params.stepIndex);
          const wtPath = worktreePool.getPath(params.stepIndex);
          if (wtBranch) {
            // Auto-commit any uncommitted changes (fallback for sub-agents that forgot)
            if (wtPath) {
              const { autoCommitWorktree } = await import("./worktree.js");
              const acResult = await autoCommitWorktree(
                pi, wtPath, `auto-commit step ${params.stepIndex}: ${step.description.slice(0, 60)}`
              );
              if (acResult.ok && acResult.data) {
                ctx.ui.notify(`📝 Auto-committed uncommitted changes in step ${params.stepIndex} worktree`, "info");
              }
            }
            const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 3000, cwd: ctx.cwd });
            const targetBranch = branchResult.stdout.trim();

            // PRE-MERGE SCOPE GATE: revert any out-of-scope files before merging
            // Uses `git show` to get the original file content from the base branch,
            // which works correctly in worktrees on different branches.
            if (wtPath) {
              const diffResult = await pi.exec("git", ["diff", "--name-only", targetBranch], { timeout: 5000, cwd: wtPath });
              if (diffResult.stdout.trim()) {
                const changedFiles = diffResult.stdout.trim().split("\n");
                const allowedFiles = new Set(step.artifacts);
                const outOfScope = changedFiles.filter(f => !allowedFiles.has(f));
                if (outOfScope.length > 0) {
                  ctx.ui.notify(`⚠️ Step ${params.stepIndex} touched out-of-scope files: ${outOfScope.join(", ")} — reverting`, "warning");
                  // Restore each out-of-scope file to its state on the target branch
                  for (const file of outOfScope) {
                    try {
                      const showResult = await pi.exec("git", ["show", `${targetBranch}:${file}`], { timeout: 5000, cwd: wtPath });
                      if (showResult.code === 0) {
                        // File exists on target branch — restore it
                        const { writeFileSync } = await import("fs");
                        const { join } = await import("path");
                        writeFileSync(join(wtPath, file), showResult.stdout);
                      } else {
                        // File doesn't exist on target branch — remove it
                        await pi.exec("git", ["rm", "-f", file], { timeout: 5000, cwd: wtPath });
                      }
                    } catch {
                      ctx.ui.notify(`⚠️ Could not revert out-of-scope file: ${file}`, "warning");
                    }
                  }
                  // Stage reverted files and amend the last commit
                  await pi.exec("git", ["add", ...outOfScope], { timeout: 5000, cwd: wtPath });
                  const hasChanges = await pi.exec("git", ["diff", "--cached", "--quiet"], { timeout: 5000, cwd: wtPath });
                  if (hasChanges.code !== 0) {
                    await pi.exec("git", ["commit", "--amend", "--no-edit"], { timeout: 5000, cwd: wtPath });
                  }
                }
              }
            }

            const mergeResult = await mergeWorktreeChanges(
              pi, ctx.cwd, wtBranch, targetBranch, step.description
            );
            if (!mergeResult.ok) {
              if (mergeResult.conflict) {
                ctx.ui.notify(
                  `⚠️ Merge conflict in step ${params.stepIndex}: ${mergeResult.conflictFiles?.join(", ")}`,
                  "warning"
                );
              } else {
                ctx.ui.notify(`⚠️ Worktree merge failed: ${mergeResult.error}`, "warning");
              }
            }
            // Release the worktree
            await worktreePool.release(params.stepIndex);
          }
        }

        // Track review passes per step using dedicated counter
        const prevPassCount = state.reviewPassCounts[params.stepIndex] ?? 0;
        state.reviewPassCounts[params.stepIndex] = prevPassCount + 1;
        persistState();

        setPhase("reviewing", ctx);

        // Hit-me flow uses two flags:
        // - hitMeTriggered: set when user picks "🔥 Hit me" and agents are spawned
        // - hitMeCompleted: set by the orchestrator ONLY after review agents return results
        //
        // An agent calling orch_review while hitMeTriggered=true but hitMeCompleted=false
        // means it's trying to bypass — we block it and re-present the spawn instruction.
        const hitMeWasTriggered = state.hitMeTriggered?.[params.stepIndex] ?? false;
        const hitMeWasCompleted = state.hitMeCompleted?.[params.stepIndex] ?? false;
        const allArtifactsForStep = step.artifacts;
        let hitMeChoice: string | undefined;

        if (!hitMeWasTriggered) {
          // No hit-me agents have run yet — user decides
          hitMeChoice = await ctx.ui.select(
            `✅ Step ${params.stepIndex} passed self-review.`,
            [
              "🔥 Hit me — spawn parallel review agents for this step",
              "✅ Looks good — move on",
            ]
          );
        } else if (!hitMeWasCompleted) {
          // Hit-me was triggered but agents haven't completed — bypass attempt
          ctx.ui.notify(`⚠️ Review agents haven't completed yet. Re-presenting spawn instruction.`, "warning");
          // Don't decrement counters — just re-present the spawn instruction
          const round = Math.max(0, prevPassCount - 1);
          const rePresThreadId = state.beadIds?.[params.stepIndex] ?? `step-${params.stepIndex}`;
          const rePresPreamble = (name: string) =>
            state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, name, step.description, allArtifactsForStep, rePresThreadId)
              : "";
          const agentConfigs = [
            {
              name: `fresh-eyes-s${params.stepIndex}-r${round}`,
              task: `${rePresPreamble(`fresh-eyes-s${params.stepIndex}-r${round}`)}Fresh-eyes reviewer for step ${params.stepIndex} (round ${round}). NEVER seen this code.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-s${params.stepIndex}-r${round}`,
              task: `${rePresPreamble(`polish-s${params.stepIndex}-r${round}`)}Polish reviewer for step ${params.stepIndex} (round ${round}). De-slopify.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-s${params.stepIndex}-r${round}`,
              task: `${rePresPreamble(`ergonomics-s${params.stepIndex}-r${round}`)}Ergonomics reviewer for step ${params.stepIndex} (round ${round}).\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-s${params.stepIndex}-r${round}`,
              task: `${rePresPreamble(`reality-check-s${params.stepIndex}-r${round}`)}Reality checker for step ${params.stepIndex} (round ${round}).\n\n${realityCheckInstructions(state.plan!.goal, state.plan!.steps, state.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
            },
          ];
          const stepReviewJson = JSON.stringify({ agents: agentConfigs }, null, 2);
          return {
            content: [
              {
                type: "text",
                text: `**Review agents must complete before advancing. Call \`parallel_subagents\` NOW with the config below.**\n\n## 🔥 Hit me — Step ${params.stepIndex}, Round ${round} (re-presented)\n\n\`\`\`json\n${stepReviewJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` again for step ${params.stepIndex} with what was fixed.`,
              },
            ],
            details: { review, hitMe: true, round, step: params.stepIndex, rePresented: true },
          };
        } else {
          // Hit-me triggered AND completed — legit review round, auto-advance
          hitMeChoice = "✅";
          state.hitMeTriggered[params.stepIndex] = false;
          state.hitMeCompleted[params.stepIndex] = false;
          persistState();
          ctx.ui.notify(`✅ Step ${params.stepIndex} passed review (round ${prevPassCount}).`, "info");
        }

        if (hitMeChoice?.startsWith("🔥")) {
          // Mark that hit-me was triggered
          if (!state.hitMeTriggered) state.hitMeTriggered = {};
          if (!state.hitMeCompleted) state.hitMeCompleted = {};
          state.hitMeTriggered[params.stepIndex] = true;
          state.hitMeCompleted[params.stepIndex] = false;
          persistState();

          const round = prevPassCount;
          const hitMeStepThreadId = state.beadIds?.[params.stepIndex] ?? `step-${params.stepIndex}`;
          const hitMeStepPreamble = (name: string) =>
            state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, name, step.description, allArtifactsForStep, hitMeStepThreadId)
              : "";
          const agentConfigs = [
            {
              name: `fresh-eyes-s${params.stepIndex}-r${round}`,
              task: `${hitMeStepPreamble(`fresh-eyes-s${params.stepIndex}-r${round}`)}Fresh-eyes reviewer for step ${params.stepIndex} (round ${round}). NEVER seen this code.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-s${params.stepIndex}-r${round}`,
              task: `${hitMeStepPreamble(`polish-s${params.stepIndex}-r${round}`)}Polish reviewer for step ${params.stepIndex} (round ${round}). De-slopify.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-s${params.stepIndex}-r${round}`,
              task: `${hitMeStepPreamble(`ergonomics-s${params.stepIndex}-r${round}`)}Ergonomics reviewer for step ${params.stepIndex} (round ${round}).\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-s${params.stepIndex}-r${round}`,
              task: `${hitMeStepPreamble(`reality-check-s${params.stepIndex}-r${round}`)}Reality checker for step ${params.stepIndex} (round ${round}).\n\n${realityCheckInstructions(state.plan!.goal, state.plan!.steps, state.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
            },
          ];

          // Run review agents inline — wait for completion before returning
          // This prevents the LLM from bypassing by calling orch_review before agents finish
          const hitMeResults = await runHitMeAgents(agentConfigs, ctx.cwd, ctx);

          // Mark completion — only the orchestrator can set this flag
          state.hitMeCompleted[params.stepIndex] = true;
          persistState();

          const stepReviewJson = JSON.stringify({ agents: agentConfigs }, null, 2);

          return {
            content: [
              {
                type: "text",
                text: `## 🔥 Hit me — Step ${params.stepIndex}, Round ${round}\n\n${hitMeResults.text}\n\n${hitMeResults.diff ? `### Diff\n\`\`\`diff\n${hitMeResults.diff}\n\`\`\`\n\n` : ""}After reviewing the findings above, call \`orch_review\` again for step ${params.stepIndex} with what was fixed.`,
              },
            ],
            details: { review, hitMe: true, round, step: params.stepIndex },
          };
        }

        // User said "looks good" — figure out what to do next.
        // Key scenarios:
        // A) Parallel group: other steps in the same group may still need review
        // B) Next group: if current group is done, launch the next parallel group
        // C) Sequential: simple advance to next step
        // D) All done: enter guided gates

        // Find all steps that still need review (no success result yet)
        const unreviewedSteps = state.plan.steps.filter(
          (s) => !state.stepResults.find((r) => r.stepIndex === s.index && r.status === "success")
        );

        if (unreviewedSteps.length > 0) {
          // Check if remaining steps can be skipped (work already done)
          if (unreviewedSteps.length > 1) {
            const skipChoice = await ctx.ui.select(
              `${unreviewedSteps.length} steps remaining.`,
              [
                `▶️  Continue`,
                "⏭️  Skip to completion — mark remaining steps as done",
              ]
            );
            if (skipChoice?.startsWith("⏭️")) {
              for (const rs of unreviewedSteps) {
                state.stepResults.push({
                  stepIndex: rs.index,
                  status: "success",
                  summary: "Skipped — work completed in earlier step",
                });
              }
              state.currentStepIndex = state.plan.steps[state.plan.steps.length - 1].index;
              persistState();
              // Fall through to the "all steps done" branch below
            }
          }

          // Re-check unreviewed after potential skip
          const stillUnreviewed = state.plan.steps.filter(
            (s) => !state.stepResults.find((r) => r.stepIndex === s.index && r.status === "success")
          );

          if (stillUnreviewed.length > 0) {
            // Check if these steps were already implemented in a parallel group
            // (they have worktrees, or were in a same-dir group)
            // If so, tell the agent to call orch_review for them, not implement them.
            const alreadyImplemented = stillUnreviewed.filter(
              (s) => worktreePool?.getPath(s.index) || worktreePool?.getBranch(s.index) || isSameDirStep(s.index)
            );

            if (alreadyImplemented.length > 0) {
              // These steps were implemented in parallel — just need review
              const stepList = alreadyImplemented.map((s) => `- Step ${s.index}: ${s.description}`).join("\n");
              ctx.ui.notify(`✅ Step ${params.stepIndex} passed! ${alreadyImplemented.length} parallel steps await review.`, "info");

              return {
                content: [
                  {
                    type: "text",
                    text: `✅ Step ${params.stepIndex} passed.\n\nThese steps were implemented in parallel and need review. Call \`orch_review\` for each:\n\n${stepList}`,
                  },
                ],
                details: { review, parallelReviewPending: alreadyImplemented.map((s) => s.index) },
              };
            }

            // Check if the next unreviewed steps form a parallel group
            // and should be launched together
            if (parallelAnalysis) {
              const currentGroup = parallelAnalysis.groups.find((g) =>
                g.includes(params.stepIndex)
              );
              const currentGroupIdx = currentGroup
                ? parallelAnalysis.groups.indexOf(currentGroup)
                : -1;

              // Are all steps in the current group done?
              const currentGroupDone = currentGroup?.every(
                (idx) => state.stepResults.find((r) => r.stepIndex === idx && r.status === "success")
              );

              if (currentGroupDone && currentGroupIdx >= 0) {
                const nextGroupIdx = currentGroupIdx + 1;
                if (nextGroupIdx < parallelAnalysis.groups.length) {
                  const nextGroup = parallelAnalysis.groups[nextGroupIdx];

                  const nextGroupIsSameDir = sameDirGroups.has(nextGroupIdx);
                  const nextGroupCanParallel = nextGroup.length > 1 &&
                    (nextGroupIsSameDir || worktreePool);

                  if (nextGroupCanParallel) {
                    // Launch next parallel group
                    const agentConfigs = nextGroup.map((stepIdx) => {
                      const s = state.plan!.steps.find((st) => st.index === stepIdx)!;
                      const wtPath = nextGroupIsSameDir ? undefined : worktreePool?.getPath(stepIdx);
                      const workDir = wtPath ?? ctx.cwd;
                      const agentName = `step-${stepIdx}`;
                      const threadId = state.beadIds?.[stepIdx] ?? `step-${stepIdx}`;
                      const preamble = state.coordinationBackend?.agentMail
                        ? agentMailTaskPreamble(ctx.cwd, agentName, s.description, s.artifacts, threadId)
                        : "";
                      return {
                        name: agentName,
                        task: `${preamble}You are implementing Step ${stepIdx} of a plan.\n\n## Step ${stepIdx}: ${s.description}\n\n### Acceptance Criteria\n${s.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n### Files to modify\n${s.artifacts.join(", ")}\n\n⚠️ SCOPE CONSTRAINT: You MUST NOT create or modify any files outside the list above.\n\n### Working Directory\ncd to: ${workDir}\n${nextGroupIsSameDir ? "\n🤝 **Same-dir mode**: Other agents are working in this directory too. Your file reservations via agent-mail protect your files. Do NOT touch files outside your artifact list.\n" : ""}\nImplement the step.\n\nWhen done, do a fresh-eyes review then COMMIT:\n\`\`\`bash\ncd ${workDir}\ngit add ${s.artifacts.map(f => '"' + f + '"').join(' ')} && git commit -m "step ${stepIdx}: ${s.description.slice(0, 60)}"\n\`\`\`\n\nSummarize what you did.`,
                      };
                    });

                    const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
                    const modeLabel = nextGroupIsSameDir ? "same-dir + reservations" : "worktrees";
                    ctx.ui.notify(`✅ Group ${currentGroupIdx + 1} complete! Launching Group ${nextGroupIdx + 1} (steps ${nextGroup.join(", ")}, ${modeLabel}).`, "info");

                    return {
                      content: [
                        {
                          type: "text",
                          text: `✅ Step ${params.stepIndex} passed. Group ${currentGroupIdx + 1} complete!\n\n**NEXT: Call \`parallel_subagents\` NOW to launch Group ${nextGroupIdx + 1} (Steps ${nextGroup.join(", ")}).**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each step.`,
                        },
                      ],
                      details: { review, nextGroup: nextGroup, launchingParallel: true, sameDirMode: nextGroupIsSameDir },
                    };
                  }
                }
              }
            }

            // Default: advance to next sequential step
            const actualNextStep = stillUnreviewed[0];
            state.currentStepIndex = actualNextStep.index;
            state.retryCount = 0;
            setPhase("implementing", ctx);
            persistState();

            // Mark next step's bead as in_progress
            const nextBeadId = state.beadIds?.[actualNextStep.index];
            if (nextBeadId) {
              const { updateBeadStatus } = await import("./beads.js");
              await updateBeadStatus(pi, ctx.cwd, nextBeadId, "in_progress");
            }

            const implInstr = implementerInstructions(
              actualNextStep,
              state.repoProfile!,
              state.stepResults
            );

            ctx.ui.notify(`✅ Step ${params.stepIndex} passed! Moving to step ${actualNextStep.index}.`, "info");

            return {
              content: [
                {
                  type: "text",
                  text: `✅ Step ${params.stepIndex} passed.\n\n---\nMoving to Step ${actualNextStep.index}:\n\n${implInstr}`,
                },
              ],
              details: { review, nextStep: actualNextStep.index },
            };
          }
        }

        // All steps done — enter guided review gates directly
        // (don't ask the agent to make another orch_review call — it may not follow through)
        {
          // Run beads validation if beads coordination is active
          let beadsReviewInfo = "";
          if (state.coordinationBackend?.beads && state.beadIds) {
            const { validateBeads, getBeadsSummary, syncBeads, readBeads } = await import("./beads.js");
            await syncBeads(pi, ctx.cwd);
            const validation = await validateBeads(pi, ctx.cwd);
            const allBeads = await readBeads(pi, ctx.cwd);
            const summary = getBeadsSummary(allBeads);
            beadsReviewInfo = `\n\n**Beads:** ${summary}${!validation.ok ? `\n⚠️ ${validation.cycles ? "Cycles detected" : ""} ${validation.orphaned.length > 0 ? `Orphaned: ${validation.orphaned.join(", ")}` : ""}` : ""}`;
          }

          // Run sophia validate/review if available
          let sophiaReviewInfo = "";
          if (hasSophia && sophiaCRResult) {
            const { validateCR, reviewCR } = await import("./sophia.js");
            const valResult = await validateCR(pi, ctx.cwd, sophiaCRResult.cr.id);
            const revResult = await reviewCR(pi, ctx.cwd, sophiaCRResult.cr.id);
            sophiaReviewInfo = `\n\n**Sophia validation:** ${valResult.ok ? "✅ passed" : `⚠️ ${valResult.error}`}\n**Sophia review:** ${revResult.ok ? "✅ passed" : `⚠️ ${revResult.error}`}`;
          }

          // Clean up worktrees and tender
          if (worktreePool) {
            await worktreePool.cleanup();
            worktreePool = undefined;
          }
          if (swarmTender) {
            swarmTender.stop();
            swarmTender = undefined;
          }

          ctx.ui.notify("🔄 All steps done — entering review gates", "info");
          setPhase("iterating", ctx);
          state.iterationRound = 0;
          state.currentGateIndex = 0;
          persistState();

          // Fall through directly into the guided gate flow
          // (reuse the sentinel handler inline instead of asking agent to call back)
          return await runGuidedGates(state, ctx, beadsReviewInfo + sophiaReviewInfo);
        }
      } else {
        // Failed — retry
        state.retryCount++;
        persistState();

        if (state.retryCount >= state.maxRetries) {
          const cont = await ctx.ui.confirm(
            "Step Failed",
            `Step ${params.stepIndex} failed after ${state.maxRetries} attempts.\n\nContinue to next step anyway?`
          );

          if (cont) {
            const nextStep = state.plan.steps.find(
              (s) => s.index === params.stepIndex + 1
            );
            if (nextStep) {
              state.currentStepIndex = nextStep.index;
              state.retryCount = 0;
              setPhase("implementing", ctx);
              persistState();

              const implInstr = implementerInstructions(
                nextStep,
                state.repoProfile!,
                state.stepResults
              );

              return {
                content: [
                  {
                    type: "text",
                    text: `⚠️ Skipping step ${params.stepIndex} (max retries). Moving to Step ${nextStep.index}:\n\n${implInstr}`,
                  },
                ],
                details: { review, skipped: true, nextStep: nextStep.index },
              };
            }
          }

          orchestratorActive = false;
          setPhase("idle", ctx);
          persistState();
          return {
            content: [
              { type: "text", text: "Orchestration stopped due to repeated failures." },
            ],
            details: { review, stopped: true },
          };
        }

        ctx.ui.notify(
          `⚠️ Step ${params.stepIndex} needs revision (attempt ${state.retryCount}/${state.maxRetries})`,
          "warning"
        );

        return {
          content: [
            {
              type: "text",
              text: `❌ Step ${params.stepIndex} did not pass review (attempt ${state.retryCount}/${state.maxRetries}).\n\nRevision needed: ${params.revisionInstructions ?? params.feedback}\n\nPlease fix the issues using the code tools, then call \`orch_review\` again.`,
            },
          ],
          details: { review, retryCount: state.retryCount },
        };
      }
    },

    renderCall(args, theme) {
      const a = args as any;
      const icon = a.verdict === "pass" ? "✅" : "❌";
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_review ")) +
          theme.fg("dim", `step ${a.stepIndex} ${icon}`),
        0, 0
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.complete)
        return new Text(theme.fg("success", "🎉 All steps complete!"), 0, 0);
      if (d?.stopped)
        return new Text(theme.fg("error", "🛑 Orchestration stopped"), 0, 0);
      if (d?.review?.passed)
        return new Text(
          theme.fg("success", `✅ Step ${d.review.stepIndex} passed`) +
            (d.nextStep ? theme.fg("dim", ` → step ${d.nextStep}`) : ""),
          0, 0
        );
      return new Text(
        theme.fg("warning", `❌ Step ${d?.review?.stepIndex} needs revision`) +
          theme.fg("dim", ` (${d?.retryCount}/${state.maxRetries})`),
        0, 0
      );
    },
  });

  // ─── Provide discovery instructions via the profile context ──
  // The LLM gets discovery instructions from orch_profile's result
  // and planner instructions from orch_select's result, so we don't
  // need separate "instruction" tools. The LLM uses its intelligence
  // to follow the workflow defined in the system prompt.
}
