import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths, buildSessionInternalRequest } from "../session/contracts";
import { createDurableObjectSessionRuntimeDispatch } from "./session-runtime-dispatch";

describe("createDurableObjectSessionRuntimeDispatch", () => {
  it("sends the request to the Durable Object named by the session id", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true });
    });
    const idFromName = vi.fn((name: string) => `do-${name}`);
    const get = vi.fn(() => ({ fetch }));
    const dispatch = createDurableObjectSessionRuntimeDispatch({
      idFromName,
      get,
    } as unknown as DurableObjectNamespace);

    const response = await dispatch(
      "session-1",
      buildSessionInternalRequest(
        SessionInternalPaths.events,
        { method: "POST", headers: { "x-trace-id": "trace-1" }, body: "{}" },
        "?limit=10"
      )
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(idFromName).toHaveBeenCalledWith("session-1");
    expect(get).toHaveBeenCalledWith("do-session-1");
    expect(fetch).toHaveBeenCalledOnce();
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
  });
});
