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
      : vi.fn().mockImplementation(async () => fetchResult.clone());
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

  it("reads channels afresh per user, keeping workspace reads actorless and cached", async () => {
    const env = makeEnv(jsonResponse({ environments: [], total: 0 }));
    const fetch = vi.mocked(env.CONTROL_PLANE.fetch);
    fetch.mockImplementation(async (_input, init) => {
      const name = new Headers(init?.headers).get("X-OpenInspect-Actor")?.slice(6) ?? "workspace";
      return jsonResponse({
        environments: [{ ...TEST_ENVIRONMENT, name }],
        total: 1,
      });
    });
    expect((await getAvailableEnvironments(env, "trace", null, "U123"))[0].name).toBe("workspace");
    expect((await getAvailableEnvironments(env, "trace", "C1", "U123"))[0].name).toBe("U123");
    expect((await getAvailableEnvironments(env, "trace", "C1", "U456"))[0].name).toBe("U456");
    expect((await getAvailableEnvironments(env, "trace", "C1", "U123"))[0].name).toBe("U123");
    expect((await getAvailableEnvironments(env, "trace", null, "U456"))[0].name).toBe("workspace");
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-OpenInspect-Actor"))
    ).toEqual([null, "slack:U123", "slack:U456", "slack:U123"]);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://internal/environments",
      "https://internal/environments?channel=slack%3AC1",
      "https://internal/environments?channel=slack%3AC1",
      "https://internal/environments?channel=slack%3AC1",
    ]);
    expect(env.SLACK_KV.put).toHaveBeenCalledTimes(1);
    expect(env.SLACK_KV.get).not.toHaveBeenCalled();
  });

  it("makes no channel catalog request without a current user", async () => {
    const env = makeEnv(new Error("should not fetch"));
    expect(await getAvailableEnvironments(env, "trace", "C1")).toEqual([]);
    expect(await getAvailableEnvironments(env, "trace", "C1", "")).toEqual([]);
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    expect(env.SLACK_KV.get).not.toHaveBeenCalled();
    expect(env.SLACK_KV.put).not.toHaveBeenCalled();
  });

  it.each<[string, Response | Error]>([
    ["denied", new Response(null, { status: 403 })],
    ["unavailable", new Response(null, { status: 503 })],
    ["offline", new Error("CP offline")],
    ["malformed", jsonResponse({ environments: [{ id: "env_bad" }], total: 1 })],
    ["invalid JSON", new Response("not JSON")],
  ])("fails closed on %s with preseeded caches", async (_name, result) => {
    const env = makeEnv(result);
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValueOnce(
      jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 })
    );
    const workspaceEnvironments = await getAvailableEnvironments(env, "trace");
    expect(workspaceEnvironments).toEqual([TEST_ENVIRONMENT]);
    env.SLACK_KV.get = vi.fn().mockResolvedValue(workspaceEnvironments);
    expect(await getAvailableEnvironments(env, "trace", "C1", "U123")).toEqual([]);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    expect(env.SLACK_KV.get).not.toHaveBeenCalled();
    expect(env.SLACK_KV.put).toHaveBeenCalledTimes(1);
    expect(await getAvailableEnvironments(env, "trace")).toBe(workspaceEnvironments);
    clearEnvironmentsLocalCache();
    expect(await getAvailableEnvironments(env, "trace")).toEqual(workspaceEnvironments);
    expect(env.SLACK_KV.get).toHaveBeenCalledWith("slack:environments", "json");
  });

  it("parses environments and retains memory even if the KV write fails", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    vi.mocked(env.SLACK_KV.put).mockRejectedValueOnce(new Error("KV unavailable"));
    expect(await getAvailableEnvironments(env, "trace")).toEqual([TEST_ENVIRONMENT]);
    expect(await getAvailableEnvironments(env, "trace")).toEqual([TEST_ENVIRONMENT]);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails open when the control-plane response is malformed", async () => {
    const env = makeEnv(jsonResponse({ environments: [{ id: "env_bad" }], total: 1 }));
    expect(await getAvailableEnvironments(env, "trace")).toEqual([]);
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
    expect(await getEnvironmentById(env, "env_abc123", "trace", "C1", "U123")).toEqual(
      TEST_ENVIRONMENT
    );
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/environments?channel=slack%3AC1",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-OpenInspect-Actor": "slack:U123" }),
      })
    );
  });

  it("returns undefined for an unknown id", async () => {
    const env = makeEnv(jsonResponse({ environments: [TEST_ENVIRONMENT], total: 1 }));
    expect(await getEnvironmentById(env, "env_missing")).toBeUndefined();
  });
});
