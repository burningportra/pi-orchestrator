import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  resilientExec,
  brExec,
  brExecJson,
  isTransientBrError,
  type RawExecOutput,
} from "./cli-exec.js";

// ─── Mock pi factory ──────────────────────────────────────────

function successResult(stdout = "", stderr = ""): RawExecOutput {
  return { stdout, stderr, code: 0, killed: false };
}

function failResult(code: number, stderr = ""): RawExecOutput {
  return { stdout: "", stderr, code, killed: false };
}

function createMockPi(
  execImpl: (...args: any[]) => any,
): ExtensionAPI {
  return { exec: vi.fn(execImpl) } as unknown as ExtensionAPI;
}

// ─── isTransientBrError ───────────────────────────────────────

describe("isTransientBrError", () => {
  it("classifies timeout as transient", () => {
    expect(isTransientBrError(null, "", new Error("Command timed out"))).toBe(true);
  });

  it("classifies ETIMEDOUT as transient", () => {
    expect(isTransientBrError(null, "", new Error("connect ETIMEDOUT"))).toBe(true);
  });

  it("classifies signal kill (null exit) as transient", () => {
    expect(isTransientBrError(null, "", null)).toBe(true);
  });

  it("classifies exit 1 + empty stderr as transient (DB busy shape)", () => {
    expect(isTransientBrError(1, "", null)).toBe(true);
    expect(isTransientBrError(1, "  \n  ", null)).toBe(true);
  });

  it("classifies exit 1 + non-empty stderr as permanent", () => {
    expect(isTransientBrError(1, "error: bead not found", null)).toBe(false);
  });

  it("classifies exit > 1 as permanent", () => {
    expect(isTransientBrError(2, "", null)).toBe(false);
    expect(isTransientBrError(127, "", null)).toBe(false);
  });

  it("classifies ENOENT as permanent", () => {
    expect(isTransientBrError(null, "", new Error("spawn br ENOENT"))).toBe(false);
  });

  it("classifies EACCES as permanent", () => {
    expect(isTransientBrError(null, "", new Error("spawn br EACCES"))).toBe(false);
  });

  it("classifies killed error message as transient", () => {
    expect(isTransientBrError(null, "", new Error("Process was killed"))).toBe(true);
  });
});

// ─── resilientExec ────────────────────────────────────────────

describe("resilientExec", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok on success", async () => {
    const pi = createMockPi(async () => successResult("hello"));
    const result = await resilientExec(pi, "echo", ["hello"], { logWarnings: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stdout).toBe("hello");
  });

  it("retries on transient failure then succeeds", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      if (calls === 1) throw new Error("Command timed out");
      return successResult("ok");
    });
    const result = await resilientExec(pi, "br", ["list"], {
      retryDelayMs: 0,
      logWarnings: false,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does NOT retry permanent failures", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      return failResult(2, "fatal error");
    });
    const result = await resilientExec(pi, "br", ["bad"], {
      retryDelayMs: 0,
      maxRetries: 3,
      logWarnings: false,
      // Default isTransient won't classify exit code 2 as transient
      isTransient: (_code, _stderr, _err) => false,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("exhausts maxRetries on persistent transient failures", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      throw new Error("Command timed out");
    });
    const result = await resilientExec(pi, "br", ["list"], {
      maxRetries: 2,
      retryDelayMs: 0,
      logWarnings: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.attempts).toBe(3); // 1 initial + 2 retries
      expect(result.error.isTransient).toBe(true);
    }
    expect(calls).toBe(3);
  });

  it("respects maxRetries: 0 (no retries)", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      throw new Error("Command timed out");
    });
    const result = await resilientExec(pi, "br", ["--help"], {
      maxRetries: 0,
      retryDelayMs: 0,
      logWarnings: false,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("logs warning on failure when logWarnings is true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = createMockPi(async () => failResult(2, "some error"));
    await resilientExec(pi, "br", ["bad"], {
      maxRetries: 0,
      retryDelayMs: 0,
      logWarnings: true,
      isTransient: () => false,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[cli-exec]");
    expect(warnSpy.mock.calls[0][0]).toContain("permanent");
    warnSpy.mockRestore();
  });

  it("does NOT log when logWarnings is false", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = createMockPi(async () => failResult(2, "error"));
    await resilientExec(pi, "br", ["bad"], {
      maxRetries: 0,
      retryDelayMs: 0,
      logWarnings: false,
      isTransient: () => false,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("handles non-zero exit with custom transient check", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      if (calls <= 2) return failResult(1, "");
      return successResult("ok");
    });
    const result = await resilientExec(pi, "br", ["list"], {
      maxRetries: 2,
      retryDelayMs: 0,
      logWarnings: false,
      isTransient: (code, stderr) => code === 1 && stderr.trim() === "",
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });
});

// ─── brExec ───────────────────────────────────────────────────

describe("brExec", () => {
  it("prefixes command with 'br'", async () => {
    const execFn = vi.fn(async () => successResult("ok"));
    const pi = { exec: execFn } as unknown as ExtensionAPI;
    await brExec(pi, ["list", "--json"], { logWarnings: false });
    expect(execFn).toHaveBeenCalledWith("br", ["list", "--json"], expect.any(Object));
  });

  it("retries exit-1 empty-stderr (br transient)", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      if (calls === 1) return failResult(1, "");
      return successResult('{"ok":true}');
    });
    const result = await brExec(pi, ["list"], { retryDelayMs: 0, logWarnings: false });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry exit-2 (permanent)", async () => {
    let calls = 0;
    const pi = createMockPi(async () => {
      calls++;
      return failResult(2, "unknown flag");
    });
    const result = await brExec(pi, ["bad"], { maxRetries: 2, retryDelayMs: 0, logWarnings: false });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

// ─── brExecJson ───────────────────────────────────────────────

describe("brExecJson", () => {
  it("parses valid JSON stdout", async () => {
    const pi = createMockPi(async () => successResult('{"id":"br-1","title":"Test"}'));
    const result = await brExecJson<{ id: string; title: string }>(pi, ["show", "br-1", "--json"], {
      logWarnings: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("br-1");
      expect(result.value.title).toBe("Test");
    }
  });

  it("returns structured error on invalid JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = createMockPi(async () => successResult("not json at all"));
    const result = await brExecJson(pi, ["show", "br-1", "--json"], {
      logWarnings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isTransient).toBe(false);
      expect(result.error.stderr).toContain("JSON parse error");
      expect(result.error.exitCode).toBe(0); // command succeeded, parse failed
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("JSON parse failure");
    warnSpy.mockRestore();
  });

  it("propagates exec failure without attempting JSON parse", async () => {
    const pi = createMockPi(async () => failResult(2, "not found"));
    const result = await brExecJson(pi, ["show", "bad"], { maxRetries: 0, retryDelayMs: 0, logWarnings: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(2);
      // stderr should be the exec stderr, not a JSON parse error
      expect(result.error.stderr).toBe("not found");
    }
  });

  it("does not log JSON parse warning when logWarnings is false", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = createMockPi(async () => successResult("bad json"));
    await brExecJson(pi, ["list"], { logWarnings: false });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
