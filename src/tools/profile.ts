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

      // Check for existing beads so we can offer a clear option
      let existingBeadCount = 0;
      let deferredBeadCount = 0;
      let existingBeadIds: string[] = [];
      let deferredBeadIds: string[] = [];
      try {
        const { readBeads } = await import("../beads.js");
        const existingBeads = await readBeads(oc.pi, ctx.cwd);
        const activeBeads = existingBeads.filter(b => b.status === "open" || b.status === "in_progress");
        const deferredBeads = existingBeads.filter(b => b.status === "deferred");
        existingBeadCount = activeBeads.length;
        existingBeadIds = activeBeads.map(b => b.id);
        deferredBeadCount = deferredBeads.length;
        deferredBeadIds = deferredBeads.map(b => b.id);
      } catch { /* no beads dir */ }

      const totalBeadCount = existingBeadCount + deferredBeadCount;
      const allBeadIds = [...existingBeadIds, ...deferredBeadIds];

      // Offer discovery mode choice — unified menu replaces the old two-step flow
      const discoveryChoices: string[] = [];
      if (existingBeadCount > 0) {
        discoveryChoices.push(`▶️  Work on beads — implement the ${existingBeadCount} existing open bead(s)`);
      }
      if (deferredBeadCount > 0) {
        discoveryChoices.push(`♻️  Reactivate deferred — restore ${deferredBeadCount} deferred bead(s) and start implementing`);
      }
      discoveryChoices.push(
        "💡 Standard discovery — generate 10-15 scored ideas",
        "🔬 Deep discovery (30→5→15 funnel) — broader brainstorm with competitive winnowing",
        "✏️  I know what I want — enter a custom goal",
      );
      if (totalBeadCount > 0) {
        discoveryChoices.push(`🗑️ Clear beads — permanently delete all ${totalBeadCount} bead(s) and start fresh`);
      }
      discoveryChoices.push("❌ Cancel");

      const discoveryMode = await ctx.ui.select(
        "How should we discover improvement ideas?",
        discoveryChoices
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
              text: `**NEXT: Call \`orch_plan\` with mode \`single_model\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nGenerate a detailed implementation plan as a markdown artifact. Stay inside the orchestrate workflow: after the plan is written, return to \`orch_approve_beads\` for plan approval before creating beads.`,
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
              text: `**NEXT: Call \`orch_plan\` with mode \`multi_model\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nRun competing planners for correctness, robustness, and ergonomics, then synthesize them into one plan document artifact. Stay inside the orchestrate workflow: after synthesis, return to \`orch_approve_beads\` for plan approval before creating beads.`,
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
            text: `**NEXT: Create beads for this goal using \`br create\` and \`br dep add\` in bash NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nStay inside the orchestrate workflow: once the beads exist, return to \`orch_approve_beads\` for bead approval before implementation.\n\n---\n\n${instructions}`,
          }],
          details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "direct" },
        };
      }

      if (discoveryMode?.startsWith("🔬")) {
        // Deep discovery: 30→5→15 funnel via sub-agents
        oc.setPhase("discovering", ctx);
        oc.persistState();

        const { broadIdeationPrompt, winnowingPrompt, expandIdeasPrompt, parseIdeasJSON, parseWinnowingResult } = await import("../ideation-funnel.js");
        // GAP 15 & 17: import WINNOWING_MODEL_NOTE for annotation (enforces model divergence)
        const { WINNOWING_MODEL_NOTE: _winnowingNote } = await import("../ideation-funnel.js");
        void _winnowingNote; // already prepended inside winnowingPrompt() itself
        const { runDeepPlanAgents } = await import("../deep-plan.js");
        const { pickRefinementModel } = await import("../prompts.js");

        // Phase 1: Generate 30 ideas (sub-agent)
        // GAP 15: fetch existing bead titles to prevent duplicate proposals
        ctx.ui.notify("💡 Phase 1/3: Generating 30 raw ideas...", "info");
        let phase1BeadTitles: string[] = [];
        try {
          // Try br list --json first (as specified), fall back to readBeads
          const brOutput = await oc.pi.exec("br", ["list", "--json"], { cwd: ctx.cwd, timeout: 8000 });
          const parsed = JSON.parse(brOutput.stdout);
          if (Array.isArray(parsed)) {
            phase1BeadTitles = parsed
              .map((b: unknown) => (b as Record<string, unknown>)?.title)
              .filter((t): t is string => typeof t === "string");
          }
        } catch {
          // br unavailable or failed — try readBeads fallback, then continue with empty array
          try {
            const { readBeads } = await import("../beads.js");
            const beads = await readBeads(oc.pi, ctx.cwd);
            phase1BeadTitles = beads.map((b) => b.title);
          } catch { /* no beads yet, pass empty array */ }
        }
        const phase1Prompt = broadIdeationPrompt(profile, scanResult, phase1BeadTitles);
        // GAP 17: model(0) for ideation — winnowing MUST use a different model (model(1))
        const phase1Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-broad",
          model: pickRefinementModel(0), // ideation model — different from winnowing (model 1)
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

        // Phase 2: Winnow to 5 (DIFFERENT model — GAP 17)
        // pickRefinementModel(1) is structurally different from pickRefinementModel(0).
        // This ensures winnowing uses a different provider/checkpoint than ideation,
        // so the critique comes from genuinely different blind spots.
        ctx.ui.notify("🔬 Phase 2/3: Competitive winnowing (30→5)...", "info");
        const phase2Prompt = winnowingPrompt(rawIdeas, profile);
        const phase2Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-winnow",
          // GAP 17: MUST use a different model index than ideation (index 0).
          // Different models = different blind spots = real critical evaluation.
          model: pickRefinementModel(1), // winnowing model — structurally different from ideation (model 0)
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
        ctx.ui.notify(`✅ Deep discovery complete: ${top5.length} top + ${expandedIdeas.length} honorable = ${allIdeas.length} total ideas.`, "info");

        // ── GAP 16: Human review between Phase 3 and bead creation ──────────────
        // The guide requires a human review step: users must confirm which ideas
        // to pursue before beads are created.
        const ideasSummary = [
          `### Top ${top5.length} Ideas (winnowed from ${rawIdeas.length} raw)`,
          ...top5.map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`),
          `\n### Complementary Ideas (${expandedIdeas.length})`,
          ...expandedIdeas.map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`),
        ].join("\n");

        const reviewChoice = await ctx.ui.select(
          `🔬 Phase 3 complete — ${allIdeas.length} ideas ready.\n\n${ideasSummary}\n\nHow do you want to proceed?`,
          [
            `✅ Accept all ${allIdeas.length} — create beads for all`,
            "🔍 Select subset — choose which to pursue",
            "🔄 Refine further — run discovery again",
            "❌ Discard — start over",
          ]
        );

        let finalIdeas = allIdeas;

        if (reviewChoice?.startsWith("❌")) {
          // User wants to start over — reset funnel state and restart
          oc.state.funnelRawIdeas = undefined;
          oc.state.funnelWinnowedIds = undefined;
          oc.state.candidateIdeas = undefined;
          oc.setPhase("profiling", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Discarded. Call `orch_profile` to start the discovery funnel again." }],
            details: { profile, scanResult, funnel: true, discarded: true },
          };
        } else if (reviewChoice?.startsWith("🔄")) {
          // User wants to refine further — re-run orch_profile with deep discovery
          oc.state.funnelRawIdeas = undefined;
          oc.state.funnelWinnowedIds = undefined;
          oc.state.candidateIdeas = undefined;
          oc.setPhase("profiling", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Resetting for another round. Call `orch_profile` and choose deep discovery again to refine further." }],
            details: { profile, scanResult, funnel: true, refined: true },
          };
        } else if (reviewChoice?.startsWith("🔍")) {
          // User wants to select a subset — show each idea with confirm
          ctx.ui.notify("Select which ideas to pursue (confirm each one):", "info");
          const selectedIdeas: typeof allIdeas = [];
          for (const idea of allIdeas) {
            const keep = await ctx.ui.confirm(
              `Keep "${idea.title}"?`,
              `[${idea.category}] ${idea.description}`
            );
            if (keep) selectedIdeas.push(idea);
          }
          if (selectedIdeas.length === 0) {
            ctx.ui.notify("No ideas selected. Using all ideas instead.", "warning");
          } else {
            finalIdeas = selectedIdeas;
            ctx.ui.notify(`Selected ${finalIdeas.length} idea(s) to pursue.`, "info");
          }
        }
        // else "✅ Accept all" — use allIdeas as-is

        oc.state.candidateIdeas = finalIdeas;
        oc.state.funnelWinnowedIds = finalIdeas.filter((i) => i.tier === "top").map((i) => i.id);
        oc.setPhase("awaiting_selection", ctx);
        oc.persistState();

        return {
          content: [{
            type: "text",
            text: `**Workflow:** ${roadmap}\n\n**NEXT: Call \`orch_select\` NOW to present these ${finalIdeas.length} ideas to the user.**\n\n---\n\n🔬 Deep discovery complete (30→5→${allIdeas.length} funnel, ${finalIdeas.length} selected)\n\n### Top Ideas (tier: top)\n${finalIdeas.filter(i => i.tier === "top").map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`).join("\n")}\n\n### Complementary Ideas (tier: honorable)\n${finalIdeas.filter(i => i.tier !== "top").map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`).join("\n")}`,
          }],
          details: { profile, scanResult, funnel: true, rawCount: rawIdeas.length, winnowedCount: top5.length, expandedCount: expandedIdeas.length, selectedCount: finalIdeas.length },
        };
      }

      // Reactivate deferred beads
      if (discoveryMode?.startsWith("♻️")) {
        ctx.ui.notify(`♻️ Reactivating ${deferredBeadIds.length} deferred bead(s)...`, "info");
        let reactivated = 0;
        for (const id of deferredBeadIds) {
          try {
            await oc.pi.exec("br", ["update", id, "--status", "open"], { cwd: ctx.cwd, timeout: 5000 });
            reactivated++;
          } catch { /* best effort */ }
        }
        ctx.ui.notify(`✅ Reactivated ${reactivated} bead(s).`, "info");
        oc.orchestratorActive = true;
        oc.setPhase("implementing", ctx);
        oc.persistState();
        const { implementerInstructions } = await import("../prompts.js");
        const { readMemory } = await import("../memory.js");
        const { readyBeads } = await import("../beads.js");
        const memRules = readMemory(ctx.cwd);
        const ready = await readyBeads(oc.pi, ctx.cwd);
        const nextBead = ready[0];
        if (!nextBead) {
          return {
            content: [{ type: "text", text: `♻️ Reactivated ${reactivated} bead(s). Run \`br ready\` to see what\'s unblocked.` }],
            details: { profile, scanResult },
          };
        }
        const beadProfile = oc.state.repoProfile ?? profile;
        const prevResults = Object.values(oc.state.beadResults ?? {});
        return {
          content: [{
            type: "text",
            text: implementerInstructions(nextBead, beadProfile, prevResults, memRules),
          }],
          details: { profile, scanResult, implementingBead: nextBead.id },
        };
      }

      // Work on existing beads
      if (discoveryMode?.startsWith("▶️")) {
        oc.orchestratorActive = true;
        oc.setPhase("implementing", ctx);
        oc.persistState();
        const { implementerInstructions } = await import("../prompts.js");
        const { readMemory } = await import("../memory.js");
        const { readyBeads } = await import("../beads.js");
        const memRules = readMemory(ctx.cwd);
        // Pick the first ready (unblocked) bead
        const ready = await readyBeads(oc.pi, ctx.cwd);
        const nextBead = ready[0];
        if (!nextBead) {
          return {
            content: [{ type: "text", text: "No ready beads found (all may be blocked by dependencies). Run `br ready` to check." }],
            details: { profile, scanResult },
          };
        }
        const beadProfile = oc.state.repoProfile ?? profile;
        const prevResults = Object.values(oc.state.beadResults ?? {});
        return {
          content: [{
            type: "text",
            text: implementerInstructions(nextBead, beadProfile, prevResults, memRules),
          }],
          details: { profile, scanResult, implementingBead: nextBead.id },
        };
      }

      // Cancel
      if (!discoveryMode || discoveryMode.startsWith("❌")) {
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [{ type: "text", text: "Orchestration cancelled." }],
          details: { profile, scanResult, cancelled: true },
        };
      }

      // Clear beads
      if (discoveryMode.startsWith("🗑️")) {
        let deleted = 0;
        if (allBeadIds.length > 0) {
          try {
            // --force bypasses dependent checks; --hard prunes tombstones from JSONL immediately
            await oc.pi.exec("br", ["delete", ...allBeadIds, "--force", "--hard"], { cwd: ctx.cwd, timeout: 15000 });
            deleted = allBeadIds.length;
            ctx.ui.notify(`🗑️ Deleted ${deleted} bead(s).`, "info");
          } catch {
            // Fallback: try without --hard in case version doesn't support it
            try {
              await oc.pi.exec("br", ["delete", ...allBeadIds, "--force"], { cwd: ctx.cwd, timeout: 15000 });
              deleted = allBeadIds.length;
              ctx.ui.notify(`🗑️ Deleted ${deleted} bead(s).`, "info");
            } catch {
              ctx.ui.notify("⚠️ Failed to delete beads — try \`br delete --force\` manually.", "warning");
            }
          }
        }
        oc.setPhase("idle", ctx);
        oc.persistState();
        // Auto-restart orchestration so user doesn't have to manually re-run
        oc.pi.sendUserMessage("/orchestrate", { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `🗑️ Cleared ${deleted} bead(s). Starting fresh...` }],
          details: { profile, scanResult, cleared: true },
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
