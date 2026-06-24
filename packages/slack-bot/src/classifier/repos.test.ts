import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { clearLocalCache, getAvailableRepos, getRoutingRules, getWatchedChannels } from "./repos";

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

  it("normalizes rules read from the KV cache on the fail-open path", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue([{ keyword: " FrontEnd ", target: "Acme/Web" }]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      },
    } as unknown as Env;

    expect(await getRoutingRules(env, "trace")).toEqual([
      { keyword: "frontend", target: "acme/web" },
    ]);
  });
});

describe("getAvailableRepos", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("normalizes control-plane repositories and stores them in KV", async () => {
    const env = makeEnv(
      jsonResponse({
        repos: [
          {
            id: 123,
            owner: "Open-Inspect",
            name: "Background-Agents",
            fullName: "Open-Inspect/Background-Agents",
            description: "Fallback description",
            private: true,
            defaultBranch: "main",
            archived: false,
            metadata: {
              description: "Slack-facing description",
              aliases: ["agents"],
              keywords: ["slack", "classifier"],
              channelAssociations: ["C123"],
            },
          },
        ],
        cached: false,
        cachedAt: new Date().toISOString(),
      })
    );

    const repos = await getAvailableRepos(env, "trace-1");

    expect(repos).toEqual([
      {
        id: "open-inspect/background-agents",
        owner: "open-inspect",
        name: "background-agents",
        fullName: "open-inspect/background-agents",
        displayName: "Background-Agents",
        description: "Slack-facing description",
        defaultBranch: "main",
        private: true,
        aliases: ["agents"],
        keywords: ["slack", "classifier"],
        channelAssociations: ["C123"],
      },
    ]);
    expect(env.SLACK_KV.put).toHaveBeenCalledWith("repos:cache", JSON.stringify(repos), {
      expirationTtl: 300,
    });
  });

  it("falls back to cached repos when the control plane returns an error", async () => {
    const cachedRepos = [
      {
        id: "acme/web",
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        displayName: "web",
        description: "Cached repo",
        defaultBranch: "main",
        private: false,
      },
    ];
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue(cachedRepos),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 503 })),
      },
    } as unknown as Env;

    await expect(getAvailableRepos(env, "trace-2")).resolves.toEqual(cachedRepos);
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("repos:cache", "json");
  });

  it("uses the in-memory cache after a successful fetch", async () => {
    const env = makeEnv(
      jsonResponse({
        repos: [
          {
            id: 1,
            owner: "acme",
            name: "api",
            fullName: "acme/api",
            description: null,
            private: false,
            defaultBranch: "main",
            archived: false,
          },
        ],
        cached: false,
        cachedAt: new Date().toISOString(),
      })
    );

    const first = await getAvailableRepos(env);
    const second = await getAvailableRepos(env);

    expect(second).toBe(first);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("getWatchedChannels", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("returns the watched channel set from the control plane and stores it in KV", async () => {
    const env = makeEnv(jsonResponse({ channels: ["C1", "C2"] }));

    const channels = await getWatchedChannels(env, "trace");

    expect(channels).toEqual(new Set(["C1", "C2"]));
    expect(env.SLACK_KV.put).toHaveBeenCalledWith(
      "slack:watched-channels",
      JSON.stringify(["C1", "C2"]),
      { expirationTtl: 300 }
    );
  });

  it("returns an empty set when the response has no channels", async () => {
    const env = makeEnv(jsonResponse({}));
    expect(await getWatchedChannels(env)).toEqual(new Set());
  });

  it("fails closed to an empty set on a non-OK response with no cache", async () => {
    const env = makeEnv(new Response("error", { status: 500 }));
    expect(await getWatchedChannels(env)).toEqual(new Set());
  });

  it("fails closed to an empty set when the fetch throws and no cache exists", async () => {
    const env = makeEnv(new Error("control plane unreachable"));
    expect(await getWatchedChannels(env)).toEqual(new Set());
  });

  it("serves the KV last-known-good set on a control-plane failure", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue(["C7", "C8"]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 503 })),
      },
    } as unknown as Env;

    expect(await getWatchedChannels(env, "trace")).toEqual(new Set(["C7", "C8"]));
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("slack:watched-channels", "json");
  });

  it("uses the in-memory cache after a successful fetch", async () => {
    const env = makeEnv(jsonResponse({ channels: ["C1"] }));

    await getWatchedChannels(env);
    await getWatchedChannels(env);

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });
});
