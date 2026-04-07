import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { runDeepPlanAgents, type DeepPlanAgent, type DeepPlanResult } from "../deep-plan.js";
import type { OrchestratorContext } from "../types.js";
import {
  competingPlanAgentPrompt,
  planSynthesisPrompt,
  planDocumentPrompt,
  DEEP_PLAN_MODELS,
} from "../prompts.js";
import { sessionArtifactPath } from "../session-artifacts.js";
import { getDeepPlanModels, detectAvailableModels, formatDetectedModels } from "../model-detection.js";

function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan";
}

export function multiModelPlanArtifactNames(goal: string) {
  const slug = slugifyGoal(goal);
  const baseDir = `plans/${slug}-multi-model`;
  return {
    final: `plans/${slug}-multi-model.md`,
    planners: {
      correctness: `${baseDir}/correctness.md`,
      robustness: `${baseDir}/robustness.md`,
      ergonomics: `${baseDir}/ergonomics.md`,
    },
  };
}

export function buildMultiModelPlanSubagentConfigs(
  cwd: string,
  goal: string,
  profile: OrchestratorContext["state"]["repoProfile"],
  scanResult: OrchestratorContext["state"]["scanResult"],
  ctx?: ExtensionContext,
) {
  const artifactNames = multiModelPlanArtifactNames(goal);
  
  // Use detected models if context is available, otherwise fall back to defaults
  const models = ctx ? getDeepPlanModels(ctx) : DEEP_PLAN_MODELS;
  
  const planners = [
    {
      name: "correctness",
      model: models.correctness,
      task: competingPlanAgentPrompt("correctness", goal, profile!, scanResult),
      artifactName: artifactNames.planners.correctness,
    },
    {
      name: "robustness",
      model: models.robustness,
      task: competingPlanAgentPrompt("robustness", goal, profile!, scanResult),
      artifactName: artifactNames.planners.robustness,
    },
    {
      name: "ergonomics",
      model: models.ergonomics,
      task: competingPlanAgentPrompt("ergonomics", goal, profile!, scanResult),
      artifactName: artifactNames.planners.ergonomics,
    },
  ] as const;

  return planners.map((planner) => ({
    name: `plan-${planner.name}`,
    agent: "planner",
    cwd,
    model: planner.model,
    task:
      `${planner.task}\n\n` +
      `After you finish the plan, save it with write_artifact using exactly this name: \`${planner.artifactName}\`.\n` +
      `Do not create beads. In your final response, mention that you wrote \`${planner.artifactName}\`.`,
  }));
}

function loadPlannerArtifacts(ctx: ExtensionContext, goal: string): DeepPlanResult[] {
  const artifactNames = multiModelPlanArtifactNames(goal);
  const models = getDeepPlanModels(ctx);
  const plannerEntries = [
    ["correctness", artifactNames.planners.correctness, models.correctness],
    ["robustness", artifactNames.planners.robustness, models.robustness],
    ["ergonomics", artifactNames.planners.ergonomics, models.ergonomics],
  ] as const;

  return plannerEntries.flatMap(([name, artifactName, model]) => {
    const filePath = sessionArtifactPath(ctx, artifactName);
    if (!existsSync(filePath)) {
      return [];
    }
    const plan = readFileSync(filePath, "utf8").trim();
    if (!plan) {
      return [];
    }
    return [{ name, model, plan, exitCode: 0, elapsed: 0 } satisfies DeepPlanResult];
  });
}

export function registerPlanTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_plan",
    label: "Generate Plan",
    description:
      "Generate a plan document for the selected goal. Supports single-model and multi-model competing-plan synthesis.",
    promptSnippet: "Generate a detailed plan document",
    parameters: Type.Object({
      mode: Type.Union([
        Type.Literal("single_model"),
        Type.Literal("multi_model"),
      ]),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!oc.state.selectedGoal || !oc.state.repoProfile) {
        throw new Error("No selected goal or repo profile. Call orch_profile and orch_select first.");
      }

      const mode = params.mode as "single_model" | "multi_model";
      const goal = oc.state.selectedGoal;
      const profile = oc.state.repoProfile;
      const scanResult = oc.state.scanResult;

      if (mode === "single_model") {
        oc.setPhase("planning", ctx);
        oc.persistState();
        return {
          content: [{
            type: "text",
            text: `**NEXT: Generate a single-model plan document and save it as a session artifact using \`write_artifact\` NOW.**\n\n${planDocumentPrompt(goal, profile, scanResult)}`,
          }],
          details: { mode, goal },
        };
      }

      const artifactNames = multiModelPlanArtifactNames(goal);
      const interactivePlannerConfigs = buildMultiModelPlanSubagentConfigs(ctx.cwd, goal, profile, scanResult, ctx);
      const savedPlannerResults = loadPlannerArtifacts(ctx, goal);

      if (ctx.hasUI && savedPlannerResults.length < interactivePlannerConfigs.length) {
        oc.state.planDocument = undefined;
        oc.setPhase("planning", ctx);
        oc.persistState();

        const completed = new Set(savedPlannerResults.map((result) => result.name));
        const pendingConfigs = interactivePlannerConfigs.filter((config) => !completed.has(config.name.replace(/^plan-/, "")));
        const statusLine = completed.size > 0
          ? `Completed planners: ${[...completed].join(", ")}\nPending planners: ${pendingConfigs.map((config) => config.name.replace(/^plan-/, "")).join(", ")}`
          : "No planner artifacts found yet.";

        return {
          content: [{
            type: "text",
            text:
              `**NEXT: Spawn interactive planning sub-agents using \`subagent\` NOW.**\n\n` +
              `${statusLine}\n\n` +
              `Launch one \`subagent\` call for each pending planner config below. ` +
              `Each planner writes its draft to a session artifact. After all planners complete, call \`orch_plan\` with mode \`multi_model\` again to synthesize the final plan.\n\n` +
              `\`\`\`json\n${JSON.stringify(pendingConfigs, null, 2)}\n\`\`\``,
          }],
          details: {
            mode,
            goal,
            interactive: true,
            awaitingPlannerArtifacts: true,
            plannerArtifacts: artifactNames.planners,
            pendingPlannerCount: pendingConfigs.length,
          },
        };
      }

      // Use detected models for non-interactive path
      const detectedModels = getDeepPlanModels(ctx);
      
      const planners: DeepPlanAgent[] = [
        {
          name: "correctness",
          model: detectedModels.correctness,
          task: competingPlanAgentPrompt("correctness", goal, profile, scanResult),
        },
        {
          name: "robustness",
          model: detectedModels.robustness,
          task: competingPlanAgentPrompt("robustness", goal, profile, scanResult),
        },
        {
          name: "ergonomics",
          model: detectedModels.ergonomics,
          task: competingPlanAgentPrompt("ergonomics", goal, profile, scanResult),
        },
      ];

      const planResults = savedPlannerResults.length === planners.length
        ? savedPlannerResults
        : await runDeepPlanAgents(oc.pi, ctx.cwd, planners, signal);
      const successfulPlans = planResults.filter((result) => result.exitCode === 0 && result.plan.trim().length > 0);
      if (successfulPlans.length === 0) {
        const failures = planResults
          .map((r) => `  - ${r.name} (${r.model}): exit=${r.exitCode}${r.error ? `, error=${r.error}` : ""}${r.plan ? `, output=${r.plan.slice(0, 200)}` : ""}`)
          .join("\n");
        
        // Show detected models for debugging
        const detected = detectAvailableModels(ctx);
        const detectedInfo = formatDetectedModels(detected);
        
        throw new Error(
          `All competing planning agents failed. Details:\n${failures}\n\n` +
          `${detectedInfo}\n\n` +
          `Try \`orch_plan({ mode: "single_model" })\` as a fallback.`
        );
      }

      const synthesisResult = await runDeepPlanAgents(
        oc.pi,
        ctx.cwd,
        [{ name: "synthesis", model: detectedModels.synthesis, task: planSynthesisPrompt(successfulPlans) }],
        signal
      );
      const synthesizedPlan = synthesisResult[0]?.plan?.trim();
      if (!synthesizedPlan) {
        throw new Error("Plan synthesis failed.");
      }

      const artifactName = artifactNames.final;
      const artifactPath = sessionArtifactPath(ctx, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, synthesizedPlan, "utf8");

      oc.state.planDocument = artifactName;
      oc.state.planRefinementRound = 0;
      oc.setPhase("awaiting_plan_approval", ctx);
      oc.persistState();

      const plannerSummary = successfulPlans
        .map((result) => `- ${result.name} (${result.model})${result.elapsed > 0 ? ` — ${result.elapsed}s` : " — artifact"}`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text: `Generated a synthesized multi-model plan and saved it as session artifact \`${artifactName}\`.\n\nPlanner runs:\n${plannerSummary}\n\nReview the saved plan, refine it if needed, then create beads from it.`,
        }],
        details: {
          mode,
          goal,
          artifactName,
          plannerCount: successfulPlans.length,
        },
      };
    },

    renderCall(args, theme) {
      const mode = (args as { mode?: string } | undefined)?.mode ?? "single_model";
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_plan ")) +
          theme.fg("dim", `generating ${mode === "multi_model" ? "multi-model" : "single-model"} plan...`),
        0, 0
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as {
        artifactName?: string;
        mode?: string;
        awaitingPlannerArtifacts?: boolean;
        pendingPlannerCount?: number;
      } | undefined;
      if (details?.awaitingPlannerArtifacts) {
        return new Text(
          theme.fg("accent", "🧠 Planner swarm") +
            theme.fg("dim", ` → waiting on ${details.pendingPlannerCount ?? 0} planner artifact(s)`),
          0, 0
        );
      }
      return new Text(
        theme.fg("success", "📋 Plan ready") +
          theme.fg("dim", details?.artifactName ? ` → ${details.artifactName}` : ""),
        0, 0
      );
    },
  });
}
