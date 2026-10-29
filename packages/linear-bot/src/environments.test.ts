import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableEnvironments, getEnvironmentById } from "./environments";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

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

const scope = { linearTeamId: "external-team-1", actorUserId: "user-1" };

describe("getAvailableEnvironments", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("looks up team-scoped environments through live reads without touching KV", async () => {
    const { kv, putCalls } = createFakeKV();
    let reads = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get("channel")).toBe("linear:external-team-1");
      reads += 1;
      return Response.json({
        environments: [{ ...validEnvironment, id: "env_scoped", name: `Scoped ${reads}` }],
        total: 1,
      });
    });
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });

    expect((await getAvailableEnvironments(env, scope, "trace-1"))[0].name).toBe("Scoped 1");
    expect(await getEnvironmentById(env, "env_scoped", scope, "trace-1")).toMatchObject({
      id: "env_scoped",
      name: "Scoped 2",
    });
    expect(await getEnvironmentById(env, validEnvironment.id, scope, "trace-1")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(kv.get).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it.each(["denied", "unavailable", "network", "malformed", "invalid-json"])(
    "rejects a %s response instead of using an empty list",
    async (failure) => {
      const fetch = vi.fn(async () => {
        if (failure === "network") throw new Error("Control plane unavailable");
        if (failure === "invalid-json") return new Response("{not-json");
        if (failure === "malformed") {
          return Response.json({ environments: [{ id: "env_abc" }], total: 1 });
        }
        return new Response(null, { status: failure === "denied" ? 403 : 503 });
      });
      const { kv } = createFakeKV();
      const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });

      await expect(
        getEnvironmentById(env, validEnvironment.id, { linearTeamId: "external-team-1" })
      ).rejects.toThrow();
    }
  );
});
