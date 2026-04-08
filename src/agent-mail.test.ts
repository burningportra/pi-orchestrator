import { describe, it, expect, vi } from "vitest";
import {
  reserveFileReservations,
  releaseFileReservations,
  checkFileReservations,
  renewFileReservations,
  forceReleaseFileReservation,
  sendMessage,
  replyMessage,
  acknowledgeMessage,
  fetchInbox,
  searchMessages,
  summarizeThread,
  whoisAgent,
  acquireBuildSlot,
  renewBuildSlot,
  releaseBuildSlot,
  healthCheck,
  type ExecFn,
} from "./agent-mail.js";

function mockExec(responses: Array<any>): ExecFn {
  const fn = vi.fn();
  responses.forEach((response) => fn.mockResolvedValueOnce(response));
  return fn as unknown as ExecFn;
}

describe("agent-mail reservation helpers", () => {
  it("reserves files with the existing file_reservation_paths tool", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { granted: ["src/agent-mail.ts"], conflicts: [] } } }), stderr: "" },
    ]);

    const result = await reserveFileReservations(exec, "/repo", "GreenCastle", ["src/agent-mail.ts"], "pi-orchestrator-dcu");

    expect(result.granted).toEqual(["src/agent-mail.ts"]);
    const [cmd, args] = (exec as any).mock.calls[0];
    expect(cmd).toBe("curl");
    const body = JSON.parse(args[7]);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("file_reservation_paths");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      agent_name: "GreenCastle",
      paths: ["src/agent-mail.ts"],
      ttl_seconds: 3600,
      exclusive: true,
      reason: "pi-orchestrator-dcu",
    });
  });

  it("releases specific files with release_file_reservations", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { released: 1 } } }), stderr: "" },
    ]);

    await releaseFileReservations(exec, "/repo", "GreenCastle", ["src/agent-mail.ts"]);

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("release_file_reservations");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      agent_name: "GreenCastle",
      paths: ["src/agent-mail.ts"],
    });
  });

  it("filters active overlapping reservations owned by other agents", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { project: { slug: "repo-slug" } } } }), stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify({
          result: {
            contents: [
              {
                text: JSON.stringify({
                  reservations: [
                    { id: 1, agent_name: "OtherAgent", path_pattern: "src/**", active: true },
                    { id: 2, agent_name: "GreenCastle", path_pattern: "src/agent-mail.ts", active: true },
                    { id: 3, agent_name: "OtherAgent", path_pattern: "docs/**", active: true },
                    { id: 4, agent_name: "OtherAgent", path_pattern: "src/old.ts", active: false },
                  ],
                }),
              },
            ],
          },
        }),
        stderr: "",
      },
    ]);

    const reservations = await checkFileReservations(exec, "/repo", ["src/agent-mail.ts"], "GreenCastle");

    expect(reservations).toEqual([
      { id: 1, agent_name: "OtherAgent", path_pattern: "src/**", active: true },
    ]);

    const [, ensureArgs] = (exec as any).mock.calls[0];
    expect(JSON.parse(ensureArgs[7]).params.name).toBe("ensure_project");

    const [, resourceArgs] = (exec as any).mock.calls[1];
    const resourceBody = JSON.parse(resourceArgs[7]);
    expect(resourceBody.method).toBe("resources/read");
    expect(resourceBody.params.uri).toBe("resource://file_reservations/repo-slug?active_only=true");
  });
});

describe("reservation lifecycle", () => {
  it("renews file reservations with extend_seconds", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { renewed: 2 } } }), stderr: "" },
    ]);

    await renewFileReservations(exec, "/repo", "GreenCastle", 3600);

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("renew_file_reservations");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      agent_name: "GreenCastle",
      extend_seconds: 3600,
    });
  });

  it("force-releases a stale reservation by ID", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { released: true } } }), stderr: "" },
    ]);

    await forceReleaseFileReservation(exec, "/repo", "GreenCastle", 42, "Agent crashed");

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("force_release_file_reservation");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      agent_name: "GreenCastle",
      file_reservation_id: 42,
      note: "Agent crashed",
      notify_previous: true,
    });
  });
});

describe("messaging", () => {
  it("sends a message with importance and ack_required", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { id: 1 } } }), stderr: "" },
    ]);

    await sendMessage(exec, "/repo", "GreenCastle", ["BlueLake"], "Review needed", "Please review auth", {
      threadId: "bd-123",
      importance: "high",
      ackRequired: true,
      cc: ["RedBear"],
    });

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("send_message");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      sender_name: "GreenCastle",
      to: ["BlueLake"],
      subject: "Review needed",
      body_md: "Please review auth",
      thread_id: "bd-123",
      importance: "high",
      ack_required: true,
      cc: ["RedBear"],
    });
  });

  it("replies to a message by ID", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { id: 2 } } }), stderr: "" },
    ]);

    await replyMessage(exec, "/repo", 1, "BlueLake", "Looks good!");

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("reply_message");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      message_id: 1,
      sender_name: "BlueLake",
      body_md: "Looks good!",
    });
  });

  it("acknowledges a message", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { acknowledged: true } } }), stderr: "" },
    ]);

    await acknowledgeMessage(exec, "/repo", "GreenCastle", 42);

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("acknowledge_message");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      agent_name: "GreenCastle",
      message_id: 42,
    });
  });

  it("fetches inbox with urgent_only filter", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { messages: [{ id: 1, subject: "Urgent!" }] } } }), stderr: "" },
    ]);

    const msgs = await fetchInbox(exec, "/repo", "GreenCastle", { urgentOnly: true });

    expect(msgs).toEqual([{ id: 1, subject: "Urgent!" }]);
    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.arguments).toMatchObject({
      urgent_only: true,
    });
  });

  it("searches messages via FTS5", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { messages: [{ id: 5, subject: "Auth fix" }] } } }), stderr: "" },
    ]);

    const msgs = await searchMessages(exec, "/repo", '"auth" AND error');

    expect(msgs).toEqual([{ id: 5, subject: "Auth fix" }]);
    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("search_messages");
    expect(body.params.arguments.query).toBe('"auth" AND error');
  });

  it("summarizes a thread", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { summary: "Thread about auth refactor" } } }), stderr: "" },
    ]);

    const result = await summarizeThread(exec, "/repo", "bd-123");

    expect(result.summary).toBe("Thread about auth refactor");
    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("summarize_thread");
    expect(body.params.arguments).toMatchObject({
      thread_id: "bd-123",
      include_examples: true,
      llm_mode: true,
    });
  });
});

describe("whois", () => {
  it("fetches agent profile with recent commits", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { name: "GreenCastle", program: "claude-code", commits: [] } } }), stderr: "" },
    ]);

    const result = await whoisAgent(exec, "/repo", "GreenCastle");

    expect(result.name).toBe("GreenCastle");
    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("whois");
    expect(body.params.arguments).toMatchObject({
      agent_name: "GreenCastle",
      include_recent_commits: true,
      commit_limit: 5,
    });
  });
});

describe("build slots", () => {
  it("acquires a build slot", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { acquired: true } } }), stderr: "" },
    ]);

    await acquireBuildSlot(exec, "/repo", "GreenCastle", "dev-server", 7200);

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("acquire_build_slot");
    expect(body.params.arguments).toMatchObject({
      project_key: "/repo",
      agent_name: "GreenCastle",
      slot: "dev-server",
      ttl_seconds: 7200,
      exclusive: true,
    });
  });

  it("renews a build slot", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { renewed: true } } }), stderr: "" },
    ]);

    await renewBuildSlot(exec, "/repo", "GreenCastle", "dev-server", 3600);

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("renew_build_slot");
    expect(body.params.arguments).toMatchObject({
      slot: "dev-server",
      extend_seconds: 3600,
    });
  });

  it("releases a build slot", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { released: true } } }), stderr: "" },
    ]);

    await releaseBuildSlot(exec, "/repo", "GreenCastle", "dev-server");

    const [, args] = (exec as any).mock.calls[0];
    const body = JSON.parse(args[7]);
    expect(body.params.name).toBe("release_build_slot");
    expect(body.params.arguments).toMatchObject({
      slot: "dev-server",
    });
  });
});

describe("health", () => {
  it("returns health status on success", async () => {
    const exec = mockExec([
      { code: 0, stdout: JSON.stringify({ result: { structuredContent: { status: "healthy" } } }), stderr: "" },
    ]);

    const result = await healthCheck(exec);
    expect(result).toEqual({ status: "healthy" });
  });

  it("returns null on failure", async () => {
    const exec = mockExec([
      { code: 1, stdout: "", stderr: "connection refused" },
    ]);

    const result = await healthCheck(exec);
    expect(result).toBeNull();
  });
});
