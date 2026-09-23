import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "./contracts";
import {
  createSessionRuntimeClient,
  createSessionRuntimeClientForTrace,
  createSessionRuntimeClientForTraceOver,
  createSessionRuntimeClientOver,
  type SessionRuntimeDispatch,
} from "./runtime-client";
import type { CorrelationContext } from "../logger";
import type { Env } from "../types";

function createCtx(): CorrelationContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
  };
}

/** A platform whose session dispatch records what it is handed. */
function recordingEnv(): { env: Env; calls: Array<{ sessionId: string; request: Request }> } {
  const calls: Array<{ sessionId: string; request: Request }> = [];
  const SESSION: SessionRuntimeDispatch = async (sessionId, request) => {
    calls.push({ sessionId, request });
    return Response.json({ ok: true });
  };
  return { env: { SESSION } as unknown as Env, calls };
}

describe("createSessionRuntimeClientOver", () => {
  it("hands the dispatch a correlated internal request for the session", async () => {
    const calls: Array<{ sessionId: string; request: Request }> = [];
    const dispatch: SessionRuntimeDispatch = async (sessionId, request) => {
      calls.push({ sessionId, request });
      return Response.json({ ok: true });
    };
    const controller = new AbortController();

    const response = await createSessionRuntimeClientOver(dispatch, createCtx()).fetch(
      "session-1",
      SessionInternalPaths.events,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      },
      "?limit=10"
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const { sessionId, request } = calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    await expect(request.text()).resolves.toBe("{}");
    // The caller's signal reaches the dispatch as the request's own.
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("rejects the call when the dispatch rejects", async () => {
    const dispatch: SessionRuntimeDispatch = async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    };
    await expect(
      createSessionRuntimeClientOver(dispatch, createCtx()).fetch("s", SessionInternalPaths.state)
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("createSessionRuntimeClientForTraceOver", () => {
  it("keeps the trace and mints a fresh request id for every call", async () => {
    const requests: Request[] = [];
    const dispatch: SessionRuntimeDispatch = async (_sessionId, request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    };

    const client = createSessionRuntimeClientForTraceOver(dispatch, "child-session-id");
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });

    expect(requests.map((request) => request.headers.get("x-trace-id"))).toEqual([
      "child-session-id",
      "child-session-id",
    ]);
    const requestIds = requests.map((request) => request.headers.get("x-request-id"));
    expect(requestIds[0]).toMatch(/[0-9a-f-]{36}/);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});

describe("createSessionRuntimeClient", () => {
  it("dispatches through the platform's session port with the correlation headers", async () => {
    const { env, calls } = recordingEnv();

    const response = await createSessionRuntimeClient(env, createCtx()).fetch(
      "session-1",
      SessionInternalPaths.events,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      "?limit=10"
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const { sessionId, request } = calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("createSessionRuntimeClientForTrace", () => {
  it("keeps the trace and mints a fresh request id for every call", async () => {
    const { env, calls } = recordingEnv();

    const client = createSessionRuntimeClientForTrace(env, "child-object-id");
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });

    const headers = calls.map(({ request }) => request.headers);
    expect(headers.map((h) => h.get("x-trace-id"))).toEqual(["child-object-id", "child-object-id"]);
    const requestIds = headers.map((h) => h.get("x-request-id"));
    expect(requestIds[0]).toMatch(/[0-9a-f-]{36}/);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(vi.isMockFunction(env.SESSION)).toBe(false);
  });
});
