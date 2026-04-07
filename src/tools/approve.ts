import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { readFileSync } from "fs";
import type { OrchestratorContext, Bead } from "../types.js";
import { implementerInstructions, freshContextRefinementPrompt, computeConvergenceScore, blunderHuntInstructions, SWARM_STAGGER_DELAY_MS, beadCreationPrompt, freshPlanRefinementPrompt, planToBeadsPrompt, formatPlanToBeadAuditWarnings, pickRefinementModel, beadQualityScoringPrompt, parseBeadQualityScore, formatBeadQualityAudit, type BeadQualityAuditResult } from "../prompts.js";
import { agentMailTaskPreamble } from "../agent-mail.js";
import { planQualityScoringPrompt, parsePlanQualityScore, formatPlanQualityScore, type PlanQualityScore } from "../plan-quality.js";
import { sessionArtifactPath } from "../session-artifacts.js";
import { getParallelModelAssignments, resolveExecutionMode } from "./shared.js";

// ─── Module-level bead snapshots for change detection ────────
// These live at module scope so they persist across multiple calls to
// orch_approve_beads within the same orchestration session. Each call
// compares the current beads against the previous snapshot to compute
// the number of changes made during a polish round.
type BeadSnapshot = Map<string, { title: string; descFingerprint: string }>;
let _lastBeadSnapshot: BeadSnapshot | undefined;

/** Cheap fingerprint for change detection: length + first 50 chars. Not a cryptographic hash. */
function descFingerprint(desc: string): string {
  return `${desc.length}:${desc.slice(0, 50)}`;
}

function snapshotBeads(beads: Bead[]): BeadSnapshot {
  const snap: BeadSnapshot = new Map();
  for (const b of beads) {
    snap.set(b.id, { title: b.title, descFingerprint: descFingerprint(b.description) });
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
    if (old && (old.title !== entry.title || old.descFingerprint !== entry.descFingerprint)) {
      changes++;
    }
  }
  return changes;
}

// ─── Extended snapshot for detailed diff ─────────────────────
type BeadSnapshotFull = Map<string, { title: string; descLength: number; descFingerprint: string; files: string[] }>;

function snapshotBeadsFull(beads: Bead[], extractArtifacts: (b: Bead) => string[]): BeadSnapshotFull {
  const snap: BeadSnapshotFull = new Map();
  for (const b of beads) {
    snap.set(b.id, { title: b.title, descLength: b.description.length, descFingerprint: descFingerprint(b.description), files: extractArtifacts(b) });
  }
  return snap;
}

export interface DiffSummary {
  added: { id: string; title: string }[];
  removed: string[];
  modified: { id: string; changes: string[] }[];
  unchangedCount: number;
}

export function diffBeadSnapshots(prev: BeadSnapshotFull, curr: BeadSnapshotFull): DiffSummary {
  const added: DiffSummary["added"] = [];
  const removed: string[] = [];
  const modified: DiffSummary["modified"] = [];
  let unchangedCount = 0;

  for (const [id, entry] of curr) {
    const old = prev.get(id);
    if (!old) {
      added.push({ id, title: entry.title });
      continue;
    }
    const changes: string[] = [];
    if (old.title !== entry.title) changes.push(`title: "${old.title}" → "${entry.title}"`);
    if (old.descFingerprint !== entry.descFingerprint) {
      const delta = entry.descLength - old.descLength;
      changes.push(`description: ${delta >= 0 ? "+" : ""}${delta} chars`);
    }
    const addedFiles = entry.files.filter(f => !old.files.includes(f));
    const removedFiles = old.files.filter(f => !entry.files.includes(f));
    if (addedFiles.length > 0 || removedFiles.length > 0) {
      const parts: string[] = [];
      if (addedFiles.length) parts.push(`+${addedFiles.join(", +")}`);
      if (removedFiles.length) parts.push(`-${removedFiles.join(", -")}`);
      changes.push(`files: ${parts.join(", ")}`);
    }
    if (changes.length > 0) {
      modified.push({ id, changes });
    } else {
      unchangedCount++;
    }
  }

  for (const id of prev.keys()) {
    if (!curr.has(id)) removed.push(id);
  }

  return { added, removed, modified, unchangedCount };
}

export function formatDiffSummary(diff: DiffSummary): string {
  const lines: string[] = ["📋 **Changes since last round:**"];
  if (diff.added.length) {
    lines.push(`  ➕ Added: ${diff.added.map(a => `${a.id} (${a.title})`).join(", ")}`);
  }
  if (diff.removed.length) {
    lines.push(`  ➖ Removed: ${diff.removed.join(", ")}`);
  }
  for (const m of diff.modified) {
    lines.push(`  ✏️  ${m.id}: ${m.changes.join("; ")}`);
  }
  if (diff.unchangedCount > 0) {
    lines.push(`  ⬜ ${diff.unchangedCount} bead${diff.unchangedCount !== 1 ? "s" : ""} unchanged`);
  }
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    lines.push("  No changes detected.");
  }
  return lines.join("\n");
}

/** Extended snapshot for rendering diff summaries between polish rounds. */
let _lastBeadSnapshotFull: BeadSnapshotFull | undefined;

const MAX_POLISH_ROUNDS = 12;

type PlanSnapshot = { fingerprint: string; lineCount: number; size: number; content: string };
let _lastPlanSnapshot: PlanSnapshot | undefined;


function snapshotPlan(plan: string): PlanSnapshot {
  return {
    fingerprint: descFingerprint(plan),
    lineCount: plan.split("\n").length,
    size: plan.length,
    content: plan,
  };
}

function countPlanChanges(prev: string, curr: string): number {
  if (prev === curr) return 0;
  const prevLines = prev.split("\n");
  const currLines = curr.split("\n");
  const maxLen = Math.max(prevLines.length, currLines.length);
  let changes = Math.abs(prevLines.length - currLines.length);
  for (let i = 0; i < Math.min(prevLines.length, currLines.length); i++) {
    if (prevLines[i] !== currLines[i]) changes++;
  }
  return Math.min(changes, maxLen);
}

function formatPlanSummary(plan: string): string {
  const lines = plan.split("\n");
  const headings = lines.filter((line) => /^#{1,3}\s/.test(line.trim())).slice(0, 8);
  const preview = lines
    .filter((line) => line.trim().length > 0)
    .slice(0, 12)
    .join("\n")
    .slice(0, 2000);

  const summary = [
    `📄 **Plan artifact preview** (${lines.length} lines, ${plan.length} chars)`,
    headings.length > 0 ? `\n**Sections:**\n${headings.map((h) => `- ${h.trim()}`).join("\n")}` : "",
    `\n**Preview:**\n${preview}${preview.length < plan.length ? "\n...(truncated)" : ""}`,
  ].filter(Boolean);

  return summary.join("\n");
}

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

      if (oc.state.phase === "awaiting_plan_approval" || (oc.state.phase === "planning" && oc.state.planDocument)) {
        if (!oc.state.planDocument) {
          throw new Error("No saved plan artifact found in orchestrator state.");
        }

        const planPath = sessionArtifactPath(ctx, oc.state.planDocument);
        const plan = readFileSync(planPath, "utf8");
        const currentPlanSnapshot = snapshotPlan(plan);
        const returningFromRefinement = oc.state.phase === "planning" && !!_lastPlanSnapshot;

        if (returningFromRefinement) {
          const previousPlanSnapshot = _lastPlanSnapshot!;
          const changes = previousPlanSnapshot.fingerprint === currentPlanSnapshot.fingerprint ? 0 : countPlanChanges(previousPlanSnapshot.content, plan);
          oc.state.polishChanges.push(changes);
          if (!oc.state.polishOutputSizes) oc.state.polishOutputSizes = [];
          oc.state.polishOutputSizes.push(currentPlanSnapshot.size);
          oc.state.planRefinementRound = (oc.state.planRefinementRound ?? 0) + 1;
          if (oc.state.polishChanges.length >= 2) {
            const recent = oc.state.polishChanges.slice(-2);
            oc.state.polishConverged = recent[0] === 0 && recent[1] === 0;
          }
        } else if (!_lastPlanSnapshot) {
          oc.state.planRefinementRound = oc.state.planRefinementRound ?? 0;
          oc.state.polishChanges = [];
          oc.state.polishOutputSizes = [currentPlanSnapshot.size];
          oc.state.polishConverged = false;
          // Save original plan to docs/plans/ on first view (before any refinement)
          if ((oc.state.planRefinementRound ?? 0) === 0) {
            try {
              const { saveDocsPlan } = await import("./plan.js");
              saveDocsPlan(ctx.cwd, oc.state.selectedGoal!, "original", plan);
            } catch { /* best-effort */ }
          }
        }

        _lastPlanSnapshot = currentPlanSnapshot;
        oc.setPhase("awaiting_plan_approval", ctx);

        const planRound = oc.state.planRefinementRound ?? 0;
        const planConvergenceScore = oc.state.polishChanges.length >= 3
          ? computeConvergenceScore(oc.state.polishChanges, oc.state.polishOutputSizes)
          : undefined;
        if (planConvergenceScore !== undefined) {
          oc.state.planConvergenceScore = planConvergenceScore;
        }
        oc.persistState();

        const changesInfo = oc.state.polishChanges.length > 0
          ? `\n📊 Refinement history: ${oc.state.polishChanges.map((n, i) => `R${i + 1}: ${n} change${n !== 1 ? "s" : ""}`).join(", ")}`
          : "";
        const convergenceInfo = planConvergenceScore !== undefined
          ? `\n📈 Convergence: ${(planConvergenceScore * 100).toFixed(0)}%${planConvergenceScore >= 0.90 ? " (diminishing returns)" : planConvergenceScore >= 0.75 ? " (ready to accept)" : ""}`
          : "";
        const roundHeader = planRound > 0
          ? `\n🔄 Plan refinement round ${planRound}${changesInfo}${convergenceInfo}${oc.state.polishConverged ? "\n✅ Steady-state reached (0 changes for 2 consecutive rounds)" : ""}`
          : "";

        // ── Plan size gate (guide §03: mature plans are 3,000–6,000+ lines) ──
        const planLineCount = plan.split("\n").length;
        const planSizeInfo =
          planLineCount < 100
            ? `\n\n⛔ **Plan too short (${planLineCount} lines)** — this is a sketch, not a plan. Needs substantial expansion before creating beads.`
            : planLineCount < 500
            ? `\n\n⚠️ **Plan is short (${planLineCount} lines)** — guide recommends 3,000–6,000+ lines for mature plans. Consider more refinement rounds.`
            : planLineCount < 1500
            ? `\n\n📊 **Plan length: ${planLineCount} lines** — decent start, but likely missing detail. Guide target: 3,000–6,000+ lines.`
            : `\n\n✅ **Plan length: ${planLineCount} lines**`;

        // Score plan quality on first view and after each refinement round.
        let qualityInfo = "";
        const shouldScore = !oc.state.planReadinessScore || returningFromRefinement;
        if (shouldScore) {
          const scoringPrompt = planQualityScoringPrompt(plan, oc.state.selectedGoal!);
          try {
            const { runDeepPlanAgents } = await import("../deep-plan.js");
            const scoreResults = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
              name: "plan-quality",
              task: scoringPrompt,
            }]);
            const scoreOutput = scoreResults[0]?.plan ?? "";
            const parsed = parsePlanQualityScore(scoreOutput);
            if (parsed) {
              oc.state.planReadinessScore = parsed;
              oc.persistState();
            }
          } catch {
            // Quality scoring is best-effort — don't block the flow
          }
        }

        const qualityScore = oc.state.planReadinessScore;
        if (qualityScore) {
          qualityInfo = `\n\n${formatPlanQualityScore(qualityScore)}`;
        }

        // Build options — gate "Accept" if quality score says "block" OR plan is too short
        const planTooShort = planLineCount < 100;
        const planOptions: string[] = [];
        if (planTooShort || qualityScore?.recommendation === "block") {
          planOptions.push(`🔍 Refine plan (round ${planRound + 1}) — ${planTooShort ? "plan too short" : "score too low to accept"}`);
          planOptions.push("✅ Accept anyway (override quality gate)");
        } else {
          planOptions.push("✅ Accept plan and create beads");
          planOptions.push(`🔍 Refine plan (round ${planRound + 1})`);
        }
        // Guide §03: offer auto-drive 4-5 refinement rounds on first view when quality is low
        if (planRound === 0 && (planTooShort || qualityScore?.recommendation === "block" || qualityScore?.recommendation === "warn")) {
          planOptions.push("🚀 Auto-refine (4 rounds, rotate models)");
        }
        // Round-2 nudge: guide recommends 4-5 rounds
        if (planRound === 2 && (qualityScore?.recommendation === "warn")) {
          planOptions.push("💡 Tip: guide recommends 4-5 rounds — continue refining");
        }
        planOptions.push("❌ Reject plan");

        const choice = await ctx.ui.select(
          `Review plan for: ${oc.state.selectedGoal}${roundHeader}${planSizeInfo}${qualityInfo}\n\n${formatPlanSummary(plan)}`,
          planOptions
        );

        if (!choice || choice.startsWith("❌")) {
          _lastPlanSnapshot = undefined;
          oc.state.planDocument = undefined;
          oc.state.planRefinementRound = 0;
          oc.state.planConvergenceScore = undefined;
          oc.state.planReadinessScore = undefined;
          oc.state.polishChanges = [];
          oc.state.polishOutputSizes = [];
          oc.state.polishConverged = false;
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Plan rejected. Orchestration stopped." }],
            details: { approved: false, plan: true },
          };
        }

        if (choice.startsWith("🚀 Auto-refine")) {
          oc.setPhase("planning", ctx);
          oc.persistState();

          // Build instructions for 4 sequential auto-refinement rounds
          const roundInstructions = [1, 2, 3, 4].map((r) => {
            const m = pickRefinementModel(planRound + r - 1);
            const fp = freshPlanRefinementPrompt(plan, oc.state.planDocument!, planRound + r, ctx.cwd);
            return `**Round ${r}** — model: \`${m}\`\n\`\`\`json\n${JSON.stringify({ name: `plan-refine-r${planRound + r}`, task: `${fp}\n\nAfter refining, write the updated plan to the artifact: \`${oc.state.planDocument}\`\nUse write_artifact with name "${oc.state.planDocument}".`, model: m, cwd: ctx.cwd }, null, 2)}\n\`\`\``;
          }).join("\n\n");

          return {
            content: [{
              type: "text",
              text: `**NEXT: Run 4 sequential plan refinement rounds, then call \`orch_approve_beads\` to review the final result.**\n\nFor each round (1-4):\n1. Spawn a fresh sub-agent using the \`subagent\` tool (fork: false)\n2. Wait for it to complete before starting the next round\n3. After all 4 rounds, call \`orch_approve_beads\` to review the improved plan\n\n${roundInstructions}`,
            }],
            details: { approved: false, plan: true, refining: true, autoRefine: true, rounds: 4, planDocument: oc.state.planDocument, planRound },
          };
        }

        if (choice.startsWith("💡")) {
          // Round-2 nudge: treat as a single refinement round
          oc.setPhase("planning", ctx);
          oc.persistState();

          const refinementModel = pickRefinementModel(planRound);
          const freshPrompt = freshPlanRefinementPrompt(plan, oc.state.planDocument!, planRound + 1, ctx.cwd);

          return {
            content: [{
              type: "text",
              text: `💡 You're at round ${planRound}. Guide recommends 4-5 rounds total — ${4 - planRound} more to go.\n\n**NEXT: Spawn a fresh sub-agent for plan refinement, then call \`orch_approve_beads\` again.**\n\nUse \`subagent\` with these parameters:\n\`\`\`json\n${JSON.stringify({ name: `plan-refine-r${planRound + 1}`, task: `${freshPrompt}\n\nAfter refining, write the updated plan to the artifact: \`${oc.state.planDocument}\`\nUse write_artifact with name "${oc.state.planDocument}".`, model: refinementModel, cwd: ctx.cwd }, null, 2)}\n\`\`\`\n\nThis uses **${refinementModel}** (model rotation prevents taste convergence).\nAfter the sub-agent completes, call \`orch_approve_beads\` to review changes.`,
            }],
            details: { approved: false, plan: true, refining: true, freshAgent: true, model: refinementModel, planDocument: oc.state.planDocument, planRound },
          };
        }

        if (choice.startsWith("🔍")) {
          oc.setPhase("planning", ctx);
          oc.persistState();

          // Fresh sub-agent + model rotation prevents anchoring on prior output.
          const refinementModel = pickRefinementModel(planRound);
          const freshPrompt = freshPlanRefinementPrompt(
            plan,
            oc.state.planDocument!,
            planRound + 1,
            ctx.cwd
          );

          return {
            content: [{
              type: "text",
              text: `**NEXT: Spawn a fresh sub-agent for plan refinement, then call \`orch_approve_beads\` again.**\n\nUse \`subagent\` with these parameters:\n\`\`\`json\n${JSON.stringify({
                name: `plan-refine-r${planRound + 1}`,
                task: `${freshPrompt}\n\nAfter refining, write the updated plan to the artifact: \`${oc.state.planDocument}\`\nUse write_artifact with name \"${oc.state.planDocument}\".`,
                model: refinementModel,
                cwd: ctx.cwd,
              }, null, 2)}\n\`\`\`\n\nThis uses **${refinementModel}** (model rotation prevents taste convergence).\nThe sub-agent has NO prior conversation context — this is deliberate.\n\nAfter the sub-agent completes, call \`orch_approve_beads\` to review changes.`,
            }],
            details: { approved: false, plan: true, refining: true, freshAgent: true, model: refinementModel, planDocument: oc.state.planDocument, planRound },
          };
        }

        _lastPlanSnapshot = undefined;
        oc.state.planRefinementRound = 0;
        oc.state.planConvergenceScore = undefined;
        oc.state.polishChanges = [];
        oc.state.polishOutputSizes = [];
        oc.state.polishConverged = false;
        oc.state.polishRound = 0;
        _lastBeadSnapshot = undefined;
        _lastBeadSnapshotFull = undefined;
        // Save final plan to docs/plans/ at approval
        if (oc.state.planDocument) {
          try {
            const finalPlan = readFileSync(sessionArtifactPath(ctx, oc.state.planDocument), "utf8");
            const { saveDocsPlan } = await import("./plan.js");
            saveDocsPlan(ctx.cwd, oc.state.selectedGoal!, "final", finalPlan);
          } catch { /* best-effort */ }
        }
        oc.setPhase("creating_beads", ctx);
        oc.persistState();

        let creationPrompt = oc.state.repoProfile
          ? planToBeadsPrompt(oc.state.planDocument, oc.state.selectedGoal, oc.state.repoProfile)
          : `${beadCreationPrompt(oc.state.selectedGoal, "", oc.state.constraints)}\n\n### Approved Plan Artifact\nRead the approved plan artifact at \`${oc.state.planDocument}\` before creating beads, and carry the needed context directly into each bead description.`;

        // Auto-inject CASS context into bead creation prompt
        try {
          const { withCassContext } = await import("../feedback.js");
          creationPrompt = withCassContext(creationPrompt, ctx.cwd, `creating beads for: ${oc.state.selectedGoal}`);
        } catch { /* best-effort */ }

        // Auto-inject MemPalace episodic context into bead creation prompt
        try {
          const { getEpisodicContext, sanitiseSlug } = await import("../episodic-memory.js");
          const projectSlug = sanitiseSlug(ctx.cwd);
          const episodic = getEpisodicContext(
            `creating beads for: ${oc.state.selectedGoal}`,
            projectSlug
          );
          if (episodic) {
            creationPrompt = `${episodic}\n---\n\n${creationPrompt}`;
          }
        } catch { /* best-effort */ }

        return {
          content: [{
            type: "text",
            text: `**NEXT: Create beads from the approved plan using \`br create\` and \`br dep add\` in bash NOW. When all beads are created, call \`orch_approve_beads\` again to enter the bead approval menu.**\n\nArtifact: \`${oc.state.planDocument}\`\n\n---\n\n${creationPrompt}\n\n---\n\n**After creating all beads:** call \`orch_approve_beads\` to review and approve before implementation begins.`,
          }],
          details: { approved: true, plan: true, creatingBeads: true, planDocument: oc.state.planDocument },
        };
      }

      const { readBeads, readyBeads, extractArtifacts, validateBeads, syncBeads, updateBeadStatus, bvInsights, auditPlanToBeads } = await import("../beads.js");
      const { beadRefinementPrompt } = await import("../prompts.js");
      const { simulateExecutionPaths, formatSimulationReport, beadsToSimulated } = await import("../plan-simulation.js");

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

          // Track prompt effectiveness for the self-improvement loop
          try {
            const { trackPromptUse } = await import("../feedback.js");
            trackPromptUse("beadRefinement", changes);
          } catch { /* best-effort */ }
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

      // Build diff summary for polish rounds >= 1
      const polishRoundForDisplay = oc.state.polishRound;
      const currentSnapshotFull = snapshotBeadsFull(beads, extractArtifacts);
      const diffText = (polishRoundForDisplay >= 1 && _lastBeadSnapshotFull)
        ? formatDiffSummary(diffBeadSnapshots(_lastBeadSnapshotFull, currentSnapshotFull))
        : undefined;

      const beadListParts: string[] = [];
      if (diffText) {
        // Compact mode: diff summary + abbreviated bead list
        beadListParts.push(diffText);
        beadListParts.push("");
        beadListParts.push("**All beads:**");
        for (const b of beads) {
          if (childIds.has(b.id)) continue;
          beadListParts.push(`• ${b.id}: ${b.title}`);
          const children = childrenByParent.get(b.id);
          if (children) {
            for (const child of children) {
              beadListParts.push(`  ↳ ${child.id}: ${child.title}`);
            }
          }
        }
      } else {
        // Round 0: full detailed format
        for (const b of beads) {
          if (childIds.has(b.id)) continue;
          beadListParts.push(formatBead(b));
          const children = childrenByParent.get(b.id);
          if (children) {
            for (const child of children) {
              beadListParts.push(`   ↳ ${formatBead(child, "   ")}`);
            }
          }
        }
      }
      const beadListText = diffText
        ? beadListParts.join("\n")
        : beadListParts.join("\n\n");

      // Compact one-liner list for LLM context (avoids repeating full bead dump on every refinement call)
      const compactBeadList = beads.map((b) => `• ${b.id}: ${b.title}`).join("\n");

      // Update full snapshot for next round
      _lastBeadSnapshotFull = currentSnapshotFull;

      const bvWarnings = validation.warnings?.length ? `\n⚠️ ${validation.warnings.join("\n⚠️ ")}` : "";
      const shallowWarning = validation.shallowBeads?.length
        ? `\n📝 Shallow beads: ${validation.shallowBeads.map((s) => `${s.id} (${s.reason})`).join(", ")}`
        : "";
      const templateWarning = validation.templateIssues?.length
        ? `\n🧩 Template hygiene: ${validation.templateIssues.map((issue) => `${issue.beadId} (${issue.issueType}: ${issue.excerpt})`).join(", ")}`
        : "";
      const validationWarning = (!validation.ok
        ? `\n\n⚠️ Validation issues: ${validation.cycles ? "dependency cycles detected" : ""} ${validation.orphaned.length > 0 ? `orphaned: ${validation.orphaned.join(", ")}` : ""}`
        : "") + bvWarnings + shallowWarning + templateWarning;

      const insights = await bvInsights(oc.pi, ctx.cwd);
      const bottleneckWarning = insights?.Bottlenecks?.length
        ? `\n\n⚠️ **Bottleneck beads:** ${insights.Bottlenecks.map((b) => b.ID).join(", ")} — high betweenness centrality means these block many downstream beads. Consider splitting them (Advanced → Fix graph issues) before implementing.`
        : "";

      // ── Plan simulation ──
      let simulationWarning = "";
      try {
        // Build dep map from br dep list
        const depMap = new Map<string, string[]>();
        for (const b of beads) {
          try {
            const depResult = await oc.pi.exec("br", ["dep", "list", b.id, "--json"], { cwd: ctx.cwd });
            const deps = JSON.parse(depResult.stdout);
            const blockedBy = (deps.dependencies ?? []).filter((d: any) => d.type === "blocks").map((d: any) => d.depends_on_id);
            if (blockedBy.length > 0) depMap.set(b.id, blockedBy);
          } catch { /* skip beads with no deps */ }
        }

        // Get repo file list
        const repoFiles = new Set<string>();
        try {
          const findResult = await oc.pi.exec("find", ["src", "-type", "f"], { cwd: ctx.cwd });
          for (const line of findResult.stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) repoFiles.add(trimmed);
          }
        } catch { /* fallback: empty set, missing files will be flagged */ }

        const simulated = beadsToSimulated(beads, depMap);
        const simResult = simulateExecutionPaths(simulated, repoFiles);
        const simReport = formatSimulationReport(simResult);

        if (simResult.valid) {
          simulationWarning = `\n\n✅ Simulation passed — ${simResult.parallelGroups.length} execution level(s), no structural issues.`;
        } else {
          simulationWarning = `\n\n${simReport}`;
        }
      } catch {
        // Non-fatal — simulation is advisory
      }

      let planAuditWarning = "";
      if (oc.state.planDocument) {
        try {
          const plan = readFileSync(sessionArtifactPath(ctx, oc.state.planDocument), "utf8");
          const planAudit = auditPlanToBeads(plan, beads);
          planAuditWarning = formatPlanToBeadAuditWarnings(planAudit);
          if (planAuditWarning) planAuditWarning = `\n\n${planAuditWarning}`;

          // Plan-to-bead coverage dashboard (fast keyword-based)
          const { coverageFromKeywordAudit, formatPlanCoverage } = await import("../plan-coverage.js");
          const coverageResult = coverageFromKeywordAudit(planAudit);
          const coverageDisplay = formatPlanCoverage(coverageResult);
          if (coverageDisplay) planAuditWarning += `\n\n${coverageDisplay}`;
        } catch {
          // Non-fatal: missing or unreadable plan artifact should not block approval.
        }
      }

      // Quality summary
      const { qualityCheckBeads } = await import("../beads.js");
      const qualityPreview = await qualityCheckBeads(oc.pi, ctx.cwd);
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

      // Composite readiness score from all signals.
      let foregoneInfo = "";
      if (round >= 2) {
        try {
          const { computeForegoneScore, formatForegoneScore } = await import("../foregone.js");
          const { bvInsights: getBvInsights } = await import("../beads.js");

          // Gather bead quality pass rate from qualityPreview
          const failingBeadIds = new Set(qualityPreview.failures.map((f: { beadId: string }) => f.beadId));
          const beadQualityPassRate = {
            passed: beads.length - failingBeadIds.size,
            total: beads.length,
          };

          // Gather graph insights (best-effort)
          let graphInsights = null;
          try { graphInsights = await getBvInsights(oc.pi, ctx.cwd); } catch { /* bv unavailable */ }

          // Gather plan coverage (already computed above as keyword audit)
          let planCoverageResult = null;
          if (oc.state.planDocument) {
            try {
              const { coverageFromKeywordAudit: covFromAudit } = await import("../plan-coverage.js");
              const planText = readFileSync(sessionArtifactPath(ctx, oc.state.planDocument), "utf8");
              const audit = auditPlanToBeads(planText, beads);
              planCoverageResult = covFromAudit(audit);
            } catch { /* non-fatal */ }
          }

          const foregone = computeForegoneScore({
            planQuality: oc.state.planReadinessScore ?? null,
            convergenceScore: convergenceScore ?? null,
            beadQualityPassRate,
            graphInsights,
            planCoverage: planCoverageResult,
          });

          oc.state.foregoneScore = foregone;
          oc.persistState();

          foregoneInfo = `\n\n${formatForegoneScore(foregone)}`;
        } catch {
          // Foregone scoring is best-effort
        }
      }

      const foregoneReady = oc.state.foregoneScore?.recommendation === "foregone";
      const startLabel = foregoneReady
        ? "🎯 Launch — foregone conclusion reached!"
        : maxReached
        ? "▶️  Start implementing (max rounds reached)"
        : converged
          ? "▶️  Start implementing (steady-state reached ✅)"
          : convergenceScore !== undefined && convergenceScore >= 0.75
          ? `▶️  Start implementing (convergence ${(convergenceScore * 100).toFixed(0)}% ✅)`
          : "▶️  Start implementing";

      // ── Detect graph health issues for remediation option ──
      const hasGraphIssues = validation.orphaned.length > 0 || (validation.warnings?.length ?? 0) > 0;
      const graphIssueCount = validation.orphaned.length + (validation.warnings?.length ?? 0);

      // ── Simplified options: progressive disclosure ──
      // Main menu: Start / Polish (or Refine) / Advanced / Reject
      // Advanced sub-menu: all specialist options for power users
      const options: string[] = [];
      if (maxReached) {
        options.push(startLabel, "❌ Reject");
      } else {
        options.push(startLabel);
        if (round >= 1) {
          // After round 1, default refinement action is fresh-agent (reduces anchoring bias)
          options.push(`🔍 Refine further (round ${round + 1})`);
        } else {
          options.push(`🔍 Polish beads (round ${round + 1})`);
        }
        options.push("⚙️ Advanced options...");
        options.push("❌ Reject");
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
        // Re-run quality gate before auto-approve (qualityPreview may be stale)
        const autoQuality = await qualityCheckBeads(oc.pi, ctx.cwd);

        if (autoQuality.passed) {
          // Show interruptible countdown.
          // ctx.ui.confirm with timeout: returns false on timeout (no user input),
          // returns true if user presses Enter (i.e. they want to review manually).
          const userWantsManualReview = await ctx.ui.confirm(
            `✅ Beads converged${convergenceScore !== undefined ? ` (${(convergenceScore * 100).toFixed(0)}%)` : ""} — auto-approving in 3s`,
            "Press Enter to review manually instead",
            { timeout: 3000 }
          );

          if (!userWantsManualReview) {
            // Auto-approve: skip to implementation (quality gate already passed above)
            choice = "auto-approved";
          }
          // If user pressed Enter, choice stays undefined → fall through to manual select
        }
        // If quality gate failed, fall through to manual select
      }

      if (choice === undefined) {
        choice = await ctx.ui.select(
          `${beads.length} beads ready for: ${oc.state.selectedGoal}${roundHeader}${qualitySummary}${simulationWarning}${bottleneckWarning}${planAuditWarning}${foregoneInfo}\n\n${beadListText}${validationWarning}${convergenceTip}`,
          options
        );
      }

      // ── Advanced sub-menu handler ──
      if (choice?.startsWith("⚙️")) {
        const advancedOptions: string[] = [
          `🧠 Fresh-agent refinement (round ${round + 1})`,
          `🔍 Same-agent polish (round ${round + 1})`,
          `🔨 Blunder hunt (5x overshoot)`,
          `🔗 Dedup check`,
          `📊 WHAT/WHY/HOW quality audit`,
        ];
        if (round >= 1) {
          advancedOptions.push("🔀 Cross-model review");
        }
        if (hasGraphIssues) {
          advancedOptions.push(`🩺 Fix graph issues (${graphIssueCount} warning${graphIssueCount !== 1 ? "s" : ""})`);
        }
        advancedOptions.push("⬅️ Back");

        const advChoice = await ctx.ui.select(
          "⚙️ Advanced refinement options:",
          advancedOptions
        );

        if (!advChoice || advChoice.startsWith("⬅️")) {
          // Back to main menu — re-trigger approval
          return {
            content: [{ type: "text", text: "Call `orch_approve_beads` again to return to the approval menu." }],
            details: { approved: false },
          };
        }
        // Delegate to existing handlers by reassigning choice
        choice = advChoice;
        // Fall through to handler blocks below...
      }

      // ── "🔍 Refine further" (round 1+) → fresh-agent refinement ──
      if (choice?.startsWith("🔍 Refine further")) {
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);

        // Model rotation: different model each round for diverse perspectives
        const refinementModel = pickRefinementModel(round);
        const freshPrompt = freshContextRefinementPrompt(ctx.cwd, oc.state.selectedGoal!, round);
        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Spawn a fresh sub-agent for bead refinement, then call \`orch_approve_beads\` again.**\n\nUse \`subagent\` with these parameters:\n\`\`\`json\n${JSON.stringify({
                name: `fresh-refine-r${round + 1}`,
                task: freshPrompt,
                model: refinementModel,
                cwd: ctx.cwd,
              }, null, 2)}\n\`\`\`\n\nThis uses **${refinementModel}** (model rotation prevents taste convergence).\nThe sub-agent has NO prior conversation context — this is deliberate. Fresh eyes catch what anchored reviewers miss.\n\nAfter the sub-agent completes, call \`orch_approve_beads\` to see the changes.`,
            },
          ],
          details: { approved: false, refining: true, freshAgent: true, model: refinementModel, beadCount: beads.length, polishRound: round },
        };
      }

      // ── "🔍 Polish beads" (round 0) or "🔍 Same-agent polish" (from Advanced menu) ──
      if (choice?.startsWith("🔍")) {
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);
        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Review and refine the beads using br CLI, then call \`orch_approve_beads\` again.**\n\n${beadRefinementPrompt(round, oc.state.polishChanges)}\n\n---\n\nCurrent beads (${beads.length} total):\n${compactBeadList}\n\nUse \`br show <id>\` for full bead details.`,
            },
          ],
          details: { approved: false, refining: true, beadCount: beads.length, polishRound: round },
        };
      }

      if (choice?.startsWith("🧠 Fresh-agent")) {
        // Fresh-context refinement: sub-agent with zero prior context prevents anchoring.
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);

        // Model rotation: different model each round for diverse perspectives
        const refinementModel = pickRefinementModel(round);
        const freshPrompt = freshContextRefinementPrompt(ctx.cwd, oc.state.selectedGoal!, round);
        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Spawn a fresh sub-agent for bead refinement, then call \`orch_approve_beads\` again.**\n\nUse \`subagent\` with these parameters:\n\`\`\`json\n${JSON.stringify({
                name: `fresh-refine-r${round + 1}`,
                task: freshPrompt,
                model: refinementModel,
                cwd: ctx.cwd,
              }, null, 2)}\n\`\`\`\n\nThis uses **${refinementModel}** (model rotation prevents taste convergence).\nThe sub-agent has NO prior conversation context — this is deliberate. Fresh eyes catch what anchored reviewers miss.\n\nAfter the sub-agent completes, call \`orch_approve_beads\` to see the changes.`,
            },
          ],
          details: { approved: false, refining: true, freshAgent: true, model: refinementModel, beadCount: beads.length, polishRound: round },
        };
      }

      if (choice?.startsWith("🔨")) {
        // Blunder hunt: 5x overshoot mismatch technique
        oc.setPhase("refining_beads", ctx);
        oc.persistState();
        await syncBeads(oc.pi, ctx.cwd);

        // Build 5 sequential blunder hunt passes as a single task
        // Inject domain-specific checklist items if we know the tech stack
        const { getDomainChecklist, formatDomainBlunderItems } = await import("../domain-knowledge.js");
        const domainChecklist = oc.state.repoProfile ? getDomainChecklist(oc.state.repoProfile) : null;
        const domainExtras = domainChecklist ? formatDomainBlunderItems(domainChecklist) : undefined;
        const passes = Array.from({ length: 5 }, (_, i) =>
          blunderHuntInstructions(ctx.cwd, i + 1, domainExtras)
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

      if (choice?.startsWith("📊")) {
        // WHAT/WHY/HOW quality audit — run scorer on all beads in parallel, surface weak axes
        const { runDeepPlanAgents } = await import("../deep-plan.js");

        ctx.ui.notify(`📊 Running WHAT/WHY/HOW quality audit on ${beads.length} bead${beads.length !== 1 ? "s" : ""}...`, "info");

        const auditAgents = beads.map((b, i) => ({
          name: `wwh-${b.id}`,
          task: beadQualityScoringPrompt(b.id, b.title, b.description),
          model: pickRefinementModel(i),
        }));

        let auditResults: BeadQualityAuditResult[];
        try {
          const rawResults = await runDeepPlanAgents(oc.pi, ctx.cwd, auditAgents);
          auditResults = rawResults.map((r, i) => {
            const b = beads[i];
            const score = parseBeadQualityScore(r.plan ?? "");
            const axes = score ? [score.what, score.why, score.how] : [];
            const avgScore = axes.length ? axes.reduce((s, n) => s + n, 0) / axes.length : null;
            const weakAxis = score
              ? (score.what <= Math.min(score.what, score.why, score.how) && score.what < 3 ? "what"
                : score.why <= Math.min(score.what, score.why, score.how) && score.why < 3 ? "why"
                : score.how < 3 ? "how" : null)
              : null;
            return { beadId: b.id, title: b.title, score, avgScore, weakAxis } satisfies BeadQualityAuditResult;
          });
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `❌ WHAT/WHY/HOW audit failed: ${err.message ?? err}\n\nCall \`orch_approve_beads\` again to continue.` }],
            details: { approved: false, auditError: String(err) },
          };
        }

        const auditDisplay = formatBeadQualityAudit(auditResults);

        // Offer to feed weak-bead suggestions into the next refinement round
        const weakBeads = auditResults.filter(
          (r) => r.score && (r.score.what < 3 || r.score.why < 3 || r.score.how < 3)
        );
        const auditChoice = await ctx.ui.select(
          `${auditDisplay}`,
          weakBeads.length > 0
            ? [
                `🔍 Refine ${weakBeads.length} weak bead${weakBeads.length !== 1 ? "s" : ""} (send suggestions to polish round)`,
                `⏭️  Continue without refining`,
              ]
            : [`✅ All beads above threshold — continue`]
        );

        if (auditChoice?.startsWith("🔍")) {
          oc.setPhase("refining_beads", ctx);
          oc.persistState();
          await syncBeads(oc.pi, ctx.cwd);

          const refinementModel = pickRefinementModel(round);
          const weakSuggestions = weakBeads
            .map((r) => {
              const weakAxes = [
                r.score!.what < 3 ? `WHAT(${r.score!.what}/5)` : "",
                r.score!.why < 3 ? `WHY(${r.score!.why}/5)` : "",
                r.score!.how < 3 ? `HOW(${r.score!.how}/5)` : "",
              ].filter(Boolean).join(", ");
              const suggestions = r.score!.suggestions.map((s) => `  - ${s}`).join("\n");
              return `### ${r.beadId}: ${r.title}\nWeak axes: ${weakAxes}\n${suggestions}`;
            })
            .join("\n\n");

          return {
            content: [{
              type: "text",
              text: `**NEXT: Improve these ${weakBeads.length} weak beads, then call \`orch_approve_beads\` again.**\n\n` +
                `Use \`br update <id> --description '...'\` to improve the weak axes.\n\n` +
                `## Beads Needing Improvement\n\n${weakSuggestions}\n\n` +
                `cd ${ctx.cwd}`,
            }],
            details: {
              approved: false, refining: true, whatWhyHowAudit: true,
              weakBeadCount: weakBeads.length, polishRound: round,
              model: refinementModel,
            },
          };
        }

        // Continue without refining
        return {
          content: [{ type: "text", text: `${auditDisplay}\n\nCall \`orch_approve_beads\` again to continue.` }],
          details: { approved: false, whatWhyHowAudit: true, weakBeadCount: weakBeads.length },
        };
      }

      if (choice?.startsWith("🩺")) {
        // Graph health remediation sub-menu
        const { remediateOrphans } = await import("../beads.js");

        const subOptions: string[] = [];
        if (validation.orphaned.length > 0) {
          subOptions.push(`🧹 Close ${validation.orphaned.length} orphaned bead${validation.orphaned.length !== 1 ? "s" : ""}`);
        }
        // Parse bottleneck bead IDs from warnings
        const bottleneckIds = (validation.warnings ?? [])
          .filter(w => w.includes("bottleneck"))
          .map(w => w.match(/bead (\S+)/)?.[1])
          .filter((id): id is string => !!id);
        if (bottleneckIds.length > 0) {
          subOptions.push(`✂️  Split ${bottleneckIds.length} bottleneck bead${bottleneckIds.length !== 1 ? "s" : ""}`);
        }
        // Parse articulation point IDs from warnings
        const articulationIds = (validation.warnings ?? [])
          .filter(w => w.includes("single point of failure"))
          .map(w => w.match(/bead (\S+)/)?.[1])
          .filter((id): id is string => !!id);
        if (articulationIds.length > 0) {
          subOptions.push(`🔗 Add redundancy for ${articulationIds.length} single-point-of-failure bead${articulationIds.length !== 1 ? "s" : ""}`);
        }
        subOptions.push("⬅️  Back to approval");

        const subChoice = await ctx.ui.select(
          `🩺 **Graph Health Remediation**\n\n` +
          (validation.orphaned.length > 0 ? `• ${validation.orphaned.length} orphaned beads: ${validation.orphaned.join(", ")}\n` : "") +
          (bottleneckIds.length > 0 ? `• ${bottleneckIds.length} bottleneck beads: ${bottleneckIds.join(", ")}\n` : "") +
          (articulationIds.length > 0 ? `• ${articulationIds.length} single points of failure: ${articulationIds.join(", ")}\n` : ""),
          subOptions,
        );

        if (subChoice?.startsWith("🧹")) {
          // Close orphaned beads directly
          const result = await remediateOrphans(oc.pi, ctx.cwd, validation.orphaned);
          ctx.ui.notify(
            `🧹 Closed ${result.closed.length} orphaned bead${result.closed.length !== 1 ? "s" : ""}` +
            (result.failed.length > 0 ? ` (${result.failed.length} failed)` : ""),
            result.failed.length > 0 ? "warning" : "info"
          );
          // Re-validate and return to approval
          return {
            content: [{
              type: "text",
              text: `**Closed ${result.closed.length} orphaned beads:** ${result.closed.join(", ")}${result.failed.length > 0 ? `\n⚠️ Failed to close: ${result.failed.join(", ")}` : ""}\n\nCall \`orch_approve_beads\` again to see updated graph health.`,
            }],
            details: { approved: false, remediation: "orphans", closed: result.closed, failed: result.failed },
          };
        }

        if (subChoice?.startsWith("✂️")) {
          // Bottleneck splitting: generate concrete split proposals via LLM
          oc.setPhase("refining_beads", ctx);
          oc.persistState();
          await syncBeads(oc.pi, ctx.cwd);

          const { beadSplitProposalPrompt, parseSplitProposal, formatSplitProposal, formatSplitCommands } = await import("../bead-splitting.js");
          const { runDeepPlanAgents } = await import("../deep-plan.js");

          // Generate split proposals for each bottleneck via sub-agents
          const proposalAgents = bottleneckIds.map((id) => {
            const bead = beads.find((b) => b.id === id);
            const betweenness = insights?.Bottlenecks?.find((b) => b.ID === id)?.Value ?? 0.5;
            return {
              name: `split-${id}`,
              task: bead ? beadSplitProposalPrompt(bead, betweenness) : `Bead ${id} not found.`,
              _beadId: id,
              _beadTitle: bead?.title ?? id,
              _betweenness: betweenness,
            };
          });

          const proposalResults = await runDeepPlanAgents(
            oc.pi, ctx.cwd,
            proposalAgents.map(({ name, task }) => ({ name, task })),
          );

          const proposals = proposalResults.map((result, i) => {
            const agent = proposalAgents[i];
            return parseSplitProposal(
              result.plan ?? "",
              agent._beadId,
              agent._beadTitle,
              agent._betweenness,
            );
          });

          const splittable = proposals.filter((p) => p.splittable);
          const unsplittable = proposals.filter((p) => !p.splittable);

          const proposalDisplay = proposals.map(formatSplitProposal).join("\n\n");
          const commands = splittable.map(formatSplitCommands).filter(Boolean).join("\n\n");

          return {
            content: [{
              type: "text",
              text: `**NEXT: Review these split proposals and execute the commands below, then call \`orch_approve_beads\` again.**\n\n## Bottleneck Split Proposals\n\n${proposalDisplay}\n\n${splittable.length > 0 ? `## Commands to Execute\n\n\`\`\`bash\n${commands}\n\`\`\`\n\nReview and run these commands to split the bottleneck beads.` : "No beads can be split — they are inherently sequential."}${unsplittable.length > 0 ? `\n\n## Cannot Split (${unsplittable.length})\n${unsplittable.map((p) => `- ${p.originalBeadId}: ${p.reason}`).join("\n")}` : ""}\n\ncd ${ctx.cwd}`,
            }],
            details: { approved: false, remediation: "bottlenecks", proposals, splittableCount: splittable.length, bottleneckIds, beadCount: beads.length },
          };
        }

        if (subChoice?.startsWith("🔗")) {
          // Articulation point remediation: add redundant dependency paths
          oc.setPhase("refining_beads", ctx);
          oc.persistState();
          await syncBeads(oc.pi, ctx.cwd);

          const articulationDetails = articulationIds.map(id => {
            const bead = beads.find(b => b.id === id);
            return bead ? `### ${id}: ${bead.title}\n${bead.description.split("\n").slice(0, 5).join("\n")}` : `### ${id} (details unavailable)`;
          }).join("\n\n");

          return {
            content: [{
              type: "text",
              text: `**NEXT: Reduce single-point-of-failure risk for these beads, then call \`orch_approve_beads\` again.**\n\n## Single Points of Failure\n\nThese beads are articulation points — if blocked, they disconnect the dependency graph and stall all downstream work.\n\nFor each articulation point:\n1. Read the full bead and its dependencies via \`br show <id>\` and \`br dep list <id>\`\n2. Consider:\n   - Can the bead be split so parallel paths exist?\n   - Can some downstream beads bypass this dependency?\n   - Is the dependency actually necessary or overly conservative?\n3. Make changes via \`br create\`, \`br dep add\`, or \`br dep remove\` as needed\n\n${articulationDetails}\n\ncd ${ctx.cwd}`,
            }],
            details: { approved: false, remediation: "articulation", articulationIds, beadCount: beads.length },
          };
        }

        // "Back to approval" — just re-trigger
        return {
          content: [{
            type: "text",
            text: "Call `orch_approve_beads` again to return to the approval menu.",
          }],
          details: { approved: false },
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
                text: `**NEXT: Apply this cross-model feedback, then call \`orch_approve_beads\` again.**\n\n### Raw cross-model feedback:\n${reviewResult.rawOutput}\n\n---\n\n${injectedPrompt}\n\n---\n\nCurrent beads (${beads.length} total):\n${compactBeadList}\n\nUse \`br show <id>\` for full bead details.`,
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
              text: `**NEXT: Apply these cross-model suggestions, then call \`orch_approve_beads\` again.**\n\n### Cross-model suggestions to apply:\n${suggestionsText}\n\n---\n\n${injectedPrompt}\n\n---\n\nCurrent beads (${beads.length} total):\n${compactBeadList}\n\nUse \`br show <id>\` for full bead details.`,
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
        _lastBeadSnapshotFull = undefined;
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [{ type: "text", text: "Beads rejected. Orchestration stopped." }],
          details: { approved: false },
        };
      }

      // "▶️ Start implementing" — run quality gate first (skip if auto-approved, already checked)
      const skipQualityGate = choice === "auto-approved";
      const qualityResult = skipQualityGate ? { passed: true, failures: [] as { beadId: string; check: string; reason: string }[] } : await qualityCheckBeads(oc.pi, ctx.cwd);
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
                text: `**Quality gate failed. Fix these issues, then call \`orch_approve_beads\` again.**\n\n⚠️ Issues:\n${failureLines.join("\n")}\n\n---\n\n${beadRefinementPrompt(round, oc.state.polishChanges)}\n\n---\n\nCurrent beads (${beads.length} total):\n${compactBeadList}\n\nUse \`br show <id>\` for full bead details.`,
              },
            ],
            details: { approved: false, refining: true, qualityGateFailed: true, beadCount: beads.length },
          };
        }
      }

      // Reset polish snapshot
      _lastBeadSnapshot = undefined;
      _lastBeadSnapshotFull = undefined;

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
        const executionMode = resolveExecutionMode(
          oc.state.coordinationMode,
          !!oc.state.coordinationBackend?.agentMail
        );
        const singleBranchMode = executionMode === "single-branch";

        // Check bv for bottleneck recommendations
        const { bvInsights } = await import("../beads.js");
        const insights = await bvInsights(oc.pi, ctx.cwd);
        let bvRecommendation = "";
        if (insights?.Bottlenecks?.length) {
          const top = insights.Bottlenecks[0];
          const readyIds = new Set(ready.map(b => b.id));
          if (readyIds.has(top.ID)) {
            bvRecommendation = `\n\n🎯 bv recommends implementing ${top.ID} first (critical bottleneck — unlocks most downstream work). Consider launching it before the others.`;
          }
        }

        // Build parallel agent configs
        const modelAssignments = await getParallelModelAssignments(ctx, ready.length);
        const agentConfigs = ready.map((bead, index) => {
          const artifacts = extractArtifacts(bead);
          const agentName = `bead-${bead.id}`;
          const preamble = oc.state.coordinationBackend?.agentMail
            ? agentMailTaskPreamble(
                ctx.cwd,
                agentName,
                bead.title,
                artifacts,
                bead.id,
                executionMode
              )
            : "";
          const branchModeInstructions = singleBranchMode
            ? "🤝 **Single-branch mode**: Work in the shared checkout at the provided cwd. Respect file reservations and avoid worktree-specific assumptions.\n\n"
            : "🌿 **Worktree mode**: Work in your assigned isolated checkout if one is provided by the orchestrator.\n\n";
          return {
            name: agentName,
            cwd: ctx.cwd,
            task: `${preamble}You are implementing bead ${bead.id}.\n\n## ${bead.title}\n\n${bead.description}\n\n⚠️ SCOPE CONSTRAINT: Only modify files listed in the bead. If additional files need changes, note them in your summary but DO NOT modify them.\n\n${branchModeInstructions}Implement the bead. When done, do a fresh-eyes review of all changes. Then COMMIT:${singleBranchMode ? "" : " only your bead changes"}\n\`\`\`bash\ngit add ${artifacts.map(f => '"' + f + '"').join(' ')} && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"${singleBranchMode ? "\ngit push" : ""}\n\`\`\`\n\nSummarize what you did and what the fresh-eyes review found.`,
            ...(modelAssignments[index] ? { model: modelAssignments[index] } : {}),
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
        const modeLabel = singleBranchMode
          ? "🤝 Single-branch mode — agents share the main checkout via cwd and coordinate with agent-mail reservations when available."
          : "🌿 Worktree mode — agents run in isolated checkouts when provided by the orchestrator.";

        return {
          content: [
            {
              type: "text",
              text: ready.length > 2
                ? `⏱️ **STAGGER LAUNCH**: You have ${ready.length} agents to launch. Launch them ONE AT A TIME with ${SWARM_STAGGER_DELAY_MS / 1000}-second gaps between each to prevent thundering herd. Call \`subagent\` for each agent config below sequentially, waiting ${SWARM_STAGGER_DELAY_MS / 1000}s between calls.${bvRecommendation}\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each bead with the sub-agent's summary.\n\n---\n\nBeads approved! ${beads.length} total, ${ready.length} ready now.\n\n${modeLabel}`
                : `**NEXT: Call \`parallel_subagents\` NOW to launch ${ready.length} parallel beads.**${bvRecommendation}\n\n\`\`\`json\n${parallelJson}\n\`\`\`\n\nAfter all agents complete, call \`orch_review\` for each bead with the sub-agent's summary.\n\n---\n\nBeads approved! ${beads.length} total, ${ready.length} ready now.\n\n${modeLabel}`,
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

      const { getEpisodicContext, sanitiseSlug } = await import("../episodic-memory.js");
      const firstBeadEpisodic = getEpisodicContext(firstBead.title, sanitiseSlug(ctx.cwd));
      const implInstr = implementerInstructions(
        firstBead,
        oc.state.repoProfile!,
        Object.values(oc.state.beadResults ?? {}),
        undefined,
        firstBeadEpisodic || undefined
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
      if (d?.plan) {
        if (!d.approved) return new Text(theme.fg("warning", "📋 Plan not approved"), 0, 0);
        return new Text(theme.fg("success", "📋 Plan approved — ready to create beads"), 0, 0);
      }
      if (!d?.approved) return new Text(theme.fg("warning", "📝 Beads rejected"), 0, 0);
      let text = theme.fg("success", `📝 Beads approved — ${d.beadCount} beads, ${d.readyCount} ready`);
      if (d.parallel) text += theme.fg("dim", " (parallel)");
      return new Text(text, 0, 0);
    },
  });
}
