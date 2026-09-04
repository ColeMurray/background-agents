import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "./contracts";
import {
  createSessionRuntimeClient,
  createSessionRuntimeClientForTrace,
  type SessionRuntimeClient,
} from "./runtime-client";
import type { CorrelationContext } from "../logger";
import type { Env } from "../types";

function createCtx(): CorrelationContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
  };
}

function recordingEnv(): {
  env: Env;
  fetch: ReturnType<typeof vi.fn<SessionRuntimeClient["fetch"]>>;
} {
  const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ ok: true }));
  return { env: { SESSION: { fetch } } as unknown as Env, fetch };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe("createSessionRuntimeClient", () => {
  it("forwards the call to the platform's session client with the correlation headers", async () => {
    const { env, fetch } = recordingEnv();

    const client = createSessionRuntimeClient(env, createCtx());
    const response = await client.fetch(
      "session-1",
      SessionInternalPaths.events,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      "?limit=10"
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    const [sessionId, path, init, search] = fetch.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(path).toBe(SessionInternalPaths.events);
    expect(search).toBe("?limit=10");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    const headers = headersOf(init);
    expect(headers.get("x-trace-id")).toBe("trace-1");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });
});

describe("createSessionRuntimeClientForTrace", () => {
  it("keeps the trace and mints a fresh request id for every call", async () => {
    const { env, fetch } = recordingEnv();

    const client = createSessionRuntimeClientForTrace(env, "child-object-id");
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });

    const headers = fetch.mock.calls.map(([, , init]) => headersOf(init));
    expect(headers.map((h) => h.get("x-trace-id"))).toEqual(["child-object-id", "child-object-id"]);
    const requestIds = headers.map((h) => h.get("x-request-id"));
    expect(requestIds[0]).toMatch(/[0-9a-f-]{36}/);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});
