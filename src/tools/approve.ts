import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext, Bead } from "../types.js";
import { implementerInstructions } from "../prompts.js";
import { agentMailTaskPreamble } from "../agent-mail.js";

// ─── Module-level bead snapshot for change detection ─────────
type BeadSnapshot = Map<string, { title: string; descHash: string }>;
let _lastBeadSnapshot: BeadSnapshot | undefined;

/** Cheap content hash: length + first 50 chars. */
function descHash(desc: string): string {
  return `${desc.length}:${desc.slice(0, 50)}`;
}

function snapshotBeads(beads: Bead[]): BeadSnapshot {
  const snap: BeadSnapshot = new Map();
  for (const b of beads) {
    snap.set(b.id, { title: b.title, descHash: descHash(b.description) });
  }
  return snap;
}

function countChanges(prev: BeadSnapshot, curr: BeadSnapshot): number {
  let changes = 0;
  // Added beads
  for (const id of curr.keys()) {
    if (!prev.has(id)) changes++;
  }
  // Removed beads
  for (const id of prev.keys()) {
    if (!curr.has(id)) changes++;
  }
  // Modified beads
  for (const [id, entry] of curr) {
    const old = prev.get(id);
    if (old && (old.title !== entry.title || old.descHash !== entry.descHash)) {
      changes++;
    }
  }
  return changes;
}

const MAX_POLISH_ROUNDS = 12;

export function registerApproveTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_approve_beads",
    label: "Approve Beads",
    description:
      "Read beads created via br CLI, present them for user approval. Offers refinement passes (Phase 6) before execution. Call after the LLM has created beads with br create.",
    promptSnippet: "Present beads for user approval before execution",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!oc.state.selectedGoal) {
        throw new Error("No goal selected. Call orch_select first.");
      }

      const { readBeads, readyBeads, extractArtifacts, validateBeads, syncBeads, updateBeadStatus } = await import("../beads.js");
      const { beadRefinementPrompt } = await import("../prompts.js");

      // Read all beads from br CLI
      let beads = await readBeads(oc.pi, ctx.cwd);
      // Filter to open beads only (ignore closed beads from prior sessions)
      beads = beads.filter((b) => b.status === "open" || b.status === "in_progress");

      if (beads.length === 0) {
        return {
          content: [{ type: "text", text: "No open beads found. Create beads with `br create` first, then call `orch_approve_beads`." }],
          details: { approved: false },
        };
      }

      // ── Polish loop: compute change delta if returning from refinement ──
      const isRefining = oc.state.phase === "refining_beads";
      if (isRefining) {
        const currentSnapshot = snapshotBeads(beads);
        if (_lastBeadSnapshot) {
          const changes = countChanges(_lastBeadSnapshot, currentSnapshot);
          oc.state.polishChanges.push(changes);
        }
        oc.state.polishRound++;
        _lastBeadSnapshot = currentSnapshot;

        // Check convergence: 2 consecutive rounds with 0 changes
        const pc = oc.state.polishChanges;
        if (pc.length >= 2 && pc[pc.length - 1] === 0 && pc[pc.length - 2] === 0) {
          oc.state.polishConverged = true;
        }
      } else if (!_lastBeadSnapshot) {
        // First entry — take initial snapshot
        _lastBeadSnapshot = snapshotBeads(beads);
      }

      // Store bead IDs in state
      oc.state.activeBeadIds = beads.map((b) => b.id);
      oc.setPhase("awaiting_bead_approval", ctx);
      oc.persistState();

      // Validate — check for cycles
      const validation = await validateBeads(oc.pi, ctx.cwd);

      // Format bead list for display — group subtasks under parents
      const parentIds = new Set(beads.filter((b) => b.parent).map((b) => b.parent!));
      const childrenByParent = new Map<string, typeof beads>();
      for (const b of beads) {
        if (b.parent) {
          const children = childrenByParent.get(b.parent) ?? [];
          children.push(b);
          childrenByParent.set(b.parent, children);
        }
      }
      const childIds = new Set(beads.filter((b) => b.parent).map((b) => b.id));

      const formatBead = (b: typeof beads[0], indent = "") => {
        const files = extractArtifacts(b);
        return `${indent}**${b.id}: ${b.title}**\n${indent}   ${b.description.split("\n").slice(0, 3).join("\n" + indent + "   ")}\n${indent}   📄 ${files.length > 0 ? files.join(", ") : "(no files specified)"}`;
      };

      const beadListParts: string[] = [];
      for (const b of beads) {
        if (childIds.has(b.id)) continue; // rendered under parent
        beadListParts.push(formatBead(b));
        const children = childrenByParent.get(b.id);
        if (children) {
          for (const child of children) {
            beadListParts.push(`   ↳ ${formatBead(child, "   ")}`);
          }
        }
      }
      const beadListText = beadListParts.join("\n\n");

      const bvWarnings = validation.warnings?.length ? `\n⚠️ ${validation.warnings.join("\n⚠️ ")}` : "";
      const shallowWarning = validation.shallowBeads?.length
        ? `\n📝 Shallow beads: ${validation.shallowBeads.map((s) => `${s.id} (${s.reason})`).join(", ")}`
        : "";
      const validationWarning = (!validation.ok
        ? `\n\n⚠️ Validation issues: ${validation.cycles ? "dependency cycles detected" : ""} ${validation.orphaned.length > 0 ? `orphaned: ${validation.orphaned.join(", ")}` : ""}`
        : "") + bvWarnings + shallowWarning;

      // Quality summary
      const { qualityCheckBeads: qcBeads } = await import("../beads.js");
      const qualityPreview = await qcBeads(oc.pi, ctx.cwd);
      const qualitySummary = qualityPreview.passed
        ? `\n✅ ${beads.length}/${beads.length} beads pass quality checks`
        : `\n⚠️ ${beads.length - new Set(qualityPreview.failures.map((f) => f.beadId)).size}/${beads.length} pass — ${new Set(qualityPreview.failures.map((f) => f.beadId)).size} issues found`;

      // ── Build UI options based on polish state ──
      const round = oc.state.polishRound;
      const maxReached = round >= MAX_POLISH_ROUNDS;
      const converged = oc.state.polishConverged;

      // Round info header
      const changesInfo = oc.state.polishChanges.length > 0
        ? `\n📊 Polish history: ${oc.state.polishChanges.map((n, i) => `R${i + 1}: ${n} change${n !== 1 ? "s" : ""}`).join(", ")}`
        : "";
      const roundHeader = round > 0
        ? `\n🔄 Polish round ${round}${changesInfo}${converged ? "\n✅ Steady-state reached (0 changes for 2 consecutive rounds)" : ""}`
        : "";

      const options: string[] = [];
      if (maxReached) {
        options.push(
          "▶️  Start implementing (max rounds reached)",
          "❌ Reject"
        );
      } else {
        const startLabel = converged
          ? "▶️  Start implementing (steady-state reached ✅)"
          : "▶️  Start implementing";
        options.push(
          startLabel,
          `🔍 Polish again (round ${round + 1})`,
        );
        // Cross-model review available after at least 1 polish round
        if (round >= 1) {
          options.push("🔀 Cross-model review");
        }
        options.push("❌ Reject");
      }

      const choice = await ctx.ui.select(
        `${beads.length} beads ready for: ${oc.state.selectedGoal}${roundHeader}${qualitySummary}\n\n${beadListText}${validationWarning}`,
        options
      );

      if (choice?.startsWith("🔍")) {
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);
        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Review and refine the beads using br CLI, then call \`orch_approve_beads\` again.**\n\n${beadRefinementPrompt(round, oc.state.polishChanges)}\n\n---\n\nCurrent beads:\n\n${beadListText}`,
            },
          ],
          details: { approved: false, refining: true, beadCount: beads.length, polishRound: round },
        };
      }

      if (choice?.startsWith("🔀")) {
        // Cross-model review: send beads to alternative model
        const { crossModelBeadReview } = await import("../bead-review.js");
        const reviewResult = await crossModelBeadReview(
          oc.pi, ctx.cwd, beads, oc.state.selectedGoal!, undefined
        );

        if (reviewResult.suggestions.length === 0) {
          return {
            content: [{
              type: "text",
              text: `**Cross-model review (${reviewResult.model}):** No specific suggestions — beads look solid.\n\nCall \`orch_approve_beads\` again to continue.`,
            }],
            details: { approved: false, crossModelReview: true, model: reviewResult.model },
          };
        }

        const suggestionsText = reviewResult.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n");
        const applyChoice = await ctx.ui.select(
          `**Cross-model review (${reviewResult.model}) — ${reviewResult.suggestions.length} suggestions:**\n\n${suggestionsText}`,
          [
            "✅ Apply suggestions (send to next polish round)",
            "⏭️  Ignore and continue",
          ]
        );

        if (applyChoice?.startsWith("✅")) {
          // Inject suggestions into next polish round — increment polishRound, set phase to refining
          oc.state.polishRound++;
          oc.setPhase("refining_beads", ctx);
          oc.persistState();
          _lastBeadSnapshot = snapshotBeads(beads);

          const injectedPrompt = beadRefinementPrompt(oc.state.polishRound - 1, oc.state.polishChanges);
          return {
            content: [{
              type: "text",
              text: `**NEXT: Apply these cross-model suggestions, then call \`orch_approve_beads\` again.**\n\n### Cross-model suggestions to apply:\n${suggestionsText}\n\n---\n\n${injectedPrompt}\n\n---\n\nCurrent beads:\n\n${beadListText}`,
            }],
            details: { approved: false, refining: true, crossModelApplied: true, beadCount: beads.length, polishRound: oc.state.polishRound },
          };
        }

        // Ignored — return to approval screen
        return {
          content: [{
            type: "text",
            text: "Cross-model suggestions ignored. Call `orch_approve_beads` again to continue.",
          }],
          details: { approved: false, crossModelReview: true, ignored: true },
        };
      }

      if (!choice || choice.startsWith("❌")) {
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [{ type: "text", text: "Beads rejected. Orchestration stopped." }],
          details: { approved: false },
        };
      }

      // "▶️ Start implementing" — run quality gate first
      const { qualityCheckBeads } = await import("../beads.js");
      const qualityResult = await qualityCheckBeads(oc.pi, ctx.cwd);
      if (!qualityResult.passed) {
        const failureLines = qualityResult.failures.map(
          (f) => `- ${f.beadId}: ${f.check} — ${f.reason}`
        );
        const qualityChoice = await ctx.ui.select(
          `⚠️ Quality issues found:\n${failureLines.join("\n")}`,
          [
            "🔍 Go back to polish",
            "▶️  Proceed anyway",
          ]
        );

        if (qualityChoice?.startsWith("🔍")) {
          oc.setPhase("refining_beads", ctx);
          oc.persistState();
          await syncBeads(oc.pi, ctx.cwd);
          const { beadRefinementPrompt } = await import("../prompts.js");
          return {
            content: [
              {
                type: "text",
                text: `**Quality gate failed. Fix these issues, then call \`orch_approve_beads\` again.**\n\n⚠️ Issues:\n${failureLines.join("\n")}\n\n---\n\n${beadRefinementPrompt(round, oc.state.polishChanges)}\n\n---\n\nCurrent beads:\n\n${beadListText}`,
              },
            ],
            details: { approved: false, refining: true, qualityGateFailed: true, beadCount: beads.length },
          };
        }
      }

      // Reset polish snapshot
      _lastBeadSnapshot = undefined;

      // ── Approved — launch execution ──────────────────────────
      // Reset bead-centric implementation state
      oc.state.beadResults = {};
      oc.state.beadReviews = {};
      oc.state.beadReviewPassCounts = {};
      oc.state.beadHitMeTriggered = {};
      oc.state.beadHitMeCompleted = {};
      oc.state.iterationRound = 0;
      oc.state.currentGateIndex = 0;
      oc.setPhase("implementing", ctx);
      await syncBeads(oc.pi, ctx.cwd);
      oc.persistState();

      // Get first batch of ready beads (unblocked by dependencies)
      const ready = await readyBeads(oc.pi, ctx.cwd);
      if (ready.length === 0) {
        return {
          content: [{ type: "text", text: "⚠️ No ready beads (all blocked by dependencies). Check `br dep cycles` and `br ready`." }],
          details: { approved: true, beadCount: beads.length, readyCount: 0 },
        };
      }

      // Determine if we can run in parallel
      const hasParallel = ready.length > 1;

      if (hasParallel) {
        // Check artifact overlap for same-dir vs worktree decision
        const allArtifactSets = ready.map((b) => new Set(extractArtifacts(b)));
        const allDisjoint = allArtifactSets.every((setA, i) =>
          allArtifactSets.every((setB, j) =>
            i === j || [...setA].every((f) => !setB.has(f))
          )
        );
        const canSameDir = allDisjoint && oc.state.coordinationBackend?.agentMail;

        // Build parallel agent configs
        const agentConfigs = ready.map((bead) => {
          const artifacts = extractArtifacts(bead);
          const agentName = `bead-${bead.id}`;
          const preamble = oc.state.coordinationBackend?.agentMail
            ? agentMailTaskPreamble(ctx.cwd, agentName, bead.title, artifacts, bead.id)
            : "";
          return {
            name: agentName,
            task: `${preamble}You are implementing bead ${bead.id}.\n\n## ${bead.title}\n\n${bead.description}\n\n⚠️ SCOPE CONSTRAINT: Only modify files listed in the bead. If additional files need changes, note them in your summary but DO NOT modify them.\n\n${canSameDir ? "🤝 **Same-dir mode**: Other agents are working in this directory. Your file reservations protect your files.\n\n" : ""}Implement the bead. When done, do a fresh-eyes review of all changes. Then COMMIT:\n\`\`\`bash\ngit add ${artifacts.map(f => '"' + f + '"').join(' ')} && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\n\`\`\`\n\nSummarize what you did and what the fresh-eyes review found.\n\ncd ${ctx.cwd}`,
          };
        });

        // Mark all as in_progress
        for (const bead of ready) {
          await updateBeadStatus(oc.pi, ctx.cwd, bead.id, "in_progress");
        }
        await syncBeads(oc.pi, ctx.cwd);

        oc.state.currentBeadId = ready[0].id;
        oc.persistState();

        const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
        const modeLabel = canSameDir
          ? "🤝 Same-dir mode — agents coordinate via agent-mail file reservations."
          : "🔄 Parallel execution via sub-agents.";

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`parallel_subagents\` NOW to launch ${ready.length} parallel beads.**\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each bead with the sub-agent's summary.\n\n---\n\nBeads approved! ${beads.length} total, ${ready.length} ready now.\n\n${modeLabel}`,
            },
          ],
          details: { approved: true, beadCount: beads.length, readyCount: ready.length, parallel: true },
        };
      }

      // Sequential: start with first ready bead
      const firstBead = ready[0];
      await updateBeadStatus(oc.pi, ctx.cwd, firstBead.id, "in_progress");
      await syncBeads(oc.pi, ctx.cwd);
      oc.state.currentBeadId = firstBead.id;
      oc.persistState();

      const implInstr = implementerInstructions(
        firstBead,
        oc.state.repoProfile!,
        Object.values(oc.state.beadResults ?? {})
      );

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Implement bead ${firstBead.id} NOW, then call \`orch_review\` when done.**\n\nBeads approved! ${beads.length} total, starting with ${firstBead.id}.\n\n---\n\n${implInstr}`,
          },
        ],
        details: { approved: true, beadCount: beads.length, readyCount: ready.length, firstBead: firstBead.id },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_approve_beads ")) +
          theme.fg("dim", "reviewing beads..."),
        0, 0
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d?.approved) return new Text(theme.fg("warning", "📝 Beads rejected"), 0, 0);
      let text = theme.fg("success", `📝 Beads approved — ${d.beadCount} beads, ${d.readyCount} ready`);
      if (d.parallel) text += theme.fg("dim", " (parallel)");
      return new Text(text, 0, 0);
    },
  });
}
