import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runDeepPlanAgents, type DeepPlanAgent } from "../deep-plan.js";
import type { OrchestratorContext } from "../types.js";
import {
  competingPlanAgentPrompt,
  planSynthesisPrompt,
  planDocumentPrompt,
} from "../prompts.js";

function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan";
}

function sessionArtifactPath(ctx: ExtensionContext, name: string): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getSessionId();

  if (sessionFile && sessionId) {
    const artifactRoot = sessionFile.includes("/sessions/")
      ? sessionFile.replace(/\/sessions\/[^/]+$/, `/artifacts/${sessionId}`)
      : join(dirname(sessionFile), "..", "artifacts", sessionId);
    return join(artifactRoot, name);
  }

  return join(ctx.cwd, ".pi-orchestrator-artifacts", name);
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

      const planners: DeepPlanAgent[] = [
        {
          name: "correctness",
          model: "openai/gpt-5",
          task: competingPlanAgentPrompt("correctness", goal, profile, scanResult),
        },
        {
          name: "robustness",
          model: "anthropic/claude-sonnet-4.5",
          task: competingPlanAgentPrompt("robustness", goal, profile, scanResult),
        },
        {
          name: "ergonomics",
          model: "google/gemini-2.5-pro",
          task: competingPlanAgentPrompt("ergonomics", goal, profile, scanResult),
        },
      ];

      const planResults = await runDeepPlanAgents(oc.pi, ctx.cwd, planners, signal);
      const successfulPlans = planResults.filter((result) => result.exitCode === 0 && result.plan.trim().length > 0);
      if (successfulPlans.length === 0) {
        throw new Error("All competing planning agents failed.");
      }

      const synthesisResult = await runDeepPlanAgents(
        oc.pi,
        ctx.cwd,
        [{ name: "synthesis", model: "openai/gpt-5", task: planSynthesisPrompt(successfulPlans) }],
        signal
      );
      const synthesizedPlan = synthesisResult[0]?.plan?.trim();
      if (!synthesizedPlan) {
        throw new Error("Plan synthesis failed.");
      }

      const artifactName = `plans/${slugifyGoal(goal)}-multi-model.md`;
      const artifactPath = sessionArtifactPath(ctx, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, synthesizedPlan, "utf8");

      oc.state.planDocument = artifactName;
      oc.state.planRefinementRound = 0;
      oc.setPhase("awaiting_plan_approval", ctx);
      oc.persistState();

      const plannerSummary = successfulPlans
        .map((result) => `- ${result.name} (${result.model}) — ${result.elapsed}s`)
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
      const details = result.details as { artifactName?: string; mode?: string } | undefined;
      return new Text(
        theme.fg("success", "📋 Plan ready") +
          theme.fg("dim", details?.artifactName ? ` → ${details.artifactName}` : ""),
        0, 0
      );
    },
  });
}
