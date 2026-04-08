import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerCommands } from "./commands.js";
import { createInitialState, type OrchestratorContext, type OrchestratorPhase } from "./types.js";

const ceremonyCalls: Array<{ args: unknown[] }> = [];
const ceremonyBehavior = {
  result: { rendered: true, mode: "animated", frameCount: 3, durationMs: 10 } as const,
};
let activeEvents: string[] | undefined;

vi.mock("./opening-ceremony.js", () => ({
  runOpeningCeremony: vi.fn(async (...args: unknown[]) => {
    ceremonyCalls.push({ args });
    activeEvents?.push("ceremony");
    return ceremonyBehavior.result;
  }),
}));

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-orchestrator-startup-"));
}

function buildContext(events: string[], cwd: string) {
  return {
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionDir: () => cwd,
    },
    ui: {
      select: vi.fn(async () => {
        events.push("select");
        return undefined;
      }),
      notify: vi.fn((message: string) => {
        events.push(`notify:${message}`);
      }),
      confirm: vi.fn(async () => false),
      input: vi.fn(async () => undefined),
      onTerminalInput: vi.fn(() => () => {}),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      custom: vi.fn(),
      pasteToEditor: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(() => ""),
      editor: vi.fn(async () => undefined),
      setEditorComponent: vi.fn(),
    },
    modelRegistry: {},
    model: undefined,
    isIdle: () => true,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => "",
  } as any;
}

function buildOrchestrator(events: string[]): { oc: OrchestratorContext; commands: Map<string, any> } {
  const commands = new Map<string, any>();
  let orchestratorActive = false;

  const pi = {
    registerCommand: (name: string, options: any) => {
      commands.set(name, options);
    },
    sendUserMessage: vi.fn((content: string) => {
      events.push(`send:${content}`);
    }),
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  } as any;

  const oc: OrchestratorContext = {
    pi,
    state: createInitialState(),
    get orchestratorActive() {
      return orchestratorActive;
    },
    set orchestratorActive(value: boolean) {
      orchestratorActive = value;
    },
    version: "test",
    setPhase: (phase: OrchestratorPhase) => {
      events.push(`phase:${phase}`);
      oc.state.phase = phase;
    },
    persistState: () => {
      events.push("persist");
    },
    updateWidget: vi.fn(),
    runHitMeAgents: vi.fn(async () => ({ text: "", diff: "" })),
    agentMailRPC: vi.fn(async () => ({})),
    ensureAgentMailProject: vi.fn(async () => undefined),
  } as unknown as OrchestratorContext;

  registerCommands(oc);
  return { oc, commands };
}

describe("/orchestrate startup ceremony integration", () => {
  beforeEach(() => {
    ceremonyCalls.length = 0;
    activeEvents = undefined;
    ceremonyBehavior.result = { rendered: true, mode: "animated", frameCount: 3, durationMs: 10 };
    vi.restoreAllMocks();
  });

  it("runs the ceremony before the fresh-start follow-up message", async () => {
    const cwd = makeTempDir();
    const events: string[] = [];
    activeEvents = events;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { commands } = buildOrchestrator(events);
    const handler = commands.get("orchestrate")?.handler;

    await handler("", buildContext(events, cwd));

    expect(ceremonyCalls).toHaveLength(1);
    expect(events[0]).toBe("ceremony");
    expect(events.some((event) => event.startsWith("send:Start the orchestrator workflow"))).toBe(true);
  });

  it("runs the ceremony before showing the resume menu", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".beads"), { recursive: true });
    const events: string[] = [];
    activeEvents = events;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { oc, commands } = buildOrchestrator(events);
    oc.state.phase = "discovering";
    const handler = commands.get("orchestrate")?.handler;

    await handler("", buildContext(events, cwd));

    expect(ceremonyCalls).toHaveLength(1);
    expect(events[0]).toBe("ceremony");
    expect(events[1]).toBe("select");
  });

  it.each([
    { label: "static fallback", result: { rendered: true, mode: "static", frameCount: 1, durationMs: 0 } },
    { label: "skip", result: { rendered: false, mode: "skip", frameCount: 0, durationMs: 0 } },
    { label: "internal failure", result: { rendered: false, mode: "animated", frameCount: 0, durationMs: 0, error: "boom" } },
  ])("continues startup when the ceremony chooses $label", async ({ result }) => {
    const cwd = makeTempDir();
    const events: string[] = [];
    activeEvents = events;
    ceremonyBehavior.result = result as any;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { commands } = buildOrchestrator(events);
    const handler = commands.get("orchestrate")?.handler;

    await handler("", buildContext(events, cwd));

    expect(ceremonyCalls).toHaveLength(1);
    expect(events[0]).toBe("ceremony");
    expect(events.some((event) => event.startsWith("send:Start the orchestrator workflow"))).toBe(true);
  });
});
