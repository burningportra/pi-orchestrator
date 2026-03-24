import type { FastifyInstance } from "fastify";
import { PROJECT_ROOT } from "../index.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const PLAN_PATH = () =>
  path.join(PROJECT_ROOT, ".pi-orchestrator-artifacts", "plan.md");

export default async function planRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/plan — read plan document
  app.get("/plan", async () => {
    try {
      const content = await readFile(PLAN_PATH(), "utf-8");
      return { content };
    } catch {
      return null;
    }
  });

  // PUT /api/plan — write plan content
  app.put<{ Body: { content: string } }>("/plan", async (req, reply) => {
    const { content } = req.body;
    if (typeof content !== "string") {
      return reply.status(400).send({ error: "content is required" });
    }
    try {
      const dir = path.dirname(PLAN_PATH());
      await mkdir(dir, { recursive: true });
      await writeFile(PLAN_PATH(), content, "utf-8");
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({ error: "Failed to write plan", detail: String(err) });
    }
  });

  // POST /api/plan/refine — placeholder
  app.post("/plan/refine", async () => {
    return { ok: true, message: "plan refinement started" };
  });

  // GET /api/plan/audit — placeholder
  app.get("/plan/audit", async () => {
    return { issues: [], suggestions: [], score: null };
  });
}
