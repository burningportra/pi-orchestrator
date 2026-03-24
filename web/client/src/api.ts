// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Bead {
  id: string;
  title: string;
  description?: string;
  status: "open" | "in_progress" | "closed" | "deferred" | "blocked";
  priority: 1 | 2 | 3 | 4;
  type: string;
  labels: string[];
  files: string[];
  parent?: string;
  dependencies: string[];
  children?: string[];
}

export interface OrchestratorState {
  phase: string;
  totalBeads: number;
  openBeads: number;
  inProgressBeads: number;
  closedBeads: number;
  deferredBeads: number;
  currentBeadId?: string;
  polishRounds?: { round: number; changes: number }[];
  gates?: GateStatus[];
  agentMail?: AgentMailMessage[];
  sophia?: SophiaCR[];
}

export interface GateStatus {
  name: string;
  status: "pending" | "passed" | "failed" | "skipped";
  output?: string;
}

export interface AgentMailMessage {
  id: string;
  sender: string;
  to: string[];
  subject: string;
  body: string;
  timestamp: string;
  importance: "low" | "normal" | "high" | "critical";
  threadId: string;
  acknowledged?: boolean;
}

export interface SophiaCR {
  id: string;
  title: string;
  branch: string;
  status: string;
}

export interface BvInsights {
  totalBeads: number;
  open: number;
  inProgress: number;
  closed: number;
  deferred: number;
  blocked: number;
  bottlenecks: string[];
  healthScore: number;
}

export interface BvNextPick {
  beadId: string;
  reason: string;
}

export interface PlanAudit {
  valid: boolean;
  errors: string[];
  warnings: string[];
  beadCount: number;
}

export interface ReviewData {
  beadId: string;
  verdict: "approve" | "request_changes" | "comment";
  feedback: string;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const BASE = "";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export function fetchBeads(): Promise<Bead[]> {
  return fetchJSON<Bead[]>("/api/beads");
}

export function fetchBead(id: string): Promise<Bead> {
  return fetchJSON<Bead>(`/api/beads/${id}`);
}

export function fetchReadyBeads(): Promise<Bead[]> {
  return fetchJSON<Bead[]>("/api/beads/ready");
}

export function fetchBeadDeps(id: string): Promise<string[]> {
  return fetchJSON<string[]>(`/api/beads/${id}/deps`);
}

export function updateBeadStatus(id: string, status: string): Promise<void> {
  return fetchJSON("/api/beads/" + id + "/status", {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function fetchState(): Promise<OrchestratorState> {
  return fetchJSON<OrchestratorState>("/api/state");
}

export function fetchInsights(): Promise<BvInsights | null> {
  return fetchJSON<BvInsights | null>("/api/insights");
}

export function fetchNext(): Promise<BvNextPick | null> {
  return fetchJSON<BvNextPick | null>("/api/next");
}

export function fetchPlan(): Promise<{ content: string } | null> {
  return fetchJSON<{ content: string } | null>("/api/plan");
}

export function savePlan(content: string): Promise<void> {
  return fetchJSON("/api/plan", {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export function fetchPlanAudit(): Promise<PlanAudit> {
  return fetchJSON<PlanAudit>("/api/plan/audit");
}

export function submitReview(data: ReviewData): Promise<unknown> {
  return fetchJSON("/api/commands/review", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function triggerCommand(cmd: string, body?: unknown): Promise<unknown> {
  return fetchJSON(`/api/commands/${cmd}`, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}
