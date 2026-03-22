import { describe, it, expect, vi } from "vitest";
import {
  reserveFileReservations,
  releaseFileReservations,
  checkFileReservations,
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
