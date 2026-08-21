/**
 * Unit tests for the Worker-compatible Vercel Sandbox REST client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERCEL_CLEANUP_REQUEST_DEADLINE_MS,
  VERCEL_COMMAND_REQUEST_DEADLINE_MS,
  VERCEL_COMMAND_REQUEST_DEADLINE_HEADROOM_MS,
  VERCEL_SANDBOX_START_REQUEST_DEADLINE_MS,
  VERCEL_SNAPSHOT_REQUEST_DEADLINE_MS,
  VercelSandboxApiError,
  VercelSandboxClient,
} from "./client";
import { RequestDeadlineError } from "../../request-deadline";

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

function rejectWhenAborted(signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function stalledStreamResponse(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        if (signal.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
    { status: 200 }
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
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
  it("times out when response headers stall", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation((_url, init) =>
      rejectWhenAborted((init as RequestInit).signal as AbortSignal)
    );

    const request = createClient().createSandbox({ name: "sandbox-1" });
    const rejection = expect(request).rejects.toMatchObject({
      name: RequestDeadlineError.name,
      provider: "Vercel Sandbox",
      endpoint: "createSandbox",
      timeoutMs: VERCEL_SANDBOX_START_REQUEST_DEADLINE_MS,
    });
    await vi.advanceTimersByTimeAsync(VERCEL_SANDBOX_START_REQUEST_DEADLINE_MS);
    await rejection;
  });

  it("keeps the deadline armed while reading a command stream", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation((_url, init) =>
      Promise.resolve(stalledStreamResponse((init as RequestInit).signal as AbortSignal))
    );

    const request = createClient().runCommandAndWait({
      sessionId: "session-1",
      command: "bash",
    });
    const rejection = expect(request).rejects.toThrow(
      `Vercel Sandbox request timeout after ${VERCEL_COMMAND_REQUEST_DEADLINE_MS}ms (runCommandAndWait)`
    );
    await vi.advanceTimersByTimeAsync(VERCEL_COMMAND_REQUEST_DEADLINE_MS);
    await rejection;
  });

  it("allows an explicit command timeout before applying deadline headroom", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation((_url, init) =>
      Promise.resolve(stalledStreamResponse((init as RequestInit).signal as AbortSignal))
    );
    const commandTimeoutMs = VERCEL_COMMAND_REQUEST_DEADLINE_MS * 2;

    const request = createClient().runCommandAndWait({
      sessionId: "session-1",
      command: "bash",
      timeoutMs: commandTimeoutMs,
    });
    const rejection = expect(request).rejects.toThrow(
      `Vercel Sandbox request timeout after ${commandTimeoutMs + VERCEL_COMMAND_REQUEST_DEADLINE_HEADROOM_MS}ms (runCommandAndWait)`
    );
    await vi.advanceTimersByTimeAsync(commandTimeoutMs);
    expect(lastFetchInit().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(VERCEL_COMMAND_REQUEST_DEADLINE_HEADROOM_MS);
    await rejection;
  });

  it("preserves caller cancellation when it wins just before the Vercel deadline", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const callerReason = new DOMException("caller cancelled", "AbortError");
    fetchSpy.mockImplementation((_url, init) =>
      rejectWhenAborted((init as RequestInit).signal as AbortSignal)
    );

    const request = createClient().snapshotSession("session-1", { signal: caller.signal });
    await vi.advanceTimersByTimeAsync(VERCEL_SNAPSHOT_REQUEST_DEADLINE_MS - 1);
    caller.abort(callerReason);
    vi.advanceTimersByTime(1);

    await expect(request).rejects.toBe(callerReason);
    const providerSignal = lastFetchInit().signal as AbortSignal;
    expect(providerSignal).not.toBe(caller.signal);
    expect(providerSignal.reason).toBe(callerReason);
  });

  it("keeps the deadline armed while consuming a successful void response", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation((_url, init) =>
      Promise.resolve(stalledStreamResponse((init as RequestInit).signal as AbortSignal))
    );

    const request = createClient().deleteSnapshot("snapshot-1");
    const rejection = expect(request).rejects.toThrow(
      `Vercel Sandbox request timeout after ${VERCEL_CLEANUP_REQUEST_DEADLINE_MS}ms (deleteSnapshot)`
    );
    await vi.advanceTimersByTimeAsync(VERCEL_CLEANUP_REQUEST_DEADLINE_MS);
    await rejection;
  });

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
        resources: { vcpus: 4 },
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
      resources: { vcpus: 4 },
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

  it.each([
    ["createSandbox", () => createClient().createSandbox({ name: "sandbox-1" })],
    [
      "startCommand",
      () => createClient().startCommand({ sessionId: "session-1", command: "true" }),
    ],
    ["snapshotSession", () => createClient().snapshotSession("session-1")],
    ["listSnapshots", () => createClient().listSnapshots()],
  ])("rejects a valid JSON error envelope from %s", async (_endpoint, request) => {
    const responseBody = JSON.stringify({ error: { code: "provider_drift" } });
    fetchSpy.mockResolvedValue(new Response(responseBody, { status: 201 }));

    await expect(request()).rejects.toMatchObject({
      name: "VercelSandboxApiError",
      status: 201,
      responseText: responseBody,
    });
  });

  it("preserves status and logs an error for invalid JSON", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchSpy.mockResolvedValue(new Response("not-json", { status: 202 }));

    await expect(createClient().listSnapshots()).rejects.toMatchObject({
      message: expect.stringContaining("Vercel Sandbox API returned invalid JSON"),
      status: 202,
    });
    const requestLog = logSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((entry) => entry.event === "vercel_sandbox.request");
    expect(requestLog).toMatchObject({ http_status: 202, outcome: "error" });
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

  it("uploads a gzip archive into a sandbox filesystem", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
    const archive = new Uint8Array([1, 2, 3]);

    await createClient().writeFileArchive({
      sessionId: "session/1",
      archive,
      extractDir: "/tmp/open-inspect-runtime/packages",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://vercel.test/api/v2/sandboxes/sessions/session%2F1/fs/write?teamId=team-456",
      expect.objectContaining({
        method: "POST",
        body: archive,
      })
    );
    const headers = new Headers(lastFetchInit().headers);
    expect(headers.get("content-type")).toBe("application/gzip");
    expect(headers.get("x-cwd")).toBe("/tmp/open-inspect-runtime/packages");
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

  it("lists snapshots without requiring an undocumented region", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        snapshots: [
          {
            id: "snapshot-1",
            sourceSessionId: "session-1",
            status: "created",
            sizeBytes: 1024,
            createdAt: 456,
            updatedAt: 789,
          },
        ],
      })
    );

    const snapshots = await createClient().listSnapshots({
      name: "openinspect-base-abc123",
      limit: 20,
      sortOrder: "desc",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://vercel.test/api/v2/sandboxes/snapshots?project=project-123&name=openinspect-base-abc123&limit=20&sortOrder=desc&teamId=team-456",
      expect.objectContaining({ method: "GET" })
    );
    expect(snapshots[0]?.id).toBe("snapshot-1");
    expect(snapshots[0]?.region).toBeUndefined();
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
