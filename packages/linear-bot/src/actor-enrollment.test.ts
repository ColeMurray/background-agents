import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollLinearActor } from "./actor-enrollment";
import { createFakeKV, createLinearFetchMock, makeLinearBotEnv } from "./test-helpers";
import type { LinearApiClient } from "./utils/linear-client";

const client: LinearApiClient = {
  accessToken: "linear-token",
  organizationId: "org-1",
  renewAccessToken: async () => "linear-token",
};

describe("Linear actor enrollment", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
