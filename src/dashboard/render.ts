import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { BeadSnapshot, DashboardAlert, DashboardSnapshot } from "./types.js";

// ─── Theme interface ────────────────────────────────────────────
export interface DashboardTheme {
  primary(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
}

function styled(
  theme: DashboardTheme | undefined | null,
  style: keyof DashboardTheme,
  text: string,
): string {
  if (theme && typeof theme[style] === "function") return theme[style](text);
  return text;
}

// ─── Layout breakpoints ─────────────────────────────────────────
// compact  < 80  — phase + progress only
// normal  80-119 — full table, no extras
// wide   ≥ 120  — full table + sparkline + convergence + duration

type LayoutMode = "compact" | "normal" | "wide";

function layoutMode(width: number): LayoutMode {
  if (width < 80) return "compact";
  if (width < 120) return "normal";
  return "wide";
}

// ─── Unicode helpers ────────────────────────────────────────────

const BLOCK_CHARS = " ▏▎▍▌▋▊▉█";
const SPARK_CHARS = " ▁▂▃▄▅▆▇█";

/** Fill a bar of `barWidth` inner chars using 9-level block characters. */
function filledBar(ratio: number, barWidth: number, theme: DashboardTheme): string {
  if (barWidth <= 0) return "";
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const total8ths = Math.round(clampedRatio * barWidth * 8);
  const fullBlocks = Math.floor(total8ths / 8);
  const remainder = total8ths % 8;
  const emptyBlocks = barWidth - fullBlocks - (remainder > 0 ? 1 : 0);

  const full = "█".repeat(fullBlocks);
  const partial = remainder > 0 ? BLOCK_CHARS[remainder] : "";
  const empty = "░".repeat(Math.max(emptyBlocks, 0));

  return styled(theme, "success", full + partial) + styled(theme, "muted", empty);
}

/** Sparkline for an array of values using 9-level spark chars. */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  return values.map(v => SPARK_CHARS[Math.min(8, Math.round((v / max) * 8))]).join("");
}

/** Thin horizontal divider. */
function divider(width: number, theme: DashboardTheme): string {
  return styled(theme, "muted", "─".repeat(Math.max(width, 1)));
}

/** Format milliseconds as "2m 34s" or "45s". */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/** Truncate to max visible width using pi-tui's width-aware helper. */
function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  return truncateToWidth(text, maxWidth, "...");
}

/** Right-pad a string to `width` visible cells. */
function padEnd(text: string, width: number): string {
  const vis = visibleWidth(text);
  return text + " ".repeat(Math.max(0, width - vis));
}

// ─── Priority display ────────────────────────────────────────────

const PRIORITY_DOT: Record<number, string> = {
  0: "🔴", // P0 critical
  1: "🟠", // P1 high
  2: "🟡", // P2 medium
  3: "🟢", // P3 low
  4: "⚪", // P4 backlog
};

function priorityDot(priority: number): string {
  return PRIORITY_DOT[Math.min(4, Math.max(0, priority))] ?? "⚪";
}

// ─── Status badge ────────────────────────────────────────────────

const STATUS_BADGE: Record<BeadSnapshot["status"], string> = {
  open: "○",
  in_progress: "◉",
  closed: "●",
  deferred: "◇",
};

function styledBadge(bead: BeadSnapshot, theme: DashboardTheme): string {
  const raw = STATUS_BADGE[bead.status] ?? "?";
  if (bead.status === "closed")       return styled(theme, "success",  raw);
  if (bead.status === "in_progress")  return styled(theme, "primary",  raw);
  if (bead.status === "deferred")     return styled(theme, "warning",  raw);
  return styled(theme, "muted", raw);
}

// ─── Review verdict icon ─────────────────────────────────────────

function verdictIcon(bead: BeadSnapshot): string {
  if (bead.lastReviewVerdict === true)  return "✓";
  if (bead.lastReviewVerdict === false) return "✗";
  if (bead.reviewPasses > 0)            return `×${bead.reviewPasses}`;
  return "";
}

// ─── Section: phase header ───────────────────────────────────────

export function renderPhaseHeader(
  snapshot: DashboardSnapshot,
  theme: DashboardTheme,
  width = 80,
): string[] {
  const lines: string[] = [];

  // Phase line — left: "◉ Phase: implementing"  right: "2m 14s"
  const phaseLabel = `${snapshot.phaseEmoji} ${snapshot.phaseLabel}`;
  const durationStr = snapshot.phaseDurationMs !== undefined
    ? styled(theme, "muted", formatDuration(snapshot.phaseDurationMs))
    : "";

  if (durationStr && width > 60) {
    const gap = width - visibleWidth(phaseLabel) - visibleWidth(durationStr);
    lines.push(
      styled(theme, "primary", phaseLabel) +
      " ".repeat(Math.max(1, gap)) +
      durationStr,
    );
  } else {
    lines.push(styled(theme, "primary", truncate(phaseLabel, width)));
  }

  // Repo + scan source
  if (snapshot.repoName && snapshot.repoName !== "Unknown repo") {
    const badge = snapshot.scanSource && snapshot.scanSource !== "unknown"
      ? ` (${snapshot.scanSource})`
      : "";
    lines.push(styled(theme, "muted", truncate(`📁 ${snapshot.repoName}${badge}`, width)));
  }

  return lines;
}

// ─── Section: goal ───────────────────────────────────────────────

export function renderGoalLine(
  goal: string,
  maxWidth: number,
  theme: DashboardTheme,
): string {
  if (!goal) return "";
  const prefix = "🎯 ";
  const available = Math.max(maxWidth - visibleWidth(prefix), 0);
  return styled(theme, "muted", prefix) + truncate(goal, available);
}

// ─── Section: progress bar ───────────────────────────────────────

export function renderProgressBar(
  completed: number,
  total: number,
  barWidth: number,
  theme: DashboardTheme,
  round?: number,
): string {
  const safeTotal = Math.max(total, 0);
  const safeDone  = Math.max(Math.min(completed, safeTotal), 0);
  const innerWidth = Math.max(barWidth - 2, 0);

  if (innerWidth === 0) {
    return truncate(`📊 Progress: ${safeDone}/${safeTotal} beads`, barWidth + 22);
  }

  const ratio = safeTotal === 0 ? 0 : safeDone / safeTotal;
  const pct   = Math.round(ratio * 100);
  const bar   = `[${filledBar(ratio, innerWidth, theme)}]`;
  const roundStr = round !== undefined && round > 0
    ? styled(theme, "muted", ` · round ${round}`)
    : "";
  return `📊 ${bar} ${safeDone}/${safeTotal} (${pct}%)${roundStr}`;
}

// ─── Section: convergence sparkline ──────────────────────────────

export function renderConvergenceRow(
  snapshot: DashboardSnapshot,
  width: number,
  theme: DashboardTheme,
): string | null {
  const { polishChanges, convergenceScore } = snapshot;
  if (!polishChanges || polishChanges.length === 0) return null;

  const spark = sparkline(polishChanges);
  const scoreStr = convergenceScore !== undefined
    ? ` ${Math.round(convergenceScore * 100)}%`
    : "";
  const label = "📈 Convergence: ";
  const bar = `[${spark}]${scoreStr}`;
  const full = label + bar;
  if (visibleWidth(full) > width) return styled(theme, "muted", truncate(full, width));

  // Colour the bar: green if ≥75%, yellow if ≥50%, muted otherwise
  const scoreNum = convergenceScore ?? 0;
  const barStyle: keyof DashboardTheme =
    scoreNum >= 0.75 ? "success" : scoreNum >= 0.50 ? "warning" : "muted";

  return styled(theme, "muted", label) + styled(theme, barStyle, bar);
}

// ─── Section: foregone score gauge ───────────────────────────────

export function renderForegoneRow(
  foregoneScore: number,
  width: number,
  theme: DashboardTheme,
): string {
  const label = "🎯 Readiness: [";
  const GAUGE_WIDTH = Math.min(20, width - label.length - 10);
  if (GAUGE_WIDTH < 4) return "";
  const bar = filledBar(foregoneScore, GAUGE_WIDTH, theme);
  const pct = Math.round(foregoneScore * 100);
  const verdict = foregoneScore >= 0.9
    ? styled(theme, "success",  " ✓ foregone")
    : foregoneScore >= 0.75
    ? styled(theme, "warning",  " ready")
    : styled(theme, "muted",    " polishing");

  return styled(theme, "muted", label) + bar + styled(theme, "muted", "]") +
    styled(theme, "muted", ` ${pct}%`) + verdict;
}

// ─── Section: plan quality ────────────────────────────────────────

export function renderPlanQualityRow(
  planQuality: number,
  width: number,
  theme: DashboardTheme,
): string {
  const label = "📋 Plan quality: [";
  const GAUGE_WIDTH = Math.min(20, width - label.length - 10);
  if (GAUGE_WIDTH < 4) return "";
  const ratio = planQuality / 100;
  const bar = filledBar(ratio, GAUGE_WIDTH, theme);
  const style: keyof DashboardTheme =
    planQuality >= 80 ? "success" : planQuality >= 60 ? "warning" : "error";
  return styled(theme, "muted", label) + bar +
    styled(theme, "muted", "] ") + styled(theme, style, `${planQuality}/100`);
}

// ─── Section: bead table ─────────────────────────────────────────

export function renderBeadTable(
  beads: BeadSnapshot[],
  width: number,
  theme: DashboardTheme,
  mode: LayoutMode = "normal",
): string[] {
  if (beads.length === 0) return [];

  const lines: string[] = [];

  // Column layout changes by mode:
  //   compact: badge + id + truncated-title
  //   normal:  badge + priority-dot + id + title
  //   wide:    badge + priority-dot + id + title + verdict/lock

  // Fixed-width column sizes
  const badgeW   = 1;
  const dotW     = mode === "compact" ? 0 : 2;  // "🟢 " but single emoji = 2 cells on most terminals
  const idW      = 8;
  const verdictW = mode === "wide" ? 4 : 0;     // " ✓×2"
  const lockW    = mode === "wide" ? 2 : 0;      // "🔒 "

  const overhead = badgeW + 1 + dotW + idW + 1 + verdictW + lockW;
  const titleW   = Math.max(width - overhead, 8);

  for (const bead of beads) {
    const badge = styledBadge(bead, theme);
    const dot   = mode !== "compact" ? priorityDot(bead.priority) + " " : "";
    const id    = padEnd(bead.id, idW).slice(0, idW);
    const title = truncate(bead.title, titleW);

    let suffix = "";
    if (mode === "wide") {
      const verdict = verdictIcon(bead);
      const lock    = !bead.unblocked && bead.status === "open" ? "🔒" : "  ";
      suffix = " " + padEnd(styled(theme, verdict === "✓" ? "success" : verdict === "✗" ? "error" : "muted", verdict), verdictW) + lock;
    }

    lines.push(`${badge} ${dot}${id} ${title}${suffix}`);
  }
  return lines;
}

// ─── Section: alerts ─────────────────────────────────────────────

export function renderAlerts(
  alerts: DashboardAlert[],
  theme: DashboardTheme,
): string[] {
  if (!alerts || alerts.length === 0) return [];
  return alerts.map(a => {
    const prefix = a.level === "error" ? "❌" : a.level === "warning" ? "⚠️ " : "ℹ️  ";
    const styleKey: keyof DashboardTheme =
      a.level === "error" ? "error" : a.level === "warning" ? "warning" : "muted";
    return styled(theme, styleKey, `${prefix}${a.message}`);
  });
}

// ─── Section: stale banner ───────────────────────────────────────

export function renderStaleBanner(
  snapshot: DashboardSnapshot,
  theme: DashboardTheme,
): string | null {
  if (!snapshot.staleData) return null;
  return styled(theme, "warning", "⚠️  Dashboard data may be stale — bead reads failed or returned empty.");
}

// ─── Section: tender ─────────────────────────────────────────────

export function renderTenderSection(
  tenderSummary: string | undefined,
  theme: DashboardTheme,
): string[] {
  if (!tenderSummary) return [];
  return [styled(theme, "muted", `🐝 ${tenderSummary}`)];
}

// ─── Section: status footer ──────────────────────────────────────

function renderStatusFooter(
  snapshot: DashboardSnapshot,
  width: number,
  theme: DashboardTheme,
): string {
  const refresh = `↻ ${new Date(snapshot.lastRefreshMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  const hint = snapshot.phase === "implementing" || snapshot.phase === "reviewing"
    ? "/orchestrate-drift-check to check goal alignment"
    : snapshot.phase === "awaiting_bead_approval" || snapshot.phase === "refining_beads"
    ? "orch_approve_beads to review"
    : "";

  if (hint && width > visibleWidth(hint) + visibleWidth(refresh) + 4) {
    const gap = width - visibleWidth(hint) - visibleWidth(refresh);
    return styled(theme, "muted", hint) + " ".repeat(Math.max(1, gap)) + styled(theme, "muted", refresh);
  }
  return styled(theme, "muted", refresh.padStart(width));
}

// ─── Main entry point ────────────────────────────────────────────

/**
 * Compose all dashboard sections into lines for pi-tui rendering.
 * Adapts layout based on terminal width.
 */
export function renderDashboardLines(
  snapshot: DashboardSnapshot,
  theme: DashboardTheme,
  width: number,
): string[] {
  // Absolute minimum: one-liner
  if (width < 12) {
    return [truncate(`${snapshot.phaseEmoji} ${snapshot.completedCount}/${snapshot.totalCount}`, width)];
  }
  if (width < 20) {
    return [truncate(`${snapshot.phaseEmoji} ${snapshot.completedCount}/${snapshot.totalCount} ${snapshot.phaseLabel}`, width)];
  }

  const mode = layoutMode(width);
  const lines: string[] = [];

  const push  = (...l: string[]) => lines.push(...l);
  const sep   = () => lines.push(divider(width, theme));
  const blank = () => lines.push("");

  // ── Stale banner ─────────────────────────────────────────────
  const staleBanner = renderStaleBanner(snapshot, theme);
  if (staleBanner) { push(staleBanner); blank(); }

  // ── Phase header ──────────────────────────────────────────────
  push(...renderPhaseHeader(snapshot, theme, width));

  // ── Goal ─────────────────────────────────────────────────────
  const goalLine = renderGoalLine(snapshot.goal, width, theme);
  if (goalLine) push(goalLine);

  sep();

  // ── Progress bar ──────────────────────────────────────────────
  const overhead = 22; // "📊 [" + "] X/Y (100%) · round N"
  const barWidth = Math.max(Math.min(width - overhead, 36), 4);
  push(renderProgressBar(
    snapshot.completedCount,
    snapshot.totalCount,
    barWidth,
    theme,
    snapshot.currentRound,
  ));

  // ── Convergence sparkline (normal+wide) ───────────────────────
  if (mode !== "compact") {
    const convRow = renderConvergenceRow(snapshot, width, theme);
    if (convRow) push(convRow);
  }

  // ── Foregone score gauge (wide only, after 2+ rounds) ─────────
  if (mode === "wide" && snapshot.foregoneScore !== undefined) {
    push(renderForegoneRow(snapshot.foregoneScore, width, theme));
  }

  // ── Plan quality gauge (wide only, during planning phases) ────
  if (mode === "wide" && snapshot.planQuality !== undefined &&
      (snapshot.phase === "awaiting_plan_approval" || snapshot.phase === "planning")) {
    push(renderPlanQualityRow(snapshot.planQuality, width, theme));
  }

  // ── Alerts ────────────────────────────────────────────────────
  const alertLines = renderAlerts(snapshot.alerts, theme);
  if (alertLines.length > 0) { blank(); push(...alertLines); }

  // ── Bead table ────────────────────────────────────────────────
  const tableLines = renderBeadTable(snapshot.beads, width, theme, mode);
  if (tableLines.length > 0) { blank(); push(...tableLines); }

  // ── Tender section ────────────────────────────────────────────
  const tenderLines = renderTenderSection(snapshot.tenderSummary, theme);
  if (tenderLines.length > 0) { blank(); push(...tenderLines); }

  // ── Status footer (normal+wide) ───────────────────────────────
  if (mode !== "compact" && width >= 40) {
    sep();
    push(renderStatusFooter(snapshot, width, theme));
  }

  // ── Hard-clamp: strip ANSI then truncate if still overflowing ─
  return lines.map((line) => visibleWidth(line) <= width ? line : truncate(line, width));
}
