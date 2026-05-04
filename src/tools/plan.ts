import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
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
import { readMemory } from "../memory.js";

/**
 * Save a plan snapshot to docs/plans/ in the project repo.
 * Filenames: docs/plans/<date>-<slug>-<suffix>.md
 * Best-effort — errors are silently swallowed.
 */
export function saveDocsPlan(cwd: string, goal: string, suffix: "original" | "final", content: string): string | undefined {
  try {
    const slug = slugifyGoal(goal);
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(cwd, "docs", "plans");
    mkdirSync(dir, { recursive: true });
    const filename = `${date}-${slug}-${suffix}.md`;
    const dest = join(dir, filename);
    writeFileSync(dest, content, "utf8");
    return `docs/plans/${filename}`;
  } catch {
    return undefined;
  }
}

export function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan";
}

export function singleModelPlanArtifactName(goal: string) {
  return `plans/${slugifyGoal(goal)}.md`;
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

  // Fetch CASS context for planning (GAP 24)
  const cassContext = readMemory(cwd, goal) || undefined;
  
  const planners = [
    {
      name: "correctness",
      model: models.correctness,
      task: competingPlanAgentPrompt("correctness", goal, profile!, scanResult, cassContext),
      artifactName: artifactNames.planners.correctness,
    },
    {
      name: "robustness",
      model: models.robustness,
      task: competingPlanAgentPrompt("robustness", goal, profile!, scanResult, cassContext),
      artifactName: artifactNames.planners.robustness,
    },
    {
      name: "ergonomics",
      model: models.ergonomics,
      task: competingPlanAgentPrompt("ergonomics", goal, profile!, scanResult, cassContext),
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
  for (const toolName of ["orch_plan", "flywheel_plan"] as const) {
  oc.pi.registerTool({
    name: toolName,
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
        const artifactName = singleModelPlanArtifactName(goal);
        oc.state.planDocument = artifactName;
        oc.state.planRefinementRound = 0;
        oc.setPhase("planning", ctx);
        oc.persistState();
        return {
          content: [{
            type: "text",
            text:
              `**NEXT: Generate a single-model plan document and save it as a session artifact using \`write_artifact\` NOW.**\n\n` +
              `Use exactly this artifact name: \`${artifactName}\`.\n\n` +
              `${planDocumentPrompt(goal, profile, scanResult)}\n\n` +
              `After writing the artifact, immediately continue the workflow by calling \`orch_approve_beads\` to review the plan in-menu.`,
          }],
          details: { mode, goal, artifactName },
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

      // GAP 24: fetch CASS context to inject into planning prompts
      const cassContext = readMemory(ctx.cwd, goal) || undefined;

      // GAP 23: seed plan step — generate (or reuse) an initial plan before competing agents
      let seedPlanText: string | undefined;
      const seedArtifactName = `plans/${slugifyGoal(goal)}-seed.md`;
      const seedArtifactPath = sessionArtifactPath(ctx, seedArtifactName);
      if (existsSync(seedArtifactPath)) {
        seedPlanText = readFileSync(seedArtifactPath, "utf8").trim() || undefined;
      }
      if (!seedPlanText && savedPlannerResults.length === 0) {
        // Spawn one seed agent using the synthesis model (strongest available)
        const seedResults = await runDeepPlanAgents(
          oc.pi,
          ctx.cwd,
          [{ name: "seed", model: detectedModels.synthesis, task: planDocumentPrompt(goal, profile, scanResult) }],
          signal
        );
        seedPlanText = seedResults[0]?.exitCode === 0 ? seedResults[0].plan.trim() : undefined;
        if (seedPlanText) {
          mkdirSync(dirname(seedArtifactPath), { recursive: true });
          writeFileSync(seedArtifactPath, seedPlanText, "utf8");
        }
      }
      const seedAppendix = seedPlanText
        ? `\n\nHere is an initial plan draft — use it as a starting point, critique it, and improve it from your focus lens perspective:\n\n${seedPlanText}`
        : "";

      const planners: DeepPlanAgent[] = [
        {
          name: "correctness",
          model: detectedModels.correctness,
          task: competingPlanAgentPrompt("correctness", goal, profile, scanResult, cassContext) + seedAppendix,
        },
        {
          name: "robustness",
          model: detectedModels.robustness,
          task: competingPlanAgentPrompt("robustness", goal, profile, scanResult, cassContext) + seedAppendix,
        },
        {
          name: "ergonomics",
          model: detectedModels.ergonomics,
          task: competingPlanAgentPrompt("ergonomics", goal, profile, scanResult, cassContext) + seedAppendix,
        },
      ];

      // Only re-run planners that aren't already cached — preserve partial progress
      // on retry so we don't waste API calls re-running completed planners.
      const completedNames = new Set(savedPlannerResults.map((r) => r.name));
      const pendingPlanners = planners.filter((p) => !completedNames.has(p.name));
      const newPlanResults = pendingPlanners.length > 0
        ? await runDeepPlanAgents(oc.pi, ctx.cwd, pendingPlanners, signal)
        : [];
      const planResults = [...savedPlannerResults, ...newPlanResults];
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
      saveDocsPlan(ctx.cwd, goal, "original", synthesizedPlan);

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
          text:
            `**NEXT: Call \`orch_approve_beads\` NOW to review the synthesized plan in-menu.**\n\n` +
            `Saved synthesized multi-model plan to session artifact \`${artifactName}\`.\n\n` +
            `Planner runs:\n${plannerSummary}\n\n` +
            `Stay inside the orchestration workflow: review/approve the plan first, then create beads from the approved plan via the menu flow.`,
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
}
