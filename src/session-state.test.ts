import { describe, it, expect } from "vitest";
import { detectSessionStage, formatSessionContext, buildResumeLabel } from "./session-state.js";
import type { OrchestratorState, Bead } from "./types.js";
import { createInitialState } from "./types.js";

// ─── Fixtures ─────────────────────────────────────────────────

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return { ...createInitialState(), ...overrides };
}

function makeBead(id: string, status: Bead["status"], createdDaysAgo = 0): Bead {
  const created = new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    id,
    title: `Bead ${id}`,
    description: "desc",
    status,
    priority: 0,
    type: "task",
    labels: [],
    created_at: created,
  };
}

// ─── detectSessionStage ───────────────────────────────────────

describe("detectSessionStage", () => {
  describe("high-confidence: persisted non-idle phase", () => {
    it("trusts implementing phase from state", () => {
      const state = makeState({ phase: "implementing", selectedGoal: "Add dark mode" });
      const beads = [makeBead("br-1", "open"), makeBead("br-2", "closed")];
      const stage = detectSessionStage(state, beads);

      expect(stage.phase).toBe("implementing");
      expect(stage.confidence).toBe("high");
      expect(stage.goal).toBe("Add dark mode");
      expect(stage.openBeadCount).toBe(1);
      expect(stage.completedBeadCount).toBe(1);
      expect(stage.totalBeadCount).toBe(2);
      expect(stage.inferredFrom).toContain('persisted phase "implementing"');
    });

    it("trusts planning phase", () => {
      const state = makeState({ phase: "planning", planDocument: "plan.md" });
      const stage = detectSessionStage(state, []);
      expect(stage.phase).toBe("planning");
      expect(stage.confidence).toBe("high");
      expect(stage.planDocument).toBe("plan.md");
    });

    it("trusts awaiting_plan_approval phase", () => {
      const state = makeState({ phase: "awaiting_plan_approval", planDocument: "plan.md" });
      const stage = detectSessionStage(state, []);
      expect(stage.phase).toBe("awaiting_plan_approval");
      expect(stage.confidence).toBe("high");
    });

    it("picks up currentBeadId from in-progress bead", () => {
      const state = makeState({ phase: "implementing", currentBeadId: "br-2" });
      const beads = [makeBead("br-1", "open"), makeBead("br-2", "in_progress")];
      const stage = detectSessionStage(state, beads);
      expect(stage.currentBeadId).toBe("br-2");
    });

    it("falls back to in-progress bead when currentBeadId not set in state", () => {
      const state = makeState({ phase: "implementing" });
      const beads = [makeBead("br-1", "open"), makeBead("br-3", "in_progress")];
      const stage = detectSessionStage(state, beads);
      expect(stage.currentBeadId).toBe("br-3");
    });
  });

  describe("medium-confidence: inferred from on-disk beads", () => {
    it("infers implementing from in-progress beads when state is idle", () => {
      const state = makeState({ phase: "idle" });
      const beads = [makeBead("br-1", "in_progress"), makeBead("br-2", "open")];
      const stage = detectSessionStage(state, beads);

      expect(stage.phase).toBe("implementing");
      expect(stage.confidence).toBe("medium");
      expect(stage.currentBeadId).toBe("br-1");
      expect(stage.inferredFrom.some(s => s.includes("in-progress"))).toBe(true);
    });

    it("infers implementing from open beads + plan doc when state is idle", () => {
      const state = makeState({ phase: "idle", planDocument: "artifacts/plan.md" });
      const beads = [makeBead("br-1", "open"), makeBead("br-2", "open")];
      const stage = detectSessionStage(state, beads);

      expect(stage.phase).toBe("implementing");
      expect(stage.confidence).toBe("medium");
      expect(stage.inferredFrom.some(s => s.includes("plan document"))).toBe(true);
    });

    it("infers implementing from open beads alone when state is idle", () => {
      const state = makeState({ phase: "idle" });
      const beads = [makeBead("br-1", "open")];
      const stage = detectSessionStage(state, beads);

      expect(stage.phase).toBe("implementing");
      expect(stage.confidence).toBe("medium");
    });

    it("infers complete when all beads are closed and state is idle", () => {
      const state = makeState({ phase: "idle" });
      const beads = [makeBead("br-1", "closed"), makeBead("br-2", "closed")];
      const stage = detectSessionStage(state, beads);

      expect(stage.phase).toBe("complete");
      expect(stage.confidence).toBe("medium");
    });
  });

  describe("low-confidence: minimal signals", () => {
    it("infers discovering when only repoProfile present", () => {
      const state = makeState({
        phase: "idle",
        repoProfile: { name: "myrepo" } as any,
      });
      const stage = detectSessionStage(state, []);

      expect(stage.phase).toBe("discovering");
      expect(stage.confidence).toBe("low");
      expect(stage.inferredFrom.some(s => s.includes("repo profile"))).toBe(true);
    });

    it("infers awaiting_plan_approval when plan doc exists but no beads", () => {
      const state = makeState({ phase: "idle", planDocument: "plan.md" });
      const stage = detectSessionStage(state, []);

      expect(stage.phase).toBe("awaiting_plan_approval");
      expect(stage.confidence).toBe("low");
    });

    it("returns idle with low confidence when nothing is found", () => {
      const stage = detectSessionStage(makeState(), []);
      expect(stage.phase).toBe("idle");
      expect(stage.confidence).toBe("low");
    });
  });

  describe("bead counts", () => {
    it("counts open + in_progress as openBeadCount", () => {
      const state = makeState({ phase: "implementing" });
      const beads = [
        makeBead("br-1", "open"),
        makeBead("br-2", "in_progress"),
        makeBead("br-3", "closed"),
        makeBead("br-4", "deferred"),
      ];
      const stage = detectSessionStage(state, beads);
      expect(stage.openBeadCount).toBe(2);
      expect(stage.completedBeadCount).toBe(1);
      expect(stage.totalBeadCount).toBe(4);
    });
  });

  describe("resumePrompt content", () => {
    it("includes goal in implementing resume prompt", () => {
      const state = makeState({ phase: "implementing", selectedGoal: "Add dark mode" });
      const stage = detectSessionStage(state, [makeBead("br-1", "open")]);
      expect(stage.resumePrompt).toContain("Add dark mode");
      expect(stage.resumePrompt).toContain("orch_review");
    });

    it("includes plan path in awaiting_plan_approval resume prompt", () => {
      const state = makeState({ phase: "awaiting_plan_approval", planDocument: "artifacts/plan.md" });
      const stage = detectSessionStage(state, []);
      expect(stage.resumePrompt).toContain("artifacts/plan.md");
      expect(stage.resumePrompt).toContain("orch_approve_beads");
    });

    it("includes current bead in implementing prompt when in-progress", () => {
      const state = makeState({ phase: "implementing" });
      const beads = [makeBead("br-5", "in_progress"), makeBead("br-6", "open")];
      const stage = detectSessionStage(state, beads);
      expect(stage.resumePrompt).toContain("br-5");
    });

    it("mentions orch_select for awaiting_selection", () => {
      const state = makeState({ phase: "awaiting_selection" });
      const stage = detectSessionStage(state, []);
      expect(stage.resumePrompt).toContain("orch_select");
    });
  });
});

// ─── formatSessionContext ────────────────────────────────────

describe("formatSessionContext", () => {
  it("includes phase label and emoji", () => {
    const state = makeState({ phase: "implementing" });
    const stage = detectSessionStage(state, [makeBead("br-1", "open")]);
    const output = formatSessionContext(stage);
    expect(output).toContain("⚙️");
    expect(output).toContain("Implementing");
  });

  it("includes bead progress when available", () => {
    const state = makeState({ phase: "implementing" });
    const beads = [makeBead("br-1", "open"), makeBead("br-2", "closed")];
    const stage = detectSessionStage(state, beads);
    const output = formatSessionContext(stage);
    expect(output).toContain("1/2");
  });

  it("includes goal when present", () => {
    const state = makeState({ phase: "implementing", selectedGoal: "Build search feature" });
    const stage = detectSessionStage(state, []);
    const output = formatSessionContext(stage);
    expect(output).toContain("Build search feature");
  });

  it("includes plan document path", () => {
    const state = makeState({ phase: "awaiting_plan_approval", planDocument: "research/plan.md" });
    const stage = detectSessionStage(state, []);
    const output = formatSessionContext(stage);
    expect(output).toContain("research/plan.md");
  });

  it("includes current bead with title when provided", () => {
    const state = makeState({ phase: "implementing" });
    const beads = [makeBead("br-3", "in_progress")];
    const stage = detectSessionStage(state, beads);
    const output = formatSessionContext(stage, "Add user auth");
    expect(output).toContain("br-3");
    expect(output).toContain("Add user auth");
  });

  it("truncates long goal to 72 chars", () => {
    const longGoal = "A".repeat(100);
    const state = makeState({ phase: "implementing", selectedGoal: longGoal });
    const stage = detectSessionStage(state, []);
    const output = formatSessionContext(stage);
    expect(output).toContain("...");
    expect(output).not.toContain("A".repeat(80));
  });

  it("includes confidence signal", () => {
    const state = makeState({ phase: "implementing" });
    const stage = detectSessionStage(state, []);
    const output = formatSessionContext(stage);
    expect(output).toMatch(/confidence/);
  });
});

// ─── buildResumeLabel ────────────────────────────────────────

describe("buildResumeLabel", () => {
  it("starts with the 📂 emoji", () => {
    const state = makeState({ phase: "implementing" });
    const stage = detectSessionStage(state, [makeBead("br-1", "open")]);
    expect(buildResumeLabel(stage)).toMatch(/^📂/);
  });

  it("includes current bead id when in-progress", () => {
    const state = makeState({ phase: "implementing" });
    const beads = [makeBead("br-5", "in_progress"), makeBead("br-6", "open")];
    const stage = detectSessionStage(state, beads);
    const label = buildResumeLabel(stage);
    expect(label).toContain("br-5");
  });

  it("shows queued count for implementing phase", () => {
    const state = makeState({ phase: "implementing" });
    const beads = [
      makeBead("br-1", "in_progress"),
      makeBead("br-2", "open"),
      makeBead("br-3", "open"),
    ];
    const stage = detectSessionStage(state, beads);
    const label = buildResumeLabel(stage);
    expect(label).toContain("2 more queued");
  });

  it("shows approval info for awaiting_bead_approval", () => {
    const state = makeState({ phase: "awaiting_bead_approval" });
    const beads = [makeBead("br-1", "open"), makeBead("br-2", "open")];
    const stage = detectSessionStage(state, beads);
    const label = buildResumeLabel(stage);
    expect(label).toContain("awaiting approval");
  });

  it("includes plan doc for planning phase", () => {
    const state = makeState({ phase: "planning", planDocument: "artifacts/plan.md" });
    const stage = detectSessionStage(state, []);
    const label = buildResumeLabel(stage);
    expect(label).toContain("artifacts/plan.md");
  });

  it("returns safe fallback label for idle phase", () => {
    const stage = detectSessionStage(makeState(), []);
    const label = buildResumeLabel(stage);
    expect(label).toContain("📂");
    expect(label).toContain("no active session");
  });
});
