import type { RepoProfile, PlanStep, StepResult } from "./types.js";

// ─── Repo Profile Formatting ────────────────────────────────
export function formatRepoProfile(profile: RepoProfile): string {
  const sections = [
    `## Repository: ${profile.name}`,
    `**Languages:** ${profile.languages.join(", ") || "unknown"}`,
    `**Frameworks:** ${profile.frameworks.join(", ") || "none detected"}`,
    `**Package Manager:** ${profile.packageManager ?? "unknown"}`,
    `**Entrypoints:** ${profile.entrypoints.join(", ") || "none detected"}`,
    `**Tests:** ${profile.hasTests ? `Yes (${profile.testFramework ?? "unknown framework"})` : "No"}`,
    `**Docs:** ${profile.hasDocs ? "Yes" : "No"}`,
    `**CI:** ${profile.hasCI ? `Yes (${profile.ciPlatform ?? "unknown"})` : "No"}`,
    `**TODOs/FIXMEs:** ${profile.todos.length} found`,
  ];

  if (profile.todos.length > 0) {
    sections.push(
      "\n### Notable TODOs",
      ...profile.todos.slice(0, 10).map(
        (t) => `- \`${t.file}:${t.line}\` [${t.type}] ${t.text}`
      )
    );
  }

  if (profile.recentCommits.length > 0) {
    sections.push(
      "\n### Recent Commits",
      ...profile.recentCommits.slice(0, 10).map(
        (c) => `- \`${c.hash}\` ${c.message} (${c.author})`
      )
    );
  }

  if (profile.readme) {
    const truncated =
      profile.readme.length > 2000
        ? profile.readme.slice(0, 2000) + "\n...(truncated)"
        : profile.readme;
    sections.push("\n### README (excerpt)", truncated);
  }

  return sections.join("\n");
}

// ─── System Prompt for Orchestrator Mode ────────────────────
export function orchestratorSystemPrompt(hasSophia: boolean): string {
  const sophiaSection = hasSophia
    ? `
## Sophia Integration
The orchestrator uses Sophia for change request and task management. When \`orch_plan\` is approved:
- A Sophia CR is created automatically with tasks matching plan steps
- Use \`sophia cr task done <crId> <taskId> --commit-type feat --from-contract\` to checkpoint completed tasks
- After all steps, \`sophia cr validate\` and \`sophia cr review\` run automatically

## Parallel Execution with Worktree Isolation
When the plan has independent steps (no shared artifacts), use \`parallel_subagents\` with git worktree isolation:

1. The orchestrator creates a **WorktreePool** — each parallel step gets its own git worktree checkout
2. For each parallel group, spawn sub-agents via \`parallel_subagents\`, passing the worktree path as the working directory
3. Each sub-agent works in isolation — no file conflicts between parallel steps
4. After all agents in a group complete, worktree changes are merged back to the main branch sequentially
5. Worktrees are cleaned up after merge

The plan result shows which step groups can run in parallel and provides worktree paths.
If worktree creation fails, the orchestrator falls back to sequential execution in the shared directory.`
    : "";

  return `You are operating as a repo-aware multi-agent orchestrator. You have access to specialized orchestrator tools that drive a structured workflow.

## Your Workflow
1. Call \`orch_profile\` to scan the repository
2. Call \`orch_discover\` to generate project ideas from the profile
3. Call \`orch_select\` to present ideas to the user and get their choice
4. Call \`orch_plan\` to create a step-by-step plan for the selected goal
5. For each plan step, implement using code tools (read, write, edit, bash), then call \`orch_review\`
6. After all steps pass review, the orchestrator runs post-completion checks and offers follow-up actions
${sophiaSection}

## Multi-Pass Review
Each step goes through multiple review passes:
1. **Self-review**: You assess your own work against acceptance criteria via \`orch_review\`
2. **Adversarial review**: A second pass with fresh eyes checks for bugs, oversights, ergonomics issues
3. **Cross-agent review**: After ALL steps complete, an independent reviewer sub-agent audits the full diff

This mirrors the "check over everything again with fresh eyes" pattern — don't skip it.

## Post-Completion
After all steps and reviews pass, the orchestrator offers:
- **Polish pass**: De-slopify — improve clarity, remove generic AI patterns, maximize ergonomics
- **Commit strategy**: Group changes into logical commits with detailed messages
- **Skill extraction**: Check if the work product should become a reusable skill

## Rules
- Follow the workflow in order. Do not skip steps.
- After each tool call, read the result carefully before proceeding.
- When implementing steps, use the standard code tools (read, write, edit, bash) to make actual changes.
- If a review fails, re-implement based on the revision instructions, then review again (max 3 retries per step).
- Keep the user informed with brief status updates between tool calls.
- If orch_select returns no selection, stop gracefully.
- If orch_plan returns and the user rejects, stop gracefully.`;
}

// ─── Discovery Prompt ────────────────────────────────────────
export function discoveryInstructions(profile: RepoProfile): string {
  return `Analyze this repository profile and suggest 3–7 high-leverage, concrete project ideas.

${formatRepoProfile(profile)}

## Guidelines
- Each idea should be executable in a few hours to a couple of days
- Avoid trivial tasks — aim for meaningful improvements
- Ground ideas in the actual repo state (don't suggest "add tests" if tests are comprehensive)
- Cover a mix of categories when possible
- Consider: features, refactors, docs, DX, performance, reliability, security, testing

For each idea, provide:
- **id**: unique kebab-case identifier
- **title**: short descriptive title
- **description**: 2-3 sentences explaining what to do and why
- **category**: feature | refactor | docs | dx | performance | reliability | security | testing
- **effort**: low | medium | high
- **impact**: low | medium | high`;
}

// ─── Planner Instructions ────────────────────────────────────
export function plannerInstructions(
  goal: string,
  profile: RepoProfile,
  constraints: string[]
): string {
  return `Create a detailed step-by-step plan for the following goal.

## Goal
${goal}

${formatRepoProfile(profile)}

## Constraints
${constraints.length > 0 ? constraints.map((c) => `- ${c}`).join("\n") : "None specified."}

## Guidelines
- Produce 3–7 steps
- Each step must have clear acceptance criteria
- List expected artifacts (files to create/modify) for each step
- Treat user implementation suggestions as soft constraints; justify if you deviate
- Order steps logically (foundations first, integration last)

Return a structured plan with:
- **goal**: restated goal
- **steps**: array of { index, description, acceptanceCriteria[], artifacts[] }`;
}

// ─── Deep Planning Synthesis Prompt ──────────────────────────
export function synthesisInstructions(plans: { name: string; model: string; plan: string }[]): string {
  const planBlocks = plans
    .map((p) => `### ${p.name} (${p.model})\n\n${p.plan}`)
    .join("\n\n---\n\n");

  return `## Best-of-All-Worlds Synthesis

I asked ${plans.length} competing LLMs to independently create plans. They came up with pretty different approaches. Read them below.

${planBlocks}

---

REALLY carefully analyze each plan with an open mind. Be intellectually honest about what each one did that's better than the others. Then come up with the best possible hybrid that artfully and skillfully blends the "best of all worlds" to create a true, ultimate, superior version that:

- Integrates every good idea (you don't need to mention which came from which model)
- Resolves contradictions by picking the stronger approach
- Ensures the plan covers: workflows, constraints, architecture, testing, and failure handling
- Is detailed enough that a fresh agent can execute without guessing

Then call \`orch_plan\` with the synthesized plan.`;
}

// ─── Plan-to-Tasks Conversion Prompt ─────────────────────────
export function planToTasksInstructions(goal: string, steps: PlanStep[]): string {
  return `## Convert Plan to Tasks

Take ALL of the plan below and create a comprehensive and granular set of tasks with subtasks and dependency structure, with detailed comments so the whole thing is totally self-contained and self-documenting.

### Goal
${goal}

### Steps
${steps.map((s) => `${s.index}. ${s.description}\n   Criteria: ${s.acceptanceCriteria.join("; ")}\n   Files: ${s.artifacts.join(", ")}`).join("\n\n")}

The tasks should be so detailed that we never need to consult back to the original plan. Each task should carry its own context, reasoning, dependencies, and acceptance criteria.`;
}

// ─── Reality Check Prompt ────────────────────────────────────
export function realityCheckInstructions(
  goal: string,
  steps: PlanStep[],
  results: StepResult[]
): string {
  const done = results.filter((r) => r.status === "success").length;
  const total = steps.length;

  return `## Reality Check

Where are we on this project? Do we actually have the thing we are trying to build?

### Goal
${goal}

### Progress
${done}/${total} steps completed.

${steps.map((s) => {
  const r = results.find((r) => r.stepIndex === s.index);
  return `- Step ${s.index}: ${r?.status ?? "not started"} — ${s.description}${r?.summary ? `\n  Summary: ${r.summary}` : ""}`;
}).join("\n")}

### Questions to answer honestly
1. If we intelligently implement all remaining open tasks, would we close the gap completely? Why or why not?
2. What is actually blocking us right now?
3. Are there missing tasks or dependencies that the plan didn't account for?
4. Is any completed work actually broken or incomplete despite being marked done?

Be brutally honest. If the answer is "no, we wouldn't close the gap," the fix is usually to revise the plan or add missing work, not to push harder on implementation.`;
}

// ─── Implementer Instructions ────────────────────────────────
export function implementerInstructions(
  step: PlanStep,
  profile: RepoProfile,
  previousResults: StepResult[]
): string {
  const prevContext =
    previousResults.length > 0
      ? `\n## Previous Steps Completed\n${previousResults
          .map((r) => `- Step ${r.stepIndex}: ${r.status} — ${r.summary}`)
          .join("\n")}`
      : "";

  return `## Implement Step ${step.index}: ${step.description}

### Acceptance Criteria
${step.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}

### Expected Artifacts
${step.artifacts.map((a) => `- ${a}`).join("\n")}

### Repo Context
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
${prevContext}

### Marching Orders
First read the relevant files to fully understand the code and technical architecture.
Then implement this step using the standard code tools (read, write, edit, bash).
Work systematically and meticulously. Don't get stuck in analysis — be proactive.
Make focused, targeted changes. Stay within the plan scope.

**After implementing, do a fresh-eyes review:** carefully read over ALL the new code you just wrote and any existing code you modified, looking super carefully for any obvious bugs, errors, problems, issues, or confusion. Fix anything you uncover.

After the fresh-eyes review, call \`orch_review\` with a summary of what you did and what the review found.`;
}

// ─── Reviewer Instructions ───────────────────────────────────
export function reviewerInstructions(
  step: PlanStep,
  implementationSummary: string,
  profile: RepoProfile
): string {
  return `## Review Step ${step.index}: ${step.description}

### Acceptance Criteria
${step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

### Implementation Summary
${implementationSummary}

### Project Conventions
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
- **Test Framework:** ${profile.testFramework ?? "unknown"}

### Review Checklist
1. Does the implementation satisfy each acceptance criterion?
2. Do changes align with project conventions?
3. Are there any regressions or issues introduced?
4. Is the code clean and well-structured?

Determine: **PASS** or **FAIL**
If FAIL, provide specific revision instructions.`;
}

// ─── Parallel Execution Instructions ─────────────────────────
export function parallelExecutionInstructions(
  group: number[],
  steps: PlanStep[],
  worktreePaths: Map<number, string>
): string {
  const agentConfigs = group.map((idx) => {
    const step = steps.find((s) => s.index === idx)!;
    const wtPath = worktreePaths.get(idx);
    return `### Step ${idx}: ${step.description}
- **Working directory:** \`${wtPath ?? "(shared — worktree unavailable)"}\`
- **Acceptance criteria:**
${step.acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}
- **Files:** ${step.artifacts.join(", ")}`;
  });

  return `## Parallel Execution — Group [Steps ${group.join(", ")}]

Spawn ${group.length} sub-agents to implement these steps concurrently.
Each agent works in its own git worktree — no conflicts.

${agentConfigs.join("\n\n")}

### Instructions for sub-agents
Each sub-agent should:
1. \`cd\` to its assigned worktree path
2. Implement the step using standard code tools
3. Commit changes in the worktree
4. Report completion

After ALL agents complete, changes will be merged back sequentially.`;
}

// ─── Adversarial Review Instructions ─────────────────────────
export function adversarialReviewInstructions(
  step: PlanStep,
  implementationSummary: string
): string {
  return `## Adversarial "Fresh Eyes" Review — Step ${step.index}

You are reviewing this step as if you've never seen it before. The first review already passed — your job is to catch what it missed.

### What was implemented
${implementationSummary}

### Acceptance Criteria
${step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

### Check specifically for:
1. **Blunders & bugs** — off-by-one errors, null derefs, race conditions, missing error handling
2. **Ergonomics** — is this maximally intuitive for coding agents to use? Would YOU want to use this if you came in fresh?
3. **Oversights** — edge cases not covered, missing validation, assumptions that don't hold
4. **Security** — injection, path traversal, secrets in output, unsafe defaults
5. **Style** — generic AI slop, unnecessary verbosity, unclear naming

Be harsh. If you find issues, provide specific file:line references and fixes.
If everything is genuinely clean, say so briefly — don't invent problems.`;
}

// ─── Cross-Agent Review Instructions ─────────────────────────
export function crossAgentReviewInstructions(
  goal: string,
  steps: PlanStep[],
  results: StepResult[]
): string {
  return `## Independent Cross-Agent Code Review

You are an independent reviewer auditing the FULL diff of this orchestration.
You did NOT write this code. Review it with zero assumptions.

### Goal
${goal}

### Steps Completed
${steps
  .map((s) => {
    const r = results.find((r) => r.stepIndex === s.index);
    return `- Step ${s.index}: ${s.description} (${r?.status ?? "unknown"})`;
  })
  .join("\n")}

### Your Review Checklist
1. **Correctness** — Does the implementation actually achieve the stated goal?
2. **Consistency** — Do all the pieces fit together? Any contradictions between steps?
3. **Completeness** — Anything missing that the plan promised?
4. **Code quality** — Clean, well-structured, follows project conventions?
5. **Agent ergonomics** — Would another coding agent find this easy to understand and modify?
6. **Regressions** — Could any change break existing functionality?

### Output
Provide:
- A severity-ranked list of findings (critical → minor)
- Specific fix suggestions for anything critical
- An overall verdict: APPROVE or REQUEST_CHANGES`;
}

// ─── Post-Completion Phase Instructions ──────────────────────
export function polishInstructions(goal: string, artifacts: string[]): string {
  return `## Polish Pass (De-Slopify)

Review all files changed during this orchestration and improve them:

### Goal context
${goal}

### Files to review
${artifacts.map((a) => `- ${a}`).join("\n")}

### What to fix:
1. **Remove AI slop** — generic phrases like "leverage", "robust", "comprehensive", unnecessary caveats
2. **Improve clarity** — rename vague variables, simplify convoluted logic, add comments only where non-obvious
3. **Maximize ergonomics** — make this the code YOU would want to read if coming in fresh
4. **Consistent style** — match the project's existing conventions
5. **Trim fat** — remove dead code, unused imports, unnecessary abstractions

Make targeted edits. Don't rewrite things that are already good.`;
}

export function commitStrategyInstructions(
  steps: PlanStep[],
  results: StepResult[]
): string {
  return `## Commit Strategy

Group the changes from this orchestration into logical commits with detailed messages.

### Steps completed
${steps
  .map((s) => {
    const r = results.find((r) => r.stepIndex === s.index);
    return `- Step ${s.index}: ${s.description}\n  Files: ${s.artifacts.join(", ")}\n  Summary: ${r?.summary ?? "N/A"}`;
  })
  .join("\n\n")}

### Rules
- Group by logical change, NOT by step number (steps may touch the same files)
- Each commit should be independently understandable
- Use conventional commit format: type(scope): description
- First line ≤ 72 chars, then blank line, then detailed body
- Body explains WHY, not just WHAT
- Reference step numbers in the body for traceability

Create the commits now using bash (git add -p / git add <files> then git commit).`;
}

export function skillExtractionInstructions(
  goal: string,
  artifacts: string[]
): string {
  return `## Skill Extraction Check

Evaluate whether the work from this orchestration should become a reusable agent skill.

### What was built
Goal: ${goal}
Artifacts: ${artifacts.join(", ")}

### Criteria for extraction
A skill is worth creating if:
1. The workflow/pattern will be reused across projects
2. It encapsulates non-obvious domain knowledge
3. It would save significant time on future similar tasks
4. It's self-contained enough to work without heavy context

### If yes:
- Create a SKILL.md following the standard format
- Include: name, description (trigger phrases), concrete instructions, examples
- Place it in a skills/ subdirectory

### If no:
- Briefly explain why not (too project-specific, too simple, etc.)
- Suggest if any PART of it could be a skill`;
}

// ─── Summary Instructions ────────────────────────────────────
export function summaryInstructions(
  goal: string,
  steps: PlanStep[],
  results: StepResult[]
): string {
  return `## Generate Final Summary

### Goal
${goal}

### Steps and Results
${steps
  .map((s) => {
    const result = results.find((r) => r.stepIndex === s.index);
    return `**Step ${s.index}: ${s.description}**
- Status: ${result?.status ?? "not started"}
- Summary: ${result?.summary ?? "N/A"}`;
  })
  .join("\n\n")}

### Instructions
Write a clear, user-facing summary including:
1. What goal was implemented
2. What files changed or were created
3. How to use the new functionality (commands, configuration, etc.)
4. Any follow-up recommendations

Also ask the user if they'd like you to:
- Create a GUIDE.md documenting the changes
- Run tests
- Create a git commit with a descriptive message`;
}
