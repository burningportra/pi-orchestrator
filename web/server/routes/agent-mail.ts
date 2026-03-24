import type { FastifyInstance } from "fastify";

const AGENT_MAIL_URL = "http://127.0.0.1:8765/api";

async function agentMailRPC(method: string, args: Record<string, unknown>): Promise<unknown> {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: method, arguments: args },
  };
  const resp = await fetch(AGENT_MAIL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Agent-mail returned ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data;
}

export default async function agentMailRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/agent-mail/inbox — proxy to fetch_inbox
  app.get<{ Querystring: { agent_name?: string; limit?: string; human_key?: string } }>(
    "/agent-mail/inbox",
    async (req, reply) => {
      try {
        const { agent_name, limit, human_key } = req.query;
        const result = await agentMailRPC("fetch_inbox", {
          human_key: human_key ?? "",
          agent_name: agent_name ?? "",
          limit: limit ? Number(limit) : 20,
        });
        return result;
      } catch (err) {
        return reply.status(502).send({ error: "Agent-mail proxy failed", detail: String(err) });
      }
    },
  );

  // POST /api/agent-mail/send — proxy to send_message
  app.post<{
    Body: {
      human_key: string;
      sender_name: string;
      to: string[];
      subject: string;
      body: string;
      thread_id?: string;
      importance?: string;
    };
  }>("/agent-mail/send", async (req, reply) => {
    try {
      const result = await agentMailRPC("send_message", req.body);
      return result;
    } catch (err) {
      return reply.status(502).send({ error: "Agent-mail proxy failed", detail: String(err) });
    }
  });

  // POST /api/agent-mail/ack/:messageId — proxy to acknowledge_message
  app.post<{
    Params: { messageId: string };
    Body: { human_key: string; agent_name: string };
  }>("/agent-mail/ack/:messageId", async (req, reply) => {
    try {
      const { messageId } = req.params;
      const { human_key, agent_name } = req.body;
      const result = await agentMailRPC("acknowledge_message", {
        human_key,
        agent_name,
        message_id: messageId,
      });
      return result;
    } catch (err) {
      return reply.status(502).send({ error: "Agent-mail proxy failed", detail: String(err) });
    }
  });
}
