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

// ─── Discovery ───────────────────────────────────────────────
export interface CandidateIdea {
  id: string;
  title: string;
  description: string;
  category: IdeaCategory;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
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

// ─── Planning ────────────────────────────────────────────────
export interface Plan {
  goal: string;
  constraints: string[];
  steps: PlanStep[];
}

export interface PlanStep {
  index: number;
  description: string;
  acceptanceCriteria: string[];
  artifacts: string[]; // file paths expected to be created/modified
  /**
   * Logical execution dependencies — step indices that must complete before this step runs.
   * - omitted: implicitly depends on the previous step (sequential by default)
   * - []: explicitly independent, can run in parallel
   * - [1, 3]: depends on steps 1 and 3
   */
  dependsOn?: number[];
}

// ─── Implementation ──────────────────────────────────────────
export interface StepResult {
  stepIndex: number;
  status: "success" | "partial" | "blocked";
  summary: string;
}

// ─── Review ──────────────────────────────────────────────────
export interface ReviewVerdict {
  stepIndex: number;
  passed: boolean;
  feedback: string;
  revisionInstructions?: string;
}

// ─── Session State ───────────────────────────────────────────
export type OrchestratorPhase =
  | "idle"
  | "profiling"
  | "discovering"
  | "awaiting_selection"
  | "planning"
  | "awaiting_plan_approval"
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
  plan?: Plan;
  stepResults: StepResult[];
  reviewVerdicts: ReviewVerdict[];
  currentStepIndex: number;
  retryCount: number;
  maxRetries: number;
  maxReviewPasses: number;
  /** Tracks how many passing reviews each step has completed. Key: stepIndex, Value: pass count */
  reviewPassCounts: Record<number, number>;
  /** Tracks whether hit-me review agents were triggered for a step. Prevents bypass via double orch_review calls. */
  hitMeTriggered: Record<number, boolean>;
  /** Tracks whether hit-me review agents have completed and returned results. Only set true by the orchestrator after agents finish. */
  hitMeCompleted: Record<number, boolean>;
  iterationRound: number;
  /** Index into the guided gates array — tracks which gate to show next */
  currentGateIndex: number;
  worktreePoolState?: {
    repoRoot: string;
    baseBranch: string;
    worktrees: { path: string; branch: string; stepIndex: number }[];
  };
  hasSophia: boolean;
  sophiaCRId?: number;
  sophiaCRBranch?: string;
  sophiaCRTitle?: string;
  sophiaTaskIds?: Record<number, number>;
}

export function createInitialState(): OrchestratorState {
  return {
    phase: "idle",
    constraints: [],
    stepResults: [],
    reviewVerdicts: [],
    currentStepIndex: 0,
    retryCount: 0,
    maxRetries: 3,
    maxReviewPasses: 2,
    reviewPassCounts: {},
    hitMeTriggered: {},
    hitMeCompleted: {},
    iterationRound: 0,
    currentGateIndex: 0,
    hasSophia: false,
  };
}
