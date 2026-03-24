import type { FastifyInstance } from "fastify";
import { execCmd } from "../index.js";

export default async function sophiaRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/sophia/crs — list sophia CRs
  app.get("/sophia/crs", async (_req, reply) => {
    const result = await execCmd("sophia", ["cr", "list", "--json"]);
    if (result.code !== 0) {
      return reply.status(500).send({ error: "sophia cr list failed", stderr: result.stderr });
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return reply.status(500).send({ error: "Failed to parse sophia output", stdout: result.stdout });
    }
  });

  // GET /api/sophia/crs/:id — show a single sophia CR
  app.get<{ Params: { id: string } }>("/sophia/crs/:id", async (req, reply) => {
    const { id } = req.params;
    const result = await execCmd("sophia", ["cr", "show", id, "--json"]);
    if (result.code !== 0) {
      return reply.status(404).send({ error: `Sophia CR ${id} not found`, stderr: result.stderr });
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return reply.status(500).send({ error: "Failed to parse sophia output", stdout: result.stdout });
    }
  });
}
