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
} from "./types.js";
import { createInitialState } from "./types.js";
import { profileRepo } from "./profiler.js";
import {
  orchestratorSystemPrompt,
  formatRepoProfile,
  discoveryInstructions,
  plannerInstructions,
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
import { WorktreePool } from "./worktree.js";
import { runDeepPlanAgents } from "./deep-plan.js";

const PHASE_EMOJI: Record<OrchestratorPhase, string> = {
  idle: "⏸",
  profiling: "📊",
  discovering: "💡",
  awaiting_selection: "🎯",
  planning: "📝",
  awaiting_plan_approval: "📋",
  implementing: "🔨",
  reviewing: "🔍",
  iterating: "🔄",
  complete: "✅",
};

export default function (pi: ExtensionAPI) {
  // Log version at startup so stale code is immediately obvious
  const ORCHESTRATOR_VERSION = '0.5.0';
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
  let hasSophia = false;
  let sophiaCRResult: PlanToCRResult | undefined;
  let worktreePool: WorktreePool | undefined;
  let parallelAnalysis: ParallelAnalysis | undefined;
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
    if (state.repoProfile) lines.push(`📁 Repo: ${state.repoProfile.name}`);
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
      systemPrompt: event.systemPrompt + "\n\n" + orchestratorSystemPrompt(hasSophia),
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

        // Restore sophia state — re-validate availability
        hasSophia = state.hasSophia ?? false;
        if (hasSophia) {
          // Re-check sophia is still available (might have been uninstalled)
          const stillAvailable = await isSophiaAvailable(pi, ctx.cwd);
          if (!stillAvailable) {
            hasSophia = false;
            state.hasSophia = false;
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
          `Start the orchestrator workflow for this repo. I want to: ${goalArg}\n\nBegin by calling \`orch_profile\` to scan the repo, then skip discovery and go straight to \`orch_plan\` with my stated goal.`,
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

      const profile = await profileRepo(pi, ctx.cwd, signal);
      state.repoProfile = profile;

      // Detect sophia availability
      const sophiaAvail = await isSophiaAvailable(pi, ctx.cwd);
      const sophiaInit = sophiaAvail && await isSophiaInitialized(pi, ctx.cwd);
      hasSophia = sophiaInit ?? false;
      persistState();

      setPhase("discovering", ctx);

      const formatted = formatRepoProfile(profile);

      // Read compound memory from prior orchestrations
      const { readMemory } = await import("./memory.js");
      const memory = readMemory(ctx.cwd);
      const memoryContext = memory
        ? `\n\n### Compound Memory (from prior runs)\n${memory}`
        : "";

      const discoveryMode = await ctx.ui.select(
        "Discovery mode:",
        [
          "📋 Standard — 3-7 practical ideas",
          "🚀 Creative — think of 100, tell me your 7 best",
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
            details: { profile },
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
        setPhase("planning", ctx);
        persistState();

        // Generate standard plan first — user can upgrade to deep plan
        // in orch_plan after seeing it
        const instructions = plannerInstructions(goal, profile, constraints);

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`orch_plan\` with a structured plan NOW.**\n\nGoal: "${goal}"\n\n---\n\nRepository profiled successfully.\n\n${formatted}${memoryContext}\n\n${instructions}`,
            },
          ],
          details: { profile, customGoal: goal },
        };
      }

      const isCreative = discoveryMode?.startsWith("🚀");
      const discoveryPrompt = isCreative
        ? `**NEXT: Call \`orch_discover\` with your top 7 ideas NOW.**\n\n🚀 Creative Discovery Mode: Come up with your top 7 most brilliant ideas for adding extremely powerful and cool functionality that will make this system far more compelling, useful, intuitive, versatile, powerful, robust, and reliable for users. Be pragmatic — don't suggest features that are extremely hard to implement or not worth the complexity. But I don't want you to just think of 7 ideas: seriously think hard, come up with ONE HUNDRED ideas internally, then only tell me your 7 VERY BEST and most brilliant, clever, and radically innovative ideas.`
        : `**NEXT: Call \`orch_discover\` to generate project ideas NOW.**`;

      return {
        content: [
          {
            type: "text",
            text: `${discoveryPrompt}\n\n---\n\nRepository profiled successfully.\n\n${formatted}${memoryContext}`,
          },
        ],
        details: { profile },
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

      const ideaList = state.candidateIdeas
        .map(
          (idea, i) =>
            `${i + 1}. **[${idea.category}] ${idea.title}** (effort: ${idea.effort}, impact: ${idea.impact})\n   ${idea.description}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Call \`orch_select\` NOW to present these to the user.**\n\n---\n\nGenerated ${state.candidateIdeas.length} project ideas:\n\n${ideaList}`,
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
      let text = theme.fg("success", `💡 ${d?.ideas?.length ?? 0} ideas generated`);
      if (expanded && d?.ideas) {
        for (const idea of d.ideas) {
          text += `\n  [${idea.category}] ${idea.title}`;
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

      const options = state.candidateIdeas.map(
        (idea) =>
          `[${idea.category}] ${idea.title} (effort: ${idea.effort}, impact: ${idea.impact})`
      );
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
      } else {
        const choiceIndex = options.indexOf(choice);
        const idea = state.candidateIdeas[choiceIndex];
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

      // Generate a standard plan first — user can upgrade to deep plan
      // in orch_plan after seeing it
      const instructions = plannerInstructions(
        goal,
        state.repoProfile!,
        state.constraints
      );

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Call \`orch_plan\` with a structured plan NOW.**\n\nGoal: "${goal}"${state.constraints.length > 0 ? `\nConstraints: ${state.constraints.join(", ")}` : ""}\n\n---\n\n${instructions}`,
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

  // ─── Tool: orch_plan ─────────────────────────────────────────
  pi.registerTool({
    name: "orch_plan",
    label: "Create Plan",
    description:
      "Submit a structured plan for the selected goal. The plan will be shown to the user for approval. Each step needs: index, description, acceptanceCriteria (string[]), artifacts (string[]).",
    promptSnippet: "Submit a step-by-step plan for user approval",
    parameters: Type.Object({
      goal: Type.String({ description: "restated goal" }),
      steps: Type.Array(
        Type.Object({
          index: Type.Number({ description: "step number (1-based)" }),
          description: Type.String({ description: "what to do in this step" }),
          acceptanceCriteria: Type.Array(Type.String(), {
            description: "criteria to verify this step is done",
          }),
          artifacts: Type.Array(Type.String(), {
            description: "files to create or modify",
          }),
          dependsOn: Type.Optional(Type.Array(Type.Number(), {
            description: "step indices this step depends on. Omit for sequential (depends on previous). Use [] for independent (can parallelize). Use [1,3] for explicit deps.",
          })),
        }),
        { description: "3-7 ordered steps" }
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.selectedGoal) {
        throw new Error("No goal selected. Call orch_select first.");
      }

      const plan: Plan = {
        goal: params.goal,
        constraints: state.constraints,
        steps: params.steps as PlanStep[],
      };

      // Present plan for approval
      const planText = plan.steps
        .map(
          (s) => {
            const criteria = s.acceptanceCriteria.join("\n   ✓ ");
            const files = s.artifacts.join(", ");
            let depLine = "";
            if (s.dependsOn !== undefined) {
              depLine = s.dependsOn.length === 0
                ? "\n   ⚡ independent"
                : `\n   🔗 depends on: ${s.dependsOn.join(", ")}`;
            }
            return `${s.index}. ${s.description}\n   ✓ ${criteria}\n   📄 ${files}${depLine}`;
          }
        )
        .join("\n\n");

      setPhase("awaiting_plan_approval", ctx);

      // Show the full plan first, then ask what to do
      const planChoice = await ctx.ui.select(
        `📝 Plan: ${plan.goal}\n\n${planText}`,
        [
          "✅ Approve this plan",
          "🧠 Deep plan — 3 competing LLMs → best-of-all-worlds synthesis",
          "🚀 Creative brainstorm — enhance before approving",
          "❌ Reject",
        ]
      );

      if (planChoice?.startsWith("🧠")) {
        // Deep plan — spawn 3 competing agents then synthesize
        const profileSummary = state.repoProfile ? formatRepoProfile(state.repoProfile) : "";
        const planPrompt = `Create a detailed step-by-step plan (3-7 steps) for this goal.\n\n## Goal\n${plan.goal}\n\n## Repo\n${profileSummary}\n\n## Constraints\n${plan.constraints.length > 0 ? plan.constraints.join(", ") : "None"}\n\n## Current Plan (for reference — you may improve on it)\n${planText}\n\n**IMPORTANT: Output your plan as plain text. Do NOT call any orch_ tools. Do NOT try to implement anything. Just write the plan.**\n\nReturn your plan as a numbered list with: step description, acceptance criteria, and files to modify. Be specific and opinionated.`;

        const available = ctx.modelRegistry.getAvailable();
        const seen = new Set<string>();
        const filtered = available
          .sort((a, b) => b.contextWindow - a.contextWindow)
          .filter((m) => {
            const dateMatch = m.id.match(/-(\d{8})$/);
            if (dateMatch) {
              const baseId = m.id.replace(/-(\d{8})$/, "");
              const hasLatest = available.some(
                (o) =>
                  o.provider === m.provider &&
                  (o.id === baseId ||
                    o.id === baseId + "-0" ||
                    o.id.startsWith(baseId + "-latest"))
              );
              if (hasLatest) return false;
            }
            const key = `${m.provider}/${m.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

        const perProvider = new Map<string, typeof filtered>();
        for (const m of filtered) {
          const list = perProvider.get(m.provider) ?? [];
          if (list.length < 3) list.push(m);
          perProvider.set(m.provider, list);
        }
        const topModels = [...perProvider.values()]
          .flat()
          .sort((a, b) => {
            if (a.provider !== b.provider)
              return a.provider.localeCompare(b.provider);
            return b.contextWindow - a.contextWindow;
          });

        const modelOptions = topModels.map((m) => {
          const ctx_k =
            m.contextWindow >= 1000000
              ? `${(m.contextWindow / 1000000).toFixed(1)}M`
              : `${Math.round(m.contextWindow / 1000)}K`;
          const r = m.reasoning ? " 🧠" : "";
          return `${m.provider}/${m.id} (${ctx_k}${r})`;
        });

        const labels = ["Alpha (correctness)", "Beta (robustness)", "Gamma (ergonomics)"];
        const pickedModels: (string | undefined)[] = [];
        for (const label of labels) {
          const choice = await ctx.ui.select(
            `Pick model for Planner ${label}:`,
            modelOptions
          );
          pickedModels.push(choice ? choice.split(" (")[0] : undefined);
        }

        const agentConfigs = [
          {
            name: "planner-alpha",
            task: `You are Planner Alpha. ${planPrompt}\n\nFocus on: correctness, minimal scope, and clean architecture.\n\ncd ${ctx.cwd}`,
            ...(pickedModels[0] ? { model: pickedModels[0] } : {}),
          },
          {
            name: "planner-beta",
            task: `You are Planner Beta. ${planPrompt}\n\nFocus on: robustness, edge cases, and testing strategy.\n\ncd ${ctx.cwd}`,
            ...(pickedModels[1] ? { model: pickedModels[1] } : {}),
          },
          {
            name: "planner-gamma",
            task: `You are Planner Gamma. ${planPrompt}\n\nFocus on: developer experience, ergonomics, and future extensibility.\n\ncd ${ctx.cwd}`,
            ...(pickedModels[2] ? { model: pickedModels[2] } : {}),
          },
        ];

        const modelInfo = `\n\nModels selected:\n${agentConfigs.map((a) => `- **${a.name}**: ${a.model ?? "default"}`).join("\n")}`;

        ctx.ui.notify(`🧠 Spawning 3 competing planners...`, "info");
        const deepResults = await runDeepPlanAgents(pi, ctx.cwd, agentConfigs);
        ctx.ui.notify(`All 3 planners completed.`, "info");

        const successCount = deepResults.filter((r) => r.exitCode === 0 && r.plan).length;
        if (successCount === 0) {
          const errors = deepResults.map((r) => `- ${r.name}: ${r.error || "(no output)"}`).join("\n");
          throw new Error(`All 3 planners failed. Cannot synthesize.\n${errors}`);
        }

        const planBlocks = deepResults.map((r) => {
          const status = r.exitCode === 0 ? "✅" : "⚠️";
          return `### ${status} ${r.name} (${r.model}, ${r.elapsed}s)\n\n${r.plan || r.error || "(no output)"}`;
        }).join("\n\n---\n\n");

        const synthesis = synthesisInstructions(deepResults.map((r) => ({
          name: r.name, model: r.model, plan: r.plan,
        })));

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Synthesize the 3 plans below into one superior hybrid, then call \`orch_plan\` again NOW.**\n\nGoal: "${plan.goal}"${modelInfo}\n\n---\n\n${planBlocks}\n\n---\n\n${synthesis}`,
            },
          ],
          details: { approved: false, deepPlan: true, deepResults },
        };
      }

      if (planChoice?.startsWith("🚀")) {
        const brainstormTask = `You are a creative brainstormer. Here is a plan that needs enhancement:\n\n${planText}\n\nGoal: ${plan.goal}\n\nThink of ONE HUNDRED ways to make this plan more powerful, innovative, and robust. Then pick only your 3-5 VERY BEST ideas. Each idea must be:\n- **Positive expected value**: the benefit clearly outweighs the implementation cost and complexity burden\n- **Pragmatic**: can be implemented without heroic effort\n- **Concrete**: specific enough to act on, not vague hand-waving\n\nFor each idea, output:\n1. **Title** — short name\n2. **What it does** — one sentence\n3. **Why it's +EV** — why the payoff justifies the cost\n\nDo NOT rewrite the plan. Do NOT call any tools.`;

        const brainstormAgents = [
          {
            name: "brainstorm-innovator",
            task: `${brainstormTask}\n\nFocus on: novel features and capabilities nobody has thought of.`,
            tools: "read,bash,grep,find,ls",
          },
          {
            name: "brainstorm-hardener",
            task: `${brainstormTask}\n\nFocus on: robustness, failure modes, edge cases, and safety.`,
            tools: "read,bash,grep,find,ls",
          },
          {
            name: "brainstorm-simplifier",
            task: `${brainstormTask}\n\nFocus on: removing complexity, merging steps, finding shortcuts that achieve the same outcome with less work.`,
            tools: "read,bash,grep,find,ls",
          },
        ];

        // Spawn brainstorm agents inline (don't rely on agent to call parallel_subagents)
        ctx.ui.notify(`🚀 Spawning 3 brainstorm agents...`, "info");
        const brainstormResults = await runHitMeAgents(brainstormAgents, ctx.cwd, ctx);

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: List all ideas below, ask the user which to include, fold them into the plan, and call \`orch_plan\` again NOW.**\n\n## 🚀 Creative Brainstorm — 3 Parallel Agents\n\nResults from innovator, hardener, and simplifier:\n\n${brainstormResults.text}\n\n---\n\nList ALL ideas from every brainstormer as:\n\`[N] Title — What it does (Source: innovator/hardener/simplifier)\`\nAsk the user which numbers to include, then fold ONLY those into the plan.`,
            },
          ],
          details: { approved: false, creativeBrainstorm: true },
        };
      }

      if (!planChoice || planChoice.startsWith("❌")) {
        orchestratorActive = false;
        setPhase("idle", ctx);
        persistState();
        return {
          content: [
            { type: "text", text: "User rejected the plan. Orchestration stopped." },
          ],
          details: { approved: false },
        };
      }

      state.plan = plan;
      state.currentStepIndex = 1;
      // Reset implementation state — critical when orch_plan is called
      // multiple times (polish loop or creative brainstorm re-entry)
      state.stepResults = [];
      state.reviewVerdicts = [];
      state.reviewPassCounts = {};
      state.hitMeTriggered = {};
      state.hitMeCompleted = {};
      state.iterationRound = 0;
      state.currentGateIndex = 0;
      setPhase("awaiting_plan_approval", ctx);
      persistState();

      // Polish tasks in plan space BEFORE creating sophia tasks
      // This way, if the user sends back for revision and the LLM calls
      // orch_plan again, we haven't created orphaned CRs/tasks yet.
      let polishing = true;
      while (polishing) {
        const taskList = plan.steps
          .map((s) => `**Step ${s.index}: ${s.description}**\n   ✓ ${s.acceptanceCriteria.join("\n   ✓ ")}\n   📄 ${s.artifacts.join(", ")}${s.dependsOn !== undefined ? (s.dependsOn.length === 0 ? "\n   ⚡ independent" : `\n   🔗 depends on: ${s.dependsOn.join(", ")}`) : ""}`)
          .join("\n\n");

        const polishChoice = await ctx.ui.select(
          `${plan.steps.length} tasks ready.\n\n${taskList}`,
          [
            "▶️  Start implementing",
            "🔍 Polish — send tasks back for LLM review",
            "❌ Reject plan",
          ]
        );

        if (polishChoice?.startsWith("🔍")) {
          // Return to LLM for revision — it will call orch_plan again
          // No sophia CR created yet, so no orphans
          return {
            content: [
              {
                type: "text",
                text: `**NEXT: Review the tasks below, revise them, and call \`orch_plan\` again with updated steps NOW.**\n\n## 🔍 Task Polishing\n\n${taskList}\n\n---\n\nCheck over each task super carefully — are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? If so, revise the task. It's a lot easier and faster to operate in "plan space" before we start implementing these things! Use /effort max.`,
              },
            ],
            details: { approved: true, plan, polishing: true },
          };
        }

        if (!polishChoice || polishChoice.startsWith("❌")) {
          orchestratorActive = false;
          setPhase("idle", ctx);
          persistState();
          return {
            content: [{ type: "text", text: "Plan rejected. Orchestration stopped." }],
            details: { approved: false },
          };
        }

        // "▶️ Start implementing" — break out of polish loop
        polishing = false;
      }

      // Now that polishing is done and user committed to implementing,
      // create Sophia CR with the FINAL plan steps
      let sophiaInfo = "";
      if (hasSophia) {
        const available = await isSophiaAvailable(pi, ctx.cwd);
        const initialized = available && await isSophiaInitialized(pi, ctx.cwd);
        if (initialized) {
          const crResult = await createCRFromPlan(
            pi, ctx.cwd, plan.goal, plan.steps, plan.constraints
          );
          if (crResult.ok && crResult.data) {
            sophiaCRResult = crResult.data;
            sophiaInfo = `\n\n**Sophia CR #${crResult.data.cr.id}** created on branch \`${crResult.data.cr.branch}\` with ${crResult.data.taskIds.size} tasks.`;
          } else {
            sophiaInfo = `\n\n⚠️ Sophia CR creation failed: ${crResult.error}`;
          }
        }
      }

      setPhase("implementing", ctx);
      persistState();

      // Analyze parallel groups
      const analysis = analyzeParallelGroups(plan.steps);
      parallelAnalysis = analysis;
      const { groups, mergeOrder } = analysis;
      const hasParallel = groups.some((g) => g.length > 1);

      // Create worktree pool for parallel steps
      let worktreeInfo = "";
      if (hasParallel) {
        try {
          const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 3000, cwd: ctx.cwd });
          const currentBranch = branchResult.stdout.trim() || "main";
          worktreePool = new WorktreePool(pi, ctx.cwd, currentBranch);

          // Pre-create worktrees for all parallel steps
          const parallelSteps = groups.filter((g) => g.length > 1).flat();
          const createdPaths: string[] = [];
          for (const stepIdx of parallelSteps) {
            const result = await worktreePool.acquire(stepIdx);
            if (result.ok && result.data) {
              createdPaths.push(`  Step ${stepIdx}: \`${result.data}\``);
            }
          }
          if (createdPaths.length > 0) {
            worktreeInfo = `\n\n**Worktrees created:**\n${createdPaths.join("\n")}`;
          }
        } catch {
          worktreeInfo = "\n\n⚠️ Worktree creation failed — falling back to sequential execution.";
          worktreePool = undefined;
          if (swarmTender) { swarmTender.stop(); swarmTender = undefined; }
        }
      }

      const parallelInfo = hasParallel
        ? `\n\n**Parallel execution plan:**\n${groups.map((g, i) => `  Group ${i + 1}: Steps ${g.join(", ")}${g.length > 1 ? " (can run in parallel via parallel_subagents)" : ""}`).join("\n")}\n  Merge order: ${mergeOrder.join(" → ")}${worktreeInfo}`
        : "";

      const firstGroup = groups[0];
      const firstGroupIsParallel = firstGroup.length > 1 && worktreePool;

      if (firstGroupIsParallel) {
        // Build explicit parallel_subagents call for the first group
        const agentConfigs = firstGroup.map((stepIdx) => {
          const step = plan.steps.find((s) => s.index === stepIdx)!;
          const wtPath = worktreePool!.getPath(stepIdx);
          return {
            name: `step-${stepIdx}`,
            task: `You are implementing Step ${stepIdx} of a plan.\n\n## Step ${stepIdx}: ${step.description}\n\n### Acceptance Criteria\n${step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n### Files to modify\n${step.artifacts.join(", ")}\n\n⚠️ SCOPE CONSTRAINT: You MUST NOT create or modify any files outside the list above. If you believe additional files need changes, note them in your summary but DO NOT modify them.\n\n### Working Directory\ncd to: ${wtPath ?? ctx.cwd}\n\nImplement the step.\n\nWhen done implementing, STOP and do a fresh-eyes review: carefully read over ALL the new code you just wrote and any existing code you modified, looking super carefully for any obvious bugs, errors, problems, issues, or confusion. Fix anything you uncover.\n\nThen COMMIT your changes:\n\`\`\`bash\ncd ${wtPath ?? ctx.cwd}\ngit add ${step.artifacts.map(f => '"' + f + '"').join(' ')} && git commit -m "step ${stepIdx}: ${step.description.slice(0, 60)}"\n\`\`\`\n\nThen summarize what you did and what the fresh-eyes review found.`,
          };
        });

        // Include parallel launch instruction directly in tool result —
        // NOT via sendUserMessage followUp, which arrives late and causes
        // duplicate instructions if the LLM already acted on the tool result.
        const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);

        // Start swarm tender to monitor parallel agents
        if (worktreePool) {
          const { SwarmTender } = await import("./tender.js");
          const worktreeInfos = firstGroup
            .map((idx) => ({ path: worktreePool!.getPath(idx)!, stepIndex: idx }))
            .filter((w) => w.path);
          if (worktreeInfos.length > 0) {
            swarmTender = new SwarmTender(pi, ctx.cwd, worktreeInfos, {
              onStuck: (agent) => {
                ctx.ui.notify(`⚠️ Step ${agent.stepIndex} agent appears stuck (no activity for 5 min)`, "warning");
              },
              onConflict: (conflict) => {
                ctx.ui.notify(`⚠️ Conflict: ${conflict.file} modified in steps ${conflict.stepIndices.join(", ")}`, "warning");
              },
            });
            swarmTender.start();
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`parallel_subagents\` NOW to launch Group 1 (Steps ${firstGroup.join(", ")}).**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each step with the sub-agent's summary.\n\n---\n\nPlan approved! ${plan.steps.length} steps to execute.${sophiaInfo}${parallelInfo}\n\n🔄 Swarm tender active — monitoring agent health every 60s.`,
            },
          ],
          details: { approved: true, plan, parallelGroups: groups, sophiaCR: sophiaCRResult?.cr, launchingParallel: true },
        };
      }

      // Sequential: start with step 1
      const firstStep = plan.steps[0];
      const implInstr = implementerInstructions(
        firstStep,
        state.repoProfile!,
        state.stepResults
      );

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Implement Step 1 NOW, then call \`orch_review\` when done.**\n\nPlan approved! ${plan.steps.length} steps to execute.${sophiaInfo}${parallelInfo}\n\n---\n\n${implInstr}`,
          },
        ],
        details: { approved: true, plan, parallelGroups: groups, sophiaCR: sophiaCRResult?.cr },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_plan ")) +
          theme.fg("dim", `${(args as any).steps?.length ?? "?"} steps`),
        0, 0
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d?.approved) return new Text(theme.fg("warning", "📝 Plan rejected"), 0, 0);
      let text = theme.fg("success", `📝 Plan approved — ${d.plan?.steps?.length} steps`);
      if (expanded && d?.plan?.steps) {
        for (const s of d.plan.steps) {
          text += `\n  ${s.index}. ${s.description}`;
        }
      }
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
      const peerAgents = [
        {
          name: `peer-bugs-r${round}`,
          task: `Peer reviewer (round ${round}). Review code written by your fellow agents. Check for issues, bugs, errors, inefficiencies, security problems, reliability issues. Diagnose root causes using first-principle analysis. Don't restrict to latest commits — cast a wider net and go super deep!\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-polish-r${round}`,
          task: `Polish reviewer (round ${round}). De-slopify the code. Remove AI slop, improve clarity, make it agent-friendly.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-ergonomics-r${round}`,
          task: `Ergonomics reviewer (round ${round}). If you came in fresh with zero context, would you understand this code? Fix anything confusing.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
        },
        {
          name: `peer-reality-r${round}`,
          task: `Reality checker (round ${round}).\n\n${realityCheckInstructions(st.plan!.goal, st.plan!.steps, st.stepResults)}\n\nDo NOT edit code. Just report findings.\n\ncd ${ctx.cwd}`,
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
    const agentConfigs = [
      {
        name: `fresh-eyes-r${round}`,
        task: `Fresh-eyes reviewer round ${round}. NEVER seen this code.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `polish-r${round}`,
        task: `Polish/de-slopify reviewer round ${round}.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nMake targeted edits directly — don't just report.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `ergonomics-r${round}`,
        task: `Agent-ergonomics reviewer round ${round}. Make this maximally intuitive for coding agents.\n\nGoal: ${st.plan!.goal}\nFiles: ${allArtifacts.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything that fails that test.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `reality-check-r${round}`,
        task: `Reality checker round ${round}.\n\n${realityCheckInstructions(st.plan!.goal, st.plan!.steps, st.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
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
        if (worktreePool) {
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
          const agentConfigs = [
            {
              name: `fresh-eyes-s${params.stepIndex}-r${round}`,
              task: `Fresh-eyes reviewer for step ${params.stepIndex} (round ${round}). NEVER seen this code.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-s${params.stepIndex}-r${round}`,
              task: `Polish reviewer for step ${params.stepIndex} (round ${round}). De-slopify.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-s${params.stepIndex}-r${round}`,
              task: `Ergonomics reviewer for step ${params.stepIndex} (round ${round}).\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-s${params.stepIndex}-r${round}`,
              task: `Reality checker for step ${params.stepIndex} (round ${round}).\n\n${realityCheckInstructions(state.plan!.goal, state.plan!.steps, state.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
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
          const agentConfigs = [
            {
              name: `fresh-eyes-s${params.stepIndex}-r${round}`,
              task: `Fresh-eyes reviewer for step ${params.stepIndex} (round ${round}). NEVER seen this code.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-s${params.stepIndex}-r${round}`,
              task: `Polish reviewer for step ${params.stepIndex} (round ${round}). De-slopify.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-s${params.stepIndex}-r${round}`,
              task: `Ergonomics reviewer for step ${params.stepIndex} (round ${round}).\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-s${params.stepIndex}-r${round}`,
              task: `Reality checker for step ${params.stepIndex} (round ${round}).\n\n${realityCheckInstructions(state.plan!.goal, state.plan!.steps, state.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
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
            // (they have worktrees or were part of a parallel_subagents call)
            // If so, tell the agent to call orch_review for them, not implement them.
            const alreadyImplemented = stillUnreviewed.filter(
              (s) => worktreePool?.getPath(s.index) || worktreePool?.getBranch(s.index)
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

                  if (nextGroup.length > 1 && worktreePool) {
                    // Launch next parallel group
                    const agentConfigs = nextGroup.map((stepIdx) => {
                      const s = state.plan!.steps.find((st) => st.index === stepIdx)!;
                      const wtPath = worktreePool!.getPath(stepIdx);
                      return {
                        name: `step-${stepIdx}`,
                        task: `You are implementing Step ${stepIdx} of a plan.\n\n## Step ${stepIdx}: ${s.description}\n\n### Acceptance Criteria\n${s.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n### Files to modify\n${s.artifacts.join(", ")}\n\n⚠️ SCOPE CONSTRAINT: You MUST NOT create or modify any files outside the list above.\n\n### Working Directory\ncd to: ${wtPath ?? ctx.cwd}\n\nImplement the step.\n\nWhen done, do a fresh-eyes review then COMMIT:\n\`\`\`bash\ncd ${wtPath ?? ctx.cwd}\ngit add ${s.artifacts.map(f => '"' + f + '"').join(' ')} && git commit -m "step ${stepIdx}: ${s.description.slice(0, 60)}"\n\`\`\`\n\nSummarize what you did.`,
                      };
                    });

                    const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
                    ctx.ui.notify(`✅ Group ${currentGroupIdx + 1} complete! Launching Group ${nextGroupIdx + 1} (steps ${nextGroup.join(", ")}).`, "info");

                    return {
                      content: [
                        {
                          type: "text",
                          text: `✅ Step ${params.stepIndex} passed. Group ${currentGroupIdx + 1} complete!\n\n**NEXT: Call \`parallel_subagents\` NOW to launch Group ${nextGroupIdx + 1} (Steps ${nextGroup.join(", ")}).**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each step.`,
                        },
                      ],
                      details: { review, nextGroup: nextGroup, launchingParallel: true },
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
          return await runGuidedGates(state, ctx, sophiaReviewInfo);
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
