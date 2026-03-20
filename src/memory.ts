import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const MEMORY_DIR = ".pi-orchestrator";
const MEMORY_FILE = "memory.md";
const MAX_READ_BYTES = 10 * 1024; // 10KB context window protection

function memoryPath(cwd: string): string {
  return join(cwd, MEMORY_DIR, MEMORY_FILE);
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
