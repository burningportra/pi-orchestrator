import type { FastifyInstance } from "fastify";
import { execCmd } from "../index.js";

export default async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/insights — run bv --robot-insights
  app.get("/insights", async (_req, reply) => {
    const result = await execCmd("bv", ["--robot-insights"]);
    if (result.code !== 0) {
      return null;
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  });

  // GET /api/next — run bv --robot-next
  app.get("/next", async (_req, reply) => {
    const result = await execCmd("bv", ["--robot-next"]);
    if (result.code !== 0) {
      return null;
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  });
}
