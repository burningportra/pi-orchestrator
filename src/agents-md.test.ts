import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureAgentMailSection, ensureCoreRules, scoreAgentsMd } from "./agents-md.js";

const SECTION_MARKER = "## MCP Agent Mail";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agents-md-test-"));
});

// cleanup after each test
import { afterEach } from "vitest";
afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("ensureAgentMailSection", () => {
  it("creates AGENTS.md with header, core rules, and section when file does not exist", async () => {
    await ensureAgentMailSection(tmpDir);

    const agentsMdPath = join(tmpDir, "AGENTS.md");
    expect(existsSync(agentsMdPath)).toBe(true);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("# AGENTS.md");
    expect(content).toContain(SECTION_MARKER);
    expect(content).toContain("## Core Rules");
    expect(content).toContain("Rule 0");
    expect(content).toContain("Rule 7");
  });

  it("appends section when AGENTS.md exists without the section", async () => {
    const agentsMdPath = join(tmpDir, "AGENTS.md");
    writeFileSync(agentsMdPath, "# AGENTS.md\n\nSome existing content.\n", "utf-8");

    await ensureAgentMailSection(tmpDir);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("Some existing content.");
    expect(content).toContain(SECTION_MARKER);
  });

  it("is idempotent — does not duplicate section if already present", async () => {
    const agentsMdPath = join(tmpDir, "AGENTS.md");
    writeFileSync(agentsMdPath, `# AGENTS.md\n\n${SECTION_MARKER}\n\nExisting agent mail section.\n`, "utf-8");

    await ensureAgentMailSection(tmpDir);
    await ensureAgentMailSection(tmpDir); // call twice

    const content = readFileSync(agentsMdPath, "utf-8");
    const occurrences = (content.match(new RegExp(SECTION_MARKER, "g")) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("preserves existing content when appending", async () => {
    const agentsMdPath = join(tmpDir, "AGENTS.md");
    const existingContent = "# AGENTS.md\n\n## Some other section\n\nContent here.\n";
    writeFileSync(agentsMdPath, existingContent, "utf-8");

    await ensureAgentMailSection(tmpDir);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("## Some other section");
    expect(content).toContain("Content here.");
    expect(content).toContain(SECTION_MARKER);
  });

  it("adds core rules to existing AGENTS.md that lacks them", async () => {
    const agentsMdPath = join(tmpDir, "AGENTS.md");
    writeFileSync(agentsMdPath, `# AGENTS.md\n\n${SECTION_MARKER}\n\nExisting.\n`, "utf-8");

    await ensureAgentMailSection(tmpDir);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("## Core Rules");
    expect(content).toContain("No Destructive Git");
  });
});

describe("ensureCoreRules", () => {
  it("creates AGENTS.md with core rules when file does not exist", async () => {
    await ensureCoreRules(tmpDir);

    const agentsMdPath = join(tmpDir, "AGENTS.md");
    expect(existsSync(agentsMdPath)).toBe(true);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("# AGENTS.md");
    expect(content).toContain("## Core Rules");
    expect(content).toContain("Override Prerogative");
    expect(content).toContain("No File Deletion");
    expect(content).toContain("No Destructive Git");
    expect(content).toContain("Branch Policy");
    expect(content).toContain("No Script-Based Code Changes");
    expect(content).toContain("No File Proliferation");
    expect(content).toContain("Verify After Changes");
    expect(content).toContain("Multi-Agent Awareness");
  });

  it("appends core rules to existing AGENTS.md", async () => {
    const agentsMdPath = join(tmpDir, "AGENTS.md");
    writeFileSync(agentsMdPath, "# AGENTS.md\n\nExisting content.\n", "utf-8");

    await ensureCoreRules(tmpDir);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("Existing content.");
    expect(content).toContain("## Core Rules");
  });

  it("is idempotent", async () => {
    await ensureCoreRules(tmpDir);
    await ensureCoreRules(tmpDir);

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    const occurrences = (content.match(/## Core Rules/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe("scoreAgentsMd", () => {
  it("returns score 0 when AGENTS.md does not exist", () => {
    const health = scoreAgentsMd(tmpDir);
    expect(health.score).toBe(0);
    expect(health.hasCoreRules).toBe(false);
    expect(health.missing).toContain("AGENTS.md file");
  });

  it("returns high score for complete AGENTS.md", async () => {
    await ensureAgentMailSection(tmpDir);

    const health = scoreAgentsMd(tmpDir);
    expect(health.score).toBeGreaterThanOrEqual(80);
    expect(health.hasCoreRules).toBe(true);
    expect(health.hasCoordination).toBe(true);
    expect(health.hasMemory).toBe(true);
    expect(health.missing).toHaveLength(0);
  });

  it("returns partial score for AGENTS.md with only core rules", async () => {
    await ensureCoreRules(tmpDir);

    const health = scoreAgentsMd(tmpDir);
    expect(health.score).toBeGreaterThan(0);
    expect(health.score).toBeLessThan(80);
    expect(health.hasCoreRules).toBe(true);
    expect(health.hasCoordination).toBe(false);
  });

  it("detects missing core rules", () => {
    const agentsMdPath = join(tmpDir, "AGENTS.md");
    writeFileSync(agentsMdPath, "# AGENTS.md\n\nJust a header.\n", "utf-8");

    const health = scoreAgentsMd(tmpDir);
    expect(health.hasCoreRules).toBe(false);
    expect(health.coreRuleCount).toBe(0);
  });
});
