import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { OrchestratorContext } from "../types.js";
import { getBeadById, updateBeadStatus } from "../beads.js";

interface VerifyOutcome {
  verified: string[];
  autoClosed: Array<{ beadId: string; commit: string }>;
  unclosedNoCommit: Array<{ id: string; status: string }>;
  errors: Record<string, string>;
}

async function findCommitForBead(oc: OrchestratorContext, cwd: string, beadId: string): Promise<string | null> {
  try {
    const result = await oc.pi.exec("git", ["log", `--grep=${beadId}`, "--oneline", "-1"], { cwd, timeout: 5000 });
    if (result.code !== 0) return null;
    const sha = result.stdout.trim().split(/\s+/)[0];
    return sha && /^[0-9a-f]{4,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function renderOutcome(outcome: VerifyOutcome, total: number): string {
  const lines = [`Verified ${outcome.verified.length}/${total} bead(s) closed.`];
  if (outcome.autoClosed.length > 0) {
    lines.push("", `Auto-closed ${outcome.autoClosed.length} bead(s) with matching commits:`);
    for (const item of outcome.autoClosed) lines.push(`- ${item.beadId} → ${item.commit.slice(0, 7)}`);
  }
  if (outcome.unclosedNoCommit.length > 0) {
    lines.push("", `⚠️ ${outcome.unclosedNoCommit.length} bead(s) still not closed and no matching commit was found:`);
    for (const item of outcome.unclosedNoCommit) lines.push(`- ${item.id} (${item.status})`);
  }
  const errors = Object.entries(outcome.errors);
  if (errors.length > 0) {
    lines.push("", "Errors:");
    for (const [id, error] of errors) lines.push(`- ${id}: ${error}`);
  }
  return lines.join("\n");
}

export function registerVerifyBeadsTool(oc: OrchestratorContext) {
  for (const toolName of ["flywheel_verify_beads", "orch_verify_beads"] as const) {
  oc.pi.registerTool({
    name: toolName,
    label: "Verify Beads",
    description: "Reconcile a completed implementation wave: verify bead IDs are closed, auto-close those with matching commits, and report stragglers.",
    promptSnippet: "Verify a wave of beads after implementation agents report completion",
    parameters: Type.Object({
      beadIds: Type.Array(Type.String(), { description: "Bead IDs to reconcile after an implementation wave", minItems: 1 }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const beadIds = Array.isArray(params.beadIds) ? params.beadIds as string[] : [];
      if (beadIds.length === 0) {
        return {
          content: [{ type: "text", text: "Error: beadIds must be a non-empty array." }],
          details: { error: true },
        };
      }

      const outcome: VerifyOutcome = { verified: [], autoClosed: [], unclosedNoCommit: [], errors: {} };

      for (const beadId of beadIds) {
        try {
          const bead = await getBeadById(oc.pi, ctx.cwd, beadId);
          if (!bead) {
            outcome.errors[beadId] = "bead not found";
            continue;
          }
          if (bead.status === "closed") {
            outcome.verified.push(beadId);
            continue;
          }

          const commit = await findCommitForBead(oc, ctx.cwd, beadId);
          if (commit) {
            await updateBeadStatus(oc.pi, ctx.cwd, beadId, "closed");
            outcome.autoClosed.push({ beadId, commit });
            outcome.verified.push(beadId);
            oc.state.beadResults ??= {};
            oc.state.beadResults[beadId] = {
              beadId,
              status: "success",
              summary: `Auto-closed by ${toolName} (commit: ${commit.slice(0, 7)})`,
            };
            continue;
          }

          outcome.unclosedNoCommit.push({ id: beadId, status: bead.status });
        } catch (err) {
          outcome.errors[beadId] = err instanceof Error ? err.message : String(err);
        }
      }

      if (outcome.autoClosed.length > 0) oc.persistState();

      return {
        content: [{ type: "text", text: renderOutcome(outcome, beadIds.length) }],
        details: { outcome },
      };
    },

    renderResult(result, _options, theme) {
      const outcome = (result.details as any)?.outcome as VerifyOutcome | undefined;
      if (!outcome) return new Text("Verify beads completed", 0, 0);
      const hasProblems = outcome.unclosedNoCommit.length > 0 || Object.keys(outcome.errors).length > 0;
      return new Text(
        hasProblems
          ? theme.fg("warning", `Verified ${outcome.verified.length}; ${outcome.unclosedNoCommit.length} straggler(s)`)
          : theme.fg("success", `Verified ${outcome.verified.length} bead(s)`),
        0,
        0,
      );
    },
  });
  }
}
