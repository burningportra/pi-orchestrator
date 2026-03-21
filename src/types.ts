// ─── Repo Profile ────────────────────────────────────────────
export interface RepoProfile {
  name: string;
  languages: string[];
  frameworks: string[];
  structure: string; // raw file tree
  entrypoints: string[];
  recentCommits: CommitSummary[];
  hasTests: boolean;
  testFramework?: string;
  hasDocs: boolean;
  hasCI: boolean;
  ciPlatform?: string;
  todos: TodoItem[];
  keyFiles: Record<string, string>;
  readme?: string;
  packageManager?: string;
}

// ─── Repository Scan Contract ───────────────────────────────
export type ScanSource = "ccc" | "builtin";

export interface ScanInsight {
  title: string;
  detail: string;
}

export interface ScanQualitySignal {
  label: string;
  value: string;
  detail?: string;
}

export type ScanRecommendationPriority = "low" | "medium" | "high";

export interface ScanRecommendation {
  /** Stable identifier for deduping or provider-specific follow-up. */
  id: string;
  /** Short recommendation title. */
  title: string;
  /** Human-readable detail suitable for prompts or UI. */
  detail: string;
  /** Optional structured payload for downstream routing. */
  payload?: Record<string, unknown>;
  priority?: ScanRecommendationPriority;
}

export interface ScanCodebaseAnalysis {
  /** Short scan summary that can be reused in prompts. */
  summary?: string;
  /** Provider-supplied recommendation inputs for discovery and planning. */
  recommendations: ScanRecommendation[];
  /** Structural findings about architecture, boundaries, or hotspots. */
  structuralInsights: ScanInsight[];
  /** Quality signals attached by a scan provider. */
  qualitySignals: ScanQualitySignal[];
}

export interface ScanErrorInfo {
  code?: string;
  message: string;
  recoverable?: boolean;
}

export interface ScanFallbackInfo {
  /** Whether the requested provider path degraded to the built-in profiler. */
  used: boolean;
  /** Provider family originally attempted. */
  from: ScanSource;
  /** Current fallback target. Step 1 only supports builtin fallback. */
  to: "builtin";
  /** Human-readable explanation for the fallback decision. */
  reason: string;
  /** Optional structured error from the failed provider attempt. */
  error?: ScanErrorInfo;
}

/**
 * Normalized repository scan output.
 *
 * `profile` keeps the existing `RepoProfile` shape so current discovery,
 * planning, and implementation code can continue to work unchanged.
 * Providers can attach additional scan metadata alongside it.
 *
 * In practice, Step 1 callers should usually read this as:
 * `const profile = scanResult.profile`.
 */
export interface ScanSourceMetadata {
  /** Friendly provider label for diagnostics/UI. */
  label?: string;
  /** Provider version or implementation tag when known. */
  version?: string;
  /** Non-fatal warnings emitted during scanning. */
  warnings?: string[];
}

export interface ScanResult {
  /** The provider that actually produced the attached RepoProfile. */
  source: ScanSource;
  /** Stable provider identifier for programmatic checks/logging. */
  provider: string;
  profile: RepoProfile;
  codebaseAnalysis: ScanCodebaseAnalysis;
  sourceMetadata?: ScanSourceMetadata;
  fallback?: ScanFallbackInfo;
}

export interface ScanProvider {
  id: string;
  label: string;
  scan(
    pi: import("@mariozechner/pi-coding-agent").ExtensionAPI,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ScanResult>;
}

export interface CommitSummary {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export interface TodoItem {
  file: string;
  line: number;
  text: string;
  type: "TODO" | "FIXME" | "HACK" | "XXX";
}

// ─── Beads (br CLI types) ────────────────────────────────────

/** Mirrors br list --json output for a single bead/issue. */
export interface Bead {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "closed" | "deferred";
  priority: number; // 0-4
  type: string;     // "task" | "feature" | "bug" etc.
  labels: string[];
  estimate?: number; // minutes
  /** Parent bead ID (from --parent flag). */
  parent?: string;
}

export interface BeadResult {
  beadId: string;
  status: "success" | "partial" | "blocked";
  summary: string;
}

export interface BeadReview {
  beadId: string;
  passed: boolean;
  feedback: string;
  revisionInstructions?: string;
}

// ─── Discovery ───────────────────────────────────────────────
export interface IdeaScores {
  useful: number;     // 1-5: solves a real, frequent pain
  pragmatic: number;  // 1-5: realistic to build in hours/days
  accretive: number;  // 1-5: clearly adds value beyond what exists
  robust: number;     // 1-5: handles edge cases, works reliably
  ergonomic: number;  // 1-5: reduces friction or cognitive load
}

export interface CandidateIdea {
  id: string;
  title: string;
  description: string;
  category: IdeaCategory;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  /** Why this idea beat other candidates — specific repo evidence and reasoning. */
  rationale: string;
  /** "top" = top 5 picks, "honorable" = next 5-10 worth considering. */
  tier: "top" | "honorable";
  /** What repo signals support this idea. */
  sourceEvidence?: string[];
  /** Known downsides or unknowns. */
  risks?: string[];
  /** IDs of other ideas this complements. */
  synergies?: string[];
  /** Rubric scores (1-5 per axis). */
  scores?: IdeaScores;
}

export type IdeaCategory =
  | "feature"
  | "refactor"
  | "docs"
  | "dx"
  | "performance"
  | "reliability"
  | "security"
  | "testing";

// ─── Session State ───────────────────────────────────────────
export type OrchestratorPhase =
  | "idle"
  | "profiling"
  | "discovering"
  | "awaiting_selection"
  | "planning"
  | "awaiting_plan_approval"
  | "creating_beads"
  | "refining_beads"
  | "awaiting_bead_approval"
  | "implementing"
  | "reviewing"
  | "iterating"
  | "complete";

export interface OrchestratorState {
  phase: OrchestratorPhase;
  repoProfile?: RepoProfile;
  scanResult?: ScanResult;
  candidateIdeas?: CandidateIdea[];
  selectedGoal?: string;
  constraints: string[];
  retryCount: number;
  maxRetries: number;
  maxReviewPasses: number;
  iterationRound: number;
  /** Index into the guided gates array — tracks which gate to show next */
  currentGateIndex: number;
  worktreePoolState?: {
    repoRoot: string;
    baseBranch: string;
    worktrees: { path: string; branch: string; stepIndex: number }[];
  };
  sophiaCRId?: number;
  sophiaCRBranch?: string;
  sophiaCRTitle?: string;

  // ─── Coordination backend state ────────────────────────────
  /** Detected coordination backends (beads, agentMail, sophia) */
  coordinationBackend?: import("./coordination.js").CoordinationBackend;
  /** Selected coordination strategy based on available backends */
  coordinationStrategy?: import("./coordination.js").CoordinationStrategy;
  /** Whether agent-mail session was bootstrapped for this orchestration */
  agentMailSessionActive?: boolean;

  // ─── Bead-centric state (new) ──────────────────────────────
  /** Bead IDs created for this orchestration (ordered). */
  activeBeadIds?: string[];
  /** Results keyed by bead ID. */
  beadResults?: Record<string, import("./types.js").BeadResult>;
  /** Review verdicts keyed by bead ID. */
  beadReviews?: Record<string, import("./types.js").BeadReview[]>;
  /** Currently executing bead ID. */
  currentBeadId?: string | null;
  /** Hit-me triggered per bead ID. */
  beadHitMeTriggered?: Record<string, boolean>;
  /** Hit-me completed per bead ID. */
  beadHitMeCompleted?: Record<string, boolean>;
  /** Review pass counts per bead ID. */
  beadReviewPassCounts?: Record<string, number>;
}

export function createInitialState(): OrchestratorState {
  return {
    phase: "idle",
    constraints: [],
    retryCount: 0,
    maxRetries: 3,
    maxReviewPasses: 2,
    iterationRound: 0,
    currentGateIndex: 0,
  };
}
