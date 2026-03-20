import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";

const MEMORY_DIR = ".pi-orchestrator";
const MEMORY_FILE = "memory.md";
const MAX_READ_BYTES = 10 * 1024; // 10KB context window protection

// ─── Types ──────────────────────────────────────────────────

export interface MemoryEntry {
  /** 1-based index for user-facing display and pruning */
  index: number;
  /** Raw timestamp string from the ## header */
  timestamp: string;
  /** Entry content (without the ## header line) */
  content: string;
}

export interface MemoryStats {
  entryCount: number;
  totalBytes: number;
  oldest: string | null;
  newest: string | null;
}

// ─── Helpers ────────────────────────────────────────────────

function memoryPath(cwd: string): string {
  return join(cwd, MEMORY_DIR, MEMORY_FILE);
}

/** Read the raw file content, or empty string if missing. */
function readRawMemory(cwd: string): string {
  try {
    const path = memoryPath(cwd);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read compound memory from .pi-orchestrator/memory.md.
 * Returns empty string if file doesn't exist.
 * Truncates to last 10KB to protect context window.
 */
export function readMemory(cwd: string): string {
  try {
    const path = memoryPath(cwd);
    if (!existsSync(path)) return "";

    const content = readFileSync(path, "utf8");
    if (content.length <= MAX_READ_BYTES) return content;

    // Truncate to last 10KB — most recent learnings are most relevant
    const truncated = content.slice(-MAX_READ_BYTES);
    // Find the first complete section (starts with ##)
    const firstSection = truncated.indexOf("\n## ");
    if (firstSection > 0) {
      return "...(earlier entries truncated)\n" + truncated.slice(firstSection);
    }
    return "...(truncated)\n" + truncated;
  } catch {
    return "";
  }
}

/**
 * Append a learning entry to .pi-orchestrator/memory.md.
 * Creates the directory and file if they don't exist.
 * Each entry is a timestamped markdown section.
 */
export function appendMemory(cwd: string, entry: string): boolean {
  try {
    const path = memoryPath(cwd);
    const dir = dirname(path);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const section = `\n## ${timestamp}\n\n${entry.trim()}\n`;

    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      writeFileSync(path, existing + section, "utf8");
    } else {
      writeFileSync(
        path,
        `# Compound Memory\n\nLearnings carried across orchestration runs.\n${section}`,
        "utf8"
      );
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Structured Access ──────────────────────────────────────

/**
 * Parse memory.md into structured entries.
 * Each entry starts with a `## timestamp` header.
 * Returns 1-based indexed entries. Empty/missing files return [].
 */
export function listMemoryEntries(cwd: string): MemoryEntry[] {
  const raw = readRawMemory(cwd);
  if (!raw) return [];

  const entries: MemoryEntry[] = [];
  // Split on ## headers (but not the # Compound Memory title)
  const parts = raw.split(/\n(?=## )/);

  let idx = 1;
  for (const part of parts) {
    // Match ## followed by a timestamp-like string
    const match = part.match(/^## (.+)\n([\s\S]*)/);
    if (!match) continue; // skip the file header or malformed sections

    const timestamp = match[1].trim();
    const content = match[2].trim();
    if (!content) continue; // skip empty entries

    entries.push({ index: idx++, timestamp, content });
  }

  return entries;
}

/**
 * Search memory entries by case-insensitive substring match
 * in either timestamp or content.
 */
export function searchMemory(cwd: string, query: string): MemoryEntry[] {
  const entries = listMemoryEntries(cwd);
  const lower = query.toLowerCase();
  return entries.filter(
    (e) =>
      e.timestamp.toLowerCase().includes(lower) ||
      e.content.toLowerCase().includes(lower)
  );
}

/**
 * Remove entries at the given 1-based indices.
 * Processes in descending order to avoid index shifting.
 * Preserves the file header. Returns the count of entries removed.
 */
export function pruneMemoryEntries(cwd: string, indices: number[]): number {
  const entries = listMemoryEntries(cwd);
  if (entries.length === 0) return 0;

  // Deduplicate, sort descending, filter to valid range
  const toRemove = new Set(
    indices.filter((i) => i >= 1 && i <= entries.length)
  );
  if (toRemove.size === 0) return 0;

  const remaining = entries.filter((e) => !toRemove.has(e.index));

  // Rebuild the file
  const path = memoryPath(cwd);
  const header = "# Compound Memory\n\nLearnings carried across orchestration runs.\n";
  const sections = remaining
    .map((e) => `\n## ${e.timestamp}\n\n${e.content}\n`)
    .join("");

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, header + sections, "utf8");

  return toRemove.size;
}

/**
 * Get summary statistics about the memory file.
 */
export function getMemoryStats(cwd: string): MemoryStats {
  const entries = listMemoryEntries(cwd);
  let totalBytes = 0;
  try {
    const path = memoryPath(cwd);
    if (existsSync(path)) {
      totalBytes = statSync(path).size;
    }
  } catch {
    // ignore
  }

  return {
    entryCount: entries.length,
    totalBytes,
    oldest: entries.length > 0 ? entries[0].timestamp : null,
    newest: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
  };
}
