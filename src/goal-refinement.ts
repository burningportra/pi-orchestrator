/**
 * Goal Refinement — interactive questionnaire that sharpens a raw user goal
 * into a structured, unambiguous specification via LLM-generated questions.
 *
 * Exports:
 *  - refineGoal(questions, ctx)           — TUI questionnaire via ctx.ui.custom()
 *  - synthesizeGoal(rawGoal, answers)     — pure formatter, no LLM
 *  - runGoalRefinement(rawGoal, profile, pi, ctx) — end-to-end orchestrator
 *  - extractConstraints(answers)          — pull constraint strings from answers
 *  - parseQuestionsJSON(output)           — parse LLM output into questions
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { RepoProfile } from "./types.js";
import { goalRefinementPrompt } from "./prompts.js";

// ─── Types ──────────────────────────────────────────────────

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface RefinementQuestion {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
}

export interface RefinementAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
}

export interface RefinementResult {
  answers: RefinementAnswer[];
  cancelled: boolean;
}

export interface GoalRefinementOutcome {
  enrichedGoal: string;
  answers: RefinementAnswer[];
  skipped: boolean;
}

// ─── refineGoal ─────────────────────────────────────────────

/**
 * Present a questionnaire TUI with tab navigation, freeform input,
 * and Esc-to-cancel. Returns answers or { cancelled: true }.
 */
export async function refineGoal(
  questions: RefinementQuestion[],
  ctx: ExtensionContext
): Promise<RefinementResult> {
  if (!ctx.hasUI) {
    return { answers: [], cancelled: true };
  }

  const totalTabs = questions.length + 1; // questions + Submit

  return ctx.ui.custom<RefinementResult>((tui, theme, _kb, done) => {
    // State
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionId: string | null = null;
    let cachedLines: string[] | undefined;
    const answers = new Map<string, RefinementAnswer>();

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      done({ answers: Array.from(answers.values()), cancelled });
    }

    function currentQuestion(): RefinementQuestion | undefined {
      return questions[currentTab];
    }

    type RenderOption = QuestionOption & { isOther?: boolean };

    function currentOptions(): RenderOption[] {
      const q = currentQuestion();
      if (!q) return [];
      const opts: RenderOption[] = [...q.options];
      if (q.allowOther) {
        opts.push({ value: "__other__", label: "Type something.", isOther: true });
      }
      return opts;
    }

    function allAnswered(): boolean {
      return questions.every((q) => answers.has(q.id));
    }

    function advanceAfterAnswer() {
      if (questions.length === 1) {
        submit(false);
        return;
      }
      if (currentTab < questions.length - 1) {
        currentTab++;
      } else {
        currentTab = questions.length; // Submit tab
      }
      optionIndex = 0;
      refresh();
    }

    function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean) {
      answers.set(questionId, { id: questionId, value, label, wasCustom });
    }

    editor.onSubmit = (value) => {
      if (!inputQuestionId) return;
      const trimmed = value.trim() || "(no response)";
      saveAnswer(inputQuestionId, trimmed, trimmed, true);
      inputMode = false;
      inputQuestionId = null;
      editor.setText("");
      advanceAfterAnswer();
    };

    function handleInput(data: string) {
      // Input mode: route to editor
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      const q = currentQuestion();
      const opts = currentOptions();

      // Tab navigation (multi-question)
      if (questions.length > 1) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          currentTab = (currentTab + 1) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          currentTab = (currentTab - 1 + totalTabs) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
      }

      // Submit tab
      if (currentTab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) {
          submit(false);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

      // Option navigation
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(opts.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      // Select option
      if (matchesKey(data, Key.enter) && q) {
        const opt = opts[optionIndex];
        if (opt.isOther) {
          inputMode = true;
          inputQuestionId = q.id;
          editor.setText("");
          refresh();
          return;
        }
        saveAnswer(q.id, opt.value, opt.label, false);
        advanceAfterAnswer();
        return;
      }

      // Cancel
      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const q = currentQuestion();
      const opts = currentOptions();
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("accent", theme.bold(" 🎯 Goal Refinement")));
      lines.push("");

      // Tab bar (multi-question)
      if (questions.length > 1) {
        const tabs: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const isActive = i === currentTab;
          const isAnswered = answers.has(questions[i].id);
          const lbl = questions[i].label;
          const box = isAnswered ? "■" : "□";
          const color = isAnswered ? "success" : "muted";
          const text = ` ${box} ${lbl} `;
          const styled = isActive
            ? theme.bg("selectedBg", theme.fg("text", text))
            : theme.fg(color, text);
          tabs.push(`${styled} `);
        }
        const canSubmit = allAnswered();
        const isSubmitTab = currentTab === questions.length;
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab
          ? theme.bg("selectedBg", theme.fg("text", submitText))
          : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled} →`);
        add(` ${tabs.join("")}`);
        lines.push("");
      }

      // Content
      if (inputMode && q) {
        add(theme.fg("text", ` ${q.prompt}`));
        lines.push("");
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          if (opt.isOther) {
            add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
          } else {
            add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`));
          }
          if (opt.description) {
            add(`     ${theme.fg("muted", opt.description)}`);
          }
        }
        lines.push("");
        add(theme.fg("muted", " Your answer:"));
        for (const line of editor.render(width - 2)) {
          add(` ${line}`);
        }
        lines.push("");
        add(theme.fg("dim", " Enter to submit • Esc to cancel"));
      } else if (currentTab === questions.length) {
        // Submit tab — show summary
        add(theme.fg("accent", theme.bold(" Ready to submit")));
        lines.push("");
        for (const question of questions) {
          const answer = answers.get(question.id);
          if (answer) {
            const prefix = answer.wasCustom ? "(wrote) " : "";
            add(
              `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`
            );
          }
        }
        lines.push("");
        if (allAnswered()) {
          add(theme.fg("success", " Press Enter to submit"));
        } else {
          const missing = questions
            .filter((q) => !answers.has(q.id))
            .map((q) => q.label)
            .join(", ");
          add(theme.fg("warning", ` Unanswered: ${missing}`));
        }
      } else if (q) {
        add(theme.fg("text", ` ${q.prompt}`));
        lines.push("");
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`));
          if (opt.description) {
            add(`     ${theme.fg("muted", opt.description)}`);
          }
        }
      }

      lines.push("");
      if (!inputMode) {
        const help =
          questions.length > 1
            ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
            : " ↑↓ navigate • Enter select • Esc cancel";
        add(theme.fg("dim", help));
      }
      add(theme.fg("accent", "─".repeat(width)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}

// ─── synthesizeGoal ─────────────────────────────────────────

/**
 * Pure function — formats a raw goal + answers into structured sections.
 * Omits empty sections. No LLM calls, no side effects.
 */
export function synthesizeGoal(
  rawGoal: string,
  answers: RefinementAnswer[]
): string {
  // Categorize each answer into exactly one bucket (first match wins).
  // This prevents an answer from appearing in multiple sections.
  const buckets = {
    scope: [] as RefinementAnswer[],
    constraints: [] as RefinementAnswer[],
    nonGoals: [] as RefinementAnswer[],
    successCriteria: [] as RefinementAnswer[],
    implNotes: [] as RefinementAnswer[],
  };

  for (const a of answers) {
    if (a.id.includes("scope") || a.id.includes("target") || a.id.includes("layer")) {
      buckets.scope.push(a);
    } else if (a.id.includes("constraint")) {
      buckets.constraints.push(a);
    } else if (
      a.id.includes("non-goal") ||
      a.id.includes("exclude") ||
      a.id.includes("avoid") ||
      a.value.startsWith("no-") ||
      a.value.startsWith("avoid-")
    ) {
      buckets.nonGoals.push(a);
    } else if (
      a.id.includes("success") ||
      a.id.includes("criteria") ||
      a.id.includes("quality") ||
      a.id.includes("test")
    ) {
      buckets.successCriteria.push(a);
    } else {
      buckets.implNotes.push(a);
    }
  }

  const fmt = (items: RefinementAnswer[]) => items.map((a) => `- ${a.label}`).join("\n");
  const fmtImpl = (items: RefinementAnswer[]) =>
    items.map((a) => `- **${a.id}**: ${a.label}`).join("\n");

  // Build output — omit empty sections
  const sections: string[] = [`## Goal\n${rawGoal}`];

  const scope = fmt(buckets.scope);
  const constraints = fmt(buckets.constraints);
  const nonGoals = fmt(buckets.nonGoals);
  const successCriteria = fmt(buckets.successCriteria);
  const implNotes = fmtImpl(buckets.implNotes);

  if (scope) sections.push(`## Scope\n${scope}`);
  if (constraints) sections.push(`## Constraints\n${constraints}`);
  if (nonGoals) sections.push(`## Non-Goals\n${nonGoals}`);
  if (successCriteria) sections.push(`## Success Criteria\n${successCriteria}`);
  if (implNotes) sections.push(`## Implementation Notes\n${implNotes}`);

  return sections.join("\n\n");
}

// ─── runGoalRefinement ──────────────────────────────────────

/**
 * End-to-end orchestrator:
 * 1. Call LLM to generate clarifying questions
 * 2. Parse JSON (with fallback)
 * 3. Present questionnaire TUI
 * 4. Synthesize structured goal
 * 5. Show confirmation (Y/edit/skip)
 *
 * On any failure, falls back to raw goal.
 */
export async function runGoalRefinement(
  rawGoal: string,
  profile: RepoProfile,
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<GoalRefinementOutcome> {
  const fallback: GoalRefinementOutcome = {
    enrichedGoal: rawGoal,
    answers: [],
    skipped: true,
  };

  // 1. Generate questions via LLM
  // Write prompt to temp file to avoid shell escaping issues and argument length limits
  // (same pattern as deep-plan.ts)
  let questions: RefinementQuestion[];
  try {
    const prompt = goalRefinementPrompt(rawGoal, profile);
    const promptDir = join(tmpdir(), `pi-goal-refinement-${Date.now()}`);
    mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, "prompt.md");
    writeFileSync(promptFile, prompt, "utf8");

    const result = await pi.exec(
      "pi",
      [
        "--print",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--tools", "",
        `@${promptFile}`,
      ],
      { timeout: 60000, cwd: ctx.cwd }
    );

    const output = result.stdout.trim();
    questions = parseQuestionsJSON(output);
  } catch (err) {
    ctx.ui.notify(
      `⚠️ Goal refinement LLM call failed: ${err instanceof Error ? err.message : String(err)}. Using raw goal.`,
      "warning"
    );
    return fallback;
  }

  // Enforce 1–5 question cap
  if (questions.length === 0) {
    ctx.ui.notify("⚠️ LLM returned no questions. Using raw goal.", "warning");
    return fallback;
  }
  if (questions.length > 5) {
    questions = questions.slice(0, 5);
  }

  // 2. Present questionnaire
  const result = await refineGoal(questions, ctx);

  if (result.cancelled) {
    return fallback;
  }

  // 3. Synthesize enriched goal
  const enrichedGoal = synthesizeGoal(rawGoal, result.answers);

  // 4. Confirmation step
  const confirmation = await ctx.ui.select(
    `🎯 Enriched Goal:\n\n${enrichedGoal}\n\nUse this goal?`,
    ["✅ Yes — use this goal", "✏️  Edit — let me revise", "⏭️  Skip — use original goal"]
  );

  if (!confirmation || confirmation.startsWith("⏭️")) {
    return fallback;
  }

  if (confirmation.startsWith("✏️")) {
    const edited = await ctx.ui.input("Edit the enriched goal:", enrichedGoal);
    if (!edited) {
      return fallback;
    }
    return {
      enrichedGoal: edited,
      answers: result.answers,
      skipped: false,
    };
  }

  // "Yes"
  return {
    enrichedGoal,
    answers: result.answers,
    skipped: false,
  };
}

// ─── Helpers ────────────────────────────────────────────────

/** Extract constraint strings from refinement answers for the planner. */
export function extractConstraints(answers: RefinementAnswer[]): string[] {
  return answers
    .filter(
      (a) =>
        a.id.includes("constraint") ||
        a.id.includes("non-goal") ||
        a.id.includes("avoid") ||
        a.id.includes("exclude")
    )
    .map((a) => a.label)
    .filter(Boolean);
}

/**
 * Parse LLM output as a JSON array of questions. Handles markdown
 * code fences. Falls back to a single generic question on parse failure.
 */
export function parseQuestionsJSON(output: string): RefinementQuestion[] {
  // Strip markdown code fences if present
  let jsonStr = output;
  const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected JSON array");
    }

    // Validate and normalize each question
    return parsed
      .filter(
        (q: any) =>
          q &&
          typeof q.id === "string" &&
          typeof q.prompt === "string" &&
          Array.isArray(q.options) &&
          q.options.length > 0
      )
      .map((q: any) => ({
        id: q.id,
        label: q.label || q.id,
        prompt: q.prompt,
        options: q.options
          .filter((o: any) => o && typeof o.value === "string" && typeof o.label === "string")
          .map((o: any) => ({
            value: o.value,
            label: o.label,
            description: o.description,
          })),
        allowOther: q.allowOther !== false,
      }));
  } catch {
    // Fallback: single generic question
    return [
      {
        id: "approach",
        label: "Approach",
        prompt: "How would you like to approach this goal?",
        options: [
          { value: "minimal", label: "Minimal — smallest possible change" },
          { value: "standard", label: "Standard — balanced approach" },
          { value: "comprehensive", label: "Comprehensive — thorough implementation" },
        ],
        allowOther: true,
      },
    ];
  }
}
