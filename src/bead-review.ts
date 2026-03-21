import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Bead } from "./types.js";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

export interface CrossModelReviewResult {
  suggestions: string[];
  rawOutput: string;
  model: string;
}

/**
 * Send beads to an alternative model for cross-model review.
 * Uses pi --print with a different model to get a fresh perspective.
 */
export async function crossModelBeadReview(
  pi: ExtensionAPI,
  cwd: string,
  beads: Bead[],
  goal: string,
  signal?: AbortSignal
): Promise<CrossModelReviewResult> {
  // Pick an alternative model — try to use something different from the current session
  const altModel = pickAlternativeModel();

  const beadList = beads.map((b) => {
    return `### Bead ${b.id}: ${b.title}
Priority: ${b.priority} | Type: ${b.type} | Status: ${b.status}
${b.description}`;
  }).join("\n\n---\n\n");

  const prompt = `You are reviewing a set of implementation beads (tasks) for the goal: "${goal}"

## Beads to Review

${beadList}

## Your Task
Review these beads critically. Look for:
1. **Gaps in coverage** — is anything missing that the goal requires?
2. **Oversimplifications** — are any beads too vague or hand-wavy?
3. **Missing dependencies** — should any bead depend on another that it doesn't?
4. **Unclear scope** — would a fresh developer know exactly what to do?
5. **Split or merge candidates** — are any beads too large (should split) or too small (should merge)?
6. **Redundancies** — do any beads overlap significantly?

Output specific, actionable suggestions as a numbered list. Each suggestion should reference specific bead IDs.
If the beads look solid, say so briefly — don't invent problems.`;

  const outputDir = join(tmpdir(), `pi-bead-review-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const taskFile = join(outputDir, "review-task.md");
  writeFileSync(taskFile, prompt, "utf8");

  try {
    const args = [
      "--print",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--tools", "read,bash",
    ];

    if (altModel) {
      args.push("--model", altModel);
    }

    args.push(`@${taskFile}`);

    const result = await pi.exec("pi", args, {
      timeout: 120000, // 2 min
      cwd,
      signal,
    });

    const rawOutput = result.stdout.trim();
    const suggestions = parseSuggestions(rawOutput);

    // Clean up temp files
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }

    return {
      suggestions,
      rawOutput,
      model: altModel ?? "default",
    };
  } catch (err) {
    // Clean up temp files on error too
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }

    return {
      suggestions: [],
      rawOutput: err instanceof Error ? err.message : String(err),
      model: altModel ?? "default",
    };
  }
}

/**
 * Pick an alternative model for cross-review.
 * Tries to select a model different from the likely current session model.
 */
function pickAlternativeModel(): string | undefined {
  // Default to gemini — different provider perspective from Claude
  return "gemini-2.5-pro";
}

/**
 * Parse numbered suggestions from model output.
 */
function parseSuggestions(output: string): string[] {
  const lines = output.split("\n");
  const suggestions: string[] = [];
  let current = "";

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (match) {
      if (current) suggestions.push(current.trim());
      current = match[2];
    } else if (current && line.trim()) {
      current += " " + line.trim();
    }
  }
  if (current) suggestions.push(current.trim());

  return suggestions;
}
