import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { dirname, join, resolve } from "path";

type ArtifactContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

export function sessionArtifactRoot(ctx: ArtifactContext): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();

  if (sessionDir && sessionId) {
    return join(sessionDir, "artifacts", sessionId);
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile && sessionId) {
    return join(dirname(sessionFile), "..", "artifacts", sessionId);
  }

  return join(ctx.cwd, ".pi-orchestrator-artifacts");
}

export function sessionArtifactPath(ctx: ArtifactContext, name: string): string {
  return resolve(sessionArtifactRoot(ctx), name);
}
