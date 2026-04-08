import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, it, expect } from "vitest";
import {
  renderDashboardLines,
  renderPhaseHeader,
  renderProgressBar,
  renderGoalLine,
  renderBeadTable,
  renderStaleBanner,
  renderTenderSection,
  renderAlerts,
} from "../render.js";
import type { DashboardSnapshot, BeadSnapshot } from "../types.js";

/** Mock theme whose methods return text unmodified (identity). */
const mockTheme = {
  primary: (t: string) => t,
  muted: (t: string) => t,
  success: (t: string) => t,
  warning: (t: string) => t,
  error: (t: string) => t,
};

function makeSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    phase: "implementing",
    phaseLabel: "Implementing",
    phaseEmoji: "🔨",
    repoName: "my-repo",
    scanSource: "ccc",
    goal: "Add a monitoring dashboard",
    beads: [],
    completedCount: 2,
    totalCount: 5,
    tenderSummary: undefined,
    lastRefreshMs: Date.now(),
    staleData: false,
    alerts: [],
    ...overrides,
  };
}

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "pi-abc",
    title: "Test bead",
    status: "open",
    priority: 2,
    unblocked: true,
    reviewPasses: 0,
    lastReviewVerdict: undefined,
    ...overrides,
  };
}

describe("renderDashboardLines", () => {
  it("renders a full-layout dashboard with all sections", () => {
    const snap = makeSnapshot({
      beads: [
        makeBead({ id: "pi-1", title: "First", status: "closed" }),
        makeBead({ id: "pi-2", title: "Second", status: "in_progress" }),
      ],
      tenderSummary: "3 agents active",
      alerts: [{ level: "info", message: "All good" }],
    });

    const lines = renderDashboardLines(snap, mockTheme, 80);
    // Sections are separated by blank lines, so expect more total lines
    expect(lines.length).toBeGreaterThanOrEqual(7);

    const joined = lines.join("\n");
    expect(joined).toContain("Implementing");
    expect(joined).toContain("my-repo");
    expect(joined).toContain("Add a monitoring dashboard");
    expect(joined).toContain("2/5");
    expect(joined).toContain("pi-1");
    expect(joined).toContain("pi-2");
    expect(joined).toContain("3 agents active");
    expect(joined).toContain("All good");
  });

  it("renders minimal layout when width < 20", () => {
    const snap = makeSnapshot();
    const lines = renderDashboardLines(snap, mockTheme, 15);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2/5");
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(15);
  });

  it("handles width exactly 20", () => {
    const snap = makeSnapshot();
    const lines = renderDashboardLines(snap, mockTheme, 20);

    const allText = lines.join("\n");
    expect(allText).toContain("2/5");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("hard-clamps ultra-narrow layouts", () => {
    const snap = makeSnapshot();
    const lines = renderDashboardLines(snap, mockTheme, 9);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2/5");
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(9);
  });
});

describe("renderProgressBar", () => {
  it("renders 0/0 without division error", () => {
    const result = renderProgressBar(0, 0, 20, mockTheme);
    expect(result).toContain("0/0");
    expect(result).not.toContain("NaN");
    expect(result).not.toContain("Infinity");
  });

  it("renders partial progress", () => {
    const result = renderProgressBar(3, 10, 20, mockTheme);
    expect(result).toContain("3/10");
    expect(result).toContain("█");
    expect(result).toContain("░");
  });

  it("renders complete progress", () => {
    const result = renderProgressBar(5, 5, 20, mockTheme);
    expect(result).toContain("5/5");
    expect(result).toContain("█");
  });

  it("handles very small bar width", () => {
    const result = renderProgressBar(2, 4, 2, mockTheme);
    // At bar width 2, inner width is 0, falls back to compact format
    expect(result).toContain("2/4");
    expect(result).toContain("Progress");
    expect(result).toContain("beads");
  });

  it("handles bar width 0", () => {
    const result = renderProgressBar(1, 3, 0, mockTheme);
    expect(result).toContain("1/3");
    expect(result).toContain("Progress");
  });
});

describe("renderGoalLine", () => {
  it("truncates long goals with ellipsis", () => {
    const longGoal = "A".repeat(200);
    const result = renderGoalLine(longGoal, 50, mockTheme);
    expect(visibleWidth(result)).toBeLessThanOrEqual(50);
    expect(result).toContain("...");
  });

  it("does not truncate short goals", () => {
    const result = renderGoalLine("Short goal", 80, mockTheme);
    expect(result).toContain("Short goal");
    expect(result).not.toContain("...");
  });

  it("returns empty string for empty goal", () => {
    const result = renderGoalLine("", 80, mockTheme);
    expect(result).toBe("");
  });
});

describe("renderBeadTable", () => {
  it("renders beads with status badges", () => {
    const beads = [
      makeBead({ id: "pi-1", title: "Open bead", status: "open" }),
      makeBead({ id: "pi-2", title: "In progress", status: "in_progress" }),
      makeBead({ id: "pi-3", title: "Done", status: "closed" }),
      makeBead({ id: "pi-4", title: "Deferred", status: "deferred" }),
    ];

    const lines = renderBeadTable(beads, 60, mockTheme);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("○"); // open
    expect(lines[1]).toContain("◉"); // in_progress
    expect(lines[2]).toContain("●"); // closed
    expect(lines[3]).toContain("◇"); // deferred
  });

  it("truncates very long bead titles", () => {
    const beads = [makeBead({ id: "pi-1", title: "A".repeat(200) })];
    const lines = renderBeadTable(beads, 40, mockTheme);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pi-1");
    expect(lines[0]).toContain("...");
  });

  it("returns empty array for empty bead list", () => {
    const lines = renderBeadTable([], 80, mockTheme);
    expect(lines).toEqual([]);
  });

  it("preserves bead ids in output", () => {
    const beads = [
      makeBead({ id: "pi-abc", title: "Test" }),
      makeBead({ id: "pi-xyz", title: "Another" }),
    ];
    const lines = renderBeadTable(beads, 60, mockTheme);
    expect(lines[0]).toContain("pi-abc");
    expect(lines[1]).toContain("pi-xyz");
  });
});

describe("renderStaleBanner", () => {
  it("returns null when data is fresh", () => {
    const snap = makeSnapshot({ staleData: false });
    expect(renderStaleBanner(snap, mockTheme)).toBeNull();
  });

  it("returns warning line when staleData is true", () => {
    const snap = makeSnapshot({ staleData: true });
    const result = renderStaleBanner(snap, mockTheme);
    expect(result).toBeTruthy();
    expect(result).toContain("stale");
  });
});

describe("renderTenderSection", () => {
  it("returns empty array for undefined tender", () => {
    expect(renderTenderSection(undefined, mockTheme)).toEqual([]);
  });

  it("renders tender summary when present", () => {
    const lines = renderTenderSection("2 active, 1 idle", mockTheme);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 active, 1 idle");
  });
});

describe("renderAlerts", () => {
  it("returns empty array for empty alerts", () => {
    expect(renderAlerts([], mockTheme)).toEqual([]);
  });

  it("renders alert lines with appropriate prefixes", () => {
    const alerts = [
      { level: "info" as const, message: "Info msg" },
      { level: "warning" as const, message: "Warn msg" },
      { level: "error" as const, message: "Error msg" },
    ];
    const lines = renderAlerts(alerts, mockTheme);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ℹ️");
    expect(lines[0]).toContain("Info msg");
    expect(lines[1]).toContain("⚠️");
    expect(lines[2]).toContain("❌");
  });
});

describe("renderPhaseHeader", () => {
  it("includes phase and repo", () => {
    const snap = makeSnapshot();
    const lines = renderPhaseHeader(snap, mockTheme);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("Implementing");
    expect(lines[1]).toContain("my-repo");
    expect(lines[1]).toContain("ccc");
  });

  it("omits repo line for Unknown repo", () => {
    const snap = makeSnapshot({ repoName: "Unknown repo" });
    const lines = renderPhaseHeader(snap, mockTheme);
    expect(lines).toHaveLength(1);
  });
});

describe("unicode safety", () => {
  it("renders unicode in goals without throwing", () => {
    const result = renderGoalLine("日本語のゴール 🎯 émojis", 80, mockTheme);
    expect(result).toContain("日本語");
  });

  it("renders unicode bead titles without throwing", () => {
    const beads = [makeBead({ id: "pi-1", title: "Ünïcödé bëäd tïtlé 🔧" })];
    const lines = renderBeadTable(beads, 60, mockTheme);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ünïcödé");
  });
});
