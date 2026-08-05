import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearEnvironmentsLocalCache, getAvailableEnvironments } from "./environments";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

function controlPlaneFetch(body: unknown, status = 200): Fetcher {
  return { fetch: vi.fn(async () => Response.json(body, { status })) } as unknown as Fetcher;
}

const validEnvironment = {
  id: "env_abc",
  name: "Production",
  description: null,
  prebuildEnabled: true,
  createdAt: 123,
  updatedAt: 456,
  repositories: [
    {
      repoOwner: "open-inspect",
      repoName: "background-agents",
      repoId: null,
      baseBranch: "main",
    },
  ],
};

describe("getAvailableEnvironments", () => {
  beforeEach(() => {
    clearEnvironmentsLocalCache();
  });

  it("parses a valid control-plane environments response with nullable fields", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ environments: [validEnvironment], total: 1 }),
    });

    await expect(getAvailableEnvironments(env)).resolves.toEqual([
      expect.objectContaining({ id: "env_abc", description: null }),
    ]);
  });

  it("serves the KV last-known-good copy when the fresh response is malformed", async () => {
    const { kv, putCalls } = createFakeKV({
      "environments:cache": JSON.stringify([validEnvironment]),
    });
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ environments: [{ id: "env_abc" }], total: 1 }),
    });

    await expect(getAvailableEnvironments(env)).resolves.toEqual([
      expect.objectContaining({ id: "env_abc" }),
    ]);
    // The last-known-good copy must survive a malformed fresh response.
    expect(putCalls).toEqual([]);
  });

  it("ignores a malformed KV copy and falls back to an empty list", async () => {
    const { kv } = createFakeKV({
      "environments:cache": JSON.stringify([{ id: "env_abc" }]),
    });
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ environments: [{ id: "env_abc" }], total: 1 }),
    });

    await expect(getAvailableEnvironments(env)).resolves.toEqual([]);
  });

  it("fails open to an empty list when the response is malformed and no KV copy exists", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ environments: [{ id: "env_abc" }], total: 1 }),
    });

    await expect(getAvailableEnvironments(env)).resolves.toEqual([]);
  });
});
