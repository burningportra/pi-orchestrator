// ─── Repo Profile ────────────────────────────────────────────
export interface RepoProfile {
  name: string;
  languages: string[];
  frameworks: string[];
  structure: DirectoryNode[];
  entrypoints: string[];
  recentCommits: CommitSummary[];
  hasTests: boolean;
  testFramework?: string;
  hasDocs: boolean;
  hasCI: boolean;
  ciPlatform?: string;
  todos: TodoItem[];
  readme?: string;
  packageManager?: string;
  summary: string; // LLM-generated natural language summary
}

export interface DirectoryNode {
  path: string;
  type: "file" | "dir";
  children?: DirectoryNode[];
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
}

// ─── Implementation ──────────────────────────────────────────
export interface StepResult {
  stepIndex: number;
  status: "success" | "partial" | "blocked";
  changes: FileChange[];
  notes: string;
  infoRequests?: string[];
}

export interface FileChange {
  path: string;
  action: "create" | "modify" | "delete";
  diff?: string;
}

// ─── Review ──────────────────────────────────────────────────
export interface ReviewResult {
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
  | "selecting"
  | "planning"
  | "implementing"
  | "reviewing"
  | "complete";

export interface OrchestratorState {
  phase: OrchestratorPhase;
  repoProfile?: RepoProfile;
  candidateIdeas?: CandidateIdea[];
  selectedGoal?: string;
  plan?: Plan;
  stepResults: StepResult[];
  reviewResults: ReviewResult[];
  currentStepIndex: number;
  retryCount: number;
  maxRetries: number;
}

export function createInitialState(): OrchestratorState {
  return {
    phase: "idle",
    stepResults: [],
    reviewResults: [],
    currentStepIndex: 0,
    retryCount: 0,
    maxRetries: 3,
  };
}
