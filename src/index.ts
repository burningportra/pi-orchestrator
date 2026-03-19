import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorPhase } from "./types.js";

const PHASE_LABELS: Record<OrchestratorPhase, string> = {
  idle: "⏸ Idle",
  profiling: "📊 Profiling",
  discovering: "💡 Discovering",
  selecting: "🎯 Selecting",
  planning: "📝 Planning",
  implementing: "🔨 Implementing",
  reviewing: "🔍 Reviewing",
  complete: "✅ Complete",
};

export default function (pi: ExtensionAPI) {
  let orchestrator: Orchestrator | null = null;
  let abortController: AbortController | null = null;

  // ─── Command: /orchestrate ───────────────────────────────────
  pi.registerCommand("orchestrate", {
    description:
      "Start the repo-aware multi-agent orchestrator. Profiles your repo, suggests ideas, plans, implements, and reviews.",
    handler: async (_args, ctx) => {
      if (orchestrator && orchestrator.state.phase !== "idle" && orchestrator.state.phase !== "complete") {
        const override = await ctx.ui.confirm(
          "Orchestrator Running",
          "An orchestration is in progress. Cancel it and start fresh?"
        );
        if (!override) return;
        abortController?.abort();
      }

      abortController = new AbortController();
      orchestrator = new Orchestrator(pi, ctx.cwd);

      ctx.ui.notify("🚀 Starting repo orchestrator...", "info");
      pi.setSessionName("Orchestrator Session");

      try {
        await orchestrator.run(ctx, abortController.signal);
      } catch (err: any) {
        if (err.name !== "AbortError") {
          ctx.ui.notify(`Orchestrator error: ${err.message}`, "error");
        }
      } finally {
        ctx.ui.setStatus("orchestrator", undefined);
      }
    },
  });

  // ─── Command: /orchestrate-stop ──────────────────────────────
  pi.registerCommand("orchestrate-stop", {
    description: "Stop the current orchestration run.",
    handler: async (_args, ctx) => {
      if (abortController) {
        abortController.abort();
        ctx.ui.notify("🛑 Orchestration stopped.", "warning");
      } else {
        ctx.ui.notify("No orchestration in progress.", "info");
      }
    },
  });

  // ─── Command: /orchestrate-status ────────────────────────────
  pi.registerCommand("orchestrate-status", {
    description: "Show current orchestration status.",
    handler: async (_args, ctx) => {
      if (!orchestrator) {
        ctx.ui.notify("No orchestration session.", "info");
        return;
      }

      const s = orchestrator.state;
      const lines = [
        `Phase: ${PHASE_LABELS[s.phase]}`,
        s.repoProfile ? `Repo: ${s.repoProfile.name}` : "",
        s.selectedGoal ? `Goal: ${s.selectedGoal}` : "",
        s.plan
          ? `Progress: Step ${s.currentStepIndex}/${s.plan.steps.length}`
          : "",
        s.stepResults.length > 0
          ? `Results: ${s.stepResults.filter((r) => r.status === "success").length} passed`
          : "",
      ].filter(Boolean);

      ctx.ui.setWidget("orchestrator-status", lines);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── Tool: orchestrate_repo ──────────────────────────────────
  pi.registerTool({
    name: "orchestrate_repo",
    label: "Orchestrate Repo",
    description:
      "Start the repo-aware multi-agent orchestrator. Profiles the repository, suggests project ideas, and runs a Planner → Implementer → Reviewer loop.",
    promptSnippet:
      "Start the repo orchestrator to profile, plan, implement, and review changes",
    promptGuidelines: [
      "Use orchestrate_repo when the user wants to discover and execute improvements on their codebase.",
      "The tool handles the full workflow: profile → discover ideas → plan → implement → review.",
    ],
    parameters: Type.Object({
      goal: Type.Optional(
        Type.String({
          description:
            "Optional: skip idea discovery and go straight to planning with this goal",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      abortController = new AbortController();
      orchestrator = new Orchestrator(pi, ctx.cwd);

      if (params.goal) {
        // Skip discovery, go straight to planning
        orchestrator.state.selectedGoal = params.goal;
      }

      onUpdate?.({
        content: [{ type: "text", text: "Starting orchestration..." }],
      });

      try {
        await orchestrator.run(ctx, abortController.signal);

        const s = orchestrator.state;
        const summary = [
          `## Orchestration Complete`,
          `- **Goal:** ${s.selectedGoal ?? "N/A"}`,
          `- **Steps completed:** ${s.stepResults.length}/${s.plan?.steps.length ?? 0}`,
          `- **Steps passed:** ${s.reviewResults.filter((r) => r.passed).length}`,
        ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
          details: {
            phase: s.phase,
            goal: s.selectedGoal,
            stepsCompleted: s.stepResults.length,
            stepsPassed: s.reviewResults.filter((r) => r.passed).length,
          },
        };
      } catch (err: any) {
        throw new Error(`Orchestration failed: ${err.message}`);
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("orchestrate_repo "));
      if (args.goal) {
        text += theme.fg("muted", `goal: "${args.goal}"`);
      } else {
        text += theme.fg("dim", "auto-discover mode");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", "⏳ Orchestrating..."),
          0,
          0
        );
      }

      const details = result.details as any;
      let text = theme.fg("success", "✅ Orchestration complete");
      if (expanded && details) {
        text += `\n  Goal: ${details.goal ?? "N/A"}`;
        text += `\n  Steps: ${details.stepsCompleted}/${details.stepsCompleted} completed`;
        text += `\n  Passed: ${details.stepsPassed}`;
      }
      return new Text(text, 0, 0);
    },
  });

  // ─── Widget: Phase indicator ─────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Restore state from session if needed
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === "orchestrator-state"
      ) {
        // Could restore state here for session continuity
      }
    }
  });

  pi.on("session_shutdown", async () => {
    abortController?.abort();
  });
}
