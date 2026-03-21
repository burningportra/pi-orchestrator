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
    const { readBeads, extractArtifacts: extractBeadArtifacts } = await import("./beads.js");
    const allBeads = await readBeads(pi, ctx.cwd);
    const activeBeads = st.activeBeadIds
      ? allBeads.filter((b) => st.activeBeadIds!.includes(b.id))
      : allBeads;
    const allArtifacts = [...new Set(activeBeads.flatMap((b) => extractBeadArtifacts(b)))];
    const goal = st.selectedGoal ?? st.plan?.goal ?? "Unknown goal";
    const beadResults = Object.values(st.beadResults ?? {});
    const polish = polishInstructions(goal, allArtifacts);
    const summaryText = summaryInstructions(goal, activeBeads, beadResults);

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

    const callbackHint = `\n\nAfter completing this, call \`orch_review\` with beadId "__gates__" and verdict "pass" for the next gate.`;

    if (chosen.startsWith("✅")) {
      orchestratorActive = false;
      st.currentGateIndex = 0;
      setPhase("complete", ctx);
      persistState();
      return {
        content: [
          { type: "text", text: `${summaryText}${extraInfo}\n\nOrchestration complete after ${round} round(s).\n\n---\n## 🧠 Compound Memory\n\nDistill the key decisions, gotchas, patterns, and architectural choices from this orchestration. What would a future agent need to know about this repo? Write 3–7 bullet points and append them to \`.pi-orchestrator/memory.md\` using the write or bash tool. Format as a timestamped markdown section.` },
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
          task: `${peerPreamble(`peer-bugs-r${round}`)}Peer reviewer (round ${round}). Review code written by your fellow agents. Check for issues, bugs, errors, inefficiencies, security problems, reliability issues. Diagnose root causes using first-principle analysis. Don't restrict to latest commits — cast a wider net and go super deep!\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-polish-r${round}`,
          task: `${peerPreamble(`peer-polish-r${round}`)}Polish reviewer (round ${round}). De-slopify the code. Remove AI slop, improve clarity, make it agent-friendly.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-ergonomics-r${round}`,
          task: `${peerPreamble(`peer-ergonomics-r${round}`)}Ergonomics reviewer (round ${round}). If you came in fresh with zero context, would you understand this code? Fix anything confusing.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-reality-r${round}`,
          task: `${peerPreamble(`peer-reality-r${round}`)}Reality checker (round ${round}).\n\n${realityCheckInstructions(goal, activeBeads, beadResults)}\n\nDo NOT edit code. Just report findings.\n\ncd ${ctx.cwd}`,
        },
      ];
      const peerJson = JSON.stringify({ agents: peerAgents }, null, 2);
      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Call \`parallel_subagents\` NOW with the config below.**\n\n## 👥 Peer Review — Round ${round}\n\n\`\`\`json\n${peerJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` with beadId "__gates__" and verdict "pass".`,
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
        task: `${hitMePreamble(`fresh-eyes-r${round}`)}Fresh-eyes reviewer round ${round}. NEVER seen this code.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `polish-r${round}`,
        task: `${hitMePreamble(`polish-r${round}`)}Polish/de-slopify reviewer round ${round}.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nMake targeted edits directly — don't just report.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `ergonomics-r${round}`,
        task: `${hitMePreamble(`ergonomics-r${round}`)}Agent-ergonomics reviewer round ${round}. Make this maximally intuitive for coding agents.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything that fails that test.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `reality-check-r${round}`,
        task: `${hitMePreamble(`reality-check-r${round}`)}Reality checker round ${round}.\n\n${realityCheckInstructions(goal, activeBeads, beadResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
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
      beadId: Type.String({ description: "bead ID to review (from br list), or \"__gates__\" for guided gates" }),
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
      const { getBeadById, readyBeads, updateBeadStatus, syncBeads, readBeads, extractArtifacts: extractBeadArtifacts } = await import("./beads.js");

      // Sentinel: beadId === "__gates__" while iterating = show next gate
      if (state.phase === "iterating" && params.beadId === "__gates__") {
        return await runGuidedGates(state, ctx, "");
      }

      const bead = await getBeadById(pi, ctx.cwd, params.beadId);
      if (!bead) {
        throw new Error(`Bead ${params.beadId} not found. Use \`br list\` to see available beads.`);
      }

      // Guard: reject re-review of already-completed beads
      const alreadyCompleted = state.beadResults?.[params.beadId];
      if (alreadyCompleted?.status === "success" && params.verdict === "pass") {
        return {
          content: [
            { type: "text", text: `Bead ${params.beadId} already completed. Move to the next bead or call \`orch_review\` with beadId "__gates__" for guided gates.` },
          ],
          details: { review: { beadId: params.beadId, passed: true }, alreadyDone: true },
        };
      }

      // Record the bead result
      if (!state.beadResults) state.beadResults = {};
      state.beadResults[params.beadId] = {
        beadId: params.beadId,
        status: params.verdict === "pass" ? "success" : "partial",
        summary: params.summary,
      };

      // Store review verdict
      if (!state.beadReviews) state.beadReviews = {};
      if (!state.beadReviews[params.beadId]) state.beadReviews[params.beadId] = [];
      state.beadReviews[params.beadId].push({
        beadId: params.beadId,
        passed: params.verdict === "pass",
        feedback: params.feedback,
        revisionInstructions: params.revisionInstructions,
      });

      persistState();

      if (params.verdict === "pass") {
        // Update bead status to closed
        await updateBeadStatus(pi, ctx.cwd, params.beadId, "closed");
        await syncBeads(pi, ctx.cwd);

        // Track review passes per bead
        if (!state.beadReviewPassCounts) state.beadReviewPassCounts = {};
        const prevPassCount = state.beadReviewPassCounts[params.beadId] ?? 0;
        state.beadReviewPassCounts[params.beadId] = prevPassCount + 1;
        persistState();

        // Sophia checkpointing commented out for now (uses step indices)
        // TODO: re-enable with bead ID mapping

        // Merge worktree changes back if this bead used a worktree
        // (keep worktree merge logic keyed by bead ID where possible)
        // TODO: worktree pool currently keyed by step index — will be updated later

        setPhase("reviewing", ctx);

        // Hit-me flow uses two flags keyed by bead ID:
        // - beadHitMeTriggered: set when user picks "🔥 Hit me" and agents are spawned
        // - beadHitMeCompleted: set by the orchestrator ONLY after review agents return results
        const hitMeWasTriggered = state.beadHitMeTriggered?.[params.beadId] ?? false;
        const hitMeWasCompleted = state.beadHitMeCompleted?.[params.beadId] ?? false;
        const allArtifactsForBead = extractBeadArtifacts(bead);
        let hitMeChoice: string | undefined;

        if (!hitMeWasTriggered) {
          hitMeChoice = await ctx.ui.select(
            `✅ Bead ${params.beadId} (${bead.title}) passed self-review.`,
            [
              "🔥 Hit me — spawn parallel review agents for this bead",
              "✅ Looks good — move on",
            ]
          );
        } else if (!hitMeWasCompleted) {
          ctx.ui.notify(`⚠️ Review agents haven't completed yet. Re-presenting spawn instruction.`, "warning");
          const round = Math.max(0, prevPassCount - 1);
          const rePresThreadId = params.beadId;
          const rePresPreamble = (name: string) =>
            state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, name, bead.title, allArtifactsForBead, rePresThreadId)
              : "";
          const allBeads = await readBeads(pi, ctx.cwd);
          const beadResults = Object.values(state.beadResults ?? {});
          const goal = state.selectedGoal ?? "Unknown goal";
          const agentConfigs = [
            {
              name: `fresh-eyes-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`fresh-eyes-${params.beadId}-r${round}`)}Fresh-eyes reviewer for bead ${params.beadId} (round ${round}). NEVER seen this code.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`polish-${params.beadId}-r${round}`)}Polish reviewer for bead ${params.beadId} (round ${round}). De-slopify.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`ergonomics-${params.beadId}-r${round}`)}Ergonomics reviewer for bead ${params.beadId} (round ${round}).\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`reality-check-${params.beadId}-r${round}`)}Reality checker for bead ${params.beadId} (round ${round}).\n\n${realityCheckInstructions(goal, allBeads, beadResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
            },
          ];
          const reviewJson = JSON.stringify({ agents: agentConfigs }, null, 2);
          return {
            content: [
              {
                type: "text",
                text: `**Review agents must complete before advancing. Call \`parallel_subagents\` NOW with the config below.**\n\n## 🔥 Hit me — Bead ${params.beadId}, Round ${round} (re-presented)\n\n\`\`\`json\n${reviewJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` again for bead ${params.beadId} with what was fixed.`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, hitMe: true, round, bead: params.beadId, rePresented: true },
          };
        } else {
          hitMeChoice = "✅";
          if (!state.beadHitMeTriggered) state.beadHitMeTriggered = {};
          if (!state.beadHitMeCompleted) state.beadHitMeCompleted = {};
          state.beadHitMeTriggered[params.beadId] = false;
          state.beadHitMeCompleted[params.beadId] = false;
          persistState();
          ctx.ui.notify(`✅ Bead ${params.beadId} passed review (round ${prevPassCount}).`, "info");
        }

        if (hitMeChoice?.startsWith("🔥")) {
          if (!state.beadHitMeTriggered) state.beadHitMeTriggered = {};
          if (!state.beadHitMeCompleted) state.beadHitMeCompleted = {};
          state.beadHitMeTriggered[params.beadId] = true;
          state.beadHitMeCompleted[params.beadId] = false;
          persistState();

          const round = prevPassCount;
          const hitMeThreadId = params.beadId;
          const hitMePreamble = (name: string) =>
            state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, name, bead.title, allArtifactsForBead, hitMeThreadId)
              : "";
          const allBeads = await readBeads(pi, ctx.cwd);
          const beadResults = Object.values(state.beadResults ?? {});
          const goal = state.selectedGoal ?? "Unknown goal";
          const agentConfigs = [
            {
              name: `fresh-eyes-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`fresh-eyes-${params.beadId}-r${round}`)}Fresh-eyes reviewer for bead ${params.beadId} (round ${round}). NEVER seen this code.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`polish-${params.beadId}-r${round}`)}Polish reviewer for bead ${params.beadId} (round ${round}). De-slopify.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`ergonomics-${params.beadId}-r${round}`)}Ergonomics reviewer for bead ${params.beadId} (round ${round}).\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`reality-check-${params.beadId}-r${round}`)}Reality checker for bead ${params.beadId} (round ${round}).\n\n${realityCheckInstructions(goal, allBeads, beadResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
            },
          ];

          const hitMeResults = await runHitMeAgents(agentConfigs, ctx.cwd, ctx);

          state.beadHitMeCompleted[params.beadId] = true;
          persistState();

          return {
            content: [
              {
                type: "text",
                text: `## 🔥 Hit me — Bead ${params.beadId} (${bead.title}), Round ${round}\n\n${hitMeResults.text}\n\n${hitMeResults.diff ? `### Diff\n\`\`\`diff\n${hitMeResults.diff}\n\`\`\`\n\n` : ""}After reviewing the findings above, call \`orch_review\` again for bead ${params.beadId} with what was fixed.`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, hitMe: true, round, bead: params.beadId },
          };
        }

        // User said "looks good" — check for next ready beads
        const ready = await readyBeads(pi, ctx.cwd);

        if (ready.length === 0) {
          // All beads done — enter guided review gates
          let beadsReviewInfo = "";
          if (state.coordinationBackend?.beads) {
            const { validateBeads, getBeadsSummary } = await import("./beads.js");
            await syncBeads(pi, ctx.cwd);
            const validation = await validateBeads(pi, ctx.cwd);
            const allBeads = await readBeads(pi, ctx.cwd);
            const summary = getBeadsSummary(allBeads);
            beadsReviewInfo = `\n\n**Beads:** ${summary}${!validation.ok ? `\n⚠️ ${validation.cycles ? "Cycles detected" : ""} ${validation.orphaned.length > 0 ? `Orphaned: ${validation.orphaned.join(", ")}` : ""}` : ""}`;
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

          ctx.ui.notify("🔄 All beads done — entering review gates", "info");
          setPhase("iterating", ctx);
          state.iterationRound = 0;
          state.currentGateIndex = 0;
          persistState();

          return await runGuidedGates(state, ctx, beadsReviewInfo);
        } else if (ready.length === 1) {
          // Single next bead — emit implementer instructions
          const nextBead = ready[0];
          state.currentBeadId = nextBead.id;
          await updateBeadStatus(pi, ctx.cwd, nextBead.id, "in_progress");
          state.retryCount = 0;
          setPhase("implementing", ctx);
          persistState();

          const prevResults = Object.values(state.beadResults ?? {});
          const implInstr = implementerInstructions(nextBead, state.repoProfile!, prevResults);

          ctx.ui.notify(`✅ Bead ${params.beadId} passed! Moving to bead ${nextBead.id} (${nextBead.title}).`, "info");

          return {
            content: [
              {
                type: "text",
                text: `✅ Bead ${params.beadId} (${bead.title}) passed.\n\n---\nMoving to Bead ${nextBead.id}:\n\n${implInstr}`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, nextBead: nextBead.id },
          };
        } else {
          // Multiple ready beads — emit parallel_subagents config
          const goal = state.selectedGoal ?? "Unknown goal";
          const agentConfigs = ready.map((b) => {
            const artifacts = extractBeadArtifacts(b);
            const agentName = `bead-${b.id}`;
            const threadId = b.id;
            const preamble = state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, agentName, b.title, artifacts, threadId)
              : "";
            const prevResults = Object.values(state.beadResults ?? {});
            const implInstr = implementerInstructions(b, state.repoProfile!, prevResults);
            return {
              name: agentName,
              task: `${preamble}${implInstr}\n\ncd ${ctx.cwd}`,
            };
          });

          // Mark all as in_progress
          for (const b of ready) {
            await updateBeadStatus(pi, ctx.cwd, b.id, "in_progress");
          }
          setPhase("implementing", ctx);
          persistState();

          const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
          ctx.ui.notify(`✅ Bead ${params.beadId} passed! ${ready.length} beads now ready for parallel implementation.`, "info");

          return {
            content: [
              {
                type: "text",
                text: `✅ Bead ${params.beadId} (${bead.title}) passed.\n\n**NEXT: Call \`parallel_subagents\` NOW to implement ${ready.length} ready beads.**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each bead.`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, readyBeads: ready.map((b) => b.id), launchingParallel: true },
          };
        }
      } else {
        // Failed — retry (bead stays open, don't update status)
        state.retryCount = (state.retryCount ?? 0) + 1;
        persistState();

        const review = { beadId: params.beadId, passed: false, feedback: params.feedback };

        if (state.retryCount >= state.maxRetries) {
          const cont = await ctx.ui.confirm(
            "Bead Failed",
            `Bead ${params.beadId} (${bead.title}) failed after ${state.maxRetries} attempts.\n\nSkip and move on?`
          );

          if (cont) {
            // Mark as blocked and move to next ready bead
            state.beadResults[params.beadId] = {
              beadId: params.beadId,
              status: "blocked",
              summary: `Skipped after ${state.maxRetries} failed attempts`,
            };
            await updateBeadStatus(pi, ctx.cwd, params.beadId, "deferred");
            await syncBeads(pi, ctx.cwd);

            const ready = await readyBeads(pi, ctx.cwd);
            if (ready.length > 0) {
              const nextBead = ready[0];
              state.currentBeadId = nextBead.id;
              state.retryCount = 0;
              setPhase("implementing", ctx);
              persistState();

              const prevResults = Object.values(state.beadResults ?? {});
              const implInstr = implementerInstructions(nextBead, state.repoProfile!, prevResults);

              return {
                content: [
                  {
                    type: "text",
                    text: `⚠️ Skipping bead ${params.beadId} (max retries). Moving to bead ${nextBead.id} (${nextBead.title}):\n\n${implInstr}`,
                  },
                ],
                details: { review, skipped: true, nextBead: nextBead.id },
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
          `⚠️ Bead ${params.beadId} needs revision (attempt ${state.retryCount}/${state.maxRetries})`,
          "warning"
        );

        return {
          content: [
            {
              type: "text",
              text: `❌ Bead ${params.beadId} (${bead.title}) did not pass review (attempt ${state.retryCount}/${state.maxRetries}).\n\nRevision needed: ${params.revisionInstructions ?? params.feedback}\n\nPlease fix the issues using the code tools, then call \`orch_review\` again.`,
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
          theme.fg("dim", `bead ${a.beadId} ${icon}`),
        0, 0
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.complete)
        return new Text(theme.fg("success", "🎉 All beads complete!"), 0, 0);
      if (d?.stopped)
        return new Text(theme.fg("error", "🛑 Orchestration stopped"), 0, 0);
      if (d?.review?.passed)
        return new Text(
          theme.fg("success", `✅ Bead ${d.review.beadId} passed`) +
            (d.nextBead ? theme.fg("dim", ` → bead ${d.nextBead}`) : ""),
          0, 0
        );
      return new Text(
        theme.fg("warning", `❌ Bead ${d?.review?.beadId} needs revision`) +
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
