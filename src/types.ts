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

export interface ScanCodebaseAnalysis {
  /** High-level scan summary suitable for prompt context. */
  summary?: string;
  /** Concrete recommendation inputs for discovery/planning. */
  recommendations: string[];
  /** Structural findings about architecture, boundaries, or hotspots. */
  structuralInsights: ScanInsight[];
  /** Normalized quality signals that providers can attach. */
  qualitySignals: ScanQualitySignal[];
}

export interface ScanErrorInfo {
  code?: string;
  message: string;
  recoverable?: boolean;
}

export interface ScanFallbackInfo {
  used: boolean;
  from: ScanSource;
  to: "builtin";
  reason: string;
  error?: ScanErrorInfo;
}

/**
 * Normalized repository scan output.
 *
 * `profile` intentionally preserves the legacy `RepoProfile` contract so the
 * existing orchestrator flow can continue to operate unchanged while scan
 * providers attach richer codebase-analysis metadata around it.
 */
export interface ScanResult {
  source: ScanSource;
  provider: string;
  profile: RepoProfile;
  codebaseAnalysis: ScanCodebaseAnalysis;
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
