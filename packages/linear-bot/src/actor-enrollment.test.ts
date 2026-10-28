import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTOR_ENROLLMENT_TIMEOUT_MS, enrollLinearActor } from "./actor-enrollment";
import { createFakeKV, createLinearFetchMock, makeLinearBotEnv } from "./test-helpers";
import type { LinearApiClient } from "./utils/linear-client";

const client: LinearApiClient = {
  accessToken: "linear-token",
  organizationId: "org-1",
  renewAccessToken: async () => "linear-token",
};

describe("Linear actor enrollment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the author's server-fetched profile in the first signed request", async () => {
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        graphql: ({ body }) => {
          expect(body.variables).toEqual({ id: "new-collaborator" });
          return Response.json({
            data: { user: { id: "new-collaborator", name: "Ada", email: "ada@corp.test" } },
          });
        },
      })
    );
    const env = makeLinearBotEnv(createFakeKV().kv);
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    env.CONTROL_PLANE = { fetch: request };

    expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).toBeNull();
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://internal/actors/me");
    expect(new Headers(init.headers).get("X-OpenInspect-Actor")).toBe("linear:new-collaborator");
    expect(JSON.parse(String(init.body))).toEqual({ displayName: "Ada", email: "ada@corp.test" });
  });

  it.each([403, 503])("refuses to continue when enrollment returns %s", async (status) => {
    vi.stubGlobal("fetch", createLinearFetchMock({ graphql: () => Response.json({ data: {} }) }));
    const env = makeLinearBotEnv(createFakeKV().kv);
    env.CONTROL_PLANE = { fetch: vi.fn().mockResolvedValue(Response.json({}, { status })) };
    expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).toContain(
      "Cannot verify"
    );
  });

  it.each(["request", "response body"])(
    "fails closed when the enrollment %s stalls",
    async (phase) => {
      vi.stubGlobal("fetch", createLinearFetchMock({ graphql: () => Response.json({ data: {} }) }));
      const deadline = new AbortController();
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      let markStalled!: () => void;
      const stalled = new Promise<void>((resolve) => {
        markStalled = resolve;
      });
      const neverCompletes = () =>
        new Promise<never>(() => {
          markStalled();
        });
      const response = Response.json({}, { status: 403 });
      if (phase === "response body") vi.spyOn(response, "json").mockImplementation(neverCompletes);
      const request = vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBe(deadline.signal);
        return phase === "request" ? neverCompletes() : response;
      });
      const env = makeLinearBotEnv(createFakeKV().kv);
      env.CONTROL_PLANE = { fetch: request };

      const enrollment = enrollLinearActor(env, client, "new-collaborator", "trace-1");
      await stalled;
      deadline.abort(new DOMException("timed out", "TimeoutError"));

      expect(await enrollment).toContain("Cannot verify");
      expect(request).toHaveBeenCalledOnce();
      expect(timeoutSpy).toHaveBeenCalledWith(ACTOR_ENROLLMENT_TIMEOUT_MS);
      expect(
        timeoutSpy.mock.calls.filter(([timeoutMs]) => timeoutMs === ACTOR_ENROLLMENT_TIMEOUT_MS)
      ).toHaveLength(1);
    }
  );
});
