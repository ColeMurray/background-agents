import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { Env } from "../types";
import {
  clearEnvironmentsLocalCache,
  getAvailableEnvironments,
  getEnvironmentById,
} from "./environments";

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

const TEST_ENVIRONMENT: Environment = {
  id: "env_abc123",
  name: "full-stack",
  description: null,
  prebuildEnabled: true,
  createdAt: 1,
  updatedAt: 1,
  repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
};

describe("getAvailableEnvironments", () => {
  beforeEach(() => {
    clearEnvironmentsLocalCache();
    vi.clearAllMocks();
  });

  it("isolates team memory and KV caches from workspace environments", async () => {
    const env = makeEnv(jsonResponse({ environments: [], total: 0 }));
    const fetch = vi.mocked(env.CONTROL_PLANE.fetch);
    fetch.mockImplementation(async (input) => {
      const teamId = new URL(String(input)).searchParams.get("teamId");
      return jsonResponse({
        environments: [{ ...TEST_ENVIRONMENT, name: teamId ?? "workspace" }],
        total: 1,
      });
    });
    expect((await getAvailableEnvironments(env, "trace", null))[0].name).toBe("workspace");
    expect((await getAvailableEnvironments(env, "trace", "team-a"))[0].name).toBe("team-a");
    expect((await getAvailableEnvironments(env, "trace", "team-b"))[0].name).toBe("team-b");
    await getAvailableEnvironments(env, "trace", "team-a");
    expect((await getAvailableEnvironments(env, "trace", null))[0].name).toBe("workspace");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(env.SLACK_KV.put).toHaveBeenCalledWith(
      "slack:environments:team:team-a",
      expect.any(String),
      expect.anything()
    );
    clearEnvironmentsLocalCache();
    fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    const stored = new Map(
      vi.mocked(env.SLACK_KV.put).mock.calls.map(([key, value]) => [key, JSON.parse(String(value))])
    );
    vi.mocked(env.SLACK_KV.get).mockImplementation(async (key) =>
      typeof key === "string" ? (stored.get(key) ?? null) : null
    );
    expect((await getAvailableEnvironments(env, "trace", "team-a"))[0].name).toBe("team-a");
    expect((await getAvailableEnvironments(env, "trace", "team-b"))[0].name).toBe("team-b");
    expect(await getAvailableEnvironments(env, "trace", "team-c")).toEqual([]);
    expect(await getAvailableEnvironments(env, "trace", null)).toEqual(
      stored.get("slack:environments")
    );
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("slack:environments:team:team-a", "json");
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("slack:environments", "json");
    clearEnvironmentsLocalCache();
    vi.mocked(env.SLACK_KV.get).mockRejectedValueOnce(new Error("KV unavailable"));
    expect(await getAvailableEnvironments(env, "trace", "team-a")).toEqual([]);
  });

  it("parses environments and retains memory even if the KV write fails", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    vi.mocked(env.SLACK_KV.put).mockRejectedValueOnce(new Error("KV unavailable"));
    expect(await getAvailableEnvironments(env, "trace", "team-a")).toEqual([TEST_ENVIRONMENT]);
    expect(await getAvailableEnvironments(env, "trace", "team-a")).toEqual([TEST_ENVIRONMENT]);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails open when the control-plane response is malformed", async () => {
    const env = makeEnv(jsonResponse({ environments: [{ id: "env_bad" }], total: 1 }));
    expect(await getAvailableEnvironments(env, "trace")).toEqual([]);
  });

  it("fails open to an empty list on a non-OK response", async () => {
    const env = makeEnv(new Response("error", { status: 500 }));
    expect(await getAvailableEnvironments(env)).toEqual([]);
  });

  it("fails open to an empty list when the fetch throws", async () => {
    const env = makeEnv(new Error("control plane unreachable"));
    expect(await getAvailableEnvironments(env)).toEqual([]);
  });

  it("ignores malformed environments in the KV fallback", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue([TEST_ENVIRONMENT, { id: "env_bad" }]),
        put: vi.fn().mockResolvedValue(undefined),
      },
      CONTROL_PLANE: {
        fetch: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    expect(await getAvailableEnvironments(env, "trace")).toEqual([TEST_ENVIRONMENT]);
  });
});

describe("getEnvironmentById", () => {
  beforeEach(() => {
    clearEnvironmentsLocalCache();
    vi.clearAllMocks();
  });

  it("finds an environment by its stable id", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    expect(await getEnvironmentById(env, "env_abc123")).toEqual(TEST_ENVIRONMENT);
  });

  it("returns undefined for an unknown id", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    expect(await getEnvironmentById(env, "env_missing")).toBeUndefined();
  });
});
