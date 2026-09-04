import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import worker, { SessionDO } from "../../src/index";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";

const REPOS_CACHE_KEY = "repos:list:v2";

function recordingExecutionContext(): {
  context: ExecutionContext;
  pending: Promise<unknown>[];
  waitUntil: ReturnType<typeof vi.fn>;
} {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });

  return {
    context: {
      waitUntil,
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext,
    pending,
    waitUntil,
  };
}

function envWithSessionNamespace(sessionNamespace: object): WorkerBindings {
  return {
    ...(env as unknown as WorkerBindings),
    SESSION: sessionNamespace,
  } as unknown as WorkerBindings;
}

describe("composite Worker lifecycle boundary", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.REPOS_CACHE.delete(REPOS_CACHE_KEY);
  });

  afterEach(async () => {
    await env.REPOS_CACHE.delete(REPOS_CACHE_KEY);
  });

  it("exports the entrypoints required by the Cloudflare deployment", () => {
    expect(SessionDO).toBeTypeOf("function");
    expect(worker.fetch).toBeTypeOf("function");
    expect(worker.scheduled).toBeTypeOf("function");
    expect(worker.queue).toBeTypeOf("function");
  });

  it("serves ordinary HTTP requests through the default Worker fetch entrypoint", async () => {
    const { context } = recordingExecutionContext();

    const response = await worker.fetch(
      new Request("https://test.local/health"),
      env as unknown as WorkerBindings,
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "healthy",
      service: "open-inspect-control-plane",
    });
  });

  it("rejects an upgrade on an invalid WebSocket path before Durable Object dispatch", async () => {
    const sessionNamespace = {
      idFromName: vi.fn(() => {
        throw new Error("invalid WebSocket paths must not allocate a Durable Object ID");
      }),
      get: vi.fn(() => {
        throw new Error("invalid WebSocket paths must not obtain a Durable Object stub");
      }),
    };
    const { context } = recordingExecutionContext();

    const response = await worker.fetch(
      new Request("https://test.local/not-a-session-websocket", {
        headers: { Upgrade: "websocket" },
      }),
      envWithSessionNamespace(sessionNamespace),
      context
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid WebSocket path");
    expect(sessionNamespace.idFromName).not.toHaveBeenCalled();
    expect(sessionNamespace.get).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing WebSocket session before Durable Object dispatch", async () => {
    const sessionNamespace = {
      idFromName: vi.fn(() => {
        throw new Error("missing sessions must not allocate a Durable Object ID");
      }),
      get: vi.fn(() => {
        throw new Error("missing sessions must not obtain a Durable Object stub");
      }),
    };
    const { context } = recordingExecutionContext();

    const response = await worker.fetch(
      new Request("https://test.local/sessions/missing-session/ws", {
        headers: { Upgrade: "websocket" },
      }),
      envWithSessionNamespace(sessionNamespace),
      context
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Session not found");
    expect(sessionNamespace.idFromName).not.toHaveBeenCalled();
    expect(sessionNamespace.get).not.toHaveBeenCalled();
  });

  it("routes a non-upgrade WebSocket path through ordinary HTTP dispatch", async () => {
    const response = await SELF.fetch("https://test.local/sessions/missing-session/ws");

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("keeps route background work on the original fetch execution context", async () => {
    await env.REPOS_CACHE.put(
      REPOS_CACHE_KEY,
      JSON.stringify({ repos: [], cachedAt: new Date(0).toISOString(), freshUntil: 0 })
    );
    const url = "https://test.local/repos";
    const authHeaders = await buildServiceAuthHeaders({
      service: "slack-bot",
      secret: "test-service-secret-slack-bot",
      method: "GET",
      url,
    });
    const { context, pending, waitUntil } = recordingExecutionContext();

    const response = await worker.fetch(
      new Request(url, { headers: authHeaders }),
      env as unknown as WorkerBindings,
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ cached: true, repos: [] });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    await Promise.allSettled(pending);
  });
});
