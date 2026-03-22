import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { selectStrategy, detectCoordinationBackend, resetDetection, detectUbs, resetUbsCache } from "./coordination.js";

// ─── Mock fs ────────────────────────────────────────────────

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { existsSync } from "fs";
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;

// ─── selectStrategy ─────────────────────────────────────────

describe("selectStrategy", () => {
  it("returns beads+agentmail when both beads and agentMail are true", () => {
    expect(selectStrategy({ beads: true, agentMail: true, sophia: true })).toBe("beads+agentmail");
  });

  it("returns beads+agentmail ignoring sophia when beads+agentMail available", () => {
    expect(selectStrategy({ beads: true, agentMail: true, sophia: false })).toBe("beads+agentmail");
  });

  it("returns sophia when beads+agentMail unavailable but sophia is true", () => {
    expect(selectStrategy({ beads: false, agentMail: false, sophia: true })).toBe("sophia");
  });

  it("returns worktrees when nothing is available", () => {
    expect(selectStrategy({ beads: false, agentMail: false, sophia: false })).toBe("worktrees");
  });

  it("returns worktrees when only beads is available (not enough without agentMail)", () => {
    expect(selectStrategy({ beads: true, agentMail: false, sophia: false })).toBe("worktrees");
  });

  it("returns worktrees when only agentMail is available (not enough without beads)", () => {
    expect(selectStrategy({ beads: false, agentMail: true, sophia: false })).toBe("worktrees");
  });
});

// ─── detectCoordinationBackend ──────────────────────────────

describe("detectCoordinationBackend", () => {
  let mockPi: { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;

  beforeEach(() => {
    resetDetection();
    mockPi = { exec: vi.fn() } as unknown as { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;
    mockExistsSync.mockReset();
  });

  it("returns all true when all tools are available", async () => {
    mockExistsSync.mockReturnValue(true);
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") return { code: 0, stdout: '{"status":"ok"}', stderr: "" };
      if (cmd === "sophia" && args[0] === "--help") return { code: 0, stdout: "sophia help", stderr: "" };
      if (cmd === "sophia" && args[0] === "cr") return { code: 0, stdout: '{"ok":true}', stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(true);
    expect(result.agentMail).toBe(true);
    expect(result.sophia).toBe(true);
  });

  it("returns all false when no tools are available", async () => {
    mockExistsSync.mockReturnValue(false);
    mockPi.exec.mockImplementation(async () => {
      throw new Error("command not found");
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(false);
    expect(result.agentMail).toBe(false);
    expect(result.sophia).toBe(false);
  });

  it("returns partial availability: br yes, agent-mail no, sophia yes", async () => {
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") return { code: 1, stdout: "", stderr: "" }; // unreachable
      if (cmd === "sophia" && args[0] === "--help") return { code: 0, stdout: "sophia help", stderr: "" };
      if (cmd === "sophia" && args[0] === "cr") return { code: 0, stdout: '{"ok":true}', stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".beads")) return true;
      if (p.endsWith("SOPHIA.yaml")) return true;
      return false;
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(true);
    expect(result.agentMail).toBe(false);
    expect(result.sophia).toBe(true);
  });

  it("returns beads false when .beads/ directory is missing", async () => {
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") return { code: 0, stdout: '{"status":"ok"}', stderr: "" };
      if (cmd === "sophia" && args[0] === "--help") return { code: 0, stdout: "sophia help", stderr: "" };
      if (cmd === "sophia" && args[0] === "cr") return { code: 0, stdout: '{"ok":true}', stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".beads")) return false; // not initialized
      if (p.endsWith("SOPHIA.yaml")) return true;
      return false;
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(false);
    expect(result.sophia).toBe(true);
  });

  it("caches the result on second call", async () => {
    mockExistsSync.mockReturnValue(false);
    mockPi.exec.mockRejectedValue(new Error("not found"));

    await detectCoordinationBackend(mockPi, "/fake/cwd");
    const callCount = mockPi.exec.mock.calls.length;

    // Second call should use cache
    await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(mockPi.exec.mock.calls.length).toBe(callCount);
  });
});

// ─── detectUbs ──────────────────────────────────────────────

describe("detectUbs", () => {
  let mockPi: { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;

  beforeEach(() => {
    resetUbsCache();
    mockPi = { exec: vi.fn() } as unknown as { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;
  });

  it("returns true when ubs --help succeeds", async () => {
    mockPi.exec.mockResolvedValue({ code: 0, stdout: "ubs help", stderr: "" });
    expect(await detectUbs(mockPi, "/fake/cwd")).toBe(true);
  });

  it("returns false when ubs --help fails", async () => {
    mockPi.exec.mockRejectedValue(new Error("command not found"));
    expect(await detectUbs(mockPi, "/fake/cwd")).toBe(false);
  });
});
