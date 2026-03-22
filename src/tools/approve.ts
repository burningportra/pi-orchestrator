import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext, Bead } from "../types.js";
import { implementerInstructions, freshContextRefinementPrompt, computeConvergenceScore, blunderHuntInstructions } from "../prompts.js";
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
        // Track output size (total description length) for convergence scoring
        const totalDescSize = beads.reduce((sum, b) => sum + b.description.length, 0);
        if (!oc.state.polishOutputSizes) oc.state.polishOutputSizes = [];
        oc.state.polishOutputSizes.push(totalDescSize);

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

      // ── Compute convergence score ──
      const convergenceScore = oc.state.polishChanges.length >= 3
        ? computeConvergenceScore(oc.state.polishChanges, oc.state.polishOutputSizes)
        : undefined;
      if (convergenceScore !== undefined) {
        oc.state.polishConvergenceScore = convergenceScore;
      }

      // ── Build UI options based on polish state ──
      const round = oc.state.polishRound;
      const maxReached = round >= MAX_POLISH_ROUNDS;
      const converged = oc.state.polishConverged;

      // Round info header
      const changesInfo = oc.state.polishChanges.length > 0
        ? `\n📊 Polish history: ${oc.state.polishChanges.map((n, i) => `R${i + 1}: ${n} change${n !== 1 ? "s" : ""}`).join(", ")}`
        : "";
      const convergenceInfo = convergenceScore !== undefined
        ? `\n📈 Convergence: ${(convergenceScore * 100).toFixed(0)}%${convergenceScore >= 0.90 ? " (diminishing returns)" : convergenceScore >= 0.75 ? " (ready to implement)" : ""}`
        : "";
      const roundHeader = round > 0
        ? `\n🔄 Polish round ${round}${changesInfo}${convergenceInfo}${converged ? "\n✅ Steady-state reached (0 changes for 2 consecutive rounds)" : ""}`
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
          : convergenceScore !== undefined && convergenceScore >= 0.75
          ? `▶️  Start implementing (convergence ${(convergenceScore * 100).toFixed(0)}% ✅)`
          : "▶️  Start implementing";
        if (round >= 1) {
          // After first round, prioritize fresh-agent to reduce anchoring bias
          options.push(
            startLabel,
            `🧠 Fresh-agent refinement (round ${round + 1})`,
            `🔍 Same-agent polish (may anchor) (round ${round + 1})`,
            `🔨 Blunder hunt (5x overshoot)`,
            `🔗 Dedup check`,
            "🔀 Cross-model review",
            "❌ Reject",
          );
        } else {
          options.push(
            startLabel,
            `🔍 Polish again (round ${round + 1})`,
            `🧠 Fresh-agent refinement (round ${round + 1})`,
            `🔨 Blunder hunt (5x overshoot)`,
            `🔗 Dedup check`,
            "❌ Reject",
          );
        }
      }

      const convergenceTip = round >= 1 && convergenceScore !== undefined && convergenceScore < 0.5
        ? "\n💡 Tip: Fresh-agent refinement recommended — reduces anchoring bias."
        : "";

      // ── Auto-approve when convergence criteria met ──
      const autoApproveEnabled = oc.state.autoApproveOnConvergence !== false; // default true
      const meetsAutoApprove = autoApproveEnabled && round > 0 && (
        converged || (convergenceScore !== undefined && convergenceScore >= 0.90)
      );

      let choice: string | undefined;

      if (meetsAutoApprove) {
        // Run quality gate before auto-approve
        const { qualityCheckBeads: qcAutoApprove } = await import("../beads.js");
        const autoQuality = await qcAutoApprove(oc.pi, ctx.cwd);

        if (autoQuality.passed) {
          // Show interruptible countdown — timeout returns false (auto-approve)
          const interrupted = await ctx.ui.confirm(
            `✅ Beads converged${convergenceScore !== undefined ? ` (${(convergenceScore * 100).toFixed(0)}%)` : ""} — auto-approving in 3s`,
            "Press Enter to review manually instead",
            { timeout: 3000 }
          );

          if (!interrupted) {
            // Auto-approve: set choice to start-implementing label
            choice = options[0]; // First option is always the start label
          }
          // If interrupted, choice stays undefined → fall through to manual select
        }
        // If quality gate failed, fall through to manual select
      }

      if (choice === undefined) {
        choice = await ctx.ui.select(
          `${beads.length} beads ready for: ${oc.state.selectedGoal}${roundHeader}${qualitySummary}\n\n${beadListText}${validationWarning}${convergenceTip}`,
          options
        );
      }

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

      if (choice?.startsWith("🧠 Fresh-agent")) {
        // Fresh-context refinement: spawn a sub-agent with NO prior context
        // Flywheel Section 5: "Fresh conversations prevent the model from anchoring on its own prior output."
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);

        const freshPrompt = freshContextRefinementPrompt(ctx.cwd, oc.state.selectedGoal!, round);
        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Spawn a fresh sub-agent for bead refinement, then call \`orch_approve_beads\` again.**\n\nUse \`subagent\` with these parameters:\n\`\`\`json\n${JSON.stringify({
                name: `fresh-refine-r${round + 1}`,
                task: freshPrompt,
                interactive: false,
                cwd: ctx.cwd,
              }, null, 2)}\n\`\`\`\n\nThe sub-agent has NO prior conversation context — this is deliberate. Fresh eyes catch what anchored reviewers miss.\n\nAfter the sub-agent completes, call \`orch_approve_beads\` to see the changes.`,
            },
          ],
          details: { approved: false, refining: true, freshAgent: true, beadCount: beads.length, polishRound: round },
        };
      }

      if (choice?.startsWith("🔨")) {
        // Blunder hunt: 5x overshoot mismatch technique
        // Flywheel Section 5: "Lie to them and give them a huge number"
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);

        // Build 5 sequential blunder hunt passes as a single task
        const passes = Array.from({ length: 5 }, (_, i) =>
          blunderHuntInstructions(ctx.cwd, i + 1)
        ).join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Run all 5 blunder hunt passes, then call \`orch_approve_beads\` again.**\n\n${passes}`,
            },
          ],
          details: { approved: false, refining: true, blunderHunt: true, beadCount: beads.length, polishRound: round },
        };
      }

      if (choice?.startsWith("🔗")) {
        // Bead deduplication check
        // Flywheel Section 5: "Check over ALL open beads. Make sure none are duplicative."
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);

        const dedupPrompt = `## Bead Deduplication Check

Check over ALL open beads via \`br list --json\`. Make sure none are duplicative or excessively overlapping.

For each pair of similar beads:
1. Identify which is the better "survivor" (richer description, better test specs, higher priority)
2. Merge by updating the survivor with the best content from both
3. Close the duplicate with \`br update <id> --status closed\`
4. Transfer all dependencies from the closed bead to the survivor

Report what you found and what you merged. Use ultrathink.

cd ${ctx.cwd}`;

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Run the dedup check, then call \`orch_approve_beads\` again.**\n\n${dedupPrompt}`,
            },
          ],
          details: { approved: false, refining: true, dedup: true, beadCount: beads.length, polishRound: round },
        };
      }

      if (choice?.startsWith("🔀")) {
        // Cross-model review: send beads to alternative model
        const { crossModelBeadReview } = await import("../bead-review.js");
        const reviewResult = await crossModelBeadReview(
          oc.pi, ctx.cwd, beads, oc.state.selectedGoal!, undefined
        );

        if (reviewResult.error) {
          const retryChoice = await ctx.ui.select(
            `⚠️ **Cross-model review failed:** ${reviewResult.error}`,
            [
              "🔄 Try again",
              "⏭️  Continue without cross-model review",
            ]
          );
          if (retryChoice?.startsWith("🔄")) {
            // Return to approval screen — user can pick cross-model again
          }
          return {
            content: [{
              type: "text",
              text: `**Cross-model review (${reviewResult.model}):** Review failed: ${reviewResult.error}\n\nCall \`orch_approve_beads\` again to continue.`,
            }],
            details: { approved: false, crossModelReview: true, model: reviewResult.model, error: reviewResult.error },
          };
        }

        if (reviewResult.suggestions.length === 0) {
          const rawChoice = await ctx.ui.select(
            `**Cross-model review (${reviewResult.model}):** Parser found no structured suggestions.\n\n**Raw output:**\n${reviewResult.rawOutput.slice(0, 2000)}`,
            [
              "✅ Looks fine, continue",
              "📝 Send raw feedback to polish round",
            ]
          );

          if (rawChoice?.startsWith("📝")) {
            oc.state.polishRound++;
            oc.setPhase("refining_beads", ctx);
            oc.persistState();
            _lastBeadSnapshot = snapshotBeads(beads);

            const injectedPrompt = beadRefinementPrompt(oc.state.polishRound - 1, oc.state.polishChanges);
            return {
              content: [{
                type: "text",
                text: `**NEXT: Apply this cross-model feedback, then call \`orch_approve_beads\` again.**\n\n### Raw cross-model feedback:\n${reviewResult.rawOutput}\n\n---\n\n${injectedPrompt}\n\n---\n\nCurrent beads:\n\n${beadListText}`,
              }],
              details: { approved: false, refining: true, crossModelApplied: true, beadCount: beads.length, polishRound: oc.state.polishRound },
            };
          }

          return {
            content: [{
              type: "text",
              text: `**Cross-model review (${reviewResult.model}):** No structured suggestions found.\n\nCall \`orch_approve_beads\` again to continue.`,
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
        _lastBeadSnapshot = undefined;
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
