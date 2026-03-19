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
export function orchestratorSystemPrompt(): string {
  return `You are operating as a repo-aware multi-agent orchestrator. You have access to specialized orchestrator tools that drive a structured workflow.

## Your Workflow
1. Call \`orch_profile\` to scan the repository
2. Call \`orch_discover\` to generate project ideas from the profile
3. Call \`orch_select\` to present ideas to the user and get their choice
4. Call \`orch_plan\` to create a step-by-step plan for the selected goal
5. For each plan step, call \`orch_implement\` then \`orch_review\`
6. After all steps, call \`orch_complete\` for the final summary

## Rules
- Follow the workflow in order. Do not skip steps.
- After each tool call, read the result carefully before proceeding.
- When implementing steps, use the standard code tools (read, write, edit, bash) to make actual changes.
- The orch_implement tool gives you the step context. You then use code tools to do the work, and call orch_review when done.
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

### Instructions
Now use the standard code tools (read, write, edit, bash) to implement this step.
- Read relevant files first to understand the codebase
- Make focused, targeted changes
- Stay within the plan scope
- After completing changes, call \`orch_review\` with a summary of what you did`;
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
