import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  clearLocalCache,
  getAvailableRepos,
  getRoutingRules,
  getWatchedChannels,
  REPOS_FETCH_TIMEOUT_MS,
} from "./repos";

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
    SERVICE_AUTH_SECRET: "test-secret",
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

  it("fails open when routing rules have a malformed shape", async () => {
    const env = makeEnv(
      jsonResponse({
        settings: {
          defaults: {
            routingRules: [{ keyword: "frontend" }],
          },
        },
      })
    );

    expect(await getRoutingRules(env)).toEqual([]);
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
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    expect(await getRoutingRules(env, "trace")).toEqual([
      { keyword: "frontend", target: "acme/web" },
    ]);
  });

  it("parses nullable-free environment routing rules read from the KV cache", async () => {
    const env = {
      SLACK_KV: {
        get: vi
          .fn()
          .mockResolvedValue([
            { keyword: " Dev Env ", target: " env_123 ", targetType: "environment" },
          ]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    expect(await getRoutingRules(env, "trace")).toEqual([
      { keyword: "dev env", target: "env_123", targetType: "environment" },
    ]);
  });

  it("skips malformed routing rules read from the KV cache", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue([
          { keyword: "frontend", target: "acme/web" },
          { keyword: "backend", target: null },
        ]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
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

  it("reads teams afresh per user, keeping workspace reads actorless and cached", async () => {
    const env = makeEnv(jsonResponse({ repos: [], cached: false, cachedAt: "2026-10-01" }));
    const fetch = vi.mocked(env.CONTROL_PLANE.fetch);
    fetch.mockImplementation(async (_input, init) => {
      const name = new Headers(init?.headers).get("X-OpenInspect-Actor")?.slice(6) ?? "workspace";
      return jsonResponse({
        repos: [
          {
            id: 1,
            owner: "acme",
            name,
            fullName: `acme/${name}`,
            description: null,
            archived: false,
            private: true,
            defaultBranch: "main",
          },
        ],
        cached: false,
        cachedAt: "2026-10-01",
      });
    });
    expect((await getAvailableRepos(env, "trace", null, "U123"))[0].name).toBe("workspace");
    expect((await getAvailableRepos(env, "trace", "team-a", "U123"))[0].name).toBe("u123");
    expect((await getAvailableRepos(env, "trace", "team-a", "U456"))[0].name).toBe("u456");
    expect((await getAvailableRepos(env, "trace", "team-a", "U123"))[0].name).toBe("u123");
    expect((await getAvailableRepos(env, "trace", null, "U456"))[0].name).toBe("workspace");
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-OpenInspect-Actor"))
    ).toEqual([null, "slack:U123", "slack:U456", "slack:U123"]);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://internal/repos",
      "https://internal/repos?teamId=team-a",
      "https://internal/repos?teamId=team-a",
      "https://internal/repos?teamId=team-a",
    ]);
    expect(env.SLACK_KV.put).toHaveBeenCalledTimes(1);
    expect(env.SLACK_KV.get).not.toHaveBeenCalled();
  });

  it("makes no team catalog request without a current user", async () => {
    const env = makeEnv(new Error("should not fetch"));
    expect(await getAvailableRepos(env, "trace", "team-a")).toEqual([]);
    expect(await getAvailableRepos(env, "trace", "team-a", "")).toEqual([]);
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    expect(env.SLACK_KV.get).not.toHaveBeenCalled();
    expect(env.SLACK_KV.put).not.toHaveBeenCalled();
  });

  it.each<[string, Response | Error]>([
    ["denied", new Response(null, { status: 403 })],
    ["unavailable", new Response(null, { status: 503 })],
    ["offline", new Error("CP offline")],
    ["malformed", jsonResponse({ repos: [{ owner: "acme", name: "web" }] })],
    ["invalid JSON", new Response("not JSON")],
  ])("fails closed on %s with preseeded caches", async (_name, result) => {
    const env = makeEnv(result);
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValueOnce(
      jsonResponse({
        repos: [
          {
            id: 1,
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            description: null,
            archived: false,
            private: true,
            defaultBranch: "main",
          },
        ],
        cached: false,
        cachedAt: "2026-10-01",
      })
    );
    const workspaceRepos = await getAvailableRepos(env, "trace");
    expect(workspaceRepos).toHaveLength(1);
    env.SLACK_KV.get = vi.fn().mockResolvedValue(workspaceRepos);
    expect(await getAvailableRepos(env, "trace", "team-a", "U123")).toEqual([]);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    expect(env.SLACK_KV.get).not.toHaveBeenCalled();
    expect(env.SLACK_KV.put).toHaveBeenCalledTimes(1);
    expect(await getAvailableRepos(env, "trace")).toBe(workspaceRepos);
    clearLocalCache();
    expect(await getAvailableRepos(env, "trace")).toEqual(workspaceRepos);
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("repos:cache", "json");
  });

  it("normalizes repositories and retains memory even if the KV write fails", async () => {
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

    vi.mocked(env.SLACK_KV.put).mockRejectedValueOnce(new Error("KV unavailable"));
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
    expect(await getAvailableRepos(env, "trace-1")).toBe(repos);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds the catalog fetch and serves the KV fallback when it times out", async () => {
    // The mention handler runs inside waitUntil. An unbounded fetch here eats the
    // background budget, and the platform cancels the remaining work after the
    // ack has posted but before a session exists — the request then vanishes
    // with neither a session nor an error.
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
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue(cachedRepos),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
          ),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    const repos = await getAvailableRepos(env, "trace-timeout");

    expect(repos).toEqual(cachedRepos);
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("repos:cache", "json");
    // The bound is what makes the abort happen at all; without it the fetch runs
    // until the platform kills the whole invocation.
    expect(timeoutSpy).toHaveBeenCalledWith(REPOS_FETCH_TIMEOUT_MS);
    const init = vi.mocked(env.CONTROL_PLANE.fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    // Identity, not just shape: attaching some other signal would pass an
    // instanceof check while leaving the fetch effectively unbounded.
    expect(init?.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });

  it("falls back when the control-plane repository response is malformed", async () => {
    const env = makeEnv(
      jsonResponse({
        repos: [{ owner: "Open-Inspect", name: "Background-Agents" }],
        cached: false,
        cachedAt: new Date().toISOString(),
      })
    );

    await expect(getAvailableRepos(env, "trace-3")).resolves.toEqual([]);
    expect(env.SLACK_KV.put).not.toHaveBeenCalled();
  });

  it("rejects malformed cached repositories on the fallback path", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue([{ id: "acme/web", owner: "acme", private: false }]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 503 })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    await expect(getAvailableRepos(env, "trace-4")).resolves.toEqual([]);
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("repos:cache", "json");
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

  it("rejects malformed watched-channel responses", async () => {
    const env = makeEnv(jsonResponse({ channels: ["C1", 42] }));

    expect(await getWatchedChannels(env)).toEqual(new Set());
    expect(env.SLACK_KV.put).not.toHaveBeenCalled();
  });

  it("fails closed to an empty set on a non-OK response with no cache", async () => {
    const env = makeEnv(new Response("error", { status: 500 }));
    expect(await getWatchedChannels(env)).toEqual(new Set());
  });

  it("fails closed to an empty set when the fetch throws and no cache exists", async () => {
    const env = makeEnv(new Error("control plane unreachable"));
    expect(await getWatchedChannels(env)).toEqual(new Set());
  });

  it("serves the watch-list from the KV cache without hitting the control plane", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue(["C7", "C8"]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 503 })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    expect(await getWatchedChannels(env, "trace")).toEqual(new Set(["C7", "C8"]));
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("slack:watched-channels", "json");
    // KV is the cache: a hit short-circuits before the control plane is consulted.
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed watched-channel KV cache values", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue(["C7", 8]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 503 })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    expect(await getWatchedChannels(env, "trace")).toEqual(new Set());
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });

  it("reads through the KV cache on a subsequent call (no in-memory tier)", async () => {
    let stored: unknown = null;
    const env = {
      SLACK_KV: {
        get: vi.fn().mockImplementation(async () => stored),
        put: vi.fn().mockImplementation(async (_key: string, value: string) => {
          stored = JSON.parse(value);
        }),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ channels: ["C1"] })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    expect(await getWatchedChannels(env)).toEqual(new Set(["C1"]));
    expect(await getWatchedChannels(env)).toEqual(new Set(["C1"]));

    // First call misses KV and hits the control plane; the second is served from KV.
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
    expect(env.SLACK_KV.get).toHaveBeenCalledTimes(2);
  });
});
