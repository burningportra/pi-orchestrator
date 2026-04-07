import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CoordinationMode } from "../types.js";

export function formatModelRef(model: { provider?: string; id: string }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * Assign models to parallel agents using provider-diverse rotation.
 * Returns `undefined` per slot when fewer than 2 distinct models are available.
 */
export async function getParallelModelAssignments(ctx: ExtensionContext, agentCount: number): Promise<(string | undefined)[]> {
  if (agentCount < 2) {
    return Array(agentCount).fill(undefined);
  }

  const availableModels = ctx.modelRegistry.getAvailable();
  const orderedModels = availableModels.filter((model, index, models) =>
    models.findIndex((candidate) => formatModelRef(candidate) === formatModelRef(model)) === index
  );

  if (orderedModels.length < 2) {
    return Array(agentCount).fill(undefined);
  }

  const currentModelRef = ctx.model ? formatModelRef(ctx.model) : undefined;
  if (currentModelRef) {
    const currentIndex = orderedModels.findIndex((model) => formatModelRef(model) === currentModelRef);
    if (currentIndex > 0) {
      const [currentModel] = orderedModels.splice(currentIndex, 1);
      orderedModels.unshift(currentModel);
    }
  }

  const primaryModel = orderedModels[0];
  const rotation = [
    primaryModel,
    ...orderedModels.slice(1).filter((model) => model.provider !== primaryModel.provider),
  ];

  if (rotation.length < 2) {
    const fallbackAlt = orderedModels.slice(1).find((model) => formatModelRef(model) !== formatModelRef(primaryModel));
    if (!fallbackAlt) {
      return Array(agentCount).fill(undefined);
    }
    rotation.push(fallbackAlt);
  }

  return Array.from({ length: agentCount }, (_, index) => formatModelRef(rotation[index % rotation.length]));
}

/**
 * Pick execution mode: single-branch (shared checkout with file reservations)
 * or worktree (isolated checkouts). Prefers single-branch when agent-mail
 * is available for coordination.
 */
export function resolveExecutionMode(
  coordinationMode: CoordinationMode | undefined,
  hasAgentMail: boolean
): "worktree" | "single-branch" {
  if (coordinationMode === "single-branch") return "single-branch";
  if (coordinationMode === "worktree") return "worktree";
  return hasAgentMail ? "single-branch" : "worktree";
}
