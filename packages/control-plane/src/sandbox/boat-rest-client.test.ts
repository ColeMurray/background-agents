import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoatApiError,
  BoatConflictError,
  BoatNotFoundError,
  BoatRestClient,
  type BoatRestConfig,
} from "./boat-rest-client";

const config: BoatRestConfig = {
  apiUrl: "https://boat.test/api/v1///",
  apiKey: "boat-secret-key",
  org: "team-openinspect",
  baseSnapshot: "oi-base",
};

const sandbox = {
  id: "bx_23456789",
  name: "Sandbox",
  state: "ready",
  type: "small",
  archiveAfter: "2030-01-02T03:04:05.000Z",
  snapshotAvailable: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => vi.restoreAllMocks());

describe("BoatRestClient", () => {
  it("validates configuration and the create-only base snapshot", () => {
    expect(() => new BoatRestClient({ apiKey: "" })).toThrow("apiKey");
    expect(() => new BoatRestClient({ apiKey: "key", apiUrl: "http://boat.test" })).toThrow(
      "must use HTTPS"
    );
    expect(
      () => new BoatRestClient({ apiKey: "key", apiUrl: "http://localhost:8787" })
    ).not.toThrow();
    expect(() => new BoatRestClient({ apiKey: "key" }).requireBaseSnapshot()).toThrow(
      "BOAT_BASE_SNAPSHOT"
    );
    expect(new BoatRestClient(config).requireBaseSnapshot()).toBe("oi-base");
  });

  it("creates a no-env sandbox with idempotency and organization scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: 7200, sandbox },
        202
      )
    );
    const client = new BoatRestClient(config);

    await expect(
      client.createSandbox({
        type: "small",
        ttlSeconds: 7200,
        env: { SECRET: "do-not-log" },
        from: "oi-base",
        idempotencyKey: "oi-sandbox-id",
      })
    ).resolves.toMatchObject({ id: "bx_23456789" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://boat.test/api/v1/sandboxes");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer boat-secret-key",
      "Idempotency-Key": "oi-sandbox-id",
      "X-Boat-Org": "team-openinspect",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      type: "small",
      ttlSeconds: 7200,
      env: { SECRET: "do-not-log" },
      noEnv: true,
      from: "oi-base",
      org: "team-openinspect",
    });
  });

  it("parses the observed stopped state even though the public OpenAPI omits it", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ ok: true, type: "sandbox.info", sandbox: { ...sandbox, state: "stopped" } })
    );
    await expect(new BoatRestClient(config).getSandbox(sandbox.id)).resolves.toMatchObject({
      state: "stopped",
    });
  });

  it("resumes without replacing environment variables and stops without force", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ ok: true, type: "sandbox.resuming", id: sandbox.id, status: "resuming" }, 202)
    );
    const client = new BoatRestClient(config);
    await client.resumeSandbox(sandbox.id, { type: "large", ttlSeconds: 3600 });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      type: "large",
      ttlSeconds: 3600,
    });

    fetchSpy.mockResolvedValue(
      jsonResponse({ ok: true, type: "sandbox.stopping", id: sandbox.id, status: "stopping" }, 202)
    );
    await client.stopSandbox(sandbox.id);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ force: false });
  });

  it("starts only a fixed detached command", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        ok: true,
        type: "command.started",
        success: true,
        processId: 42,
        pid: 42,
        command: "/home/user/openinspect/start-runtime",
        startedAt: "2030-01-01T00:00:00Z",
      })
    );
    await new BoatRestClient(config).startDetachedCommand(
      sandbox.id,
      "/home/user/openinspect/start-runtime"
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      command: "/home/user/openinspect/start-runtime",
      detached: true,
    });
  });

  it("rejects a command response that was not accepted and parses command status", async () => {
    const client = new BoatRestClient(config);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        ok: true,
        type: "command.started",
        success: false,
        processId: 42,
        pid: 42,
        command: "/home/user/openinspect/start-runtime",
        startedAt: "2030-01-01T00:00:00Z",
      })
    );
    await expect(
      client.startDetachedCommand(sandbox.id, "/home/user/openinspect/start-runtime")
    ).rejects.toMatchObject({ code: "command_rejected" });

    fetchSpy.mockResolvedValue(
      jsonResponse({
        ok: true,
        type: "command.status",
        success: true,
        processId: 42,
        status: "running",
        running: true,
        exitCode: null,
      })
    );
    await expect(client.getCommandStatus(sandbox.id, 42)).resolves.toMatchObject({
      status: "running",
      running: true,
    });
  });

  it("creates private host routes and writes tokenized tunnel metadata as file content", async () => {
    const client = new BoatRestClient(config);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        ok: true,
        type: "port.hosted",
        success: true,
        port: 3000,
        url: "https://sandbox-3000.on.boat.dev?_token=secret",
        isProtected: true,
        access: "private",
      })
    );
    await expect(client.hostPort(sandbox.id, 3000)).resolves.toMatchObject({ access: "private" });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ port: 3000, public: false });

    fetchSpy.mockResolvedValue(
      jsonResponse({
        ok: true,
        type: "file.written",
        success: true,
        path: "/home/user/openinspect/workspace/.tunnels.env",
        encoding: "utf8",
        size: 80,
      })
    );
    await client.writeTextFile(
      sandbox.id,
      "/home/user/openinspect/workspace/.tunnels.env",
      "PORT_3000=https://sandbox-3000.on.boat.dev?_token=secret\n"
    );
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toMatchObject({
      encoding: "utf8",
      content: expect.stringContaining("_token=secret"),
    });
  });

  it("rejects public, unprotected, mismatched, and plaintext host routes", async () => {
    const client = new BoatRestClient(config);
    for (const response of [
      {
        success: true,
        port: 3000,
        url: "https://boat.test",
        isProtected: false,
        access: "private",
      },
      { success: true, port: 3000, url: "https://boat.test", isProtected: true, access: "public" },
      { success: true, port: 3001, url: "https://boat.test", isProtected: true, access: "private" },
      { success: true, port: 3000, url: "http://boat.test", isProtected: true, access: "private" },
    ]) {
      fetchSpy.mockResolvedValue(jsonResponse({ ok: true, type: "port.hosted", ...response }));
      await expect(client.hostPort(sandbox.id, 3000)).rejects.toMatchObject({
        code: "unsafe_host_route",
      });
    }
  });

  it("confirms destructive deletion and returns its asynchronous operation", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          ok: true,
          type: "sandbox.deleting",
          operation: {
            id: "bdop_0123456789abcdef0123456789abcdef",
            kind: "sandbox",
            targetId: sandbox.id,
            status: "blocked",
            attemptCount: 1,
            requestedAt: "2030-01-01T00:00:00Z",
            completedAt: null,
          },
        },
        202
      )
    );
    const operation = await new BoatRestClient(config).deleteSandbox(sandbox.id);
    expect(operation.status).toBe("blocked");
    expect(fetchSpy.mock.calls[0][1].headers["X-Ascii-Confirm-Delete"]).toBe(sandbox.id);
  });

  it("returns typed, body-redacted provider errors", async () => {
    const client = new BoatRestClient(config);
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          code: "invalid_env",
          message: "echoed do-not-log and boat-secret-key",
          status: 400,
          requestId: "req-safe",
        },
        400
      )
    );
    let error: BoatApiError | undefined;
    try {
      await client.getSandbox("x");
    } catch (value) {
      error = value as BoatApiError;
    }
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(BoatApiError);
    expect(error!.message).toContain("invalid_env");
    expect(error!.message).toContain("req-safe");
    expect(error!.message).not.toContain("do-not-log");
    expect(error!.message).not.toContain("boat-secret-key");
  });

  it("classifies not-found and conflict responses", async () => {
    const client = new BoatRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ code: "not_found", requestId: "req-1" }, 404));
    await expect(client.getSandbox("x")).rejects.toThrow(BoatNotFoundError);

    fetchSpy.mockResolvedValue(
      jsonResponse({ code: "idempotency_in_progress", requestId: "req-2" }, 409)
    );
    await expect(
      client.createSandbox({
        type: "small",
        ttlSeconds: 7200,
        env: {},
        from: "oi-base",
        idempotencyKey: "same",
      })
    ).rejects.toMatchObject({
      constructor: BoatConflictError,
      code: "idempotency_in_progress",
    });
  });

  it("rejects malformed and non-JSON success bodies", async () => {
    const client = new BoatRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ sandbox: { id: "missing-fields" } }));
    await expect(client.getSandbox("x")).rejects.toMatchObject({ code: "invalid_response" });

    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    await expect(client.getSandbox("x")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("combines caller cancellation with the request deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true, type: "sandbox.info", sandbox }));
    await new BoatRestClient(config).getSandbox(sandbox.id, controller.signal);
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
