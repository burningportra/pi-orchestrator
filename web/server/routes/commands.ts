import type { FastifyInstance } from "fastify";

export default async function commandsRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/commands/orchestrate — placeholder
  app.post("/commands/orchestrate", async () => {
    return { ok: true, message: "orchestration started" };
  });

  // POST /api/commands/stop — placeholder
  app.post("/commands/stop", async () => {
    return { ok: true, message: "stop requested" };
  });

  // POST /api/commands/approve — placeholder
  app.post("/commands/approve", async () => {
    return { ok: true, message: "approval recorded" };
  });

  // POST /api/commands/review — placeholder
  app.post<{
    Body: { beadId: string; summary: string; verdict: string; feedback: string };
  }>("/commands/review", async (req) => {
    const { beadId, summary, verdict, feedback } = req.body;
    return { ok: true, message: "review recorded", beadId, summary, verdict, feedback };
  });

  // POST /api/commands/gate/:action — placeholder
  app.post<{ Params: { action: string } }>("/commands/gate/:action", async (req) => {
    return { ok: true, message: `gate action '${req.params.action}' acknowledged` };
  });

  // POST /api/commands/drift-check — placeholder
  app.post("/commands/drift-check", async () => {
    return { ok: true, message: "drift check initiated" };
  });

  // POST /api/commands/rollback/:beadId — placeholder
  app.post<{ Params: { beadId: string } }>("/commands/rollback/:beadId", async (req) => {
    return { ok: true, message: `rollback requested for bead ${req.params.beadId}` };
  });
}
