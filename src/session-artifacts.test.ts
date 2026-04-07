import { describe, expect, it } from "vitest";
import { sessionArtifactPath, sessionArtifactRoot } from "./session-artifacts.js";

function makeCtx(overrides?: Partial<any>) {
  return {
    cwd: "/repo",
    sessionManager: {
      getSessionDir: () => "/sessions-root/project",
      getSessionId: () => "session-123",
      getSessionFile: () => "/sessions-root/project/2026-04-07T00-00-00.jsonl",
      ...overrides?.sessionManager,
    },
    ...overrides,
  } as any;
}

describe("sessionArtifactRoot", () => {
  it("uses sessionDir and sessionId instead of deriving from the session jsonl path", () => {
    const root = sessionArtifactRoot(makeCtx());
    expect(root).toBe("/sessions-root/project/artifacts/session-123");
    expect(root).not.toContain(".jsonl/artifacts");
  });

  it("falls back to cwd when no session metadata exists", () => {
    const root = sessionArtifactRoot(makeCtx({
      sessionManager: {
        getSessionDir: () => undefined,
        getSessionId: () => undefined,
        getSessionFile: () => undefined,
      },
    }));
    expect(root).toBe("/repo/.pi-orchestrator-artifacts");
  });
});

describe("sessionArtifactPath", () => {
  it("resolves nested artifact paths under the artifact root", () => {
    const filePath = sessionArtifactPath(makeCtx(), "plans/my-plan.md");
    expect(filePath).toBe("/sessions-root/project/artifacts/session-123/plans/my-plan.md");
  });
});
