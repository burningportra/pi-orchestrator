import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OrchestratorContext, OrchestratorState } from "./types.js";
import { polishInstructions, summaryInstructions, realityCheckInstructions, deSlopifyInstructions, landingChecklistInstructions, learningsExtractionPrompt } from "./prompts.js";
import { readBeads, extractArtifacts as extractBeadArtifacts } from "./beads.js";
import { agentMailTaskPreamble } from "./agent-mail.js";
import { detectUbs } from "./coordination.js";
import { getDomainChecklist, formatDomainReviewItems } from "./domain-knowledge.js";

export async function runGuidedGates(
  oc: OrchestratorContext,
  st: OrchestratorState,
  ctx: ExtensionContext,
  extraInfo: string
): Promise<{ content: { type: "text"; text: string }[]; details: any }> {
  const allBeads = await readBeads(oc.pi, ctx.cwd);
  const activeBeads = st.activeBeadIds
    ? allBeads.filter((b) => st.activeBeadIds!.includes(b.id))
    : allBeads;
  const allArtifacts = [...new Set(activeBeads.flatMap((b) => extractBeadArtifacts(b)))];
  const goal = st.selectedGoal ?? "Unknown goal";
  const beadResults = Object.values(st.beadResults ?? {});
  const polish = polishInstructions(goal, allArtifacts);
  const summaryText = summaryInstructions(goal, activeBeads, beadResults);

  // Domain-specific review items based on tech stack
  const domainChecklist = st.repoProfile ? getDomainChecklist(st.repoProfile) : null;
  const domainReviewExtras = domainChecklist ? formatDomainReviewItems(domainChecklist) : "";

  st.iterationRound = (st.iterationRound ?? 0) + 1;
  const round = st.iterationRound;
  oc.persistState();

  // Sequential guided flow — resume from saved gate index.
  // Gates marked auto: true run immediately without prompting the user.
  // Gates marked auto: false present a select with execute/skip/done options.
  const gates = [
    { emoji: "🔍", label: "Fresh self-review", desc: "read all new code with fresh eyes", auto: true },
    { emoji: "👥", label: "Peer review", desc: "parallel agents review each other's work", auto: false },
    { emoji: "🧪", label: "Test coverage", desc: "check unit tests + e2e, create tasks for gaps", auto: true },
    { emoji: "✏️", label: "De-slopify", desc: "remove AI writing patterns from docs", auto: true },
    { emoji: "📦", label: "Commit", desc: "logical groupings with detailed messages", auto: false },
    { emoji: "🚀", label: "Ship it", desc: "commit, tag, release, deploy, monitor CI", auto: false },
    { emoji: "🛬", label: "Landing checklist", desc: "verify session is resumable", auto: false },
  ];

  // Agent-mail threading: if agentMail is active, sub-agents (peer review / hit-me) bootstrap
  // their own sessions via agentMailTaskPreamble() injected into their tasks.
  // The orchestrator itself doesn't have an agent-mail identity — it's the spawner,
  // not a participant. Sub-agents handle their own inbox checking via macro_start_session.
  // Thread IDs are gate-scoped (e.g. "peer-review-r1", "hit-me-r1").
  if (st.coordinationBackend?.agentMail) {
    // Agent-mail threading is active — sub-agents will coordinate via thread messages
  }

  let chosen: string | undefined;
  const startGate = st.currentGateIndex ?? 0;
  for (let i = startGate; i < gates.length; i++) {
    const gate = gates[i];

    if (gate.auto) {
      // Auto-advance: run this gate immediately without prompting
      st.currentGateIndex = i + 1;
      oc.persistState();
      chosen = `${gate.emoji} ${gate.label} — ${gate.desc}`;
      break;
    }

    // User-prompted gate: show select with execute/skip/done
    const pick = await ctx.ui.select(
      `Round ${round} — ${gate.emoji} ${gate.label}`,
      [
        `${gate.emoji} ${gate.label} — ${gate.desc}`,
        "⏭️  Skip",
        "✅ Done — finish orchestration",
      ]
    );
    if (!pick || pick.startsWith("✅")) {
      chosen = "✅";
      break;
    }
    if (pick.startsWith("⏭️")) {
      st.currentGateIndex = i + 1;
      oc.persistState();
      continue;
    }
    st.currentGateIndex = i + 1;
    oc.persistState();
    chosen = pick;
    break;
  }

  if (!chosen) chosen = "✅";

  const callbackHint = `\n\nAfter completing this, call \`orch_review\` with beadId "__gates__" and verdict "pass" for the next gate.`;

  // Regression hint appended to gates where fundamental issues might surface.
  // Flywheel: "If a gate fails, drop back a phase instead of pushing forward."
  const regressionHint = `\n\n---\n**If this gate revealed fundamental issues:**\n` +
    `- \`orch_review\` with beadId \"__regress_to_beads__\" → go back to bead creation\n` +
    `- \`orch_review\` with beadId \"__regress_to_plan__\" → go back to plan refinement\n` +
    `- \`orch_review\` with beadId \"__regress_to_implement__\" → go back to implementation`;

  if (chosen.startsWith("✅")) {
    oc.orchestratorActive = false;
    st.currentGateIndex = 0;
    oc.setPhase("complete", ctx);
    oc.persistState();
    const learningsText = learningsExtractionPrompt(goal, activeBeads.map((b) => b.id));

    // Self-improvement loop: save structured feedback for future orchestrations
    try {
      const { collectFeedback, saveFeedback, formatPromptEffectiveness } = await import("./feedback.js");
      const feedback = collectFeedback(st);
      saveFeedback(ctx.cwd, feedback);
    } catch {
      // Feedback collection is best-effort
    }

    // Include prompt effectiveness summary if available
    let promptEffectivenessInfo = "";
    try {
      const { formatPromptEffectiveness } = await import("./feedback.js");
      const peInfo = formatPromptEffectiveness();
      if (peInfo) promptEffectivenessInfo = `\n\n${peInfo}`;
    } catch { /* best-effort */ }

    // Completion output must include explicit `cm add` commands so the landing prompt teaches CASS capture.
    return {
      content: [
        { type: "text", text: `${summaryText}${extraInfo}\n\nOrchestration complete after ${round} round(s).${promptEffectivenessInfo}\n\n---\n${learningsText}` },
      ],
      details: { complete: true, rounds: round },
    };
  }

  if (chosen.startsWith("🔍")) {
    return {
      content: [
        {
          type: "text",
          text: `## 🔍 Fresh Self-Review — Round ${round}\n\nCarefully read over ALL the new code you just wrote and any existing code you modified with "fresh eyes" looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Carefully fix anything you uncover.\n\nFiles changed:\n${allArtifacts.map((a) => `- ${a}`).join("\n")}${callbackHint}${regressionHint}`,
        },
      ],
      details: { iterating: true, round, selfReview: true },
    };
  }

  if (chosen.startsWith("👥")) {
    const peerThreadId = `peer-review-r${round}`;
    const peerArtifacts = allArtifacts;
    const peerPreamble = (name: string) =>
      st.coordinationBackend?.agentMail
        ? agentMailTaskPreamble(ctx.cwd, name, `Peer review round ${round}`, peerArtifacts, peerThreadId)
        : "";
    const peerAgents = [
      {
        name: `peer-bugs-r${round}`,
        task: `${peerPreamble(`peer-bugs-r${round}`)}Peer reviewer (round ${round}). Review code written by your fellow agents. Check for issues, bugs, errors, inefficiencies, security problems, reliability issues. Diagnose root causes using first-principle analysis. Don't restrict to latest commits — cast a wider net and go super deep!\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}${domainReviewExtras}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `peer-polish-r${round}`,
        task: `${peerPreamble(`peer-polish-r${round}`)}Polish reviewer (round ${round}). De-slopify the code. Remove AI slop, improve clarity, make it agent-friendly.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `peer-ergonomics-r${round}`,
        task: `${peerPreamble(`peer-ergonomics-r${round}`)}Ergonomics reviewer (round ${round}). If you came in fresh with zero context, would you understand this code? Fix anything confusing.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${ctx.cwd}`,
      },
      {
        name: `peer-reality-r${round}`,
        task: `${peerPreamble(`peer-reality-r${round}`)}Reality checker (round ${round}).\n\n${realityCheckInstructions(goal, activeBeads, beadResults)}\n\nDo NOT edit code. Just report findings.\n\ncd ${ctx.cwd}`,
      },
    ];
    const peerJson = JSON.stringify({ agents: peerAgents }, null, 2);
    return {
      content: [
        {
          type: "text",
          text: `**NEXT: Call \`parallel_subagents\` NOW with the config below.**\n\n## 👥 Peer Review — Round ${round}\n\n\`\`\`json\n${peerJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` with beadId "__gates__" and verdict "pass".${regressionHint}`,
        },
      ],
      details: { iterating: true, round, peerReview: true },
    };
  }

  if (chosen.startsWith("🧪")) {
    const ubsAvailable = await detectUbs(oc.pi, ctx.cwd);
    const ubsHint = ubsAvailable
      ? `\n\nAlso run \`ubs <changed-files>\` to scan for bugs beyond what linters catch.`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `## 🧪 Test Coverage Check — Round ${round}\n\nDo we have full unit test coverage without using mocks or fake stuff? What about complete e2e integration test scripts with great, detailed logging?\n\nReview the current state:\n- Goal: ${goal}\n- Files: ${allArtifacts.join(", ")}\n\nIf test coverage is incomplete, create specific tasks for each missing test, with subtasks and dependency structure. Each task should be self-contained — a fresh agent can execute it without extra context.\n\nFor unit tests: test real behavior, not mocked interfaces. For e2e: full integration scripts with detailed logging at each stage.${ubsHint}${callbackHint}${regressionHint}`,
        },
      ],
      details: { iterating: true, round, testCoverage: true },
    };
  }

  if (chosen.startsWith("✏️")) {
    // De-slopification gate: only triggers if doc files were modified
    const docFiles = allArtifacts.filter(f =>
      f.endsWith(".md") || f.startsWith("docs/") || f.toLowerCase().includes("readme")
    );
    if (docFiles.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## ✏️ De-Slopify — Round ${round}\n\nNo documentation files were modified — skipping de-slopification.${callbackHint}`,
          },
        ],
        details: { iterating: true, round, deSlopify: true, skipped: true },
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `## ✏️ De-Slopify — Round ${round}\n\n${deSlopifyInstructions(docFiles)}${callbackHint}`,
        },
      ],
      details: { iterating: true, round, deSlopify: true },
    };
  }

  if (chosen.startsWith("📦")) {
    return {
      content: [
        {
          type: "text",
          text: `## 📦 Commit — Round ${round}\n\nBased on your knowledge of the project, commit all changed files now in a series of logically connected groupings with super detailed commit messages for each. Take your time to do it right.\n\nRules:\n- Group by logical change, NOT by file\n- Each commit should be independently understandable\n- Use conventional commit format: type(scope): description\n- First line ≤ 72 chars, then blank line, then detailed body\n- Body explains WHY, not just WHAT\n- Don't edit the code at all\n- Don't commit obviously ephemeral files\n- Push after committing${callbackHint}`,
        },
      ],
      details: { iterating: true, round, committing: true },
    };
  }

  if (chosen.startsWith("🚀")) {
    return {
      content: [
        {
          type: "text",
          text: `## 🚀 Ship It — Round ${round}\n\nDo all the GitHub stuff:\n1. **Commit** all remaining changes in logical groupings with detailed messages\n2. **Push** to remote\n3. **Create tag** with semantic version bump (based on changes: feat=minor, fix=patch)\n4. **Create GitHub release** with changelog from commits since last tag\n5. **Monitor CI** — check GitHub Actions status, wait for green\n6. **Compute checksums** if there are distributable artifacts\n7. **Bump version** in package.json if applicable\n\nDo each step and report status. If any step fails, stop and report why.${callbackHint}`,
        },
      ],
      details: { iterating: true, round, shipping: true },
    };
  }

  if (chosen.startsWith("🛬")) {
    return {
      content: [
        {
          type: "text",
          text: `## 🛬 Landing Checklist — Round ${round}\n\n${landingChecklistInstructions(ctx.cwd)}${callbackHint}`,
        },
      ],
      details: { iterating: true, round, landing: true },
    };
  }

  // "🔥 Hit me" — spawn 4 parallel review agents
  const hitMeThreadId = `hit-me-r${round}`;
  const hitMeArtifacts = allArtifacts;
  const hitMePreamble = (name: string) =>
    st.coordinationBackend?.agentMail
      ? agentMailTaskPreamble(ctx.cwd, name, `Hit me review round ${round}`, hitMeArtifacts, hitMeThreadId)
      : "";
  const agentConfigs = [
    {
      name: `fresh-eyes-r${round}`,
      task: `${hitMePreamble(`fresh-eyes-r${round}`)}Fresh-eyes reviewer round ${round}. NEVER seen this code.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}${domainReviewExtras}\n\nFind blunders, bugs, errors, oversights. Be harsh. Fix issues directly using the edit tool. Your changes persist to disk and will be shown as a diff for confirmation.\n\ncd ${ctx.cwd}`,
    },
    {
      name: `polish-r${round}`,
      task: `${hitMePreamble(`polish-r${round}`)}Polish/de-slopify reviewer round ${round}.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nMake targeted edits directly — don't just report.\n\ncd ${ctx.cwd}`,
    },
    {
      name: `ergonomics-r${round}`,
      task: `${hitMePreamble(`ergonomics-r${round}`)}Agent-ergonomics reviewer round ${round}. Make this maximally intuitive for coding agents.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nIf you came in fresh with zero context, would you understand this? Fix anything that fails that test.\n\ncd ${ctx.cwd}`,
    },
    {
      name: `reality-check-r${round}`,
      task: `${hitMePreamble(`reality-check-r${round}`)}Reality checker round ${round}.\n\n${realityCheckInstructions(goal, activeBeads, beadResults)}\n\nDo NOT edit code. Just report your findings as text.\n\ncd ${ctx.cwd}`,
    },
  ];

  const gateJson = JSON.stringify({ agents: agentConfigs }, null, 2);
  return {
    content: [
      {
        type: "text",
        text: `**NEXT: Call \`parallel_subagents\` NOW with the config below.**\n\n## 🔥 Hit me — Round ${round}\n\n\`\`\`json\n${gateJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`orch_review\` again.${callbackHint}${regressionHint}`,
      },
    ],
    details: { iterating: true, round, agents: agentConfigs.map((a) => a.name) },
  };
}
