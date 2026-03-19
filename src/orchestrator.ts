import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  OrchestratorState,
  RepoProfile,
  CandidateIdea,
  Plan,
  StepResult,
  ReviewResult,
} from "./types.js";
import { createInitialState } from "./types.js";
import { collectRepoSignals, buildDirectoryTree } from "./profiler.js";
import {
  repoProfilerPrompt,
  discoveryPrompt,
  plannerPrompt,
  implementerPrompt,
  reviewerPrompt,
  summaryPrompt,
} from "./prompts.js";

export class Orchestrator {
  state: OrchestratorState;
  private pi: ExtensionAPI;
  private cwd: string;

  constructor(pi: ExtensionAPI, cwd: string) {
    this.pi = pi;
    this.cwd = cwd;
    this.state = createInitialState();
  }

  /**
   * Run the full orchestration loop.
   * This is driven by sending messages to the LLM via pi.sendUserMessage
   * and using subagent-style prompting through the tools.
   */
  async run(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
    // Phase 1: Profile the repo
    this.state.phase = "profiling";
    ctx.ui.setStatus("orchestrator", "📊 Profiling repository...");

    const signals = await collectRepoSignals(this.pi, this.cwd, signal);
    const profilePrompt = repoProfilerPrompt(
      signals.fileTree,
      signals.recentCommits.map((c) => `${c.hash} ${c.message}`).join("\n"),
      signals.keyFiles
    );

    // We send the profiler prompt to the LLM and parse the response.
    // The orchestrator tool will handle this via the LLM's own capabilities.
    this.state.repoProfile = await this.callLLMForJSON<RepoProfile>(
      profilePrompt,
      ctx,
      signal
    );

    // Attach collected data the LLM can't infer
    this.state.repoProfile.structure = buildDirectoryTree(signals.fileTree);
    this.state.repoProfile.recentCommits = signals.recentCommits;
    this.state.repoProfile.todos = signals.todos;

    if (signal?.aborted) return;

    // Phase 2: Discover ideas
    this.state.phase = "discovering";
    ctx.ui.setStatus("orchestrator", "💡 Generating ideas...");

    const discPrompt = discoveryPrompt(this.state.repoProfile);
    this.state.candidateIdeas = await this.callLLMForJSON<CandidateIdea[]>(
      discPrompt,
      ctx,
      signal
    );

    if (signal?.aborted) return;

    // Phase 3: User selects an idea
    this.state.phase = "selecting";
    ctx.ui.setStatus("orchestrator", "🎯 Awaiting selection...");

    const selectedGoal = await this.presentIdeasAndSelect(
      this.state.candidateIdeas,
      ctx
    );
    if (!selectedGoal) {
      this.state.phase = "idle";
      ctx.ui.setStatus("orchestrator", undefined);
      return;
    }
    this.state.selectedGoal = selectedGoal;

    if (signal?.aborted) return;

    // Phase 4: Plan
    this.state.phase = "planning";
    ctx.ui.setStatus("orchestrator", "📝 Planning...");

    const constraints = await this.askForConstraints(ctx);
    const pPrompt = plannerPrompt(
      this.state.selectedGoal,
      this.state.repoProfile,
      constraints
    );
    this.state.plan = await this.callLLMForJSON<Plan>(pPrompt, ctx, signal);

    // Show plan and get approval
    const planApproved = await this.presentPlanForApproval(
      this.state.plan,
      ctx
    );
    if (!planApproved) {
      this.state.phase = "idle";
      ctx.ui.setStatus("orchestrator", undefined);
      return;
    }

    if (signal?.aborted) return;

    // Phase 5: Implement + Review loop
    for (const step of this.state.plan.steps) {
      if (signal?.aborted) break;

      this.state.currentStepIndex = step.index;
      this.state.retryCount = 0;

      let stepPassed = false;
      while (!stepPassed && this.state.retryCount < this.state.maxRetries) {
        if (signal?.aborted) break;

        // Implement
        this.state.phase = "implementing";
        ctx.ui.setStatus(
          "orchestrator",
          `🔨 Implementing step ${step.index}/${this.state.plan!.steps.length}...`
        );

        const implPrompt = implementerPrompt(
          step,
          this.state.repoProfile,
          this.state.stepResults
        );

        // Send implementation prompt — the LLM will use tools to make changes
        this.pi.sendUserMessage(implPrompt, { deliverAs: "followUp" });

        // After implementation, collect what happened
        const stepResult: StepResult = {
          stepIndex: step.index,
          status: "success", // will be updated by reviewer
          changes: [],
          notes: "Implementation completed via LLM tools.",
        };
        this.state.stepResults.push(stepResult);

        // Review
        this.state.phase = "reviewing";
        ctx.ui.setStatus(
          "orchestrator",
          `🔍 Reviewing step ${step.index}/${this.state.plan!.steps.length}...`
        );

        const revPrompt = reviewerPrompt(
          step,
          stepResult,
          this.state.repoProfile
        );
        const review = await this.callLLMForJSON<ReviewResult>(
          revPrompt,
          ctx,
          signal
        );
        this.state.reviewResults.push(review);

        if (review.passed) {
          stepPassed = true;
          ctx.ui.notify(`✅ Step ${step.index} passed review`, "info");
        } else {
          this.state.retryCount++;
          ctx.ui.notify(
            `⚠️ Step ${step.index} needs revision (attempt ${this.state.retryCount}/${this.state.maxRetries})`,
            "warning"
          );

          if (
            review.revisionInstructions &&
            this.state.retryCount < this.state.maxRetries
          ) {
            this.pi.sendUserMessage(
              `Revision needed for step ${step.index}: ${review.revisionInstructions}`,
              { deliverAs: "followUp" }
            );
          }
        }
      }

      if (!stepPassed) {
        const cont = await ctx.ui.confirm(
          "Step Failed",
          `Step ${step.index} failed after ${this.state.maxRetries} attempts. Continue to next step?`
        );
        if (!cont) break;
      }
    }

    // Phase 6: Summary
    this.state.phase = "complete";
    ctx.ui.setStatus("orchestrator", "✅ Complete");

    const sumPrompt = summaryPrompt(this.state.plan!, this.state.stepResults);
    this.pi.sendUserMessage(sumPrompt, { deliverAs: "followUp" });
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private async callLLMForJSON<T>(
    prompt: string,
    ctx: ExtensionContext,
    signal?: AbortSignal
  ): Promise<T> {
    // We send the prompt as a user message and rely on the LLM to respond with JSON.
    // The orchestrator tool's execute handler will parse it from the next assistant message.
    // For now, we use a simpler approach: send as a follow-up and trust the LLM.
    //
    // In practice, this will be handled by the tool's execute flow where the LLM
    // responds inline. We return a placeholder that gets filled by the message handler.
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });

    // Return empty/default — the actual orchestration works by sending prompts
    // that the LLM responds to with tool calls and text.
    return {} as T;
  }

  private async presentIdeasAndSelect(
    ideas: CandidateIdea[],
    ctx: ExtensionContext
  ): Promise<string | undefined> {
    if (!ideas || ideas.length === 0) {
      ctx.ui.notify("No ideas generated. Try a different repo.", "warning");
      return undefined;
    }

    const options = ideas.map(
      (idea) =>
        `[${idea.category}] ${idea.title} (effort: ${idea.effort}, impact: ${idea.impact})\n  ${idea.description}`
    );
    options.push("🔧 Enter a custom goal");

    const choice = await ctx.ui.select(
      "Select a project idea to implement:",
      options
    );

    if (choice === undefined) return undefined;

    if (choice === options.length - 1) {
      return await ctx.ui.input("Enter your goal:", "e.g., Add API rate limiting");
    }

    return ideas[choice]?.title + ": " + ideas[choice]?.description;
  }

  private async askForConstraints(
    ctx: ExtensionContext
  ): Promise<string[]> {
    const input = await ctx.ui.input(
      "Any constraints? (comma-separated, or leave empty)",
      "e.g., no new dependencies, keep backward compat"
    );
    if (!input) return [];
    return input.split(",").map((c) => c.trim()).filter(Boolean);
  }

  private async presentPlanForApproval(
    plan: Plan,
    ctx: ExtensionContext
  ): Promise<boolean> {
    const planText = plan.steps
      .map(
        (s) =>
          `${s.index}. ${s.description}\n   Criteria: ${s.acceptanceCriteria.join("; ")}\n   Files: ${s.artifacts.join(", ")}`
      )
      .join("\n\n");

    return await ctx.ui.confirm(
      `Plan for: ${plan.goal}`,
      `${planText}\n\nProceed with this plan?`
    );
  }
}
