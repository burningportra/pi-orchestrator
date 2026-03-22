import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext } from "../types.js";
import { implementerInstructions, realityCheckInstructions, randomExplorationInstructions, SWARM_STAGGER_DELAY_MS } from "../prompts.js";
import { agentMailTaskPreamble } from "../agent-mail.js";
import { runGuidedGates } from "../gates.js";

export function registerReviewTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_review",
    label: "Review Step",
    description:
      "Submit your implementation work for review. Provide a summary of what you changed. The tool evaluates against acceptance criteria and returns pass/fail.",
    promptSnippet: "Submit implementation for review against acceptance criteria",
    parameters: Type.Object({
      beadId: Type.String({ description: "bead ID to review (from br list), or \"__gates__\" for guided gates" }),
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
      const { getBeadById, readyBeads, updateBeadStatus, syncBeads, readBeads, extractArtifacts: extractBeadArtifacts, bvNext } = await import("../beads.js");

      // Sentinel: beadId === "__gates__" while iterating = show next gate
      if (oc.state.phase === "iterating" && params.beadId === "__gates__") {
        return await runGuidedGates(oc, oc.state, ctx, "");
      }

      const bead = await getBeadById(oc.pi, ctx.cwd, params.beadId);
      if (!bead) {
        throw new Error(`Bead ${params.beadId} not found. Use \`br list\` to see available beads.`);
      }

      // Guard: reject re-review of already-completed beads
      const alreadyCompleted = oc.state.beadResults?.[params.beadId];
      if (alreadyCompleted?.status === "success" && params.verdict === "pass") {
        return {
          content: [
            { type: "text", text: `Bead ${params.beadId} already completed. Move to the next bead or call \`orch_review\` with beadId "__gates__" for guided gates.` },
          ],
          details: { review: { beadId: params.beadId, passed: true }, alreadyDone: true },
        };
      }

      // Record the bead result
      if (!oc.state.beadResults) oc.state.beadResults = {};
      oc.state.beadResults[params.beadId] = {
        beadId: params.beadId,
        status: params.verdict === "pass" ? "success" : "partial",
        summary: params.summary,
      };

      // Store review verdict
      if (!oc.state.beadReviews) oc.state.beadReviews = {};
      if (!oc.state.beadReviews[params.beadId]) oc.state.beadReviews[params.beadId] = [];
      oc.state.beadReviews[params.beadId].push({
        beadId: params.beadId,
        passed: params.verdict === "pass",
        feedback: params.feedback,
        revisionInstructions: params.revisionInstructions,
      });

      oc.persistState();

      if (params.verdict === "pass") {
        // Update bead status to closed
        await updateBeadStatus(oc.pi, ctx.cwd, params.beadId, "closed");
        await syncBeads(oc.pi, ctx.cwd);

        // Auto-close parent if all sibling subtasks are closed
        if (bead.parent) {
          const allBeads = await readBeads(oc.pi, ctx.cwd);
          const siblings = allBeads.filter((b) => b.parent === bead.parent);
          const allSiblingsClosed = siblings.every((b) => b.status === "closed" || b.id === params.beadId);
          if (allSiblingsClosed) {
            await updateBeadStatus(oc.pi, ctx.cwd, bead.parent, "closed");
            await syncBeads(oc.pi, ctx.cwd);
            // Record parent as complete
            if (!oc.state.beadResults) oc.state.beadResults = {};
            oc.state.beadResults[bead.parent] = {
              beadId: bead.parent,
              status: "success",
              summary: "All subtasks complete",
            };
            oc.persistState();
            ctx.ui.notify(`✅ Parent bead ${bead.parent} auto-closed — all subtasks complete.`, "info");
          }
        }

        // Track review passes per bead
        if (!oc.state.beadReviewPassCounts) oc.state.beadReviewPassCounts = {};
        const prevPassCount = oc.state.beadReviewPassCounts[params.beadId] ?? 0;
        oc.state.beadReviewPassCounts[params.beadId] = prevPassCount + 1;
        oc.persistState();

        oc.setPhase("reviewing", ctx);

        // Hit-me flow uses two flags keyed by bead ID
        const hitMeWasTriggered = oc.state.beadHitMeTriggered?.[params.beadId] ?? false;
        const hitMeWasCompleted = oc.state.beadHitMeCompleted?.[params.beadId] ?? false;
        const allArtifactsForBead = extractBeadArtifacts(bead);
        let hitMeChoice: string | undefined;

        if (!hitMeWasTriggered) {
          hitMeChoice = await ctx.ui.select(
            `✅ Bead ${params.beadId} (${bead.title}) passed self-review.`,
            [
              "🔥 Hit me — spawn parallel review agents for this bead",
              "✅ Looks good — move on",
            ]
          );
        } else if (!hitMeWasCompleted) {
          ctx.ui.notify(`⚠️ Review agents haven't completed yet. Re-presenting spawn instruction.`, "warning");
          const round = Math.max(0, prevPassCount - 1);
          const rePresThreadId = params.beadId;
          const rePresPreamble = (name: string) =>
            oc.state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, name, bead.title, allArtifactsForBead, rePresThreadId)
              : "";
          const allBeads = await readBeads(oc.pi, ctx.cwd);
          const beadResults = Object.values(oc.state.beadResults ?? {});
          const goal = oc.state.selectedGoal ?? "Unknown goal";
          const agentConfigs = [
            {
              name: `fresh-eyes-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`fresh-eyes-${params.beadId}-r${round}`)}Fresh-eyes reviewer for bead ${params.beadId} (round ${round}). NEVER seen this code.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`polish-${params.beadId}-r${round}`)}Polish reviewer for bead ${params.beadId} (round ${round}). De-slopify.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`ergonomics-${params.beadId}-r${round}`)}Ergonomics reviewer for bead ${params.beadId} (round ${round}).\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`reality-check-${params.beadId}-r${round}`)}Reality checker for bead ${params.beadId} (round ${round}).\n\n${realityCheckInstructions(goal, allBeads, beadResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `random-explore-${params.beadId}-r${round}`,
              task: `${rePresPreamble(`random-explore-${params.beadId}-r${round}`)}${randomExplorationInstructions(goal, allArtifactsForBead, ctx.cwd)}`,
            },
          ];
          const reviewJson = JSON.stringify({ agents: agentConfigs }, null, 2);
          return {
            content: [
              {
                type: "text",
                text: `**Review agents must complete before advancing. Call \`parallel_subagents\` NOW with the config below.**\n\n## 🔥 Hit me — Bead ${params.beadId}, Round ${round} (re-presented)\n\n\`\`\`json\n${reviewJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` again for bead ${params.beadId} with what was fixed.`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, hitMe: true, round, bead: params.beadId, rePresented: true },
          };
        } else {
          hitMeChoice = "✅";
          if (!oc.state.beadHitMeTriggered) oc.state.beadHitMeTriggered = {};
          if (!oc.state.beadHitMeCompleted) oc.state.beadHitMeCompleted = {};
          oc.state.beadHitMeTriggered[params.beadId] = false;
          oc.state.beadHitMeCompleted[params.beadId] = false;
          oc.persistState();
          ctx.ui.notify(`✅ Bead ${params.beadId} passed review (round ${prevPassCount}).`, "info");
        }

        if (hitMeChoice?.startsWith("🔥")) {
          if (!oc.state.beadHitMeTriggered) oc.state.beadHitMeTriggered = {};
          if (!oc.state.beadHitMeCompleted) oc.state.beadHitMeCompleted = {};
          oc.state.beadHitMeTriggered[params.beadId] = true;
          oc.state.beadHitMeCompleted[params.beadId] = false;
          oc.persistState();

          const round = prevPassCount;
          const hitMeThreadId = params.beadId;
          const hitMePreamble = (name: string) =>
            oc.state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, name, bead.title, allArtifactsForBead, hitMeThreadId)
              : "";
          const allBeads = await readBeads(oc.pi, ctx.cwd);
          const beadResults = Object.values(oc.state.beadResults ?? {});
          const goal = oc.state.selectedGoal ?? "Unknown goal";
          const agentConfigs = [
            {
              name: `fresh-eyes-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`fresh-eyes-${params.beadId}-r${round}`)}Fresh-eyes reviewer for bead ${params.beadId} (round ${round}). NEVER seen this code.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `polish-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`polish-${params.beadId}-r${round}`)}Polish reviewer for bead ${params.beadId} (round ${round}). De-slopify.\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nRemove AI slop, improve clarity, make it agent-friendly. Fix issues directly.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `ergonomics-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`ergonomics-${params.beadId}-r${round}`)}Ergonomics reviewer for bead ${params.beadId} (round ${round}).\n\nBead: ${bead.title} — ${bead.description}\nFiles: ${allArtifactsForBead.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything confusing.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `reality-check-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`reality-check-${params.beadId}-r${round}`)}Reality checker for bead ${params.beadId} (round ${round}).\n\n${realityCheckInstructions(goal, allBeads, beadResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
            },
            {
              name: `random-explore-${params.beadId}-r${round}`,
              task: `${hitMePreamble(`random-explore-${params.beadId}-r${round}`)}${randomExplorationInstructions(goal, allArtifactsForBead, ctx.cwd)}`,
            },
          ];

          const hitMeResults = await oc.runHitMeAgents(agentConfigs, ctx.cwd, ctx);

          oc.state.beadHitMeCompleted[params.beadId] = true;
          oc.persistState();

          return {
            content: [
              {
                type: "text",
                text: `## 🔥 Hit me — Bead ${params.beadId} (${bead.title}), Round ${round}\n\n${hitMeResults.text}\n\n${hitMeResults.diff ? `### Diff\n\`\`\`diff\n${hitMeResults.diff}\n\`\`\`\n\n` : ""}After reviewing the findings above, call \`orch_review\` again for bead ${params.beadId} with what was fixed.`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, hitMe: true, round, bead: params.beadId },
          };
        }

        // User said "looks good" — check for next ready beads
        const ready = await readyBeads(oc.pi, ctx.cwd);

        if (ready.length === 0) {
          // All beads done — enter guided review gates
          let beadsReviewInfo = "";
          if (oc.state.coordinationBackend?.beads) {
            const { validateBeads, getBeadsSummary } = await import("../beads.js");
            await syncBeads(oc.pi, ctx.cwd);
            const validation = await validateBeads(oc.pi, ctx.cwd);
            const allBeads = await readBeads(oc.pi, ctx.cwd);
            const summary = getBeadsSummary(allBeads);
            const warningsStr = validation.warnings?.length ? `\n⚠️ ${validation.warnings.join("\n⚠️ ")}` : "";
            beadsReviewInfo = `\n\n**Beads:** ${summary}${!validation.ok ? `\n⚠️ ${validation.cycles ? "Cycles detected" : ""} ${validation.orphaned.length > 0 ? `Orphaned: ${validation.orphaned.join(", ")}` : ""}` : ""}${warningsStr}`;
          }

          // Clean up worktrees and tender
          if (oc.worktreePool) {
            await oc.worktreePool.cleanup();
            oc.worktreePool = undefined;
          }
          if (oc.swarmTender) {
            oc.swarmTender.stop();
            oc.swarmTender = undefined;
          }

          ctx.ui.notify("🔄 All beads done — entering review gates", "info");
          oc.setPhase("iterating", ctx);
          oc.state.iterationRound = 0;
          oc.state.currentGateIndex = 0;
          oc.persistState();

          return await runGuidedGates(oc, oc.state, ctx, beadsReviewInfo);
        } else if (ready.length === 1) {
          // Single next bead
          const nextBead = ready[0];
          oc.state.currentBeadId = nextBead.id;
          await updateBeadStatus(oc.pi, ctx.cwd, nextBead.id, "in_progress");
          oc.state.retryCount = 0;
          oc.setPhase("implementing", ctx);
          oc.persistState();

          const prevResults = Object.values(oc.state.beadResults ?? {});
          const implInstr = implementerInstructions(nextBead, oc.state.repoProfile!, prevResults);

          ctx.ui.notify(`✅ Bead ${params.beadId} passed! Moving to bead ${nextBead.id} (${nextBead.title}).`, "info");

          return {
            content: [
              {
                type: "text",
                text: `✅ Bead ${params.beadId} (${bead.title}) passed.\n\n---\nMoving to Bead ${nextBead.id}:\n\n${implInstr}`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, nextBead: nextBead.id },
          };
        } else {
          // Multiple ready beads — use bvNext to order by impact, then emit parallel_subagents
          const bvPick = await bvNext(oc.pi, ctx.cwd);
          if (bvPick) {
            // Move bv's top pick to front of the ready list
            const idx = ready.findIndex((b) => b.id === bvPick.id);
            if (idx > 0) {
              const [top] = ready.splice(idx, 1);
              ready.unshift(top);
            }
          }
          const goal = oc.state.selectedGoal ?? "Unknown goal";
          const agentConfigs = ready.map((b) => {
            const artifacts = extractBeadArtifacts(b);
            const agentName = `bead-${b.id}`;
            const threadId = b.id;
            const preamble = oc.state.coordinationBackend?.agentMail
              ? agentMailTaskPreamble(ctx.cwd, agentName, b.title, artifacts, threadId)
              : "";
            const prevResults = Object.values(oc.state.beadResults ?? {});
            const implInstr = implementerInstructions(b, oc.state.repoProfile!, prevResults);
            return {
              name: agentName,
              task: `${preamble}${implInstr}\n\ncd ${ctx.cwd}`,
            };
          });

          // Mark all as in_progress
          for (const b of ready) {
            await updateBeadStatus(oc.pi, ctx.cwd, b.id, "in_progress");
          }
          oc.setPhase("implementing", ctx);
          oc.persistState();

          const parallelJson = JSON.stringify({ agents: agentConfigs }, null, 2);
          const staggerSeconds = SWARM_STAGGER_DELAY_MS / 1000;
          const launchInstruction = ready.length > 2
            ? `⏱️ **STAGGER LAUNCH**: You have ${ready.length} agents to launch. Launch them ONE AT A TIME with ${staggerSeconds}-second gaps between each to prevent thundering herd. Call \`subagent\` for each agent config below sequentially, waiting ${staggerSeconds}s between calls.`
            : `**NEXT: Call \`parallel_subagents\` NOW to implement ${ready.length} ready beads.**`;
          ctx.ui.notify(`✅ Bead ${params.beadId} passed! ${ready.length} beads now ready for parallel implementation.`, "info");

          return {
            content: [
              {
                type: "text",
                text: `✅ Bead ${params.beadId} (${bead.title}) passed.\n\n${launchInstruction}\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each bead.`,
              },
            ],
            details: { review: { beadId: params.beadId, passed: true }, readyBeads: ready.map((b) => b.id), launchingParallel: true },
          };
        }
      } else {
        // Failed — retry (bead stays open, don't update status)
        oc.state.retryCount = (oc.state.retryCount ?? 0) + 1;
        oc.persistState();

        const review = { beadId: params.beadId, passed: false, feedback: params.feedback };

        if (oc.state.retryCount >= oc.state.maxRetries) {
          const cont = await ctx.ui.confirm(
            "Bead Failed",
            `Bead ${params.beadId} (${bead.title}) failed after ${oc.state.maxRetries} attempts.\n\nSkip and move on?`
          );

          if (cont) {
            // Mark as blocked and move to next ready bead
            oc.state.beadResults[params.beadId] = {
              beadId: params.beadId,
              status: "blocked",
              summary: `Skipped after ${oc.state.maxRetries} failed attempts`,
            };
            await updateBeadStatus(oc.pi, ctx.cwd, params.beadId, "deferred");
            await syncBeads(oc.pi, ctx.cwd);

            const ready = await readyBeads(oc.pi, ctx.cwd);
            if (ready.length > 0) {
              const nextBead = ready[0];
              oc.state.currentBeadId = nextBead.id;
              oc.state.retryCount = 0;
              oc.setPhase("implementing", ctx);
              oc.persistState();

              const prevResults = Object.values(oc.state.beadResults ?? {});
              const implInstr = implementerInstructions(nextBead, oc.state.repoProfile!, prevResults);

              return {
                content: [
                  {
                    type: "text",
                    text: `⚠️ Skipping bead ${params.beadId} (max retries). Moving to bead ${nextBead.id} (${nextBead.title}):\n\n${implInstr}`,
                  },
                ],
                details: { review, skipped: true, nextBead: nextBead.id },
              };
            }
          }

          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [
              { type: "text", text: "Orchestration stopped due to repeated failures." },
            ],
            details: { review, stopped: true },
          };
        }

        ctx.ui.notify(
          `⚠️ Bead ${params.beadId} needs revision (attempt ${oc.state.retryCount}/${oc.state.maxRetries})`,
          "warning"
        );

        return {
          content: [
            {
              type: "text",
              text: `❌ Bead ${params.beadId} (${bead.title}) did not pass review (attempt ${oc.state.retryCount}/${oc.state.maxRetries}).\n\nRevision needed: ${params.revisionInstructions ?? params.feedback}\n\nPlease fix the issues using the code tools, then call \`orch_review\` again.`,
            },
          ],
          details: { review, retryCount: oc.state.retryCount },
        };
      }
    },

    renderCall(args, theme) {
      const a = args as any;
      const icon = a.verdict === "pass" ? "✅" : "❌";
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_review ")) +
          theme.fg("dim", `bead ${a.beadId} ${icon}`),
        0, 0
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.complete)
        return new Text(theme.fg("success", "🎉 All beads complete!"), 0, 0);
      if (d?.stopped)
        return new Text(theme.fg("error", "🛑 Orchestration stopped"), 0, 0);
      if (d?.review?.passed)
        return new Text(
          theme.fg("success", `✅ Bead ${d.review.beadId} passed`) +
            (d.nextBead ? theme.fg("dim", ` → bead ${d.nextBead}`) : ""),
          0, 0
        );
      return new Text(
        theme.fg("warning", `❌ Bead ${d?.review?.beadId} needs revision`) +
          theme.fg("dim", ` (${d?.retryCount}/${oc.state.maxRetries})`),
        0, 0
      );
    },
  });
}
