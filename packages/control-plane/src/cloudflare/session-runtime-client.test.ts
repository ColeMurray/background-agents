import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import { createDurableObjectSessionRuntimeClient } from "./session-runtime-client";

describe("createDurableObjectSessionRuntimeClient", () => {
  it("sends the internal request to the Durable Object named by the session id", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true });
    });
    const idFromName = vi.fn((name: string) => `do-${name}`);
    const get = vi.fn(() => ({ fetch }));
    const client = createDurableObjectSessionRuntimeClient({
      idFromName,
      get,
    } as unknown as DurableObjectNamespace);

    const response = await client.fetch(
      "session-1",
      SessionInternalPaths.events,
      { method: "POST", headers: { "x-trace-id": "trace-1" }, body: "{}" },
      "?limit=10"
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
