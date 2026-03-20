import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
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
} from "./prompts.js";
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
  let state: OrchestratorState = createInitialState();
  let orchestratorActive = false;
  let hasSophia = false;
  let sophiaCRResult: PlanToCRResult | undefined;
  let worktreePool: WorktreePool | undefined;
  let parallelAnalysis: ParallelAnalysis | undefined;
  let swarmTender: import("./tender.js").SwarmTender | undefined;

  function setPhase(phase: OrchestratorPhase, ctx: ExtensionContext) {
    state.phase = phase;
    if (phase === "idle" || phase === "complete") {
      ctx.ui.setStatus("orchestrator", undefined);
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
        orchestratorActive = state.phase !== "idle" && state.phase !== "complete";

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
      if (swarmTender) { swarmTender.stop(); swarmTender = undefined; }
        }
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
      onUpdate?.({
        content: [{ type: "text", text: "Scanning repository..." }],
        details: {},
      });

      const profile = await profileRepo(pi, ctx.cwd, signal);
      state.repoProfile = profile;
      persistState();

      setPhase("discovering", ctx);

      const formatted = formatRepoProfile(profile);

      const discoveryMode = await ctx.ui.select(
        "Discovery mode:",
        [
          "📋 Standard — 3-7 practical ideas",
          "🚀 Creative — think of 100, tell me your 7 best",
        ]
      );

      const isCreative = discoveryMode?.startsWith("🚀");
      const discoveryPrompt = isCreative
        ? `**🚀 Creative Discovery Mode**\n\nCome up with your top 7 most brilliant ideas for adding extremely powerful and cool functionality that will make this system far more compelling, useful, intuitive, versatile, powerful, robust, and reliable for users. Be pragmatic — don't suggest features that are extremely hard to implement or not worth the complexity. But I don't want you to just think of 7 ideas: seriously think hard, come up with ONE HUNDRED ideas internally, then only tell me your 7 VERY BEST and most brilliant, clever, and radically innovative ideas.\n\nCall \`orch_discover\` with your top 7.`
        : `Next: Call \`orch_discover\` to generate project ideas based on this profile.`;

      return {
        content: [
          {
            type: "text",
            text: `Repository profiled successfully.\n\n${formatted}\n\n---\n${discoveryPrompt}`,
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
            text: `Generated ${state.candidateIdeas.length} project ideas:\n\n${ideaList}\n\n---\nNext: Call \`orch_select\` to present these to the user for selection.`,
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

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
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
        goal = custom;
      } else {
        const choiceIndex = options.indexOf(choice);
        const idea = state.candidateIdeas[choiceIndex];
        goal = `${idea.title}: ${idea.description}`;
      }

      state.selectedGoal = goal;
      setPhase("planning", ctx);
      persistState();

      // Ask for constraints
      const constraintInput = await ctx.ui.input(
        "Any constraints? (comma-separated, or leave empty)",
        "e.g., no new dependencies, keep backward compat"
      );
      state.constraints = constraintInput
        ? constraintInput.split(",").map((c) => c.trim()).filter(Boolean)
        : [];
      persistState();

      // Ask: standard plan or deep plan (3 competing agents → synthesis)?
      const planMode = await ctx.ui.select(
        "Planning mode:",
        [
          "📋 Standard — single plan",
          "🧠 Deep plan — 3 competing agents → best-of-all-worlds synthesis",
        ]
      );

      const isDeepPlan = planMode?.startsWith("🧠");

      const instructions = plannerInstructions(
        goal,
        state.repoProfile!,
        state.constraints
      );

      if (isDeepPlan) {
        // Spawn 3 parallel agents to create competing plans
        const profileSummary = formatRepoProfile(state.repoProfile!);
        const planPrompt = `Create a detailed step-by-step plan (3-7 steps) for this goal.\n\n## Goal\n${goal}\n\n## Repo\n${profileSummary}\n\n## Constraints\n${state.constraints.length > 0 ? state.constraints.join(", ") : "None"}\n\n**IMPORTANT: Output your plan as plain text. Do NOT call any orch_ tools (orch_plan, orch_select, etc). Do NOT try to implement anything. Just write the plan and summarize it.**\n\nReturn your plan as a numbered list with: step description, acceptance criteria, and files to modify. Be specific and opinionated.`;

        // Let user pick 3 models from available ones
        const available = ctx.modelRegistry.getAvailable();

        // Group by provider, pick best per provider, sort by context window
        const byProvider = new Map<string, typeof available>();
        for (const m of available) {
          const list = byProvider.get(m.provider) ?? [];
          list.push(m);
          byProvider.set(m.provider, list);
        }

        // Build selectable options: "provider/model-id (context, reasoning)"
        const modelOptions = available
          .sort((a, b) => b.contextWindow - a.contextWindow)
          .map((m) => {
            const ctx_k = m.contextWindow >= 1000000
              ? `${(m.contextWindow / 1000000).toFixed(1)}M`
              : `${Math.round(m.contextWindow / 1000)}K`;
            const r = m.reasoning ? "🧠" : "";
            return `${m.provider}/${m.id} (${ctx_k}${r})`;
          });

        // Pick 3 models
        const labels = ["Alpha (correctness)", "Beta (robustness)", "Gamma (ergonomics)"];
        const pickedModels: (string | undefined)[] = [];

        for (const label of labels) {
          const choice = await ctx.ui.select(
            `Pick model for Planner ${label}:`,
            modelOptions
          );
          if (choice) {
            // Extract "provider/model-id" from "provider/model-id (context...)"
            pickedModels.push(choice.split(" (")[0]);
          } else {
            pickedModels.push(undefined);
          }
        }

        type PlanAgent = { name: string; task: string; model?: string; tools?: string };
        const agentConfigs: PlanAgent[] = [
          {
            name: "planner-alpha",
            task: `You are Planner Alpha. ${planPrompt}\n\nFocus on: correctness, minimal scope, and clean architecture.\n\ncd ${ctx.cwd}`,
            tools: "read,bash,grep,find,ls",
            ...(pickedModels[0] ? { model: pickedModels[0] } : {}),
          },
          {
            name: "planner-beta",
            task: `You are Planner Beta. ${planPrompt}\n\nFocus on: robustness, edge cases, and testing strategy.\n\ncd ${ctx.cwd}`,
            tools: "read,bash,grep,find,ls",
            ...(pickedModels[1] ? { model: pickedModels[1] } : {}),
          },
          {
            name: "planner-gamma",
            task: `You are Planner Gamma. ${planPrompt}\n\nFocus on: developer experience, ergonomics, and future extensibility.\n\ncd ${ctx.cwd}`,
            tools: "read,bash,grep,find,ls",
            ...(pickedModels[2] ? { model: pickedModels[2] } : {}),
          },
        ];

        const modelInfo = `\n\nModels selected:\n${agentConfigs.map((a) => `- **${a.name}**: ${a.model ?? "default"}`).join("\n")}`;

        setPhase("planning", ctx);
        persistState();

        // Return immediately with parallel_subagents JSON — don't block the tool
        const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);

        return {
          content: [
            {
              type: "text",
              text: `User selected goal: "${goal}"${state.constraints.length > 0 ? `\nConstraints: ${state.constraints.join(", ")}` : ""}\n\n---\n## 🧠 Deep Planning — 3 Competing Plans${modelInfo}\n\n**Call \`parallel_subagents\` NOW:**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all 3 complete, **synthesize the best ideas from all plans** into one superior "best of all worlds" hybrid. Be intellectually honest about what each planner did better. Then call \`orch_plan\` with the synthesized plan.`,
            },
          ],
          details: { selected: true, goal, constraints: state.constraints, deepPlan: true },
        };
      }

      // Standard: single plan
      return {
        content: [
          {
            type: "text",
            text: `User selected goal: "${goal}"${state.constraints.length > 0 ? `\nConstraints: ${state.constraints.join(", ")}` : ""}\n\n---\nNext: Call \`orch_plan\` with a structured plan.\n\n${instructions}`,
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
          "🚀 Creative brainstorm — enhance before approving",
          "❌ Reject",
        ]
      );

      if (planChoice?.startsWith("🚀")) {
        const brainstormTask = `You are a creative brainstormer. Here is a plan that needs enhancement:\n\n${planText}\n\nGoal: ${plan.goal}\n\nThink of ONE HUNDRED ways to make this plan more powerful, innovative, and robust. Then pick only your 3-5 VERY BEST and most brilliant, clever, and radically innovative ideas. Be pragmatic — skip anything that isn't worth the complexity.\n\nOutput ONLY your top ideas as a numbered list with a one-sentence justification each. Do NOT rewrite the plan. Do NOT call any tools.`;

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

        const brainstormJson = JSON.stringify({ agents: brainstormAgents }, null, 2);

        return {
          content: [
            {
              type: "text",
              text: `## 🚀 Creative Brainstorm — 3 Parallel Agents\n\nSpawning 3 brainstormers with different angles:\n- **innovator**: novel features nobody has thought of\n- **hardener**: robustness, failure modes, safety\n- **simplifier**: reduce complexity, find shortcuts\n\n**Call \`parallel_subagents\` NOW:**\n\n\`\`\`json\n${brainstormJson}\n\`\`\`\n\nAfter all 3 complete, synthesize the best ideas from all brainstormers. Fold the top 3-5 enhancements into the plan and call \`orch_plan\` again with the creatively enhanced steps.`,
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
      setPhase("implementing", ctx);
      persistState();

      // Create Sophia CR if available
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
          }
        }
      }

      // Polish tasks in plan space — loop until user is satisfied
      let polishing = true;
      while (polishing) {
        const taskList = plan.steps
          .map((s) => `**Step ${s.index}: ${s.description}**\n   ✓ ${s.acceptanceCriteria.join("\n   ✓ ")}\n   📄 ${s.artifacts.join(", ")}${s.dependsOn !== undefined ? (s.dependsOn.length === 0 ? "\n   ⚡ independent" : `\n   🔗 depends on: ${s.dependsOn.join(", ")}`) : ""}`)
          .join("\n\n");

        const polishChoice = await ctx.ui.select(
          `${plan.steps.length} tasks ready.${sophiaInfo}\n\n${taskList}`,
          [
            "▶️  Start implementing",
            "🔍 Polish — send tasks back for LLM review",
            "❌ Reject plan",
          ]
        );

        if (polishChoice?.startsWith("🔍")) {
          // Return to LLM for revision — it will call orch_plan again
          return {
            content: [
              {
                type: "text",
                text: `## 🔍 Task Polishing${sophiaInfo}\n\n${taskList}\n\n---\n\nCheck over each task super carefully — are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? It's a lot easier and faster to operate in "plan space" before we start implementing!\n\nRevise and call \`orch_plan\` again with updated steps (sophia tasks will be recreated).`,
              },
            ],
            details: { approved: true, plan, polishing: true, sophiaCR: sophiaCRResult?.cr },
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
            task: `You are implementing Step ${stepIdx} of a plan.\n\n## Step ${stepIdx}: ${step.description}\n\n### Acceptance Criteria\n${step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n### Files to modify\n${step.artifacts.join(", ")}\n\n### Working Directory\ncd to: ${wtPath ?? ctx.cwd}\n\nImplement the step.\n\nWhen done implementing, STOP and do a fresh-eyes review: carefully read over ALL the new code you just wrote and any existing code you modified, looking super carefully for any obvious bugs, errors, problems, issues, or confusion. Fix anything you uncover.\n\nThen COMMIT your changes:\n\`\`\`bash\ncd ${wtPath ?? ctx.cwd}\ngit add -A && git commit -m "step ${stepIdx}: ${step.description.slice(0, 60)}"\n\`\`\`\n\nThen summarize what you did and what the fresh-eyes review found.`,
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
              text: `Plan approved! ${plan.steps.length} steps to execute.${sophiaInfo}${parallelInfo}\n\n---\n**IMPORTANT: Call \`parallel_subagents\` NOW to launch Group 1 (Steps ${firstGroup.join(", ")}).**\n\nUse exactly these parameters:\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\n🔄 Swarm tender active — monitoring agent health every 60s.\n\nAfter all agents complete, call \`orch_review\` for each step with the sub-agent's summary.`,
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
            text: `Plan approved! ${plan.steps.length} steps to execute.${sophiaInfo}${parallelInfo}\n\n---\nStarting Step 1:\n\n${implInstr}`,
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

      // Sentinel: any orch_review while iterating = show next gate
      if (state.phase === "iterating" && (!step || params.stepIndex > state.plan.steps.length)) {
        const allArtifacts = [...new Set(state.plan.steps.flatMap((s) => s.artifacts))];
        const polish = polishInstructions(state.plan.goal, allArtifacts);
        const summaryText = summaryInstructions(state.plan.goal, state.plan.steps, state.stepResults);

        state.iterationRound = (state.iterationRound ?? 0) + 1;
        const round = state.iterationRound;
        persistState();

        // Sequential guided flow — each gate offers "do this" or "skip"
        const gates = [
          { emoji: "🔍", label: "Fresh self-review", desc: "read all new code with fresh eyes" },
          { emoji: "👥", label: "Peer review", desc: "parallel agents review each other's work" },
          { emoji: "🧪", label: "Test coverage", desc: "check unit tests + e2e, create tasks for gaps" },
          { emoji: "📦", label: "Commit", desc: "logical groupings with detailed messages" },
          { emoji: "🚀", label: "Ship it", desc: "commit, tag, release, deploy, monitor CI" },
        ];

        let chosen: string | undefined;
        for (const gate of gates) {
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
          if (pick.startsWith("⏭️")) continue;
          chosen = pick;
          break;
        }

        // If we ran through all gates without picking, we're done
        if (!chosen) chosen = "✅";

        if (!chosen || chosen.startsWith("✅")) {
          orchestratorActive = false;
          setPhase("complete", ctx);
          persistState();
          return {
            content: [
              { type: "text", text: `${summaryText}\n\nOrchestration complete after ${round} round(s).` },
            ],
            details: { complete: true, rounds: round },
          };
        }

        if (chosen.startsWith("🔍")) {
          // Fresh self-review — LLM reviews its own code
          return {
            content: [
              {
                type: "text",
                text: `## 🔍 Fresh Self-Review — Round ${round}\n\nCarefully read over ALL the new code you just wrote and any existing code you modified with "fresh eyes" looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Carefully fix anything you uncover.\n\nFiles changed:\n${allArtifacts.map((a) => `- ${a}`).join("\n")}\n\nAfter fixing everything, **commit**: commit all changed files in logically connected groupings with super detailed commit messages and push. Don't edit code during commit. Don't commit ephemeral files.\n\nAfter committing, call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" for the next option.`,
              },
            ],
            details: { iterating: true, round, selfReview: true },
          };
        }

        if (chosen.startsWith("👥")) {
          // Peer review — 4 parallel agents with different review angles
          const peerAgents = [
            {
              name: `peer-bugs-r${round}`,
              task: `Peer reviewer (round ${round}). Review code written by your fellow agents. Check for issues, bugs, errors, inefficiencies, security problems, reliability issues. Diagnose root causes using first-principle analysis. Don't restrict to latest commits — cast a wider net and go super deep!\n\nGoal: ${state.plan.goal}\nFiles: ${allArtifacts.join(", ")}\n\nMake fixes directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `peer-polish-r${round}`,
              task: `Polish reviewer (round ${round}). De-slopify the code. Remove AI slop, improve clarity, make it agent-friendly.\n\nGoal: ${state.plan.goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nMake targeted edits directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `peer-ergonomics-r${round}`,
              task: `Ergonomics reviewer (round ${round}). If you came in fresh with zero context, would you understand this code? Fix anything confusing.\n\nGoal: ${state.plan.goal}\nFiles: ${allArtifacts.join(", ")}\n\nMake fixes directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `peer-reality-r${round}`,
              task: `Reality checker (round ${round}).\n\n${realityCheckInstructions(state.plan.goal, state.plan.steps, state.stepResults)}\n\nDo NOT edit code. Just report findings.\n\ncd ${ctx.cwd}`,
            },
          ];
          const peerJson = JSON.stringify({ agents: peerAgents }, null, 2);
          return {
            content: [
              {
                type: "text",
                text: `## 👥 Peer Review — Round ${round}\n\nSpawning 4 parallel reviewers:\n- **bugs**: root-cause analysis, security, reliability\n- **polish**: de-slopify, clarity\n- **ergonomics**: agent-friendliness\n- **reality-check**: are we on track?\n\n**Call \`parallel_subagents\` NOW:**\n\n\`\`\`json\n${peerJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then **commit**: commit all changed files in logically connected groupings with super detailed messages and push. Don't edit code during commit. Don't commit ephemeral files.\n\nAfter committing, call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" for the next option.`,
              },
            ],
            details: { iterating: true, round, peerReview: true },
          };
        }

        if (chosen.startsWith("🧪")) {
          // Test coverage check — assess gaps and create tasks
          return {
            content: [
              {
                type: "text",
                text: `## 🧪 Test Coverage Check — Round ${round}\n\nDo we have full unit test coverage without using mocks or fake stuff? What about complete e2e integration test scripts with great, detailed logging?\n\nReview the current state:\n- Goal: ${state.plan.goal}\n- Files: ${allArtifacts.join(", ")}\n\nIf test coverage is incomplete, create a comprehensive and granular set of tasks for all missing tests, with subtasks and dependency structure, with detailed comments so the whole thing is totally self-contained and self-documenting.\n\nFor unit tests: test real behavior, not mocked interfaces. For e2e: full integration scripts with detailed logging at each stage.\n\nAfter assessing (and creating test tasks if needed), call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" for the next option.`,
              },
            ],
            details: { iterating: true, round, testCoverage: true },
          };
        }

        if (chosen.startsWith("📦")) {
          // Commit with logical groupings
          return {
            content: [
              {
                type: "text",
                text: `## 📦 Commit — Round ${round}\n\nBased on your knowledge of the project, commit all changed files now in a series of logically connected groupings with super detailed commit messages for each. Take your time to do it right.\n\nRules:\n- Group by logical change, NOT by file\n- Each commit should be independently understandable\n- Use conventional commit format: type(scope): description\n- First line ≤ 72 chars, then blank line, then detailed body\n- Body explains WHY, not just WHAT\n- Don't edit the code at all\n- Don't commit obviously ephemeral files\n- Push after committing\n\nAfter committing, call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" for the next option.`,
              },
            ],
            details: { iterating: true, round, committing: true },
          };
        }

        if (chosen.startsWith("🚀")) {
          // Ship it — full GitHub workflow
          return {
            content: [
              {
                type: "text",
                text: `## 🚀 Ship It — Round ${round}\n\nDo all the GitHub stuff:\n1. **Commit** all remaining changes in logical groupings with detailed messages\n2. **Push** to remote\n3. **Create tag** with semantic version bump (based on changes: feat=minor, fix=patch)\n4. **Create GitHub release** with changelog from commits since last tag\n5. **Monitor CI** — check GitHub Actions status, wait for green\n6. **Compute checksums** if there are distributable artifacts\n7. **Bump version** in package.json if applicable\n\nDo each step and report status. If any step fails, stop and report why.\n\nAfter shipping, call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" for the next option.`,
              },
            ],
            details: { iterating: true, round, shipping: true },
          };
        }

        // "🔥 Hit me" — spawn 4 parallel review agents
        const agentConfigs = [
          {
            name: `fresh-eyes-r${round}`,
            task: `Fresh-eyes reviewer round ${round}. NEVER seen this code.\n\nGoal: ${state.plan.goal}\nFiles: ${allArtifacts.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Give exact file:line fixes.\n\ncd ${ctx.cwd}`,
          },
          {
            name: `polish-r${round}`,
            task: `Polish/de-slopify reviewer round ${round}.\n\nGoal: ${state.plan.goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nMake targeted edits directly — don't just report.\n\ncd ${ctx.cwd}`,
          },
          {
            name: `ergonomics-r${round}`,
            task: `Agent-ergonomics reviewer round ${round}. Make this maximally intuitive for coding agents.\n\nGoal: ${state.plan.goal}\nFiles: ${allArtifacts.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything that fails that test.\n\ncd ${ctx.cwd}`,
          },
          {
            name: `reality-check-r${round}`,
            task: `Reality checker round ${round}.\n\n${realityCheckInstructions(state.plan.goal, state.plan.steps, state.stepResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
          },
        ];

        const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
        return {
          content: [
            {
              type: "text",
              text: `## 🔥 Hit me — Round ${round}\n\nSpawning 4 parallel review agents: fresh-eyes, polish, ergonomics, reality-check.\n\n**Call \`parallel_subagents\` NOW:**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then **commit**: commit all changed files in logically connected groupings with super detailed commit messages and push. Don't edit code during commit. Don't commit ephemeral files.\n\nAfter committing, call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" for the next option.`,
            },
          ],
          details: { iterating: true, round, agents: agentConfigs.map((a) => a.name) },
        };
      }

      if (!step) {
        throw new Error(`Step ${params.stepIndex} not found in plan.`);
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
        // (not derived from verdicts array — survives regardless of how state is serialized)
        const prevPassCount = state.reviewPassCounts[params.stepIndex] ?? 0;
        state.reviewPassCounts[params.stepIndex] = prevPassCount + 1;
        persistState();

        setPhase("reviewing", ctx);

        // After first pass: ask user to hit-me or move on
        // After hit-me round (prevPassCount > 0): auto-advance — agents already reviewed
        const allArtifactsForStep = step.artifacts;
        let hitMeChoice: string | undefined;
        if (prevPassCount === 0) {
          // First review pass — user decides
          hitMeChoice = await ctx.ui.select(
            `✅ Step ${params.stepIndex} passed self-review.`,
            [
              "🔥 Hit me — spawn parallel review agents for this step",
              "✅ Looks good — move on",
            ]
          );
        } else {
          // Returning from a hit-me round — auto-advance
          hitMeChoice = "✅";
          ctx.ui.notify(`✅ Step ${params.stepIndex} passed review (round ${prevPassCount}).`, "info");
        }

        if (hitMeChoice?.startsWith("🔥")) {
          const round = prevPassCount;
          const stepDesc = step.description.slice(0, 60);
          const agentConfigs = [
            {
              name: `fresh-eyes-s${params.stepIndex}-r${round}`,
              task: `Fresh-eyes reviewer for step ${params.stepIndex} (round ${round}). NEVER seen this code.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Give exact file:line fixes.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-s${params.stepIndex}-r${round}`,
              task: `Polish reviewer for step ${params.stepIndex} (round ${round}). De-slopify.\n\nStep: ${step.description}\nFiles: ${allArtifactsForStep.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Make edits directly.\n\ncd ${ctx.cwd}`,
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

          const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);

          ctx.ui.notify(`🔥 Hit me — round ${round} for step ${params.stepIndex}`, "info");

          return {
            content: [
              {
                type: "text",
                text: `## 🔥 Hit me — Step ${params.stepIndex}, Round ${round}\n\n**Call \`parallel_subagents\` NOW:**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all complete, present findings then call \`orch_review\` again for step ${params.stepIndex} with what was fixed.`,
              },
            ],
            details: { review, hitMe: true, round, step: params.stepIndex },
          };
        }

        // User said "looks good" — move to next step or complete
        const nextStep = state.plan.steps.find(
          (s) => s.index === params.stepIndex + 1
        );

        if (nextStep) {
          // Check if remaining steps can be skipped (work already done)
          const remainingSteps = state.plan.steps.filter(
            (s) => s.index > params.stepIndex && !state.stepResults.find((r) => r.stepIndex === s.index)
          );
          if (remainingSteps.length > 1) {
            const skipChoice = await ctx.ui.select(
              `${remainingSteps.length} steps remaining. Some may already be done.`,
              [
                `▶️  Continue to step ${nextStep.index}`,
                "⏭️  Skip to completion — mark remaining steps as done",
              ]
            );
            if (skipChoice?.startsWith("⏭️")) {
              // Mark all remaining steps as done
              for (const rs of remainingSteps) {
                state.stepResults.push({
                  stepIndex: rs.index,
                  status: "success",
                  summary: "Skipped — work completed in earlier step",
                });
              }
              // Jump to completion path
              state.currentStepIndex = state.plan.steps[state.plan.steps.length - 1].index;
              persistState();
              // Fall through to the "all steps done" branch below
            }
          }

          // Re-check if we still have a next step (might have skipped)
          const actualNextStep = state.plan.steps.find(
            (s) => s.index > params.stepIndex && !state.stepResults.find((r) => r.stepIndex === s.index)
          );

          if (actualNextStep) {
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

        {
          // All steps done — cross-agent review + post-completion
          setPhase("reviewing", ctx);
          persistState();

          // Run sophia validate/review if available
          let sophiaReviewInfo = "";
          if (hasSophia && sophiaCRResult) {
            const { validateCR, reviewCR } = await import("./sophia.js");
            const valResult = await validateCR(pi, ctx.cwd, sophiaCRResult.cr.id);
            const revResult = await reviewCR(pi, ctx.cwd, sophiaCRResult.cr.id);
            sophiaReviewInfo = `\n\n**Sophia validation:** ${valResult.ok ? "✅ passed" : `⚠️ ${valResult.error}`}\n**Sophia review:** ${revResult.ok ? "✅ passed" : `⚠️ ${revResult.error}`}`;
          }

          const crossReview = crossAgentReviewInstructions(
            state.plan.goal,
            state.plan.steps,
            state.stepResults
          );

          const allArtifacts = [
            ...new Set(state.plan.steps.flatMap((s) => s.artifacts)),
          ];
          const summary = summaryInstructions(
            state.plan.goal,
            state.plan.steps,
            state.stepResults
          );
          const polish = polishInstructions(state.plan.goal, allArtifacts);
          const commits = commitStrategyInstructions(
            state.plan.steps,
            state.stepResults
          );
          const skillCheck = skillExtractionInstructions(
            state.plan.goal,
            allArtifacts
          );

          // Clean up remaining worktrees
          if (worktreePool) {
            await worktreePool.cleanup();
            worktreePool = undefined;
      if (swarmTender) { swarmTender.stop(); swarmTender = undefined; }
          }

          ctx.ui.notify("🔄 All steps done — post-implementation review", "info");
          setPhase("iterating", ctx);
          persistState();

          // Sequential post-implementation gates
          // Gate 1: Fresh self-review (the implementing agent reviews its own work)
          const selfReviewChoice = await ctx.ui.select(
            `🎉 All ${state.plan.steps.length} steps completed!${sophiaReviewInfo}`,
            [
              "🔍 Fresh self-review — read over all new code with fresh eyes",
              "⏭️  Skip to peer review",
              "✅ Done — finish orchestration",
            ]
          );

          if (!selfReviewChoice || selfReviewChoice.startsWith("✅")) {
            orchestratorActive = false;
            setPhase("complete", ctx);
            persistState();
            return {
              content: [{ type: "text", text: `${summary}\n\nOrchestration complete.` }],
              details: { review, complete: true },
            };
          }

          if (selfReviewChoice.startsWith("🔍")) {
            return {
              content: [
                {
                  type: "text",
                  text: `${summary}\n\n---\n## 🔍 Fresh Self-Review\n\nCarefully read over ALL the new code you just wrote and any existing code you modified with "fresh eyes" looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Carefully fix anything you uncover.\n\nFiles changed:\n${allArtifacts.map((a) => `- ${a}`).join("\n")}\n\nAfter fixing everything, call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" to proceed to peer review.`,
                },
              ],
              details: { review, iterating: true, selfReview: true },
            };
          }

          // User picked "skip to peer review" — trigger sentinel re-entry
          // which will show the full gate menu including peer review
          return {
            content: [
              {
                type: "text",
                text: `${summary}\n\nSkipping self-review. Call \`orch_review\` with stepIndex ${state.plan.steps.length + 1} and verdict "pass" to see the review options.`,
              },
            ],
            details: { review, iterating: true, skippedSelfReview: true },
          };
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
