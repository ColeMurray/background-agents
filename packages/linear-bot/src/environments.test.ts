import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEnvironmentsLocalCache,
  getAvailableEnvironments,
  getEnvironmentById,
} from "./environments";
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
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("looks up scoped environments through fresh reads without using either unscoped cache", async () => {
    const { kv, putCalls } = createFakeKV({
      "environments:cache": JSON.stringify([validEnvironment]),
    });
    let scopedReads = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("channel")) {
        return Response.json({ environments: [validEnvironment], total: 1 });
      }
      expect(url.searchParams.get("channel")).toBe("linear:external-team-1");
      scopedReads += 1;
      return Response.json({
        environments: [{ ...validEnvironment, id: "env_scoped", name: `Scoped ${scopedReads}` }],
        total: 1,
      });
    });
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });
    const unscoped = await getAvailableEnvironments(env);
    vi.mocked(kv.get).mockClear();
    putCalls.length = 0;
    const scope = { linearTeamId: "external-team-1", actorUserId: "user-1" };

    expect((await getAvailableEnvironments(env, "trace-1", scope))[0].name).toBe("Scoped 1");
    expect(await getEnvironmentById(env, "env_scoped", "trace-1", scope)).toMatchObject({
      id: "env_scoped",
      name: "Scoped 2",
    });
    expect(await getEnvironmentById(env, validEnvironment.id, "trace-1", scope)).toBeUndefined();
    expect(await getAvailableEnvironments(env)).toBe(unscoped);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(kv.get).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it.each(["denied", "unavailable", "network", "malformed", "invalid-json"])(
    "rejects a scoped %s response instead of using stale environments",
    async (failure) => {
      const { kv, putCalls } = createFakeKV({
        "environments:cache": JSON.stringify([validEnvironment]),
      });
      const fetch = vi.fn(async (input: string | URL | Request) => {
        if (!new URL(String(input)).searchParams.has("channel")) {
          return Response.json({ environments: [validEnvironment], total: 1 });
        }
        if (failure === "network") throw new Error("Control plane unavailable");
        if (failure === "invalid-json") return new Response("{not-json");
        if (failure === "malformed") {
          return Response.json({ environments: [{ id: "env_abc" }], total: 1 });
        }
        return new Response(null, { status: failure === "denied" ? 403 : 503 });
      });
      const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });
      await getAvailableEnvironments(env);
      vi.mocked(kv.get).mockClear();
      putCalls.length = 0;

      await expect(
        getEnvironmentById(env, validEnvironment.id, undefined, { linearTeamId: "external-team-1" })
      ).rejects.toThrow();
      expect(kv.get).not.toHaveBeenCalled();
      expect(putCalls).toEqual([]);
    }
  );
});
