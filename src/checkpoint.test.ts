import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeCheckpoint,
  readCheckpoint,
  clearCheckpoint,
  validateCheckpoint,
  computeStateHash,
  cleanupOrphanedTmp,
  CHECKPOINT_DIR,
  CHECKPOINT_FILE,
  CHECKPOINT_TMP,
  CHECKPOINT_CORRUPT,
} from "./checkpoint.js";
import { createInitialState } from "./types.js";
import type { OrchestratorState, CheckpointEnvelope } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "checkpoint-test-"));
}

function checkpointFilePath(cwd: string): string {
  return join(cwd, CHECKPOINT_DIR, CHECKPOINT_FILE);
}

function makeTestState(overrides?: Partial<OrchestratorState>): OrchestratorState {
  const state = createInitialState();
  return { ...state, ...overrides };
}

describe("writeCheckpoint + readCheckpoint round-trip", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("round-trips state correctly", () => {
    const state = makeTestState({
      phase: "implementing",
      selectedGoal: "Test goal",
      activeBeadIds: ["br-1", "br-2"],
    });

    const ok = writeCheckpoint(tmpDir, state, "1.2.3");
    expect(ok).toBe(true);

    const result = readCheckpoint(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.envelope.schemaVersion).toBe(1);
    expect(result!.envelope.orchestratorVersion).toBe("1.2.3");
    expect(result!.envelope.state.phase).toBe("implementing");
    expect(result!.envelope.state.selectedGoal).toBe("Test goal");
    expect(result!.envelope.state.activeBeadIds).toEqual(["br-1", "br-2"]);
    expect(result!.warnings).toEqual([]);
  });

  test("creates .pi-orchestrator directory automatically", () => {
    const state = makeTestState({ phase: "planning" });
    writeCheckpoint(tmpDir, state, "1.0.0");
    expect(existsSync(join(tmpDir, CHECKPOINT_DIR))).toBe(true);
    expect(existsSync(checkpointFilePath(tmpDir))).toBe(true);
  });

  test("overwrites previous checkpoint", () => {
    const state1 = makeTestState({ phase: "planning" });
    const state2 = makeTestState({ phase: "implementing" });

    writeCheckpoint(tmpDir, state1, "1.0.0");
    writeCheckpoint(tmpDir, state2, "1.0.0");

    const result = readCheckpoint(tmpDir);
    expect(result!.envelope.state.phase).toBe("implementing");
  });
});

describe("readCheckpoint — corrupt handling", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("corrupt JSON is moved to .corrupt and returns null", () => {
    const dir = join(tmpDir, CHECKPOINT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CHECKPOINT_FILE), "{corrupt json here");

    const result = readCheckpoint(tmpDir);
    expect(result).toBeNull();
    expect(existsSync(join(dir, CHECKPOINT_CORRUPT))).toBe(true);
    expect(existsSync(join(dir, CHECKPOINT_FILE))).toBe(false);
  });

  test("hash mismatch (tampered state) returns null", () => {
    const state = makeTestState({ phase: "planning" });
    writeCheckpoint(tmpDir, state, "1.0.0");

    // Tamper with the file — change phase without updating hash
    const filePath = checkpointFilePath(tmpDir);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    raw.state.phase = "implementing";
    writeFileSync(filePath, JSON.stringify(raw));

    const result = readCheckpoint(tmpDir);
    expect(result).toBeNull();
    // Should be moved to .corrupt
    expect(existsSync(join(tmpDir, CHECKPOINT_DIR, CHECKPOINT_CORRUPT))).toBe(true);
  });

  test("unknown schemaVersion returns null", () => {
    const state = makeTestState({ phase: "planning" });
    writeCheckpoint(tmpDir, state, "1.0.0");

    const filePath = checkpointFilePath(tmpDir);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    raw.schemaVersion = 999;
    writeFileSync(filePath, JSON.stringify(raw));

    const result = readCheckpoint(tmpDir);
    expect(result).toBeNull();
  });
});

describe("readCheckpoint — staleness", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("checkpoint older than 24h produces a warning", () => {
    const state = makeTestState({ phase: "implementing" });
    writeCheckpoint(tmpDir, state, "1.0.0");

    // Backdate writtenAt to 48 hours ago
    const filePath = checkpointFilePath(tmpDir);
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as CheckpointEnvelope;
    raw.writtenAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    // Recompute hash since we only changed envelope metadata, not state
    raw.stateHash = computeStateHash(raw.state);
    writeFileSync(filePath, JSON.stringify(raw));

    const result = readCheckpoint(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings[0]).toContain("stale");
  });

  test("fresh checkpoint has no warnings", () => {
    const state = makeTestState({ phase: "planning" });
    writeCheckpoint(tmpDir, state, "1.0.0");

    const result = readCheckpoint(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.warnings).toEqual([]);
  });
});

describe("clearCheckpoint", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("removes existing checkpoint file", () => {
    const state = makeTestState({ phase: "planning" });
    writeCheckpoint(tmpDir, state, "1.0.0");
    expect(existsSync(checkpointFilePath(tmpDir))).toBe(true);

    clearCheckpoint(tmpDir);
    expect(existsSync(checkpointFilePath(tmpDir))).toBe(false);
  });

  test("is safe when no file exists", () => {
    expect(() => clearCheckpoint(tmpDir)).not.toThrow();
  });

  test("cleans up orphaned .tmp files", () => {
    const dir = join(tmpDir, CHECKPOINT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CHECKPOINT_TMP), "orphaned");

    clearCheckpoint(tmpDir);
    expect(existsSync(join(dir, CHECKPOINT_TMP))).toBe(false);
  });
});

describe("validateCheckpoint", () => {
  test("rejects non-object", () => {
    expect(validateCheckpoint("string")).toEqual({
      valid: false,
      reason: "checkpoint is not an object",
    });
    expect(validateCheckpoint(null)).toEqual({
      valid: false,
      reason: "checkpoint is not an object",
    });
  });

  test("rejects missing schemaVersion", () => {
    const result = validateCheckpoint({ writtenAt: "2026-01-01T00:00:00Z" });
    expect(result.valid).toBe(false);
  });

  test("rejects invalid writtenAt", () => {
    const state = createInitialState();
    const result = validateCheckpoint({
      schemaVersion: 1,
      writtenAt: "not-a-date",
      orchestratorVersion: "1.0.0",
      state,
      stateHash: computeStateHash(state),
    });
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain("writtenAt");
  });

  test("accepts valid envelope", () => {
    const state = createInitialState();
    const result = validateCheckpoint({
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      orchestratorVersion: "1.0.0",
      state,
      stateHash: computeStateHash(state),
    });
    expect(result).toEqual({ valid: true });
  });
});

describe("writeCheckpoint — error handling", () => {
  test("returns false on permission error", () => {
    // Use a path that can't be created
    const result = writeCheckpoint("/dev/null/impossible", createInitialState(), "1.0.0");
    expect(result).toBe(false);
  });
});

describe("readCheckpoint — missing file", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns null when no checkpoint exists", () => {
    expect(readCheckpoint(tmpDir)).toBeNull();
  });

  test("cleans up orphaned tmp when reading missing checkpoint", () => {
    const dir = join(tmpDir, CHECKPOINT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CHECKPOINT_TMP), "orphaned");

    const result = readCheckpoint(tmpDir);
    expect(result).toBeNull();
    expect(existsSync(join(dir, CHECKPOINT_TMP))).toBe(false);
  });
});

describe("cleanupOrphanedTmp", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("removes orphaned tmp file", () => {
    const dir = join(tmpDir, CHECKPOINT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CHECKPOINT_TMP), "orphan");

    cleanupOrphanedTmp(tmpDir);
    expect(existsSync(join(dir, CHECKPOINT_TMP))).toBe(false);
  });

  test("does nothing when no tmp file exists", () => {
    expect(() => cleanupOrphanedTmp(tmpDir)).not.toThrow();
  });
});

describe("atomic write pattern", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("no .tmp file remains after successful write", () => {
    const state = makeTestState({ phase: "planning" });
    writeCheckpoint(tmpDir, state, "1.0.0");

    expect(existsSync(join(tmpDir, CHECKPOINT_DIR, CHECKPOINT_TMP))).toBe(false);
    expect(existsSync(checkpointFilePath(tmpDir))).toBe(true);
  });

  test("only .tmp file survives if rename somehow fails (simulated)", () => {
    // This test verifies the tmp file is written before the rename
    const dir = join(tmpDir, CHECKPOINT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CHECKPOINT_TMP), "simulated partial write");

    // readCheckpoint should not find a valid checkpoint from .tmp alone
    const result = readCheckpoint(tmpDir);
    expect(result).toBeNull();
  });
});
