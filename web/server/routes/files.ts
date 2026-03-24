import type { FastifyInstance } from "fastify";
import { PROJECT_ROOT } from "../index.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function filesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/files?path=<path> — read a file from the project directory
  app.get<{ Querystring: { path?: string } }>("/files", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) {
      return reply.status(400).send({ error: "path query parameter is required" });
    }

    // Resolve and validate path is within project root (prevent path traversal)
    const resolved = path.resolve(PROJECT_ROOT, filePath);
    const normalizedRoot = path.resolve(PROJECT_ROOT);
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      return reply.status(403).send({ error: "Path traversal not allowed" });
    }

    try {
      const content = await readFile(resolved, "utf-8");
      return { content, path: filePath };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return reply.status(404).send({ error: "File not found", path: filePath });
      }
      return reply.status(500).send({ error: "Failed to read file", detail: String(err) });
    }
  });
}
