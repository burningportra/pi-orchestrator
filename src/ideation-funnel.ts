/**
 * Externalized Ideation Funnel (30 → 5 → 15)
 *
 * The Flywheel guide: "Having agents brainstorm 30 then winnow to 5
 * produces much better results than asking for 5 directly because
 * the winnowing forces critical evaluation."
 *
 * When we tell a model "think of 30, output 5," the winnowing is
 * performative. When we have 30 real ideas and a DIFFERENT model
 * ranks them, the critical evaluation is real.
 *
 * Three phases:
 * 1. Generate 30 ideas (sub-agent, structured JSON output)
 * 2. Winnow to 5 (different model, explicit keep/cut for each)
 * 3. Expand to 15 (10 more, checked against existing beads)
 */

import type { RepoProfile, CandidateIdea, ScanResult } from "./types.js";
import { formatRepoProfile } from "./prompts.js";

// ─── Phase 2: Winnowing model note ──────────────────────────

/**
 * Prepended to winnowingPrompt() to enforce model divergence.
 * Using the same model for ideation and winnowing defeats the purpose:
 * winnowing becomes performative self-evaluation instead of real critique.
 */
export const WINNOWING_MODEL_NOTE =
  "IMPORTANT: This winnowing step MUST run on a different model than the ideation step. " +
  "Using the same model defeats the purpose — winnowing becomes performative self-evaluation.";

// ─── Phase 1: Broad Ideation ────────────────────────────────

/**
 * Prompt for generating 30 raw ideas. The model is told NOT to winnow —
 * output everything. Quantity enables quality in the next phase.
 *
 * @param existingBeadTitles - titles of existing beads to avoid duplicating.
 *   When provided and non-empty, a dedup section is injected before Instructions.
 */
export function broadIdeationPrompt(
  profile: RepoProfile,
  scanResult?: ScanResult,
  existingBeadTitles?: string[]
): string {
  const repoContext = formatRepoProfile(profile, scanResult);

  const beadDedupeSection =
    existingBeadTitles && existingBeadTitles.length > 0
      ? `### Existing Beads (do NOT duplicate these)\nThe following work items already exist. Do NOT propose duplicates:\n${existingBeadTitles.map((t) => `- ${t}`).join("\n")}\n\n`
      : "";

  return `## Broad Ideation — Generate 30 Ideas

You are brainstorming improvement ideas for this project. Your job is to generate QUANTITY, not quality. Output ALL ideas — do NOT winnow, filter, or self-censor.

${repoContext}

${beadDedupeSection}### Instructions
1. Study the repo profile, scan findings, TODOs, commits, and README carefully
2. Generate exactly 30 improvement ideas across diverse categories
3. For each idea, provide a brief 1-2 sentence description
4. Score each on 5 axes (1-5): useful, pragmatic, accretive, robust, ergonomic
5. DO NOT filter or rank — output all 30

### Categories to cover (aim for variety)
feature, refactor, docs, dx, performance, reliability, security, testing

### Output Format
Return a JSON array of 30 objects:
\`\`\`json
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "description": "1-2 sentence description",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high",
    "scores": { "useful": 4, "pragmatic": 3, "accretive": 5, "robust": 3, "ergonomic": 4 },
    "sourceEvidence": ["signal from repo"]
  }
]
\`\`\`

Output ONLY the JSON array. No markdown fences, no surrounding text. All 30 ideas.`;
}

// ─── Phase 2: Winnowing ─────────────────────────────────────

/**
 * Prompt for a DIFFERENT model to critically evaluate and winnow 30→5.
 * The winnowing must be externalized — each idea gets explicit keep/cut.
 */
export function winnowingPrompt(ideas: CandidateIdea[], profile: RepoProfile): string {
  // WINNOWING_MODEL_NOTE is prepended to remind the caller (and any reviewing agent)
  // that this step must run on a different model than the ideation step.
  const ideaList = ideas
    .map((idea, i) =>
      `${i + 1}. **${idea.title}** [${idea.category}] (effort: ${idea.effort}, impact: ${idea.impact})\n   ${idea.description}${idea.scores ? `\n   Scores: useful=${idea.scores.useful} pragmatic=${idea.scores.pragmatic} accretive=${idea.scores.accretive} robust=${idea.scores.robust} ergonomic=${idea.scores.ergonomic}` : ""}`
    )
    .join("\n\n");

  return `${WINNOWING_MODEL_NOTE}

## Critical Winnowing — Cut 30 Ideas to 5

You are reviewing ${ideas.length} improvement ideas for **${profile.name}**. Your job is to be RUTHLESSLY critical and select only the 5 most impactful.

### All ${ideas.length} Ideas
${ideaList}

### Instructions
1. For EACH of the ${ideas.length} ideas, state: **KEEP** or **CUT** with a one-sentence justification
2. You must keep exactly 5 ideas
3. Rank your 5 KEEPs from most to least impactful
4. For each KEEP, write a detailed rationale (2-3 sentences) explaining:
   - Why this beat the other 25 ideas
   - What specific repo evidence supports it
   - What makes it uniquely valuable

### Evaluation Criteria (weighted)
- **Useful** (2× weight) — solves a real, frequent pain
- **Pragmatic** (2× weight) — realistic to build in hours/days
- **Accretive** (1.5× weight) — clearly adds value beyond what exists
- **Robust** (1× weight) — handles edge cases
- **Ergonomic** (1× weight) — reduces friction

### Output Format
Return a JSON object:
\`\`\`json
{
  "cuts": [
    { "id": "idea-id", "reason": "why cut" }
  ],
  "keeps": [
    {
      "id": "idea-id",
      "rank": 1,
      "rationale": "detailed rationale for keeping"
    }
  ]
}
\`\`\`

Output ONLY the JSON. Be ruthless — if you can't articulate why an idea is in the top 5, cut it.`;
}

// ─── Phase 3: Expansion ─────────────────────────────────────

/**
 * Prompt to generate 10 MORE ideas that complement the top 5.
 * Each must be checked against existing beads for novelty.
 */
export function expandIdeasPrompt(
  top5: CandidateIdea[],
  existingBeadTitles: string[],
  profile: RepoProfile
): string {
  const topList = top5
    .map((idea, i) => `${i + 1}. **${idea.title}**: ${idea.description}`)
    .join("\n");

  const beadList = existingBeadTitles.length > 0
    ? `\n### Existing Beads (DO NOT duplicate)\n${existingBeadTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  return `## Expand — Generate 10 Complementary Ideas

The top 5 ideas have been selected through competitive winnowing:
${topList}
${beadList}

### Instructions
1. Generate 10 MORE improvement ideas for **${profile.name}**
2. Each must COMPLEMENT the top 5 (not duplicate or conflict)
3. Each must be explicitly checked against existing beads for novelty
4. Aim for variety in categories and effort levels
5. Score each on the same 5-axis rubric (useful, pragmatic, accretive, robust, ergonomic)

### Output Format
Return a JSON array of 10 objects (same format as the broad ideation):
\`\`\`json
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "description": "1-2 sentence description",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high",
    "scores": { "useful": 4, "pragmatic": 3, "accretive": 5, "robust": 3, "ergonomic": 4 },
    "sourceEvidence": ["signal from repo"],
    "rationale": "why this complements the top 5 and is novel"
  }
]
\`\`\`

Output ONLY the JSON array. No duplicates of the top 5 or existing beads.`;
}

// ─── Parsing Helpers ────────────────────────────────────────

/**
 * Parse a JSON array of ideas from LLM output.
 * Handles markdown fences, surrounding text, and partial outputs.
 */
export function parseIdeasJSON(output: string): CandidateIdea[] {
  // Try to extract a JSON array
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item: unknown) => {
        if (typeof item !== "object" || item === null) return false;
        const obj = item as Record<string, unknown>;
        return typeof obj.id === "string" && typeof obj.title === "string";
      })
      .map((item: Record<string, unknown>) => ({
        id: String(item.id),
        title: String(item.title),
        description: String(item.description ?? ""),
        category: validateCategory(String(item.category ?? "feature")),
        effort: validateEffort(String(item.effort ?? "medium")),
        impact: validateImpact(String(item.impact ?? "medium")),
        rationale: typeof item.rationale === "string" ? item.rationale : "",
        tier: "honorable" as const,
        sourceEvidence: Array.isArray(item.sourceEvidence)
          ? (item.sourceEvidence as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        scores: parseScores(item.scores),
      }));
  } catch {
    return [];
  }
}

/**
 * Extract balanced JSON object candidates from mixed LLM output.
 *
 * Regexes like /\{[\s\S]*"keeps"[\s\S]*\}/ are too greedy: if the model
 * writes any prose object-ish text before the fenced JSON, the parse fails and
 * the deep-discovery UI falls back with a noisy warning. This scanner tracks
 * strings/escapes and returns every balanced object so callers can try the
 * actual JSON payload first.
 */
function extractJsonObjectCandidates(output: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < output.length; i++) {
    const ch = output[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(output.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseJsonObjectCandidate(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    // Common LLM blemish: trailing commas before a closing object/array.
    try {
      const repaired = candidate.replace(/,\s*([}\]])/g, "$1");
      const parsed = JSON.parse(repaired);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function getArrayField(obj: Record<string, unknown>, names: string[]): unknown[] {
  for (const name of names) {
    const value = obj[name];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function keepIdFromEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (typeof entry !== "object" || entry === null) return null;
  const obj = entry as Record<string, unknown>;
  for (const field of ["id", "ideaId", "idea_id", "slug"]) {
    if (typeof obj[field] === "string" && obj[field].trim()) return obj[field].trim();
  }
  return null;
}

function entryRank(entry: unknown): number {
  if (typeof entry !== "object" || entry === null) return 99;
  const obj = entry as Record<string, unknown>;
  return Number(obj.rank ?? obj.priority ?? obj.order) || 99;
}

function parseKeepIdsFromObject(parsed: Record<string, unknown>): { keptIds: string[]; cutCount: number } {
  const keepEntries = getArrayField(parsed, ["keeps", "keep", "kept", "selected", "selectedIdeas", "top5", "winners"]);
  const directKeeps = keepEntries
    .slice()
    .sort((a, b) => entryRank(a) - entryRank(b))
    .map(keepIdFromEntry)
    .filter((id): id is string => !!id);

  const decisionEntries = getArrayField(parsed, ["decisions", "evaluations", "results"]);
  const decisionKeeps = decisionEntries
    .filter((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const obj = entry as Record<string, unknown>;
      const decision = String(obj.decision ?? obj.verdict ?? obj.status ?? "").toLowerCase();
      return decision === "keep" || decision === "kept" || decision === "selected";
    })
    .slice()
    .sort((a, b) => entryRank(a) - entryRank(b))
    .map(keepIdFromEntry)
    .filter((id): id is string => !!id);

  const keptIds = directKeeps.length > 0 ? directKeeps : decisionKeeps;
  const cutCount = getArrayField(parsed, ["cuts", "cut", "rejected"]).length ||
    decisionEntries.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const obj = entry as Record<string, unknown>;
      const decision = String(obj.decision ?? obj.verdict ?? obj.status ?? "").toLowerCase();
      return decision === "cut" || decision === "rejected";
    }).length;

  return { keptIds, cutCount };
}

function parseKeepIdsFromText(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const normalized = line.replace(/[*`_]/g, "");
    const match = normalized.match(/\bKEEP\b.*?(?:id\s*[:=-]\s*)?([a-z0-9][a-z0-9_-]{1,})/i);
    if (match?.[1]) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

/**
 * Parse winnowing results from LLM output.
 * Returns the IDs of the kept ideas in rank order.
 */
export function parseWinnowingResult(output: string): { keptIds: string[]; cutCount: number } {
  const candidates = extractJsonObjectCandidates(output)
    .filter((candidate) => /"(?:keeps?|kept|selected|selectedIdeas|top5|winners|decisions|evaluations|results)"/.test(candidate));

  for (const candidate of candidates) {
    const parsed = parseJsonObjectCandidate(candidate);
    if (!parsed) continue;
    const result = parseKeepIdsFromObject(parsed);
    if (result.keptIds.length > 0) return result;
  }

  const textKeeps = parseKeepIdsFromText(output);
  if (textKeeps.length > 0) {
    const cutCount = (output.match(/\bCUT\b/gi) ?? []).length;
    return { keptIds: textKeeps, cutCount };
  }

  return { keptIds: [], cutCount: 0 };
}

// ─── Validation Helpers ─────────────────────────────────────

type IdeaCategory = CandidateIdea["category"];
const VALID_CATEGORIES: IdeaCategory[] = [
  "feature", "refactor", "docs", "dx", "performance", "reliability", "security", "testing",
];

function validateCategory(value: string): IdeaCategory {
  const lower = value.toLowerCase();
  return VALID_CATEGORIES.includes(lower as IdeaCategory) ? (lower as IdeaCategory) : "feature";
}

function validateEffort(value: string): "low" | "medium" | "high" {
  const lower = value.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") return lower;
  return "medium";
}

function validateImpact(value: string): "low" | "medium" | "high" {
  const lower = value.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") return lower;
  return "medium";
}

function parseScores(raw: unknown): CandidateIdea["scores"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const scores = {
    useful: clamp(Number(obj.useful), 1, 5),
    pragmatic: clamp(Number(obj.pragmatic), 1, 5),
    accretive: clamp(Number(obj.accretive), 1, 5),
    robust: clamp(Number(obj.robust), 1, 5),
    ergonomic: clamp(Number(obj.ergonomic), 1, 5),
  };
  // Return undefined if all NaN
  if (Object.values(scores).every(isNaN)) return undefined;
  return scores;
}

function clamp(value: number, min: number, max: number): number {
  if (isNaN(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
