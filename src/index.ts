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
  summaryInstructions,
} from "./prompts.js";

const PHASE_EMOJI: Record<OrchestratorPhase, string> = {
  idle: "⏸",
  profiling: "📊",
  discovering: "💡",
  awaiting_selection: "🎯",
  planning: "📝",
  awaiting_plan_approval: "📋",
  implementing: "🔨",
  reviewing: "🔍",
  complete: "✅",
};

export default function (pi: ExtensionAPI) {
  let state: OrchestratorState = createInitialState();
  let orchestratorActive = false;

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
    ctx.ui.setWidget("orchestrator", lines);
  }

  // ─── Inject orchestrator system prompt when active ───────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!orchestratorActive) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + orchestratorSystemPrompt(),
    };
  });

  // ─── Restore state from session ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "orchestrator-state") {
        state = entry.data as OrchestratorState;
        orchestratorActive = state.phase !== "idle" && state.phase !== "complete";
      }
    }
  });

  pi.on("session_shutdown", async () => {
    orchestratorActive = false;
  });

  // ─── Helper: persist state ───────────────────────────────────
  function persistState() {
    pi.appendEntry("orchestrator-state", { ...state });
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
      });

      const profile = await profileRepo(pi, ctx.cwd, signal);
      state.repoProfile = profile;
      persistState();

      setPhase("discovering", ctx);

      const formatted = formatRepoProfile(profile);
      return {
        content: [
          {
            type: "text",
            text: `Repository profiled successfully.\n\n${formatted}\n\n---\nNext: Call \`orch_discover\` to generate project ideas based on this profile.`,
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
        { description: "3-7 project ideas based on the repo profile" }
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

      const choice = await ctx.ui.select(
        "🎯 Select a project idea to implement:",
        options
      );

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
      if (choice === options.length - 1) {
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
        const idea = state.candidateIdeas[choice];
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

      const instructions = plannerInstructions(
        goal,
        state.repoProfile!,
        state.constraints
      );

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
          (s) =>
            `${s.index}. ${s.description}\n   ✓ ${s.acceptanceCriteria.join("\n   ✓ ")}\n   📄 ${s.artifacts.join(", ")}`
        )
        .join("\n\n");

      setPhase("awaiting_plan_approval", ctx);

      const approved = await ctx.ui.confirm(
        `📝 Plan: ${plan.goal}`,
        `${planText}\n\nApprove this plan?`
      );

      if (!approved) {
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
            text: `Plan approved! ${plan.steps.length} steps to execute.\n\n---\nStarting Step 1:\n\n${implInstr}`,
          },
        ],
        details: { approved: true, plan },
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

      const existingReviewIdx = state.reviewVerdicts.findIndex(
        (r) => r.stepIndex === params.stepIndex
      );
      if (existingReviewIdx >= 0) {
        state.reviewVerdicts[existingReviewIdx] = review;
      } else {
        state.reviewVerdicts.push(review);
      }

      persistState();

      if (params.verdict === "pass") {
        // Move to next step or complete
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

          ctx.ui.notify(`✅ Step ${params.stepIndex} passed!`, "info");

          return {
            content: [
              {
                type: "text",
                text: `✅ Step ${params.stepIndex} passed review.\n\n---\nMoving to Step ${nextStep.index}:\n\n${implInstr}`,
              },
            ],
            details: { review, nextStep: nextStep.index },
          };
        } else {
          // All steps done
          setPhase("complete", ctx);
          persistState();

          const summaryInstr = summaryInstructions(
            state.plan.goal,
            state.plan.steps,
            state.stepResults
          );

          ctx.ui.notify("🎉 All steps completed!", "info");
          orchestratorActive = false;

          return {
            content: [
              {
                type: "text",
                text: `🎉 All ${state.plan.steps.length} steps completed and passed review!\n\n---\n${summaryInstr}`,
              },
            ],
            details: { review, complete: true },
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
