import type { FastifyInstance } from "fastify";
import { PROJECT_ROOT } from "../index.js";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export default async function stateRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/state — build summary state from .beads/ directory
  app.get("/state", async (_req, reply) => {
    try {
      const beadsDir = path.join(PROJECT_ROOT, ".beads");
      const s = await stat(beadsDir).catch(() => null);
      if (!s || !s.isDirectory()) {
        return {
          phase: "idle",
          totalBeads: 0,
          openBeads: 0,
          inProgressBeads: 0,
          closedBeads: 0,
          deferredBeads: 0,
        };
      }

      const entries = await readdir(beadsDir);
      const counts = { open: 0, in_progress: 0, closed: 0, deferred: 0 };
      let phase = "idle";

      for (const entry of entries) {
        if (!entry.endsWith(".md") && !entry.endsWith(".yaml") && !entry.endsWith(".json")) continue;
        try {
          const content = await readFile(path.join(beadsDir, entry), "utf-8");
          // Try to detect status from frontmatter or content
          const statusMatch = content.match(/status:\s*(\w+)/i);
          if (statusMatch) {
            const status = statusMatch[1].toLowerCase() as keyof typeof counts;
            if (status in counts) counts[status]++;
          }
        } catch {
          // skip unreadable
        }
      }

      const total = counts.open + counts.in_progress + counts.closed + counts.deferred;
      if (counts.in_progress > 0) phase = "implementing";
      else if (counts.open > 0 && counts.closed > 0) phase = "reviewing";
      else if (total > 0 && counts.closed === total) phase = "complete";
      else if (total > 0) phase = "planning";

      // Check for orchestrator state file
      const stateFile = path.join(PROJECT_ROOT, ".pi-orchestrator-state.json");
      let savedPhase: string | null = null;
      try {
        const stateContent = await readFile(stateFile, "utf-8");
        const parsed = JSON.parse(stateContent);
        if (parsed.phase) savedPhase = parsed.phase;
      } catch {
        // no state file
      }

      return {
        phase: savedPhase ?? phase,
        totalBeads: total,
        openBeads: counts.open,
        inProgressBeads: counts.in_progress,
        closedBeads: counts.closed,
        deferredBeads: counts.deferred,
      };
    } catch (err) {
      return reply.status(500).send({ error: "Failed to read state", detail: String(err) });
    }
  });

  // GET /api/state/phase — returns just the current phase
  app.get("/state/phase", async (_req, reply) => {
    try {
      // Try orchestrator state file first
      const stateFile = path.join(PROJECT_ROOT, ".pi-orchestrator-state.json");
      try {
        const content = await readFile(stateFile, "utf-8");
        const parsed = JSON.parse(content);
        if (parsed.phase) return { phase: parsed.phase };
      } catch {
        // fall through
      }

      // Fallback: infer from beads
      const beadsDir = path.join(PROJECT_ROOT, ".beads");
      const s = await stat(beadsDir).catch(() => null);
      if (!s || !s.isDirectory()) return { phase: "idle" };

      const entries = await readdir(beadsDir);
      if (entries.length === 0) return { phase: "idle" };
      return { phase: "planning" };
    } catch (err) {
      return reply.status(500).send({ error: "Failed to read phase", detail: String(err) });
    }
  });
}
