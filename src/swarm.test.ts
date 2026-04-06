import { describe, it, expect } from "vitest";
import {
  recommendComposition,
  generateAgentConfigs,
  formatSwarmStatus,
  formatLaunchInstructions,
} from "./swarm.js";
import type { Bead } from "./types.js";
import type { AgentStatus } from "./tender.js";
import { SWARM_STAGGER_DELAY_MS } from "./prompts.js";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "b-1", title: "Test", description: "desc",
    status: "open", priority: 2, type: "task", labels: [],
    ...overrides,
  };
}

function makeAgentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    worktreePath: "/tmp/repo",
    stepIndex: 0,
    health: "active",
    lastActivity: Date.now(),
    changedFiles: [],
    ...overrides,
  };
}

// ─── recommendComposition ───────────────────────────────────

describe("recommendComposition", () => {
  it("recommends 10 agents for 400+ beads", () => {
    const comp = recommendComposition(500);
    expect(comp.total).toBe(10);
    expect(comp.models.reduce((s, m) => s + m.count, 0)).toBe(10);
  });

  it("recommends 8 agents for 100-399 beads", () => {
    const comp = recommendComposition(200);
    expect(comp.total).toBe(8);
  });

  it("recommends 3 agents for <100 beads", () => {
    const comp = recommendComposition(50);
    expect(comp.total).toBe(3);
  });

  it("includes diverse models from centralized constants", () => {
    const comp = recommendComposition(100);
    const models = comp.models.map((m) => m.model);
    // Should use the centralized SWARM_MODELS constants
    expect(models).toContain("anthropic/claude-opus-4-6");
    expect(models).toContain("openai-codex/gpt-5.4");
    expect(models).toContain("anthropic/claude-haiku-4-5");
  });

  it("includes rationale with bead count", () => {
    const comp = recommendComposition(42);
    expect(comp.rationale).toContain("42");
  });

  it("handles 0 beads", () => {
    const comp = recommendComposition(0);
    expect(comp.total).toBe(3);
  });
});

// ─── generateAgentConfigs ───────────────────────────────────

describe("generateAgentConfigs", () => {
  const composition = recommendComposition(50);

  it("generates correct number of configs", () => {
    const configs = generateAgentConfigs(5, "/tmp/repo", composition);
    expect(configs).toHaveLength(5);
  });

  it("assigns staggered delays", () => {
    const configs = generateAgentConfigs(3, "/tmp/repo", composition);
    expect(configs[0].delayMs).toBe(0);
    expect(configs[1].delayMs).toBe(SWARM_STAGGER_DELAY_MS);
    expect(configs[2].delayMs).toBe(SWARM_STAGGER_DELAY_MS * 2);
  });

  it("distributes models across agents", () => {
    const configs = generateAgentConfigs(6, "/tmp/repo", composition);
    const models = configs.map((c) => c.model);
    // Should have a mix of models
    const unique = new Set(models);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("includes marching orders in task", () => {
    const configs = generateAgentConfigs(1, "/tmp/repo", composition);
    expect(configs[0].task).toContain("AGENTS.md");
    expect(configs[0].task).toContain("bv --robot-triage");
  });

  it("sets correct cwd", () => {
    const configs = generateAgentConfigs(2, "/my/project", composition);
    expect(configs[0].cwd).toBe("/my/project");
    expect(configs[1].cwd).toBe("/my/project");
  });

  it("generates unique names", () => {
    const configs = generateAgentConfigs(5, "/tmp", composition);
    const names = configs.map((c) => c.name);
    expect(new Set(names).size).toBe(5);
  });
});

// ─── formatSwarmStatus ──────────────────────────────────────

describe("formatSwarmStatus", () => {
  it("shows status for no agents", () => {
    expect(formatSwarmStatus([], [])).toContain("No swarm agents");
  });

  it("shows active/idle/stuck counts", () => {
    const agents: AgentStatus[] = [
      makeAgentStatus({ stepIndex: 0, health: "active" }),
      makeAgentStatus({ stepIndex: 1, health: "idle" }),
      makeAgentStatus({ stepIndex: 2, health: "stuck" }),
    ];
    const formatted = formatSwarmStatus(agents, []);
    expect(formatted).toContain("Active: 1");
    expect(formatted).toContain("Idle: 1");
    expect(formatted).toContain("Stuck: 1");
  });

  it("shows bead progress", () => {
    const beads: Bead[] = [
      makeBead({ id: "b-1", status: "open" }),
      makeBead({ id: "b-2", status: "in_progress" }),
      makeBead({ id: "b-3", status: "closed" }),
      makeBead({ id: "b-4", status: "closed" }),
    ];
    const formatted = formatSwarmStatus([makeAgentStatus()], beads);
    expect(formatted).toContain("1 open");
    expect(formatted).toContain("1 in progress");
    expect(formatted).toContain("2 closed");
  });

  it("shows 🟢 when all agents active", () => {
    const agents = [makeAgentStatus({ health: "active" })];
    expect(formatSwarmStatus(agents, [])).toContain("🟢");
  });

  it("shows 🔴 when stuck agents exist", () => {
    const agents = [makeAgentStatus({ health: "stuck" })];
    expect(formatSwarmStatus(agents, [])).toContain("🔴");
  });

  it("lists stuck agents", () => {
    const agents = [
      makeAgentStatus({ stepIndex: 3, health: "stuck" }),
      makeAgentStatus({ stepIndex: 7, health: "stuck" }),
    ];
    const formatted = formatSwarmStatus(agents, []);
    expect(formatted).toContain("#3");
    expect(formatted).toContain("#7");
  });

  it("detects file conflicts", () => {
    const agents: AgentStatus[] = [
      makeAgentStatus({ stepIndex: 0, changedFiles: ["src/shared.ts", "src/a.ts"] }),
      makeAgentStatus({ stepIndex: 1, changedFiles: ["src/shared.ts", "src/b.ts"] }),
    ];
    const formatted = formatSwarmStatus(agents, []);
    expect(formatted).toContain("File conflicts");
    expect(formatted).toContain("src/shared.ts");
    expect(formatted).toContain("#0");
    expect(formatted).toContain("#1");
  });

  it("limits conflict display to 5", () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`);
    const agents: AgentStatus[] = [
      makeAgentStatus({ stepIndex: 0, changedFiles: files }),
      makeAgentStatus({ stepIndex: 1, changedFiles: files }),
    ];
    const formatted = formatSwarmStatus(agents, []);
    expect(formatted).toContain("3 more");
  });
});

// ─── formatLaunchInstructions ───────────────────────────────

describe("formatLaunchInstructions", () => {
  const configs = generateAgentConfigs(3, "/tmp/repo", recommendComposition(50));

  it("includes all agent configs", () => {
    const instructions = formatLaunchInstructions(configs);
    expect(instructions).toContain("swarm-1");
    expect(instructions).toContain("swarm-2");
    expect(instructions).toContain("swarm-3");
  });

  it("includes model information", () => {
    const instructions = formatLaunchInstructions(configs);
    expect(instructions).toContain("Model:");
  });

  it("includes delay information", () => {
    const instructions = formatLaunchInstructions(configs);
    expect(instructions).toContain("Delay:");
    expect(instructions).toContain("0s");
  });

  it("includes JSON configs for subagent tool", () => {
    const instructions = formatLaunchInstructions(configs);
    expect(instructions).toContain('"name"');
    expect(instructions).toContain('"task"');
    expect(instructions).toContain('"cwd"');
  });

  it("includes important notes", () => {
    const instructions = formatLaunchInstructions(configs);
    expect(instructions).toContain("thundering herd");
    expect(instructions).toContain("bv --robot-next");
    expect(instructions).toContain("Agent Mail");
    expect(instructions).toContain("/orchestrate-swarm-status");
    expect(instructions).toContain("/orchestrate-swarm-stop");
  });

  it("includes stagger delay value", () => {
    const instructions = formatLaunchInstructions(configs);
    expect(instructions).toContain(`${SWARM_STAGGER_DELAY_MS / 1000}s`);
  });
});
