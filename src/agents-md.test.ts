import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureAgentMailSection } from "./agents-md.js";

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
  it("creates AGENTS.md with header and section when file does not exist", async () => {
    await ensureAgentMailSection(tmpDir);

    const agentsMdPath = join(tmpDir, "AGENTS.md");
    expect(existsSync(agentsMdPath)).toBe(true);

    const content = readFileSync(agentsMdPath, "utf-8");
    expect(content).toContain("# AGENTS.md");
    expect(content).toContain(SECTION_MARKER);
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
});
