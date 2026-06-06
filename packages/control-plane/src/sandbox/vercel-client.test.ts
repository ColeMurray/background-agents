/**
 * Unit tests for the Worker-compatible Vercel Sandbox REST client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelSandboxApiError, VercelSandboxClient } from "./vercel-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status }
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createClient(): VercelSandboxClient {
  return new VercelSandboxClient({
    token: "vercel-token",
    projectId: "project-123",
    teamId: "team-456",
    apiBaseUrl: "https://vercel.test/api/",
  });
}

function lastFetchInit(): RequestInit {
  return fetchSpy.mock.calls.at(-1)?.[1] as RequestInit;
}

function lastFetchBody(): Record<string, unknown> {
  return JSON.parse(lastFetchInit().body as string) as Record<string, unknown>;
}

describe("VercelSandboxClient", () => {
  it("validates required configuration", () => {
    expect(() => new VercelSandboxClient({ token: "", projectId: "project" })).toThrow(
      "VERCEL_TOKEN"
    );
    expect(() => new VercelSandboxClient({ token: "token", projectId: "" })).toThrow(
      "VERCEL_PROJECT_ID"
    );
  });

  it("creates a sandbox with project id, team query, auth headers, and snapshot source", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        sandbox: {
          name: "sandbox-1",
          currentSessionId: "session-1",
          createdAt: 123,
          status: "running",
        },
        session: {
          id: "session-1",
          status: "running",
          createdAt: 123,
          cwd: "/workspace",
          timeout: 7200000,
        },
        routes: [{ port: 8080, subdomain: "code", url: "https://code.test" }],
      })
    );

    const result = await createClient().createSandbox(
      {
        name: "sandbox-1",
        runtime: "node24",
        timeoutMs: 7200000,
        ports: [8080],
        env: { FOO: "bar" },
        tags: { openinspect_framework: "open-inspect" },
        sourceSnapshotId: "snapshot-1",
      },
      {
        trace_id: "trace-1",
        request_id: "request-1",
        session_id: "session-logical",
        sandbox_id: "sandbox-logical",
      }
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://vercel.test/api/v2/sandboxes?teamId=team-456",
      expect.objectContaining({ method: "POST" })
    );
    const init = lastFetchInit();
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer vercel-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("x-trace-id")).toBe("trace-1");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("x-session-id")).toBe("session-logical");
    expect(headers.get("x-sandbox-id")).toBe("sandbox-logical");
    expect(lastFetchBody()).toEqual({
      projectId: "project-123",
      name: "sandbox-1",
      runtime: "node24",
      timeout: 7200000,
      ports: [8080],
      env: { FOO: "bar" },
      tags: { openinspect_framework: "open-inspect" },
      source: { type: "snapshot", snapshotId: "snapshot-1" },
    });
    expect(result.session.id).toBe("session-1");
  });

  it("starts a command and maps the command id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ command: { id: "cmd-1", exitCode: null } }));

    const result = await createClient().startCommand({
      sessionId: "session/1",
      command: "python3",
      args: ["-m", "sandbox_runtime.entrypoint"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      sudo: true,
      timeoutMs: 1000,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://vercel.test/api/v2/sandboxes/sessions/session%2F1/cmd?teamId=team-456",
      expect.objectContaining({ method: "POST" })
    );
    expect(lastFetchBody()).toEqual({
      command: "python3",
      args: ["-m", "sandbox_runtime.entrypoint"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      sudo: true,
      timeout: 1000,
    });
    expect(result).toEqual({ commandId: "cmd-1", exitCode: null });
  });

  it("parses NDJSON output from a waited command", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        [
          JSON.stringify({ stream: { data: "installing" } }),
          JSON.stringify({ command: { id: "cmd-1", exitCode: null } }),
          JSON.stringify({ command: { id: "cmd-1", exitCode: 0 } }),
          "",
        ].join("\n"),
        { status: 200 }
      )
    );

    const result = await createClient().runCommandAndWait({
      sessionId: "session-1",
      command: "bash",
      args: ["-lc", "true"],
    });

    expect(lastFetchBody()).toEqual({
      command: "bash",
      args: ["-lc", "true"],
      env: {},
      sudo: false,
      wait: true,
    });
    expect(result).toEqual({ commandId: "cmd-1", exitCode: 0 });
  });

  it("streams waited command output across chunk boundaries", async () => {
    fetchSpy.mockResolvedValue(
      streamResponse([
        `${JSON.stringify({ stream: { data: "installing" } })}\n${JSON.stringify({
          command: { id: "cmd-1", exitCode: null },
        }).slice(0, 20)}`,
        `${JSON.stringify({ command: { id: "cmd-1", exitCode: null } }).slice(20)}\n`,
        `${JSON.stringify({ stream: { data: "done" } })}\n`,
        `${JSON.stringify({ command: { id: "cmd-1", exitCode: 0 } })}\n`,
      ])
    );

    const result = await createClient().runCommandAndWait({
      sessionId: "session-1",
      command: "bash",
      args: ["-lc", "true"],
    });

    expect(result).toEqual({ commandId: "cmd-1", exitCode: 0 });
  });

  it("throws when a waited command stream never includes a command id", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ stream: { data: "only logs" } })));

    await expect(
      createClient().runCommandAndWait({ sessionId: "session-1", command: "bash" })
    ).rejects.toThrow(VercelSandboxApiError);
  });

  it("creates and deletes snapshots with the expected endpoints", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          snapshot: { id: "snapshot-1", status: "created", createdAt: 456 },
          session: {
            id: "session-1",
            status: "running",
            createdAt: 123,
            cwd: "/workspace",
            timeout: 7200000,
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const snapshot = await createClient().snapshotSession("session-1", { expirationMs: 0 });
    await createClient().deleteSnapshot("snapshot-1");

    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://vercel.test/api/v2/sandboxes/sessions/session-1/snapshot?teamId=team-456"
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({ expiration: 0 });
    expect(snapshot.snapshot.id).toBe("snapshot-1");
    expect(fetchSpy.mock.calls[1][0]).toBe(
      "https://vercel.test/api/v2/sandboxes/snapshots/snapshot-1?teamId=team-456"
    );
    expect(fetchSpy.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  it("stops a sandbox session with the expected endpoint", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    await createClient().stopSession("session-1", {
      trace_id: "trace-1",
      request_id: "request-1",
      session_id: "session-logical",
      sandbox_id: "sandbox-logical",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://vercel.test/api/v2/sandboxes/sessions/session-1/stop?teamId=team-456",
      expect.objectContaining({ method: "POST" })
    );
    const headers = lastFetchInit().headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer vercel-token");
    expect(headers.get("x-trace-id")).toBe("trace-1");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("x-session-id")).toBe("session-logical");
    expect(headers.get("x-sandbox-id")).toBe("sandbox-logical");
  });

  it("wraps non-OK responses in VercelSandboxApiError", async () => {
    fetchSpy.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    try {
      await createClient().deleteSnapshot("snapshot-1");
      expect.unreachable("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VercelSandboxApiError);
      expect((error as VercelSandboxApiError).status).toBe(401);
      expect((error as VercelSandboxApiError).responseText).toBe("unauthorized");
    }
  });
});
