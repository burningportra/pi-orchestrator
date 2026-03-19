import type { RepoProfile, Plan, PlanStep, StepResult } from "./types.js";

// ─── Repo Profiler ───────────────────────────────────────────
export function repoProfilerPrompt(
  fileTree: string,
  recentCommits: string,
  keyFiles: Record<string, string>
): string {
  return `You are a repo profiler. Analyze the following repository and produce a structured JSON profile.

## File Tree
\`\`\`
${fileTree}
\`\`\`

## Recent Commits
\`\`\`
${recentCommits}
\`\`\`

## Key Files
${Object.entries(keyFiles)
  .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
  .join("\n\n")}

Respond with ONLY a JSON object matching this schema:
{
  "name": "repo name",
  "languages": ["lang1", "lang2"],
  "frameworks": ["framework1"],
  "entrypoints": ["src/index.ts"],
  "hasTests": true,
  "testFramework": "jest",
  "hasDocs": true,
  "hasCI": true,
  "ciPlatform": "github-actions",
  "packageManager": "npm",
  "summary": "A natural language description of what this repo does, its architecture, and notable patterns."
}`;
}

// ─── Discovery Agent ─────────────────────────────────────────
export function discoveryPrompt(profile: RepoProfile): string {
  return `You are a discovery agent for software repositories. Given the repo profile below, suggest 3–7 high-leverage, concrete project ideas.

## Repo Profile
- **Name:** ${profile.name}
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
- **Has Tests:** ${profile.hasTests}${profile.testFramework ? ` (${profile.testFramework})` : ""}
- **Has Docs:** ${profile.hasDocs}
- **Has CI:** ${profile.hasCI}${profile.ciPlatform ? ` (${profile.ciPlatform})` : ""}
- **TODOs/FIXMEs:** ${profile.todos.length} found
- **Summary:** ${profile.summary}

## Guidelines
- Each idea should be executable in a few hours to a couple of days.
- Avoid trivial tasks. Aim for meaningful improvements.
- Ground ideas in the actual repo state (don't suggest "add tests" if tests are comprehensive).
- Cover a mix of categories when possible.

Respond with ONLY a JSON array of objects:
[
  {
    "id": "unique-id",
    "title": "Short title",
    "description": "2-3 sentence description of what to do and why",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high"
  }
]`;
}

// ─── Planner Agent ───────────────────────────────────────────
export function plannerPrompt(
  goal: string,
  profile: RepoProfile,
  constraints: string[]
): string {
  return `You are a planner agent. Create a detailed step-by-step plan for the following goal.

## Goal
${goal}

## Repo Profile
- **Name:** ${profile.name}
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
- **Summary:** ${profile.summary}

## Constraints
${constraints.length > 0 ? constraints.map((c) => `- ${c}`).join("\n") : "None specified."}

## Guidelines
- Produce 3–7 steps.
- Each step must have clear acceptance criteria.
- List expected artifacts (files to create/modify) for each step.
- Treat user implementation suggestions as soft constraints; justify if you deviate.
- Order steps logically (foundations first, integration last).

Respond with ONLY a JSON object:
{
  "goal": "restated goal",
  "constraints": ["constraint1"],
  "steps": [
    {
      "index": 1,
      "description": "What to do",
      "acceptanceCriteria": ["criterion1", "criterion2"],
      "artifacts": ["path/to/file.ts"]
    }
  ]
}`;
}

// ─── Implementer Agent ───────────────────────────────────────
export function implementerPrompt(
  step: PlanStep,
  profile: RepoProfile,
  previousResults: StepResult[]
): string {
  const prevContext =
    previousResults.length > 0
      ? `\n## Previous Steps Completed\n${previousResults
          .map(
            (r) =>
              `- Step ${r.stepIndex}: ${r.status}${r.notes ? ` — ${r.notes}` : ""}`
          )
          .join("\n")}`
      : "";

  return `You are an implementer agent. Execute the following plan step by making code changes.

## Step ${step.index}: ${step.description}

## Acceptance Criteria
${step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

## Expected Artifacts
${step.artifacts.map((a) => `- ${a}`).join("\n")}

## Repo Context
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
${prevContext}

## Instructions
- Use the available tools (read, write, edit, bash) to implement the changes.
- Stay within the plan scope.
- If blocked, clearly state what information or decisions are needed.
- After completing changes, summarize what you did.`;
}

// ─── Reviewer Agent ──────────────────────────────────────────
export function reviewerPrompt(
  step: PlanStep,
  result: StepResult,
  profile: RepoProfile
): string {
  return `You are a reviewer agent. Evaluate whether the implementation satisfies the step requirements.

## Step ${step.index}: ${step.description}

## Acceptance Criteria
${step.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

## Implementation Result
- **Status:** ${result.status}
- **Changes:** ${result.changes.map((c) => `${c.action} ${c.path}`).join(", ")}
- **Notes:** ${result.notes}

## Repo Conventions
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
- **Test Framework:** ${profile.testFramework ?? "unknown"}

## Instructions
- Check each acceptance criterion.
- Verify changes align with project conventions.
- If the step fails, provide specific revision instructions.

Respond with ONLY a JSON object:
{
  "stepIndex": ${step.index},
  "passed": true|false,
  "feedback": "explanation of pass/fail",
  "revisionInstructions": "specific instructions if failed, omit if passed"
}`;
}

// ─── Final Summary ───────────────────────────────────────────
export function summaryPrompt(plan: Plan, results: StepResult[]): string {
  return `You are a summary agent. Produce a concise, user-facing summary of what was accomplished.

## Goal
${plan.goal}

## Steps and Results
${plan.steps
  .map((s) => {
    const result = results.find((r) => r.stepIndex === s.index);
    return `### Step ${s.index}: ${s.description}
- **Status:** ${result?.status ?? "not started"}
- **Changes:** ${result?.changes.map((c) => `${c.action} ${c.path}`).join(", ") ?? "none"}
- **Notes:** ${result?.notes ?? ""}`;
  })
  .join("\n\n")}

## Instructions
Produce a markdown summary with:
1. What goal was implemented
2. What files changed or were created
3. How to use the new functionality (commands, configuration, etc.)
4. Any follow-up recommendations`;
}
