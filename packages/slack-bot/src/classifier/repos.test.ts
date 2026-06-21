import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { clearLocalCache, getRoutingRules } from "./repos";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal Env whose control plane returns `response` and whose KV is empty. */
function makeEnv(fetchResult: Response | Error): Env {
  const fetch =
    fetchResult instanceof Error
      ? vi.fn().mockRejectedValue(fetchResult)
      : vi.fn().mockResolvedValue(fetchResult);
  return {
    SLACK_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    CONTROL_PLANE: { fetch },
  } as unknown as Env;
}

describe("getRoutingRules", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("parses routing rules from the control-plane settings response", async () => {
    const env = makeEnv(
      jsonResponse({
        integrationId: "slack",
        settings: { defaults: { routingRules: [{ keyword: "frontend", target: "acme/web" }] } },
      })
    );

    expect(await getRoutingRules(env, "trace")).toEqual([
      { keyword: "frontend", target: "acme/web" },
    ]);
  });

  it("returns an empty list when slack settings are unset", async () => {
    const env = makeEnv(jsonResponse({ integrationId: "slack", settings: null }));
    expect(await getRoutingRules(env)).toEqual([]);
  });

  it("normalizes rules on read (trim, lowercase, de-dupe)", async () => {
    const env = makeEnv(
      jsonResponse({
        settings: {
          defaults: {
            routingRules: [
              { keyword: " FrontEnd ", target: "Acme/Web" },
              { keyword: "frontend", target: "acme/web" },
            ],
          },
        },
      })
    );

    expect(await getRoutingRules(env)).toEqual([{ keyword: "frontend", target: "acme/web" }]);
  });

  it("fails open to an empty list on a non-OK response", async () => {
    const env = makeEnv(new Response("error", { status: 500 }));
    expect(await getRoutingRules(env)).toEqual([]);
  });

  it("fails open to an empty list when the fetch throws", async () => {
    const env = makeEnv(new Error("control plane unreachable"));
    expect(await getRoutingRules(env)).toEqual([]);
  });
});
