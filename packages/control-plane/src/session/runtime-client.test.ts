import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "./contracts";
import { createSessionRuntimeClient } from "./runtime-client";
import type { CorrelationContext } from "../logger";
import type { Env } from "../types";

function createCtx(): CorrelationContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
  };
}

describe("createSessionRuntimeClient", () => {
  it("sends correlated requests to the named Session runtime", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true });
    });
    const idFromName = vi.fn((name: string) => `do-${name}`);
    const get = vi.fn(() => ({ fetch }));
    const env = {
      SESSION: { idFromName, get },
    } as unknown as Env;

    const client = createSessionRuntimeClient(env, createCtx());
    const response = await client.fetch(
      "session-1",
      SessionInternalPaths.events,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      "?limit=10"
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(idFromName).toHaveBeenCalledWith("session-1");
    expect(get).toHaveBeenCalledWith("do-session-1");

    expect(fetch).toHaveBeenCalledOnce();
    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });
});
