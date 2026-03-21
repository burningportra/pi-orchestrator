import { execFileSync } from "child_process";

// ─── Types ──────────────────────────────────────────────────

export interface MemoryEntry {
  /** 1-based index for user-facing display */
  index: number;
  /** Bullet ID from CASS (e.g. "b-8f3a2c") */
  id: string;
  /** Category tag */
  category: string;
  /** Entry content */
  content: string;
}

export interface MemoryStats {
  entryCount: number;
  cassAvailable: boolean;
  overallStatus: string | null;
  version: string | null;
}

export interface CassContext {
  relevantBullets: Array<{ id: string; text: string; score?: number; category?: string }>;
  antiPatterns: Array<{ id: string; text: string }>;
  historySnippets: Array<{ text: string; source?: string }>;
  suggestedCassQueries: string[];
  degraded: Record<string, unknown> | null;
}

// ─── CASS Detection ─────────────────────────────────────────

let _cassAvailable: boolean | null = null;

/** Check if cm CLI is available. Caches result. */
export function detectCass(): boolean {
  if (_cassAvailable !== null) return _cassAvailable;
  try {
    execFileSync("cm", ["--version"], { timeout: 3000, stdio: "pipe" });
    _cassAvailable = true;
  } catch {
    _cassAvailable = false;
  }
  return _cassAvailable;
}

/** Reset detection cache (for testing). */
export function resetCassDetection(): void {
  _cassAvailable = null;
}

// ─── Helpers ────────────────────────────────────────────────

function runCm(args: string[], cwd?: string): string | null {
  try {
    const result = execFileSync("cm", args, {
      timeout: 10000,
      stdio: "pipe",
      cwd,
      encoding: "utf8",
    });
    return result;
  } catch {
    return null;
  }
}

function parseCmJson<T>(output: string | null): T | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    return parsed?.success ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

// ─── Core API ───────────────────────────────────────────────

/**
 * Get CASS context for a task — relevance-scored bullets, anti-patterns, history.
 * Returns null if cm unavailable.
 */
export function getContext(task: string, cwd?: string): CassContext | null {
  if (!detectCass()) return null;
  const output = runCm(["context", task, "--json"], cwd);
  return parseCmJson<CassContext>(output);
}

/**
 * Read memory as a formatted string for injection into prompts.
 * Returns relevant bullets for the given task, or empty string if unavailable.
 */
export function readMemory(cwd: string, task?: string): string {
  if (!detectCass()) return "";
  const ctx = getContext(task || "orchestration session", cwd);
  if (!ctx) return "";

  const parts: string[] = [];
  if (ctx.relevantBullets.length > 0) {
    parts.push("### Relevant Rules");
    for (const b of ctx.relevantBullets) {
      parts.push(`- [${b.id}] ${b.text}`);
    }
  }
  if (ctx.antiPatterns.length > 0) {
    parts.push("\n### Anti-Patterns");
    for (const ap of ctx.antiPatterns) {
      parts.push(`- [${ap.id}] ${ap.text}`);
    }
  }
  if (ctx.historySnippets.length > 0) {
    parts.push("\n### History Snippets");
    for (const h of ctx.historySnippets) {
      parts.push(`- ${h.text}`);
    }
  }
  return parts.join("\n");
}

/**
 * Add a learning to the CASS playbook.
 * Replaces the old appendMemory (flat file append).
 */
export function appendMemory(cwd: string, entry: string, category?: string): boolean {
  if (!detectCass()) return false;
  const args = ["add", entry, "--json"];
  if (category) args.push("--category", category);
  const output = runCm(args, cwd);
  return parseCmJson(output) !== null;
}

/**
 * List all playbook entries.
 */
export function listMemoryEntries(cwd?: string): MemoryEntry[] {
  if (!detectCass()) return [];
  const output = runCm(["ls", "--json"], cwd);
  interface CmBullet { id: string; text: string; category?: string }
  const data = parseCmJson<{ bullets: CmBullet[] } | CmBullet[]>(output);
  if (!data) return [];
  const bullets = Array.isArray(data) ? data : (data.bullets ?? []);
  return bullets.map((b, i) => ({
    index: i + 1,
    id: b.id,
    category: b.category ?? "general",
    content: b.text,
  }));
}

/**
 * Search memory entries by query using CASS similar command.
 */
export function searchMemory(cwd: string, query: string): MemoryEntry[] {
  if (!detectCass()) return [];
  const output = runCm(["similar", query, "--json"], cwd);
  interface CmResult { id?: string; text: string; score?: number; category?: string }
  const data = parseCmJson<{ results: CmResult[] }>(output);
  if (!data?.results) return [];
  return data.results.map((r, i) => ({
    index: i + 1,
    id: r.id ?? `r-${i}`,
    category: r.category ?? "general",
    content: r.text,
  }));
}

/**
 * Mark a CASS rule as helpful or harmful.
 */
export function markRule(bulletId: string, helpful: boolean, reason?: string, cwd?: string): boolean {
  if (!detectCass()) return false;
  const args = ["mark", bulletId, helpful ? "--helpful" : "--harmful", "--json"];
  if (reason) args.push("--reason", reason);
  const output = runCm(args, cwd);
  return parseCmJson(output) !== null;
}

/**
 * Get memory system stats.
 */
export function getMemoryStats(cwd?: string): MemoryStats {
  if (!detectCass()) {
    return { entryCount: 0, cassAvailable: false, overallStatus: null, version: null };
  }
  const output = runCm(["doctor", "--json"], cwd);
  interface DoctorData { version?: string; overallStatus?: string }
  const data = parseCmJson<DoctorData>(output);

  const statsOutput = runCm(["stats", "--json"], cwd);
  interface StatsData { totalBullets?: number; bulletCount?: number }
  const statsData = parseCmJson<StatsData>(statsOutput);

  return {
    entryCount: statsData?.totalBullets ?? statsData?.bulletCount ?? 0,
    cassAvailable: true,
    overallStatus: data?.overallStatus ?? null,
    version: data?.version ?? null,
  };
}
