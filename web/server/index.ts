import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
// WebSocket type from @fastify/websocket re-exports ws
type WebSocketLike = { readyState: number; send(data: string): void };

import beadsRoutes from "./routes/beads.js";
import stateRoutes from "./routes/state.js";
import commandsRoutes from "./routes/commands.js";
import insightsRoutes from "./routes/insights.js";
import planRoutes from "./routes/plan.js";
import agentMailRoutes from "./routes/agent-mail.js";
import sophiaRoutes from "./routes/sophia.js";
import filesRoutes from "./routes/files.js";

// ─── Shared helpers ──────────────────────────────────────────

const execFileAsync = promisify(execFileCb);

export const PROJECT_ROOT =
  process.env.PI_PROJECT_ROOT ?? path.resolve(process.cwd(), "..");

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function execCmd(
  cmd: string,
  args: string[],
  cwd: string = PROJECT_ROOT,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: e.code ?? 1,
    };
  }
}

// ─── WebSocket state ─────────────────────────────────────────

const wsClients = new Set<WebSocketLike>();

export function broadcast(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data });
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// ─── Polling loop ────────────────────────────────────────────

let lastBeadsHash = "";

async function pollBeads(): Promise<void> {
  try {
    const beadsDir = path.join(PROJECT_ROOT, ".beads");
    const s = await stat(beadsDir).catch(() => null);
    if (!s || !s.isDirectory()) return;

    const entries = await readdir(beadsDir);
    const hash = entries.sort().join(",");
    if (hash !== lastBeadsHash) {
      lastBeadsHash = hash;
      // Read each bead file to broadcast full state
      const beads: unknown[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".md") && !entry.endsWith(".yaml") && !entry.endsWith(".json")) continue;
        try {
          const content = await readFile(path.join(beadsDir, entry), "utf-8");
          beads.push({ file: entry, content });
        } catch {
          // skip unreadable files
        }
      }
      broadcast("beads:updated", { files: entries, beads });
    }
  } catch {
    // polling errors are non-fatal
  }
}

// ─── Server setup ────────────────────────────────────────────

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // WebSocket endpoint
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket) => {
      wsClients.add(socket);
      socket.on("close", () => wsClients.delete(socket));
    });
  });

  // API routes
  await app.register(beadsRoutes, { prefix: "/api" });
  await app.register(stateRoutes, { prefix: "/api" });
  await app.register(commandsRoutes, { prefix: "/api" });
  await app.register(insightsRoutes, { prefix: "/api" });
  await app.register(planRoutes, { prefix: "/api" });
  await app.register(agentMailRoutes, { prefix: "/api" });
  await app.register(sophiaRoutes, { prefix: "/api" });
  await app.register(filesRoutes, { prefix: "/api" });

  // Static file serving in production
  if (process.env.NODE_ENV === "production") {
    await app.register(fastifyStatic, {
      root: path.join(import.meta.dirname ?? ".", "..", "dist", "client"),
      prefix: "/",
    });
  }

  // Start polling loop
  const pollInterval = setInterval(pollBeads, 2000);
  app.addHook("onClose", () => clearInterval(pollInterval));

  const port = Number(process.env.PORT ?? 3847);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`pi-orchestrator web server listening on :${port}`);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
