import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext } from "../types.js";
import type { ScanResult } from "../types.js";
import { scanRepo } from "../scan.js";
import {
  formatRepoProfile,
  discoveryInstructions,
  beadCreationPrompt,
  workflowRoadmap,
} from "../prompts.js";
import { runGoalRefinement, extractConstraints } from "../goal-refinement.js";
import { detectCoordinationBackend, selectMode, selectStrategy } from "../coordination.js";

/** Compute weighted score for a candidate idea (for fallback sorting). */
function weightedScore(idea: import("../types.js").CandidateIdea): number {
  if (!idea.scores) return 0;
  const s = idea.scores;
  return s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
}

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
      oc.state.coordinationMode ??= selectMode(coordBackend);
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

      // Coordination backend summary with upgrade hints
      const coordParts: string[] = [];
      if (coordBackend.beads) coordParts.push("beads");
      if (coordBackend.agentMail) coordParts.push("agent-mail");
      if (coordBackend.sophia) coordParts.push("sophia");
      
      const missingTools: string[] = [];
      if (!coordBackend.beads) missingTools.push("`br init` for task tracking");
      if (!coordBackend.agentMail) missingTools.push("`agent-mail` for multi-agent coordination");
      
      const coordLine = coordParts.length > 0
        ? `🤝 Coordination: ${coordParts.join(" + ")} → strategy: **${coordStrategy}**`
        : "🤝 Coordination: bare worktrees (no beads/agent-mail/sophia detected)";
      
      const upgradeHint = missingTools.length > 0 && coordParts.length < 2
        ? `\n💡 **Upgrade available:** Install ${missingTools.join(", ")} for enhanced coordination. Run \`/orchestrate-setup\` for guided install.`
        : "";

      // Read CASS memory context for this repo/goal
      const { readMemory } = await import("../memory.js");
      const taskHint = oc.state.selectedGoal || `orchestration session for ${profile.name || "this repo"}`;
      const memory = readMemory(ctx.cwd, taskHint);
      const memoryContext = memory
        ? `\n\n### Prior Context (CASS memory; secondary to live codebase scan)\n${memory}`
        : "";

      // Workflow roadmap for user orientation
      const roadmap = workflowRoadmap("discovering");

      // Offer discovery mode choice — unified menu replaces the old two-step flow
      const discoveryMode = await ctx.ui.select(
        "How should we discover improvement ideas?",
        [
          "💡 Standard discovery — generate 10-15 scored ideas",
          "🔬 Deep discovery (30→5→15 funnel) — broader brainstorm with competitive winnowing",
          "✏️  I know what I want — enter a custom goal",
        ]
      );

      if (discoveryMode?.startsWith("✏️")) {
        // Custom goal — skip discovery + selection, go straight to workflow choice
        const goal = await ctx.ui.input(
          "Enter your goal:",
          "e.g., Add API rate limiting with Redis"
        );
        if (!goal) {
          return {
            content: [{ type: "text", text: "No goal entered." }],
            details: { profile, scanResult },
          };
        }
        const refinement = await runGoalRefinement(goal, profile, oc.pi, ctx);
        oc.state.selectedGoal = refinement.enrichedGoal;
        const refinementUsed = !refinement.skipped;
        if (refinementUsed) {
          oc.state.constraints = extractConstraints(refinement.answers);
        }
        oc.setPhase("planning", ctx);
        oc.persistState();

        // Ask for constraints only if refinement didn't already capture them
        if (!refinementUsed) {
          const constraintInput = await ctx.ui.input(
            "Any constraints? (comma-separated, or leave empty)",
            "e.g., no new dependencies, keep backward compat"
          );
          oc.state.constraints = constraintInput
            ? constraintInput.split(",").map((c) => c.trim()).filter(Boolean)
            : [];
        }
        oc.persistState();

        // Workflow choice: plan first, deep plan, or direct to beads
        const workflowOptions = [
          "📋 Plan first — generate a single plan document before creating beads",
          "🧠 Multi-model plan — competing planners synthesize one plan document",
          "🧠 Deep plan (beads) — multi-model planning agents create beads",
          "⚡ Direct to beads — jump straight to bead creation",
        ];

        let workflowChoice: string | undefined;
        try {
          workflowChoice = await ctx.ui.select("🛤️ Choose a workflow:", workflowOptions);
        } catch {
          workflowChoice = workflowOptions[3]; // default to direct
        }

        if (workflowChoice === undefined) {
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Workflow selection cancelled. Orchestration stopped." }],
            details: { selected: false },
          };
        }

        const enrichedGoal = refinement.enrichedGoal;
        const constraintsSummary = oc.state.constraints.length > 0
          ? `\nConstraints: ${oc.state.constraints.join(", ")}`
          : "";
        const repoContext = formatRepoProfile(profile, scanResult);

        if (workflowChoice.startsWith("📋")) {
          oc.state.planRefinementRound = 0;
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Call \`orch_plan\` with mode \`single_model\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nGenerate a detailed implementation plan as a markdown artifact. Once the plan is approved, beads will be created from it.`,
            }],
            details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "plan_first" },
          };
        }

        if (workflowChoice.startsWith("🧠 Multi-model")) {
          oc.state.planRefinementRound = 0;
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Call \`orch_plan\` with mode \`multi_model\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nRun competing planners for correctness, robustness, and ergonomics, then synthesize them into one plan document artifact.`,
            }],
            details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "multi_model_plan" },
          };
        }

        if (workflowChoice.startsWith("🧠 Deep plan")) {
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Run deep planning with multi-model agents.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nUse the deep planning system to generate beads via multi-model triangulation.`,
            }],
            details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "deep_plan" },
          };
        }

        // Default: Direct to beads
        const instructions = beadCreationPrompt(enrichedGoal, repoContext, oc.state.constraints);
        oc.setPhase("creating_beads", ctx);
        return {
          content: [{
            type: "text",
            text: `**NEXT: Create beads for this goal using \`br create\` and \`br dep add\` in bash NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\n---\n\n${instructions}`,
          }],
          details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "direct" },
        };
      }

      if (discoveryMode?.startsWith("🔬")) {
        // Deep discovery: 30→5→15 funnel via sub-agents
        oc.setPhase("discovering", ctx);
        oc.persistState();

        const { broadIdeationPrompt, winnowingPrompt, expandIdeasPrompt, parseIdeasJSON, parseWinnowingResult } = await import("../ideation-funnel.js");
        const { runDeepPlanAgents } = await import("../deep-plan.js");
        const { pickRefinementModel } = await import("../prompts.js");

        // Phase 1: Generate 30 ideas (sub-agent)
        ctx.ui.notify("💡 Phase 1/3: Generating 30 raw ideas...", "info");
        const phase1Prompt = broadIdeationPrompt(profile, scanResult);
        const phase1Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-broad",
          model: pickRefinementModel(0),
          task: phase1Prompt,
        }]);
        const rawIdeas = parseIdeasJSON(phase1Results[0]?.plan ?? "");

        if (rawIdeas.length < 10) {
          // Fallback to standard discovery if broad ideation failed
          ctx.ui.notify(`⚠️ Broad ideation produced only ${rawIdeas.length} ideas. Falling back to standard discovery.`, "warning");
          const modeInstructions = discoveryInstructions(profile, scanResult);
          return {
            content: [{
              type: "text",
              text: `**Workflow:** ${roadmap}\n\n**NEXT: Call \`orch_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n${modeInstructions}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${upgradeHint}${foundationWarning}\n\n${formatted}${memoryContext}`,
            }],
            details: { profile, scanResult, funnelFallback: true },
          };
        }

        oc.state.funnelRawIdeas = rawIdeas;
        oc.persistState();
        ctx.ui.notify(`✅ Phase 1 complete: ${rawIdeas.length} raw ideas generated.`, "info");

        // Phase 2: Winnow to 5 (different model)
        ctx.ui.notify("🔬 Phase 2/3: Competitive winnowing (30→5)...", "info");
        const phase2Prompt = winnowingPrompt(rawIdeas, profile);
        const phase2Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-winnow",
          model: pickRefinementModel(1), // different model for diverse evaluation
          task: phase2Prompt,
        }]);
        const winnowResult = parseWinnowingResult(phase2Results[0]?.plan ?? "");

        if (winnowResult.keptIds.length === 0) {
          ctx.ui.notify(`⚠️ Winnowing failed to parse results. Using top-scored ideas instead.`, "warning");
          // Fallback: sort by weighted score and take top 5
          winnowResult.keptIds.push(
            ...rawIdeas
              .sort((a, b) => weightedScore(b) - weightedScore(a))
              .slice(0, 5)
              .map((i) => i.id)
          );
        }

        oc.state.funnelWinnowedIds = winnowResult.keptIds;
        oc.persistState();

        const top5 = winnowResult.keptIds
          .map((id) => rawIdeas.find((i) => i.id === id))
          .filter((i): i is NonNullable<typeof i> => i != null);

        // Mark top 5 as tier "top"
        for (const idea of top5) idea.tier = "top";

        ctx.ui.notify(`✅ Phase 2 complete: ${winnowResult.cutCount} ideas cut, ${top5.length} kept.`, "info");

        // Phase 3: Expand to 15 (10 more ideas)
        ctx.ui.notify("💡 Phase 3/3: Generating 10 complementary ideas...", "info");
        let existingBeadTitles: string[] = [];
        try {
          const { readBeads } = await import("../beads.js");
          const beads = await readBeads(oc.pi, ctx.cwd);
          existingBeadTitles = beads.map((b) => b.title);
        } catch { /* no beads yet */ }

        const phase3Prompt = expandIdeasPrompt(top5, existingBeadTitles, profile);
        const phase3Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-expand",
          model: pickRefinementModel(2), // yet another model
          task: phase3Prompt,
        }]);
        const expandedIdeas = parseIdeasJSON(phase3Results[0]?.plan ?? "");

        // Mark expanded ideas as honorable
        for (const idea of expandedIdeas) idea.tier = "honorable";

        // Combine: top 5 + expanded
        const allIdeas = [...top5, ...expandedIdeas];
        oc.state.candidateIdeas = allIdeas;
        oc.setPhase("awaiting_selection", ctx);
        oc.persistState();

        ctx.ui.notify(`✅ Deep discovery complete: ${top5.length} top + ${expandedIdeas.length} honorable = ${allIdeas.length} total ideas.`, "info");

        return {
          content: [{
            type: "text",
            text: `**Workflow:** ${roadmap}\n\n**NEXT: Call \`orch_select\` NOW to present these ${allIdeas.length} ideas to the user.**\n\n---\n\n🔬 Deep discovery complete (30→5→${allIdeas.length} funnel)\n\n### Top 5 (winnowed from ${rawIdeas.length} raw ideas)\n${top5.map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`).join("\n")}\n\n### Complementary Ideas (${expandedIdeas.length})\n${expandedIdeas.map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`).join("\n")}`,
          }],
          details: { profile, scanResult, funnel: true, rawCount: rawIdeas.length, winnowedCount: top5.length, expandedCount: expandedIdeas.length },
        };
      }

      // Standard discovery (default)
      const modeInstructions = discoveryInstructions(profile, scanResult);
      const discoveryPrompt = `**NEXT: Call \`orch_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n${modeInstructions}`;

      return {
        content: [
          {
            type: "text",
            text: `**Workflow:** ${roadmap}\n\n${discoveryPrompt}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${upgradeHint}${foundationWarning}\n\n${formatted}${memoryContext}`,
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
