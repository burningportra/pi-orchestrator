import type { BeadSnapshot, DashboardAlert, DashboardSnapshot } from "./types.js";

// ─── Status badges ─────────────────────────────────────────────
const STATUS_BADGE: Record<BeadSnapshot["status"], string> = {
  open: "○",
  in_progress: "◉",
  closed: "●",
  deferred: "◇",
};

// ─── Theme-aware styling helpers ───────────────────────────────
// pi-tui does not export a stable Theme type for downstream extensions.
// This local interface documents the methods we actually use.

/** Minimal subset of pi-tui Theme used by dashboard rendering. */
export interface DashboardTheme {
  primary(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
}

function styled(theme: DashboardTheme | undefined | null, style: keyof DashboardTheme, text: string): string {
  if (theme && typeof theme[style] === "function") {
    return theme[style](text);
  }
  return text;
}

// ─── Helpers ───────────────────────────────────────────────────

/** Shorten `text` to at most `maxLen` chars, adding "..." when truncated.
 *  When maxLen < 4 there is no room for an ellipsis so we hard-cut instead. */
function truncate(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, Math.max(maxLen, 0));
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ─── Public render functions ───────────────────────────────────

/** Render a phase header: emoji + phase name, repo + scan source. */
export function renderPhaseHeader(
  snapshot: DashboardSnapshot,
  theme: DashboardTheme,
): string[] {
  const lines: string[] = [];
  lines.push(
    styled(theme, "primary", `${snapshot.phaseEmoji} Phase: ${snapshot.phase}`),
  );
  if (snapshot.repoName && snapshot.repoName !== "Unknown repo") {
    const badge = snapshot.scanSource && snapshot.scanSource !== "unknown"
      ? ` (${snapshot.scanSource})`
      : "";
    lines.push(styled(theme, "muted", `📁 Repo: ${snapshot.repoName}${badge}`));
  }
  return lines;
}

/** Render a goal line, ellipsizing long text. Returns `""` when goal is empty. */
export function renderGoalLine(
  goal: string,
  maxWidth: number,
  theme: DashboardTheme,
): string {
  if (!goal) return "";
  const prefix = "🎯 Goal: ";
  const availableWidth = Math.max(maxWidth - prefix.length, 0);
  return styled(theme, "muted", prefix + truncate(goal, availableWidth));
}

/** Render a progress bar: [████░░░░] 3/10 */
export function renderProgressBar(
  completed: number,
  total: number,
  barWidth: number,
  theme: DashboardTheme,
): string {
  const safeTotal = Math.max(total, 0);
  const safeCompleted = Math.max(Math.min(completed, safeTotal), 0);

  // Need at least 2 chars for brackets
  const innerWidth = Math.max(barWidth - 2, 0);
  if (innerWidth === 0) {
    return `📊 Progress: ${safeCompleted}/${safeTotal} beads`;
  }

  const ratio = safeTotal === 0 ? 0 : safeCompleted / safeTotal;
  const filled = Math.round(ratio * innerWidth);
  const empty = innerWidth - filled;

  const bar = `[${styled(theme, "success", "█".repeat(filled))}${"░".repeat(empty)}]`;
  return `📊 Progress: ${bar} ${safeCompleted}/${safeTotal} beads`;
}

/** Render a compact bead table with status badges. */
export function renderBeadTable(
  beads: BeadSnapshot[],
  width: number,
  theme: DashboardTheme,
): string[] {
  if (beads.length === 0) return [];

  const lines: string[] = [];
  // Reserve space for: badge(1) + space(1) + id(~8) + space(1) + title
  // Bead IDs like "pi-abc" or "pi-i3b" are ≤7 chars; pad/clip to 8 for alignment.
  const idWidth = 8;
  const fixedOverhead = 1 + 1 + idWidth + 1; // badge + space + id + space
  const titleWidth = Math.max(width - fixedOverhead, 6);

  for (const bead of beads) {
    const badge = STATUS_BADGE[bead.status] ?? "?";
    const styledBadge =
      bead.status === "closed"
        ? styled(theme, "success", badge)
        : bead.status === "in_progress"
          ? styled(theme, "primary", badge)
          : bead.status === "deferred"
            ? styled(theme, "warning", badge)
            : styled(theme, "muted", badge);

    const id = bead.id.padEnd(idWidth).slice(0, idWidth);
    const title = truncate(bead.title, titleWidth);
    lines.push(`${styledBadge} ${id} ${title}`);
  }
  return lines;
}

/** Render a stale-data warning banner. Returns null when data is fresh. */
export function renderStaleBanner(
  snapshot: DashboardSnapshot,
  theme: DashboardTheme,
): string | null {
  if (!snapshot.staleData) return null;
  return styled(theme, "warning", "⚠️  Dashboard data may be stale — bead reads failed or returned empty.");
}

/** Render the swarm tender section. Returns [] when no tender is active. */
export function renderTenderSection(
  tenderSummary: string | undefined,
  theme: DashboardTheme,
): string[] {
  if (!tenderSummary) return [];
  return [styled(theme, "muted", `🐝 Tender: ${tenderSummary}`)];
}

/** Render alert lines. Returns [] for empty alerts. */
export function renderAlerts(
  alerts: DashboardAlert[],
  theme: DashboardTheme,
): string[] {
  if (!alerts || alerts.length === 0) return [];
  return alerts.map((a) => {
    const prefix = a.level === "error" ? "❌" : a.level === "warning" ? "⚠️" : "ℹ️";
    const style = a.level === "error" ? "error" : a.level === "warning" ? "warning" : "muted";
    return styled(theme, style, `${prefix} ${a.message}`);
  });
}

/**
 * Main render entry point.
 * Composes all dashboard sections into a string[] suitable for
 * the pi-tui Component.render(width) contract.
 */
export function renderDashboardLines(
  snapshot: DashboardSnapshot,
  theme: DashboardTheme,
  width: number,
): string[] {
  // Minimal layout for very narrow terminals
  if (width < 20) {
    const compact = `${snapshot.phaseEmoji} ${snapshot.phase} ${snapshot.completedCount}/${snapshot.totalCount}`;
    return [compact];
  }

  const lines: string[] = [];

  // 1. Stale banner
  const staleBanner = renderStaleBanner(snapshot, theme);
  if (staleBanner) {
    lines.push(staleBanner);
    lines.push(""); // visual separator after banner
  }

  // 2. Phase header
  lines.push(...renderPhaseHeader(snapshot, theme));

  // 3. Goal line
  const goalLine = renderGoalLine(snapshot.goal, width, theme);
  if (goalLine) lines.push(goalLine);

  // 4. Progress bar
  // The "📊 Progress: [" prefix + "] X/Y beads" suffix consume ~22 chars.
  const progressPrefixOverhead = 22;
  const barWidth = Math.max(Math.min(width - progressPrefixOverhead, 30), 0);
  lines.push(renderProgressBar(snapshot.completedCount, snapshot.totalCount, barWidth, theme));

  // 5. Alerts
  const alertLines = renderAlerts(snapshot.alerts, theme);
  if (alertLines.length > 0) {
    lines.push(""); // blank line before alerts
    lines.push(...alertLines);
  }

  // 6. Bead table
  const tableLines = renderBeadTable(snapshot.beads, width, theme);
  if (tableLines.length > 0) {
    lines.push(""); // blank line before bead table
    lines.push(...tableLines);
  }

  // 7. Tender section
  const tenderLines = renderTenderSection(snapshot.tenderSummary, theme);
  if (tenderLines.length > 0) {
    lines.push(""); // blank line before tender section
    lines.push(...tenderLines);
  }

  return lines;
}
