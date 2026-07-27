import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Environment } from "../types";
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

  it("parses environments from the control-plane response", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    expect(await getAvailableEnvironments(env, "trace")).toEqual([TEST_ENVIRONMENT]);
  });

  it("serves the in-memory cache without refetching", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    await getAvailableEnvironments(env);
    await getAvailableEnvironments(env);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails open to an empty list on a non-OK response", async () => {
    const env = makeEnv(new Response("error", { status: 500 }));
    expect(await getAvailableEnvironments(env)).toEqual([]);
  });

  it("fails open to an empty list when the fetch throws", async () => {
    const env = makeEnv(new Error("control plane unreachable"));
    expect(await getAvailableEnvironments(env)).toEqual([]);
  });

  it("falls back to the KV cache when the control plane is down", async () => {
    const env = {
      SLACK_KV: {
        get: vi.fn().mockResolvedValue([TEST_ENVIRONMENT]),
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
