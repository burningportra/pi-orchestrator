import type { FastifyInstance } from "fastify";
import { execCmd, PROJECT_ROOT } from "../index.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export default async function beadsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/beads — list all beads
  app.get("/beads", async (_req, _reply) => {
    const result = await execCmd("br", ["list", "--json"]);
    if (result.code !== 0) return [];
    try {
      const data = JSON.parse(result.stdout);
      return Array.isArray(data) ? data : data?.issues ?? [];
    } catch {
      return [];
    }
  });

  // GET /api/beads/ready — list ready (unblocked) beads
  app.get("/beads/ready", async (_req, _reply) => {
    const result = await execCmd("br", ["ready", "--json"]);
    if (result.code !== 0) return [];
    try {
      const data = JSON.parse(result.stdout);
      return Array.isArray(data) ? data : data?.issues ?? [];
    } catch {
      return [];
    }
  });

  // POST /api/beads/validate — validate all beads
  app.post("/beads/validate", async (_req, reply) => {
    try {
      const beadsDir = path.join(PROJECT_ROOT, ".beads");
      const entries = await readdir(beadsDir).catch(() => [] as string[]);
      const issues: string[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const content = await readFile(path.join(beadsDir, entry), "utf-8");

        // Check for shallow descriptions (less than 20 chars of actual content)
        const descMatch = content.match(/## Description\n([\s\S]*?)(?=\n##|$)/);
        if (descMatch && descMatch[1].trim().length < 20) {
          issues.push(`${entry}: shallow description`);
        }

        // Check for missing files section
        if (!content.includes("## Files") && !content.includes("## files")) {
          issues.push(`${entry}: missing files section`);
        }
      }

      // Check for dependency cycles via br
      const depsResult = await execCmd("br", ["list", "--json"]);
      let hasCycles = false;
      if (depsResult.code === 0) {
        try {
          const beads = JSON.parse(depsResult.stdout);
          // Simple cycle detection would require dep info; flag if bv reports cycles
          const insightsResult = await execCmd("bv", ["--robot-insights"]);
          if (insightsResult.code === 0) {
            const insights = JSON.parse(insightsResult.stdout);
            if (insights.Cycles && insights.Cycles.length > 0) {
              hasCycles = true;
              issues.push(`Dependency cycles detected: ${JSON.stringify(insights.Cycles)}`);
            }
          }
        } catch {
          // skip parse errors
        }
      }

      return { valid: issues.length === 0, issues, hasCycles };
    } catch (err) {
      return reply.status(500).send({ error: "Validation failed", detail: String(err) });
    }
  });

  // POST /api/beads/sync — flush sync
  app.post("/beads/sync", async (_req, reply) => {
    const result = await execCmd("br", ["sync", "--flush-only"]);
    if (result.code !== 0) {
      return reply.status(500).send({ error: "br sync failed", stderr: result.stderr });
    }
    return { ok: true, stdout: result.stdout };
  });

  // GET /api/beads/:id — show a single bead
  app.get<{ Params: { id: string } }>("/beads/:id", async (req, reply) => {
    const { id } = req.params;
    const result = await execCmd("br", ["show", id, "--json"]);
    if (result.code !== 0) {
      return reply.status(404).send({ error: `Bead ${id} not found`, stderr: result.stderr });
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return reply.status(500).send({ error: "Failed to parse br output", stdout: result.stdout });
    }
  });

  // GET /api/beads/:id/deps — list dependencies
  app.get<{ Params: { id: string } }>("/beads/:id/deps", async (req, reply) => {
    const { id } = req.params;
    const result = await execCmd("br", ["dep", "list", id]);
    if (result.code !== 0) {
      return reply.status(500).send({ error: "br dep list failed", stderr: result.stderr });
    }
    const deps = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return deps;
  });

  // POST /api/beads/:id/status — update bead status
  app.post<{ Params: { id: string }; Body: { status: string } }>(
    "/beads/:id/status",
    async (req, reply) => {
      const { id } = req.params;
      const { status } = req.body;
      if (!status) {
        return reply.status(400).send({ error: "status is required" });
      }
      const result = await execCmd("br", ["update", id, "--status", status]);
      if (result.code !== 0) {
        return reply.status(500).send({ error: "br update failed", stderr: result.stderr });
      }
      return { ok: true, id, status };
    },
  );

  // POST /api/beads — create a new bead
  app.post<{
    Body: {
      title: string;
      description: string;
      type?: string;
      priority?: string;
      parent?: string;
    };
  }>("/beads", async (req, reply) => {
    const { title, description, type, priority, parent } = req.body;
    if (!title || !description) {
      return reply.status(400).send({ error: "title and description are required" });
    }
    const args = ["create", "--title", title, "--description", description];
    if (type) args.push("--type", type);
    if (priority) args.push("--priority", String(priority));
    if (parent) args.push("--parent", parent);

    const result = await execCmd("br", args);
    if (result.code !== 0) {
      return reply.status(500).send({ error: "br create failed", stderr: result.stderr });
    }
    return { ok: true, stdout: result.stdout.trim() };
  });
}
