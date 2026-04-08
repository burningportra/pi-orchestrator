/**
 * pi-mempalace — Episodic memory for every pi session.
 *
 * On each agent turn, searches MemPalace for past session excerpts relevant
 * to the current prompt and injects them into the system prompt.
 *
 * On session shutdown, mines the current session transcript into MemPalace
 * so future sessions can recall it.
 *
 * Requires: pip install mempalace && python3 -m mempalace init <dir>
 *
 * Install globally:
 *   cp -r extensions/pi-mempalace ~/.pi/agent/extensions/pi-mempalace
 * Or project-local:
 *   cp -r extensions/pi-mempalace .pi/extensions/pi-mempalace
 */

import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── MemPalace helpers ───────────────────────────────────────

function slugify(cwd: string): string {
  return basename(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

let _available: boolean | null = null;

function isAvailable(): boolean {
  if (_available !== null) return _available;
  try {
    execFileSync("python3", ["-m", "mempalace", "status"], {
      timeout: 3_000,
      stdio: "pipe",
    });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Search MemPalace for past session excerpts relevant to a query.
 * Returns a formatted string ready for prompt injection, or "" if nothing found.
 */
function search(query: string, wing: string, nResults = 3): string {
  if (!isAvailable()) return "";
  try {
    const raw = execFileSync(
      "python3",
      ["-m", "mempalace", "search", query, "--results", String(nResults), "--wing", wing],
      { timeout: 10_000, stdio: "pipe", encoding: "utf8" }
    );
    return parsePlainTextSearch(raw);
  } catch {
    return "";
  }
}

/**
 * Mine the project's sessions directory into MemPalace.
 *
 * Takes the current session file path and mines its parent directory —
 * the mempalace CLI requires a directory, not a single file. MemPalace
 * deduplicates automatically so already-filed sessions are skipped.
 * Best-effort — never throws.
 */
function mine(sessionFile: string, wing: string): void {
  if (!isAvailable()) return;
  try {
    execFileSync(
      "python3",
      [
        "-m", "mempalace",
        "mine", dirname(sessionFile),
        "--mode", "convos",
        "--wing", wing,
        "--extract", "general",
      ],
      { timeout: 30_000, stdio: "pipe" }
    );
  } catch {
    // best-effort
  }
}

/**
 * Parse plain-text `mempalace search` output into a compact formatted string.
 *
 * Each result block from the CLI looks like:
 *   [N] wing / room
 *       Source: filename
 *       Match:  0.XXX
 *
 *       <text lines (6-space indented)>
 *   ────────────────────────────────────
 */
function parsePlainTextSearch(raw: string): string {
  const blocks = raw.split(/\n\s*[─]+\s*\n/);
  const formatted: string[] = [];

  for (const block of blocks) {
    const header = block.match(/\[(\d+)\]\s+([^/]+)\/\s*(.+)/);
    if (!header) continue;

    const wing = header[2].trim();
    const room = header[3].trim();
    const simMatch = block.match(/Match:\s+([0-9.]+)/);
    const sim = simMatch ? parseFloat(simMatch[1]).toFixed(2) : "?";

    const contentMatch = block.match(/Match:\s+[0-9.]+\n\n([\s\S]+)/);
    if (!contentMatch) continue;

    const text = contentMatch[1]
      .split("\n")
      .map((l) => l.replace(/^      /, ""))
      .join("\n")
      .trim();

    if (!text) continue;
    formatted.push(`[${wing} / ${room}] (sim=${sim})\n  ${text.replace(/\n/g, "\n  ")}`);
  }

  return formatted.join("\n\n");
}

// ─── Extension ──────────────────────────────────────────────

export default function piMempalaceExtension(pi: ExtensionAPI) {
  let projectSlug = "";

  // ── Session init ─────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    projectSlug = slugify(ctx.cwd);

    if (!isAvailable()) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-mempalace: MemPalace not found — run: pip install mempalace && python3 -m mempalace init <dir>",
          "warning"
        );
      }
    } else {
      // Show load confirmation the same way other extensions do
      process.stderr.write(`[pi-mempalace] episodic memory active (wing: ${projectSlug})\n`);
    }
  });

  // ── Context injection ─────────────────────────────────────
  // Fires once per user prompt, before the agent loop starts.
  // event.prompt is the current user message — perfect search query.
  pi.on("before_agent_start", async (event) => {
    if (!projectSlug || !event.prompt?.trim()) return undefined;

    const results = search(event.prompt.trim(), projectSlug);
    if (!results) return undefined;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n---\n\n## Past Session Context\n\n` +
        `Relevant excerpts from past sessions in this project:\n\n` +
        results +
        `\n`,
    };
  });

  // ── Session mining ────────────────────────────────────────
  // After the session ends, mine the transcript so future sessions can recall it.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!projectSlug) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    mine(sessionFile, projectSlug);

    if (ctx.hasUI) {
      ctx.ui.notify("📚 Session mined into MemPalace", "info");
    }
  });
}
