import type { RepoProfile, Bead, BeadResult, ScanResult, OrchestratorPhase } from "./types.js";
import type { PlanToBeadAudit } from "./beads.js";

// ─── Workflow Roadmap ───────────────────────────────────────
const WORKFLOW_PHASES: { key: OrchestratorPhase; label: string }[] = [
  { key: "profiling", label: "Scan" },
  { key: "discovering", label: "Discover" },
  { key: "awaiting_selection", label: "Select" },
  { key: "creating_beads", label: "Plan" },
  { key: "implementing", label: "Build" },
  { key: "reviewing", label: "Review" },
  { key: "complete", label: "Done" },
];

export function workflowRoadmap(currentPhase: OrchestratorPhase): string {
  const phaseIdx = WORKFLOW_PHASES.findIndex(p => p.key === currentPhase);
  return WORKFLOW_PHASES.map((p, i) => {
    const marker = i < phaseIdx ? "✓" : i === phaseIdx ? "→" : "○";
    return `${marker} ${p.label}`;
  }).join("  ");
}

// ─── Repo Profile Formatting ────────────────────────────────
export function formatRepoProfile(profile: RepoProfile, scanResult?: ScanResult): string {
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

  if (scanResult?.codebaseAnalysis && (scanResult.codebaseAnalysis.summary || scanResult.codebaseAnalysis.recommendations.length > 0 || scanResult.codebaseAnalysis.structuralInsights.length > 0)) {
    sections.push(`\n### Codebase Analysis (${scanResult.source})`);
    if (scanResult.codebaseAnalysis.summary) {
      sections.push(scanResult.codebaseAnalysis.summary);
    }
    if (scanResult.codebaseAnalysis.recommendations.length > 0) {
      sections.push(
        "\n#### Recommended focus areas",
        ...scanResult.codebaseAnalysis.recommendations.slice(0, 5).map(
          (item) => `- **${item.title}**${item.priority ? ` (${item.priority})` : ""}: ${item.detail}`
        )
      );
    }
    if (scanResult.codebaseAnalysis.structuralInsights.length > 0) {
      sections.push(
        "\n#### Structural insights",
        ...scanResult.codebaseAnalysis.structuralInsights.slice(0, 5).map(
          (item) => `- **${item.title}**: ${item.detail}`
        )
      );
    }
  }

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
export function orchestratorSystemPrompt(
  hasSophia: boolean,
  coordBackend?: import("./coordination.js").CoordinationBackend
): string {
  // Build coordination section based on detected backends
  let coordinationSection = "";

  const useBeadsAgentMail = coordBackend?.beads && coordBackend?.agentMail;

  if (useBeadsAgentMail) {
    coordinationSection = `
## Coordination: Beads + Agent Mail
The orchestrator uses **beads** for task lifecycle and **agent-mail** for inter-agent messaging and file reservations.

### Beads (task tracking)
- Create beads via \`br create "Title" -t task -p <priority> --description "..."\` in bash
- Set dependencies via \`br dep add <child-id> <parent-id>\`
- Bead status tracks implementation: open → in_progress → closed
- \`br sync --flush-only\` persists state to .beads/ (git-visible JSONL)
- Use \`br ready\` to see actionable (unblocked) tasks

### Agent Mail (coordination)
- Each parallel agent bootstraps with \`macro_start_session\` using this repo's absolute path as \`project_key\`
- File reservations prevent conflicts: \`file_reservation_paths(project_key, agent_name, paths, ttl_seconds=3600, exclusive=true)\`
- Thread ID = bead ID — all progress updates, review findings, and handoffs are scoped to the task
- Check inbox with \`fetch_inbox\` before advancing; urgent messages may require attention
- Release reservations when done: \`release_file_reservations(project_key, agent_name)\`

### Parallel Execution
When beads have disjoint files and agent-mail is available, agents work in the **same directory** with file reservations (no worktrees needed).
When files overlap, fall back to git worktree isolation.
${hasSophia ? "\nSophia is also available as a secondary backend for CR/task management." : ""}`;
  } else if (hasSophia) {
    coordinationSection = `
## Sophia Integration
The orchestrator uses Sophia for change request and task management. When beads are created:
- A Sophia CR is created automatically with tasks matching beads
- Use \`sophia cr task done <crId> <taskId> --commit-type feat --from-contract\` to checkpoint completed tasks
- After all beads, \`sophia cr validate\` and \`sophia cr review\` run automatically

## Parallel Execution with Worktree Isolation
When beads are independent (no shared files), use \`parallel_subagents\` with git worktree isolation:

1. The orchestrator creates a **WorktreePool** — each parallel bead gets its own git worktree checkout
2. For each parallel group, spawn sub-agents via \`parallel_subagents\`, passing the worktree path as the working directory
3. Each sub-agent works in isolation — no file conflicts between parallel beads
4. After all agents in a group complete, worktree changes are merged back to the main branch sequentially
5. Worktrees are cleaned up after merge

Use \`br ready\` to determine which beads can run in parallel.
If worktree creation fails, the orchestrator falls back to sequential execution in the shared directory.`;
  }

  return `You are operating as a repo-aware multi-agent orchestrator. You have access to specialized orchestrator tools that drive a structured workflow.

## Your Workflow
1. Call \`orch_profile\` to scan the repository
2. Call \`orch_discover\` to generate project ideas from the profile
3. Call \`orch_select\` to present ideas to the user and get their choice
4. Create beads for the selected goal via \`br create\` in bash, setting dependencies with \`br dep add\`
5. For each bead, implement using code tools (read, write, edit, bash), then call \`orch_review\`
6. After all beads pass review, the orchestrator runs post-completion checks and offers follow-up actions
${coordinationSection}

## Multi-Pass Review
Each bead goes through multiple review passes:
1. **Self-review**: You assess your own work against acceptance criteria via \`orch_review\`
2. **Adversarial review**: A second pass with fresh eyes checks for bugs, oversights, ergonomics issues
3. **Cross-agent review**: After ALL beads complete, an independent reviewer sub-agent audits the full diff

This mirrors the "check over everything again with fresh eyes" pattern — don't skip it.

## Post-Completion
After all beads and reviews pass, the orchestrator offers:
- **Polish pass**: De-slopify — improve clarity, remove generic AI patterns, maximize ergonomics
- **Commit strategy**: Group changes into logical commits with detailed messages
- **Skill extraction**: Check if the work product should become a reusable skill

## CASS Memory
- Use \`orch_memory\` tool with action \`context\` to get task-relevant rules and anti-patterns
- Use \`orch_memory\` tool with action \`mark\` to give feedback on rules (\`helpful\` or \`harmful\`)
- Use \`/memory\` command to view, search, add rules, or mark rules as harmful
- When a CASS rule helps you, mark it: \`orch_memory\` action=mark query=<bulletId> helpful=true
- When a rule leads you astray, mark it: \`orch_memory\` action=mark query=<bulletId> helpful=false reason="explanation"

## Rules
- Follow the workflow in order. Do not skip steps.
- **CRITICAL: When a tool result says "NEXT: Call \`tool_name\`", you MUST call that tool IMMEDIATELY in your next response. Do NOT stop to summarize, ask questions, or chat. Just call the tool.**
- After each tool call, read the result carefully before proceeding.
- When implementing beads, use the standard code tools (read, write, edit, bash) to make actual changes.
- If a review fails, re-implement based on the revision instructions, then review again (max 3 retries per bead).
- Do NOT add commentary between orchestrator tool calls. The user sees the tool results directly.
- If orch_select returns no selection, stop gracefully.
- If you experience context compaction during this session, immediately re-read AGENTS.md and the current orchestration state via \`/orchestrate-status\` before continuing.`;
}

// ─── Discovery Prompt ────────────────────────────────────────
export function discoveryInstructions(profile: RepoProfile, scanResult?: ScanResult): string {
  const repoContext = formatRepoProfile(profile, scanResult);

  return `Analyze this repository and generate your best improvement ideas using structured ideation.

${repoContext}

## Process (do this internally before outputting)
1. **Ground yourself** — study the repo profile, scan findings, TODOs, commits, and any memory context carefully
2. **Generate broadly** — come up with at least 25–30 candidate ideas (do NOT output these)
3. **Score each candidate** against these 5 axes (1-5 scale):
   - **Useful** (2× weight) — does it solve a real, frequent pain?
   - **Pragmatic** (2× weight) — is it realistic to build in hours/days?
   - **Accretive** (1.5× weight) — does it clearly add value beyond what exists?
   - **Robust** (1× weight) — will it handle edge cases and work reliably?
   - **Ergonomic** (1× weight) — does it reduce friction or cognitive load?
4. **Cut** — remove anything scoring <3 average, anything duplicative, anything already addressed
5. **Rank** — sort by weighted score
6. **Merge overlaps** — if two ideas are variants of the same thing, combine into one stronger idea
7. **Balance** — ensure at least 2 different categories in the top 5
8. **Tier** — label your best 5 as tier "top", next 5-10 as tier "honorable"

## Output requirements
For each surviving idea, provide:
- **id**: unique kebab-case identifier
- **title**: short descriptive title
- **description**: 2-3 sentences explaining what to do and why
- **category**: feature | refactor | docs | dx | performance | reliability | security | testing
- **effort**: low | medium | high
- **impact**: low | medium | high
- **rationale**: 2-3 sentences explaining why this beat other candidates. Cite specific repo evidence. Do NOT write generic rationale like "this would improve the project" — explain what specific signals support this and what alternatives you considered.
- **tier**: "top" or "honorable"
- **sourceEvidence**: array of strings — what repo signals prompted this (e.g. "TODO in src/scan.ts:45", "ccc finding: no error recovery", "recent commits all touch prompts.ts")
- **scores**: { useful, pragmatic, accretive, robust, ergonomic } — your 1-5 ratings
- **risks**: (optional) known downsides
- **synergies**: (optional) ids of complementary ideas

Return 10-15 ideas total (5 top + 5-10 honorable).`;
}

// ─── Bead Creation Prompt ────────────────────────────────────
export function beadCreationPrompt(
  goal: string,
  repoContext: string,
  constraints: string[]
): string {
  return `## Create Beads for Goal

Take the selected goal and create beads (tasks) using the br CLI. Cover all required work.

### Goal
${goal}

### Repository Context
${repoContext}

### Constraints
${constraints.length > 0 ? constraints.map((c) => `- ${c}`).join("\n") : "None specified."}

### Instructions
For each bead, run in bash:
\`\`\`
br create "Title" -t task -p <priority 1-5> --description "Detailed description including:
- What to implement
- Why it matters
- Acceptance criteria (as checklist):
  - [ ] Criterion 1
  - [ ] Criterion 2
- ### Files: src/foo.ts, src/bar.ts"
\`\`\`

Set dependencies between beads:
\`\`\`
br dep add <child-id> <parent-id>
\`\`\`

For complex beads that would take more than a few hours, break them into subtasks:
\`\`\`
br create "Subtask title" -t task -p <priority> --description "..."
br dep add <subtask-id> <parent-id> --type parent-child
\`\`\`

Each subtask should be a single coherent unit of work that one agent can complete independently.

### Requirements
- Make beads self-documenting — include background, reasoning, and anything a future agent needs
- The beads should be so detailed that a fresh agent never needs to consult back to the original goal. Include relevant background, reasoning/justification, considerations — anything a future agent needs about goals, intentions, and thought process.
- Each bead MUST include a \`### Files:\` section listing files to create/modify
- Order by priority: foundations first, integration last
- Set dependency edges so \`br ready\` returns the correct parallel groups
- Acceptance criteria should be specific and testable
- Include test beads where appropriate

Verify with \`br list\` and \`br dep cycles\` (must show no cycles).

Use ultrathink.`;
}

export function formatPlanToBeadAuditWarnings(audit: PlanToBeadAudit): string {
  if (audit.uncoveredSections.length === 0 && audit.weakMappings.length === 0) {
    return "";
  }

  const lines = ["⚠️ **Plan-to-bead audit warnings**"];

  if (audit.uncoveredSections.length > 0) {
    lines.push(
      "Uncovered plan sections:",
      ...audit.uncoveredSections.slice(0, 5).map((section) =>
        `- **${section.heading}**${section.summary ? ` — ${section.summary}` : ""}`
      )
    );
  }

  if (audit.weakMappings.length > 0) {
    lines.push(
      "Weak section-to-bead mapping:",
      ...audit.weakMappings.slice(0, 5).map((section) => {
        const top = section.matches[0];
        return `- **${section.heading}** → ${top?.beadId ?? "no bead"}${top ? ` (${Math.round(top.score * 100)}% keyword overlap)` : ""}`;
      })
    );
  }

  lines.push("Review these gaps before implementation if they reflect missing scope or underspecified beads.");
  return lines.join("\n");
}

export function planToBeadsPrompt(
  planPath: string,
  goal: string,
  profile: RepoProfile
): string {
  return `## Convert Approved Plan into Beads

Take the approved implementation plan and translate it into beads (tasks) using the br CLI.

### Goal
${goal}

### Repository Context
${formatRepoProfile(profile)}

### Plan Artifact
The approved plan lives at: \`${planPath}\`

### Instructions
1. Read the plan artifact at \`${planPath}\` before creating any beads.
2. Treat that artifact as the source of truth for scope, sequencing, architecture, edge cases, and testing.
3. Convert the plan into executable beads with \`br create\` and dependency edges with \`br dep add\`.
4. Embed the relevant context from the plan directly into each bead description:
   - summarize the implementation intent
   - capture the rationale and important constraints
   - include acceptance criteria and verification expectations
   - list the files to create or modify
5. DO NOT write beads that say things like "see the plan", "refer to plan", or "per approved plan" without restating the needed context. Each bead must stand on its own for a fresh agent.
6. If the plan describes a large effort, split it into multiple beads so each bead is a coherent, independently executable unit.

### Bead Format
For each bead, run in bash:
\`\`\`
br create "Title" -t task -p <priority 1-5> --description "Detailed description including:
- What to implement
- Why it matters
- Key context pulled forward from the approved plan
- Acceptance criteria (as checklist):
  - [ ] Criterion 1
  - [ ] Criterion 2
- ### Files: src/foo.ts, src/bar.ts"
\`\`\`

Set dependencies between beads:
\`\`\`
br dep add <child-id> <parent-id>
\`\`\`

### Requirements
- Every bead must be self-contained and self-documenting
- Preserve the plan's intended sequencing and parallelism
- Carry forward edge cases, migration notes, and testing expectations from the plan into the relevant beads
- Each bead MUST include a \`### Files:\` section listing files to create/modify
- Acceptance criteria should be specific and testable
- Include test beads where appropriate

Verify with \`br list\` and \`br dep cycles\` (must show no cycles).

Use ultrathink.`;
}

// ─── Bead Refinement Prompt ──────────────────────────────────
export function beadRefinementPrompt(roundNumber?: number, priorChanges?: number[]): string {
  const roundInfo = roundNumber != null ? `This is polish round ${roundNumber + 1}.\n\n` : "";
  const changesInfo = priorChanges && priorChanges.length > 0
    ? `Prior rounds: ${priorChanges.map((n, i) => `Round ${i + 1}: ${n} change${n !== 1 ? "s" : ""}`).join(", ")}.\n\n`
    : "";

  return `## Bead Refinement Pass

${roundInfo}${changesInfo}Check over each bead super carefully via \`br list\` and \`br show <id>\`.

### Questions to ask for each bead:
1. Are you sure this makes sense? Is it the best approach?
2. Could we change anything to make it clearer or more actionable?
3. Does the description contain enough context for a fresh agent to execute without guessing?
4. Are the acceptance criteria specific and testable?
5. Is the \`### Files:\` section accurate and complete?
6. Are dependencies correct? Would \`br ready\` return the right parallel groups?
7. Are any beads too large? Could they be split into 2-3 subtasks for better parallelism and clearer scope?
7. Could a fresh agent implement this bead without ANY external context? If not, what background/reasoning is missing?

### Actions
- Revise with \`br update <id> --description "..."\` for any improvements
- Validate: \`br dep cycles\` (must show no cycles)

### Rules
- DO NOT OVERSIMPLIFY. DO NOT LOSE FEATURES.
- Include test beads that cover the new functionality.
- Every bead must be self-contained and self-documenting.
- If you find missing beads, create them with \`br create\`.
- If you find redundant beads, remove them with \`br rm <id>\`.

Use ultrathink.`;
}

/**
 * Fresh-context refinement prompt for sub-agent bead review.
 * Derived from Agent Flywheel Section 5: "Check your beads N times, implement once."
 * Fresh conversations prevent the model from anchoring on its own prior output.
 */
export function freshContextRefinementPrompt(cwd: string, goal: string, roundNumber: number): string {
  return `## Fresh-Context Bead Refinement (Round ${roundNumber + 1})

You are reviewing beads for a project with NO prior context. This is deliberate — fresh eyes catch what anchored reviewers miss.

**Goal:** ${goal}

### Instructions
1. Run \`br list --json\` to read all open beads
2. For each bead, evaluate:
   - Does it make sense as a self-contained work unit?
   - Is the description detailed enough for a fresh agent to implement without guessing?
   - Are acceptance criteria specific and testable?
   - Are dependencies correct?
   - Could the architecture be improved?
3. Make improvements directly via \`br update <id> --description "..."\`
4. Check for missing beads and create them with \`br create\`
5. Run \`br dep cycles\` to verify no cycles

### Rules
- DO NOT OVERSIMPLIFY. DO NOT LOSE FEATURES OR FUNCTIONALITY.
- Every bead must be self-contained and self-documenting.
- Include specific test expectations in each bead.

Use ultrathink.

cd ${cwd}`;
}

/**
 * Compute convergence score (0-1) from polish round history.
 * Weights: change velocity (40%), output size delta (30%), consecutive zero-change rounds (30%).
 * Score ≥ 0.75 means ready to implement; ≥ 0.90 means diminishing returns.
 */
export function computeConvergenceScore(
  changes: number[],
  outputSizes?: number[]
): number {
  if (changes.length < 3) return 0;

  // Change velocity: ratio of recent changes to peak changes
  const peak = Math.max(...changes, 1);
  const recent = changes[changes.length - 1];
  const velocityScore = 1 - (recent / peak);

  // Output size delta: are outputs shrinking? (convergence signal)
  let sizeScore = 0.5; // neutral if no data
  if (outputSizes && outputSizes.length >= 2) {
    const lastTwo = outputSizes.slice(-2);
    const delta = Math.abs(lastTwo[1] - lastTwo[0]);
    const maxSize = Math.max(...outputSizes, 1);
    sizeScore = 1 - Math.min(delta / maxSize, 1);
  }

  // Consecutive zero-change rounds
  let zeroStreak = 0;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i] === 0) zeroStreak++;
    else break;
  }
  const zeroScore = Math.min(zeroStreak / 2, 1); // 2 consecutive zeros = 1.0

  return velocityScore * 0.4 + sizeScore * 0.3 + zeroScore * 0.3;
}

// ─── Deep Planning Synthesis Prompt ──────────────────────────
export function synthesisInstructions(plans: { name: string; model: string; plan: string }[]): string {
  return `## Synthesis Instructions

${plans.length} independent planners produced the plans above. Synthesize them into one plan:

1. Identify the strongest ideas from each plan
2. Where plans contradict, pick the approach with better justification
3. Cover architecture, constraints, testing, and error handling
4. Make the result detailed enough for a fresh agent to execute without guessing

Then create beads via \`br create\` in bash with the synthesized plan.`;
}

// ─── Reality Check Prompt ────────────────────────────────────
export function realityCheckInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[]
): string {
  const done = results.filter((r) => r.status === "success").length;
  const total = beads.length;

  return `## Reality Check

Where are we on this project? Do we actually have the thing we are trying to build?

### Goal
${goal}

### Progress
${done}/${total} beads completed.

${beads.map((b) => {
  const r = results.find((r) => r.beadId === b.id);
  return `- Bead ${b.id}: ${r?.status ?? "not started"} — ${b.title}: ${b.description}${r?.summary ? `\n  Summary: ${r.summary}` : ""}`;
}).join("\n")}

### Questions to answer honestly
1. If we intelligently implement all remaining open beads, would we close the gap completely? Why or why not?
2. What is actually blocking us right now?
3. Are there missing beads or dependencies that we didn't account for?
4. Is any completed work actually broken or incomplete despite being marked done?

Be brutally honest. If the answer is "no, we wouldn't close the gap," the fix is usually to revise the beads or add missing work, not to push harder on implementation.`;
}

// ─── Implementer Instructions ────────────────────────────────
export function implementerInstructions(
  bead: Bead,
  profile: RepoProfile,
  previousResults: BeadResult[]
): string {
  const prevContext =
    previousResults.length > 0
      ? `\n## Previous Beads Completed\n${previousResults
          .map((r) => `- Bead ${r.beadId}: ${r.status} — ${r.summary}`)
          .join("\n")}`
      : "";

  // Extract acceptance criteria from description (lines starting with - [ ])
  const criteriaLines = bead.description
    .split("\n")
    .filter((line) => line.trim().startsWith("- [ ]"))
    .map((line) => line.trim());

  // Extract files section from description
  const filesMatch = bead.description.match(/### Files:\s*(.+?)(?:\n###|\n\n|$)/s);
  const files = filesMatch ? filesMatch[1].trim() : "See bead description";

  return `## Implement Bead ${bead.id}: ${bead.title}

### Description
${bead.description}

### Acceptance Criteria
${criteriaLines.length > 0 ? criteriaLines.join("\n") : "See bead description for criteria."}

### Expected Files
${files}

### Repo Context
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
${prevContext}

### Marching Orders
First read the relevant files to fully understand the code and technical architecture.
Use \`orch_memory\` to search for relevant learnings from prior orchestrations if applicable.
Then implement this bead using the standard code tools (read, write, edit, bash).
Work systematically and meticulously. Don't get stuck in analysis — be proactive.
Make focused, targeted changes. Stay within scope.

**After implementing, do a fresh-eyes review:** carefully read over ALL the new code you just wrote and any existing code you modified, looking super carefully for any obvious bugs, errors, problems, issues, or confusion. Fix anything you uncover.

When you finish this bead and need the next one, prefer \`bv --robot-next\` over \`br ready\` if bv is available. bv uses PageRank and betweenness centrality to pick the bead that unlocks the most downstream work.

After the fresh-eyes review, call \`orch_review\` with a summary of what you did and what the review found.`;
}

// ─── Reviewer Instructions ───────────────────────────────────
export function reviewerInstructions(
  bead: Bead,
  implementationSummary: string,
  profile: RepoProfile
): string {
  const criteriaLines = bead.description
    .split("\n")
    .filter((line) => line.trim().startsWith("- [ ]") || line.trim().startsWith("- [x]"))
    .map((line) => line.trim().replace(/^- \[.\] /, ""));

  return `## Review Bead ${bead.id}: ${bead.title}

### Acceptance Criteria
${criteriaLines.length > 0 ? criteriaLines.map((c) => `- ${c}`).join("\n") : "See bead description."}

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

// ─── Adversarial Review Instructions ─────────────────────────
export function adversarialReviewInstructions(
  bead: Bead,
  implementationSummary: string
): string {
  const criteriaLines = bead.description
    .split("\n")
    .filter((line) => line.trim().startsWith("- [ ]") || line.trim().startsWith("- [x]"))
    .map((line) => line.trim().replace(/^- \[.\] /, ""));

  return `## Adversarial "Fresh Eyes" Review — Bead ${bead.id}

You are reviewing this bead as if you've never seen it before. The first review already passed — your job is to catch what it missed.

### What was implemented
${implementationSummary}

### Acceptance Criteria
${criteriaLines.length > 0 ? criteriaLines.map((c) => `- ${c}`).join("\n") : "See bead description."}

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
  beads: Bead[],
  results: BeadResult[]
): string {
  return `## Independent Cross-Agent Code Review

You are an independent reviewer auditing the FULL diff of this orchestration.
You did NOT write this code. Review it with zero assumptions.

### Goal
${goal}

### Beads Completed
${beads
  .map((b) => {
    const r = results.find((r) => r.beadId === b.id);
    return `- Bead ${b.id}: ${b.title} (${r?.status ?? "unknown"})`;
  })
  .join("\n")}

### Your Review Checklist
1. **Correctness** — Does the implementation actually achieve the stated goal?
2. **Consistency** — Do all the pieces fit together? Any contradictions between beads?
3. **Completeness** — Anything missing that the beads promised?
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
1. **Remove AI slop** — generic filler ("leverage", "utilize", "comprehensive"), unnecessary caveats, hollow qualifiers
2. **Improve clarity** — rename vague variables, simplify convoluted logic, add comments only where non-obvious
3. **Maximize ergonomics** — make this the code YOU would want to read if coming in fresh
4. **Consistent style** — match the project's existing conventions
5. **Trim fat** — remove dead code, unused imports, unnecessary abstractions

Make targeted edits. Don't rewrite things that are already good.`;
}

export function commitStrategyInstructions(
  beads: Bead[],
  results: BeadResult[]
): string {
  // Extract files from bead descriptions
  const beadDetails = beads.map((b) => {
    const r = results.find((r) => r.beadId === b.id);
    const filesMatch = b.description.match(/### Files:\s*(.+?)(?:\n###|\n\n|$)/s);
    const files = filesMatch ? filesMatch[1].trim() : "See bead description";
    return `- Bead ${b.id}: ${b.title}\n  Files: ${files}\n  Summary: ${r?.summary ?? "N/A"}`;
  });

  return `## Commit Strategy

Group the changes from this orchestration into logical commits with detailed messages.

### Beads completed
${beadDetails.join("\n\n")}

### Rules
- Group by logical change, NOT by bead number (beads may touch the same files)
- Each commit should be independently understandable
- Use conventional commit format: type(scope): description
- First line ≤ 72 chars, then blank line, then detailed body
- Body explains WHY, not just WHAT
- Reference bead IDs in the body for traceability

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

// ─── Strategic Drift Detection ───────────────────────────────
// Derived from Agent Flywheel Section 7: "Watch for strategic drift."
/**
 * Proactive drift check that runs every N completed beads.
 * Asks: "Do we actually have the thing we are trying to build?"
 */
export function strategicDriftCheckInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[],
  completedCount: number,
  totalCount: number
): string {
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  return `## Strategic Drift Check (${completedCount}/${totalCount} beads, ${progressPct}%)

A swarm can look productive while heading in the wrong direction. This check verifies we are still converging on the actual goal.

### Goal
${goal}

### Current State
${beads.map((b) => {
  const r = results.find((r) => r.beadId === b.id);
  return `- ${b.id}: ${r?.status === "success" ? "✅" : r ? "🔄" : "⬜"} ${b.title}`;
}).join("\n")}

### Answer These Questions
1. **Gap analysis**: If we implement all remaining open beads perfectly, do we fully achieve the goal? If not, what is missing?
2. **Direction check**: Is any completed work actually moving us AWAY from the goal or creating unnecessary complexity?
3. **Bead sufficiency**: Are there capabilities the goal requires that no current bead addresses?
4. **Priority alignment**: Are the highest-impact beads being worked on, or is the swarm doing leaf work while blockers sit idle?

### Output
- **Drift detected**: YES or NO
- **Confidence**: HIGH / MEDIUM / LOW
- **Missing beads**: List any beads that should be created
- **Beads to deprioritize**: List any that are not actually needed
- **Recommendation**: CONTINUE, PAUSE_AND_REVISE, or STOP`;
}

// ─── Blunder Hunt (Overshoot Mismatch Technique) ────────────
// Derived from Agent Flywheel Section 5: "Lie to them and give them a huge number."
/**
 * The overshoot mismatch hunt prompt. Models stop finding problems after ~20-25 issues;
 * claiming 80+ errors forces them to keep searching exhaustively.
 */
export function blunderHuntInstructions(cwd: string, passNumber: number): string {
  return `## Blunder Hunt — Pass ${passNumber}/5

Reread the beads carefully. I am POSITIVE that you missed or screwed up at least 80 elements in the bead definitions. Check for:

1. **Logical flaws** in bead descriptions or acceptance criteria
2. **Missing dependencies** between beads
3. **Incomplete context** that would leave a fresh agent guessing
4. **Contradictions** between beads
5. **Missing test expectations**
6. **Overly vague acceptance criteria**
7. **Wrong file paths** in ### Files sections
8. **Duplicative or overlapping beads**
9. **Missing error handling expectations**
10. **Architectural inconsistencies**

For each issue found:
- State the bead ID and the specific problem
- Fix it directly via \`br update <id> --description "..."\`
- Or create missing beads via \`br create\`

Do NOT be satisfied with finding only a few issues. Keep looking. Use ultrathink.

cd ${cwd}`;
}

// ─── Random Code Exploration Review ──────────────────────────
// Derived from Agent Flywheel Section 8: alternating review patterns.
/**
 * Random exploration breaks the locality trap by forcing the reviewer
 * to pick files NOT in the changed artifacts list.
 */
export function randomExplorationInstructions(
  goal: string,
  changedFiles: string[],
  cwd: string
): string {
  const excludeList = changedFiles.length > 0
    ? `\n\n**EXCLUDE these files** (already reviewed by other agents):\n${changedFiles.map(f => `- ${f}`).join("\n")}`
    : "";

  return `## Random Code Exploration Review

Randomly explore code files in this project, choosing files to deeply investigate and understand. Trace their functionality and execution flows through related imports and dependents.${excludeList}

### Goal Context
${goal}

### Instructions
1. Pick 3-5 files at random (NOT from the changed files list above)
2. For each file, trace execution flows through imports and callers
3. Once you understand the purpose in the larger workflow context, do a super careful check with "fresh eyes" for:
   - Obvious bugs, problems, errors, silly mistakes
   - Logic errors in execution flows
   - Missing error handling
   - Assumptions that don't hold
4. Fix any issues you find directly using the edit tool

Be thorough. The bugs that survive to this phase live in utility modules, error handling paths, and edge-case branches — the places nobody looks.

Use ultrathink.

cd ${cwd}`;
}

// ─── De-Slopification ───────────────────────────────────────
// Derived from Agent Flywheel Section 8: "De-Slopification"
/** Extensible catalogue of AI slop patterns to detect and fix. */
export const AI_SLOP_PATTERNS = [
  { pattern: "emdash overuse (—)", fix: "Replace with semicolons, commas, or sentence splits" },
  { pattern: '"It\'s not X, it\'s Y"', fix: "Recast the contrast without the formulaic structure" },
  { pattern: '"Here\'s why" / "Here\'s why it matters:"', fix: "Remove the clickbait lead-in" },
  { pattern: '"Let\'s dive in" / "Let us dive in"', fix: "Remove forced enthusiasm" },
  { pattern: '"At its core..."', fix: "Remove pseudo-profound opener" },
  { pattern: '"It\'s worth noting..."', fix: "Remove unnecessary hedge" },
  { pattern: '"leverage" / "utilize"', fix: 'Use "use"' },
  { pattern: '"comprehensive" / "robust"', fix: "Be specific about what makes it comprehensive" },
  { pattern: '"seamless" / "seamlessly"', fix: "Describe the actual behavior" },
  { pattern: '"In conclusion" / "To summarize"', fix: "Just state the conclusion" },
];

export function deSlopifyInstructions(files: string[]): string {
  const patternList = AI_SLOP_PATTERNS
    .map((p, i) => `${i + 1}. **${p.pattern}** → ${p.fix}`)
    .join("\n");

  return `## De-Slopification Pass

Read through the following files carefully and remove telltale AI writing patterns. You MUST manually read each line and revise — NO regex or script-based replacement.

### Files to review
${files.map(f => `- ${f}`).join("\n")}

### AI Slop Patterns to Fix
${patternList}

### Rules
- Read each line of text and revise manually
- Preserve the meaning while removing the AI-ish phrasing
- If a sentence works fine with the pattern, leave it (not every emdash is bad)
- Focus on user-facing documentation, README, and doc comments
- Code comments are fine to clean up but don't over-polish them`;
}

// ─── Landing the Plane ──────────────────────────────────────
// Derived from Agent Flywheel Section 8: "Landing the Plane"
export function landingChecklistInstructions(cwd: string): string {
  return `## Landing the Plane — Session Completion Checklist

Work is NOT complete until every item below passes. A session is only "landable" when a future swarm can pick it back up from artifacts alone.

### Checklist
1. **Remaining work filed**: Create beads for any unfinished work or follow-up items
2. **Quality gates**: Run tests (\`npm test\`), type check (\`npm run build\`), lints
3. **Bead status**: Close all finished beads, update in-progress items
4. **Sync beads**: \`br sync --flush-only\` to export to JSONL
5. **Commit and push**: \`git pull --rebase && git add . && git commit && git push\`
6. **Verify**: \`git status\` must show clean working tree and up-to-date with remote
7. **Session resumability**: AGENTS.md + beads + agent-mail threads are sufficient for a new agent to continue

### For Each Item
Report: ✅ PASS or ❌ FAIL with reason

cd ${cwd}`;
}

// ─── Swarm Marching Orders ──────────────────────────────────
// Derived from Agent Flywheel Section 7: canonical swarm kickoff prompt.
export function swarmMarchingOrders(cwd: string, beadId?: string): string {
  return `## Swarm Marching Orders

First read ALL of the AGENTS.md file and README.md file super carefully and understand ALL of both. Then use your code investigation capabilities to fully understand the code, technical architecture and purpose of the project.${beadId ? `\n\nYour assigned bead: ${beadId}` : ""}

Be sure to check your agent mail and promptly respond to any messages. Then proceed meticulously with your assigned bead, working systematically and tracking progress via beads and agent mail messages.

Don't get stuck in "communication purgatory" where nothing gets done. Be proactive about starting work, but inform fellow agents via messages and mark beads appropriately.

When you're not sure what to do next, use \`bv --robot-triage\` to find the highest-impact bead, claim it, and start coding immediately. Acknowledge all communication from other agents. Use ultrathink.

cd ${cwd}`;
}

/** Stagger delay configuration for thundering herd prevention. */
export const SWARM_STAGGER_DELAY_MS = 30_000; // 30 seconds between agent starts

// ─── Bead Quality Scoring ───────────────────────────────────
// Derived from Agent Flywheel Section 4: beads as "executable memory"
/**
 * Prompt for LLM-based quality scoring of a bead on WHAT/WHY/HOW axes.
 */
export function beadQualityScoringPrompt(beadId: string, title: string, description: string): string {
  return `## Bead Quality Assessment: ${beadId}

### Title
${title}

### Description
${description}

### Score this bead on three axes (1-5 each):

**WHAT (Implementation Details)**: Does the description specify concrete implementation steps?
- 5: Exact functions, data structures, algorithms, file changes
- 3: General approach but missing specifics
- 1: Vague or missing implementation guidance

**WHY (Rationale & Context)**: Does it explain the reasoning, intent, and background?
- 5: Full rationale, design decisions, tradeoffs documented
- 3: Some context but gaps in reasoning
- 1: No rationale — just a bare task description

**HOW (Verification)**: Does it include acceptance criteria, test expectations, verification steps?
- 5: Specific, testable criteria with edge cases covered
- 3: Basic criteria but missing edge cases
- 1: No criteria — "just make it work"

### Output Format (JSON)
\`\`\`json
{
  "what": <1-5>,
  "why": <1-5>,
  "how": <1-5>,
  "weaknesses": ["specific weakness 1", "specific weakness 2"],
  "suggestions": ["specific improvement 1", "specific improvement 2"]
}
\`\`\``;
}

// ─── Research & Reimagine Workflow ───────────────────────────
// Derived from Agent Flywheel Section 6: "Major Features: Research and Reimagine"
/**
 * Step 1: Investigate an external project and propose reimagined ideas.
 */
export function researchInvestigatePrompt(externalUrl: string, projectName: string, cwd: string): string {
  return `## Research & Reimagine — Step 1: Investigate

Clone or scrape ${externalUrl} and investigate it thoroughly. Look for useful ideas that we can take and reimagine in highly accretive ways on top of ${projectName}'s existing capabilities.

Write up a proposal document that:
1. Summarizes the external project's architecture and key ideas
2. Identifies the strongest patterns and design decisions
3. Proposes how to reimagine each through the lens of ${projectName}'s unique strengths
4. Creates something neither project could achieve alone

Make the proposal genuinely novel, not a shallow port. Use ultrathink.

cd ${cwd}`;
}

/**
 * Step 2: Iterative deepening — push past conservative initial suggestions.
 */
export function researchDeepenPrompt(): string {
  return `## Research & Reimagine — Step 2: Deepen

That's a decent start, but you barely scratched the surface. Go way deeper — more ambition, more boldness. Come up with ideas that are genuinely surprising and high-impact because they are so compelling, useful, and accretive.

Push past the conservative initial suggestions. Use ultrathink.`;
}

/**
 * Step 3: Inversion analysis — what can WE do that THEY cannot?
 */
export function researchInversionPrompt(projectName: string, externalName: string): string {
  return `## Research & Reimagine — Step 3: Inversion Analysis

Now "invert" the analysis: what are things that ${projectName} can do because of its unique primitives/capabilities that ${externalName} simply could never do even if they wanted to, because they are working from less rich primitives?

This surfaces the highest-value integration points: capabilities that are genuinely novel rather than reimplementations. Use ultrathink.`;
}

// ─── Goal Refinement Prompt ──────────────────────────────────
export function goalRefinementPrompt(goal: string, profile: RepoProfile): string {
  return `## Goal Refinement

The user wants to work on this goal:
> ${goal}

${formatRepoProfile(profile)}

## Your Task
Analyze the goal against the repository context above. Generate clarifying questions that will sharpen the goal into an unambiguous, actionable plan. Each question should reference specific aspects of the repo (languages, frameworks, file structure, recent commits) — do NOT ask generic questions.

**Adaptive depth:** If the goal is already specific and detailed, generate fewer questions (as few as 1–2). If it's vague or broad, generate up to 5. Assess specificity before generating.

**Required:** One question MUST ask about constraints and non-goals — things the user explicitly does NOT want changed or wants to avoid.

## Output Format
Return a JSON array of question objects. Each question has:
- \`id\`: kebab-case identifier (e.g. "target-framework")
- \`label\`: short display label (e.g. "Target Framework")
- \`prompt\`: the full question text, referencing repo context where relevant
- \`options\`: array of 3–5 options, each with \`value\` (kebab-case), \`label\` (display text), and optional \`description\`
- \`allowOther\`: boolean — whether the user can type a custom answer

## Example Output
\`\`\`json
[
  {
    "id": "scope",
    "label": "Scope",
    "prompt": "The repo has both src/api/ and src/cli/ entrypoints. Should this change target the API layer, the CLI, or both?",
    "options": [
      { "value": "api-only", "label": "API only", "description": "Changes limited to src/api/" },
      { "value": "cli-only", "label": "CLI only", "description": "Changes limited to src/cli/" },
      { "value": "both", "label": "Both", "description": "Coordinate changes across API and CLI" }
    ],
    "allowOther": false
  },
  {
    "id": "constraints",
    "label": "Constraints & Non-Goals",
    "prompt": "Are there parts of the codebase or behaviors you want to explicitly preserve or avoid changing?",
    "options": [
      { "value": "no-breaking", "label": "No breaking changes", "description": "Public API must remain backward-compatible" },
      { "value": "no-new-deps", "label": "No new dependencies", "description": "Solve with existing packages only" },
      { "value": "no-constraints", "label": "No specific constraints", "description": "Open to any approach" }
    ],
    "allowOther": true
  }
]
\`\`\`

Return ONLY the JSON array, no surrounding text or markdown fences.`;
}

// ─── Summary Instructions ────────────────────────────────────
export function summaryInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[]
): string {
  return `## Generate Final Summary

### Goal
${goal}

### Beads and Results
${beads
  .map((b) => {
    const result = results.find((r) => r.beadId === b.id);
    return `**Bead ${b.id}: ${b.title}**
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

// ─── Plan Document Generation ───────────────────────────────
export function competingPlanAgentPrompt(
  focus: "correctness" | "robustness" | "ergonomics",
  goal: string,
  profile: RepoProfile,
  scanResult?: ScanResult
): string {
  const repoContext = formatRepoProfile(profile, scanResult);
  const lensInstructions = {
    correctness: [
      "Prioritize architectural correctness and internal consistency.",
      "Interrogate assumptions about existing interfaces, types, and control flow.",
      "Call out any places where the implementation could accidentally violate current behavior or contracts.",
    ],
    robustness: [
      "Prioritize failure modes, degraded paths, rollout safety, and testability.",
      "Stress edge cases, missing validation, sequencing hazards, and migration risks.",
      "Bias toward plans that remain reliable under partial failure and future extension.",
    ],
    ergonomics: [
      "Prioritize clarity, maintainability, and agent ergonomics for future contributors.",
      "Prefer simpler seams, better naming, and flows that reduce context-switching and ambiguity.",
      "Push for plans that are easy to execute, review, and modify without surprising coupling.",
    ],
  } satisfies Record<string, string[]>;

  return `You are an expert software architect participating in a competing-plans exercise. Use ultrathink and produce ONE detailed markdown plan document.

## Goal
${goal}

## Focus Lens: ${focus}
${lensInstructions[focus].map((line) => `- ${line}`).join("\n")}

## Repository Context
${repoContext}

## Requirements
Produce a concrete markdown plan with these sections:
1. Architecture Overview
2. User Workflows
3. Data Model / Types
4. API Surface
5. Testing Strategy
6. Edge Cases & Failure Modes
7. File Structure
8. Sequencing

## Rules
- Ground every recommendation in the repository context above.
- Do not create beads.
- Do not mention your focus lens in the final headings; express it through the substance of the plan.
- Be opinionated about trade-offs and note key risks.
- Make the plan detailed enough that a fresh agent could implement it without guessing.`;
}

export function planSynthesisPrompt(plans: { name: string; model: string; plan: string }[]): string {
  return `## Plan Synthesis Instructions

${plans.length} independent plan documents were generated for the same goal. Synthesize them into a single best-of-all-worlds implementation plan.

${plans.map((plan, index) => `### Plan ${index + 1}: ${plan.name} (${plan.model})\n\n${plan.plan}`).join("\n\n")}

## What to do
1. Identify the strongest ideas from each plan
2. Resolve contradictions explicitly; pick the approach with the best justification
3. Preserve the best correctness, robustness, and ergonomics insights
4. Produce one unified markdown plan document with these sections:
   - Architecture Overview
   - User Workflows
   - Data Model / Types
   - API Surface
   - Testing Strategy
   - Edge Cases & Failure Modes
   - File Structure
   - Sequencing
5. Make it concrete enough that a fresh agent could execute it without guessing

Return ONLY the synthesized markdown plan.`;
}

export function planDocumentPrompt(goal: string, profile: RepoProfile, scanResult?: ScanResult): string {
  const repoContext = formatRepoProfile(profile, scanResult);

  return `You are an expert software architect. Use ultrathink to produce a comprehensive implementation plan.

## Goal
${goal}

## Repository Context
${repoContext}

## Instructions
Produce a detailed markdown plan document covering ALL of the following sections:

### 1. Architecture Overview
- High-level system design and component relationships
- Key architectural decisions and trade-offs

### 2. User Workflows
- Step-by-step user-facing flows the implementation enables
- How existing workflows are affected

### 3. Data Model / Types
- New types, interfaces, or schemas needed
- Changes to existing data structures

### 4. API Surface
- New functions, methods, endpoints, or CLI commands
- Signatures, parameters, return types

### 5. Testing Strategy
- Unit, integration, and e2e test plan
- Edge cases to cover, mocking strategy

### 6. Edge Cases & Failure Modes
- What can go wrong and how to handle it
- Graceful degradation, error messages

### 7. File Structure
- Which files to create or modify
- Logical grouping and module boundaries

### 8. Sequencing
- Implementation order with dependencies
- What can be parallelized vs. must be sequential

## Output
Save the plan as a session artifact using write_artifact with a descriptive name like 'plans/<goal-slug>.md'.
Ground every recommendation in the repository context above — do not hallucinate capabilities or files that don't exist.`;
}

export function planRefinementPrompt(planPath: string, roundNumber: number): string {
  return `You are a fresh reviewer with NO prior context on this plan. Use ultrathink to critically evaluate it.

## Round ${roundNumber} Refinement

This is refinement round ${roundNumber}. Each round uses a fresh conversation to prevent anchoring bias — you should evaluate the plan with completely fresh eyes.

## Instructions
1. Read the plan artifact at: ${planPath}
2. Evaluate it critically — look for:
   - Missing edge cases or failure modes
   - Overly complex designs that could be simplified
   - Incorrect assumptions about the codebase
   - Gaps in testing strategy
   - Sequencing issues or missing dependencies
   - Vague sections that need concrete detail
3. If the plan needs improvement, rewrite the FULL refined plan and save it back to the SAME artifact with \`write_artifact\` using the exact same artifact name: ${planPath}
4. Preserve the strongest parts of the current plan while fixing weaknesses — do not regress coverage or specificity
5. If the plan is already solid, make no artifact changes and say \`NO_CHANGES\` with a brief explanation

Focus on substance over style. Each round should find fewer issues as the plan converges.`;
}

export function learningsExtractionPrompt(goal: string, beadIds: string[]): string {
  return `## 🧠 Structured Learnings Extraction

Goal: ${goal}
Beads completed: ${beadIds.join(", ")}

Reflect on this orchestration and extract actionable learnings by answering these 5 questions:

### 1. What architectural decisions were made and why?
Identify key design choices, trade-offs, and the reasoning behind them.

### 2. What gotchas or surprises were encountered?
What was unexpected? What broke in non-obvious ways? What assumptions were wrong?

### 3. What patterns worked well?
Which approaches, abstractions, or workflows proved effective and should be repeated?

### 4. What would you do differently next time?
With hindsight, what would you change about the approach, sequencing, or scope?

### 5. Were there any tool issues or workflow friction?
Did any tools misbehave? Were there workflow bottlenecks or ergonomic problems?

---

For each learning, save it to CASS memory:

\`\`\`bash
cm add '<learning>' --category orchestration --json
\`\`\`

Use appropriate categories: \`orchestration\`, \`architecture\`, \`gotcha\`, \`pattern\`, \`tooling\`

Add 3–7 rules. Each should be specific, actionable, and traceable to beads: ${beadIds.join(", ")}`;
}
