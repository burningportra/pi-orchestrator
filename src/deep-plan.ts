import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";

export interface DeepPlanAgent {
  name: string;
  task: string;
  model?: string;
}

export interface DeepPlanResult {
  name: string;
  model: string;
  plan: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

/**
 * Run deep planning agents directly via pi CLI with --no-extensions.
 * This avoids the Gemini patternProperties schema issue caused by
 * extensions like autoresearch registering tools with unsupported
 * JSON Schema features.
 */
export async function runDeepPlanAgents(
  pi: ExtensionAPI,
  cwd: string,
  agents: DeepPlanAgent[],
  signal?: AbortSignal
): Promise<DeepPlanResult[]> {
  // Write each agent's task to a temp file and spawn pi in print mode
  const outputDir = join(tmpdir(), `pi-deep-plan-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  const promises = agents.map(async (agent, i) => {
    const startTime = Date.now();
    const taskFile = join(outputDir, `${agent.name}-task.md`);
    const outputFile = join(outputDir, `${agent.name}-output.md`);
    writeFileSync(taskFile, agent.task, "utf8");

    try {
      const args = [
        "--print",            // non-interactive, output to stdout
        "--no-extensions",    // no extensions — avoids patternProperties issue
        "--no-skills",        // no skills needed for planning
        "--no-prompt-templates",
        "--tools", "read,bash,grep,find,ls",  // read-only tools
      ];

      if (agent.model) {
        args.push("--model", agent.model);
      }

      args.push(`@${taskFile}`);

      const result = await pi.exec("pi", args, {
        timeout: 180000, // 3 min timeout per planner
        cwd,
        signal,
      });

      const plan = result.stdout.trim();
      writeFileSync(outputFile, plan, "utf8");

      return {
        name: agent.name,
        model: agent.model ?? "default",
        plan,
        exitCode: result.code,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
      } as DeepPlanResult;
    } catch (err) {
      return {
        name: agent.name,
        model: agent.model ?? "default",
        plan: "",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: err instanceof Error ? err.message : String(err),
      } as DeepPlanResult;
    }
  });

  // Run all in parallel
  return Promise.all(promises);
}
