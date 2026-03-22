import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext } from "../types.js";
import type { ScanResult } from "../types.js";
import { scanRepo } from "../scan.js";
import {
  formatRepoProfile,
  discoveryInstructions,
  beadCreationPrompt,
} from "../prompts.js";
import { runGoalRefinement, extractConstraints } from "../goal-refinement.js";
import { detectCoordinationBackend, selectStrategy } from "../coordination.js";

export function registerProfileTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_profile",
    label: "Profile Repo",
    description:
      "Scan the current repository to collect its tech stack, structure, commits, TODOs, and key files. Returns a structured profile.",
    promptSnippet: "Profile the current repo (languages, frameworks, structure, commits, TODOs)",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      oc.setPhase("profiling", ctx);
      ctx.ui.notify(`pi-orchestrator v${oc.version}`, 'info');
      onUpdate?.({
        content: [{ type: "text", text: "Scanning repository..." }],
        details: {},
      });

      const scanResult: ScanResult = await scanRepo(oc.pi, ctx.cwd, signal);
      const profile = scanResult.profile;
      oc.state.scanResult = scanResult;
      oc.state.repoProfile = profile;

      // Detect all coordination backends (beads, agent-mail, sophia)
      const coordBackend = await detectCoordinationBackend(oc.pi, ctx.cwd);
      const coordStrategy = selectStrategy(coordBackend);
      oc.state.coordinationBackend = coordBackend;
      oc.state.coordinationStrategy = coordStrategy;
      oc.persistState();

      oc.setPhase("discovering", ctx);

      const formatted = formatRepoProfile(profile, scanResult);
      const scanSourceLine = scanResult.source === "ccc"
        ? "🔬 Scan: ccc"
        : `📊 Scan: built-in${scanResult.fallback ? ` (fallback from ${scanResult.fallback.from})` : ""}`;

      // Ensure AGENTS.md has agent-mail section when agent-mail is available
      if (coordBackend.agentMail) {
        const { ensureAgentMailSection } = await import("../agents-md.js");
        await ensureAgentMailSection(ctx.cwd);
        // Register project in agent-mail so sub-agents can use it
        await oc.ensureAgentMailProject(ctx.cwd);
      }

      // Foundation validation — non-blocking warnings
      const foundationGaps: string[] = [];
      const hasAgentsMd = profile.keyFiles && Object.keys(profile.keyFiles).some(f => f.toLowerCase().includes("agents.md"));
      if (!hasAgentsMd) {
        foundationGaps.push("- No AGENTS.md found. Consider creating one for agent guidance.");
      }
      if (!profile.hasTests) {
        foundationGaps.push("- No test framework detected. Consider adding tests before orchestrating.");
      }
      if (!profile.hasCI && !profile.ciPlatform) {
        foundationGaps.push("- No CI/build tooling detected. Consider adding build scripts or CI.");
      }
      if (profile.recentCommits.length === 0) {
        foundationGaps.push("- No git history detected. Consider initializing git for version control.");
      }
      const foundationWarning = foundationGaps.length > 0
        ? `\n⚠️ Foundation gaps detected:\n${foundationGaps.join("\n")}\n`
        : "";

      // Coordination backend summary
      const coordParts: string[] = [];
      if (coordBackend.beads) coordParts.push("beads");
      if (coordBackend.agentMail) coordParts.push("agent-mail");
      if (coordBackend.sophia) coordParts.push("sophia");
      const coordLine = coordParts.length > 0
        ? `🤝 Coordination: ${coordParts.join(" + ")} → strategy: **${coordStrategy}**`
        : "🤝 Coordination: bare worktrees (no beads/agent-mail/sophia detected)";

      // Read CASS memory context for this repo/goal
      const { readMemory } = await import("../memory.js");
      const taskHint = oc.state.selectedGoal || `orchestration session for ${profile.name || "this repo"}`;
      const memory = readMemory(ctx.cwd, taskHint);
      const memoryContext = memory
        ? `\n\n### Prior Context (CASS memory; secondary to live codebase scan)\n${memory}`
        : "";

      const discoveryMode = await ctx.ui.select(
        "What would you like to do?",
        [
          "💡 Suggest improvements — scan and propose ideas",
          "✏️  I know what I want — enter my own goal",
        ]
      );

      if (discoveryMode?.startsWith("✏️")) {
        const customGoal = await ctx.ui.input(
          "Enter your goal:",
          "e.g., Add API rate limiting with Redis"
        );
        if (!customGoal) {
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "No goal entered. Orchestration stopped." }],
            details: { profile, scanResult },
          };
        }

        // Refine the goal via LLM-generated questionnaire
        const refinement = await runGoalRefinement(customGoal, profile, oc.pi, ctx);
        const goal = refinement.enrichedGoal;
        const constraints = refinement.skipped ? [] : extractConstraints(refinement.answers);

        // Skip discovery entirely — go straight to planning
        oc.state.selectedGoal = goal;
        oc.state.candidateIdeas = [];
        oc.state.constraints = constraints;
        oc.setPhase("creating_beads", ctx);
        oc.persistState();

        const instructions = beadCreationPrompt(goal, formatted, constraints);

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Create beads for this goal using \`br create\` and \`br dep add\` in bash NOW.**\n\nGoal: "${goal}"\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${foundationWarning}\n\n${formatted}${memoryContext}\n\n${instructions}`,
            },
          ],
          details: { profile, scanResult, customGoal: goal },
        };
      }

      const modeInstructions = discoveryInstructions(profile, scanResult);

      const discoveryPrompt = `**NEXT: Call \`orch_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n${modeInstructions}`;

      return {
        content: [
          {
            type: "text",
            text: `${discoveryPrompt}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${foundationWarning}\n\n${formatted}${memoryContext}`,
          },
        ],
        details: { profile, scanResult },
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
}
