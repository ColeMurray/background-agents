import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRepoDescriptions, getAvailableRepos } from "./repos";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

const validReposResponse = {
  repos: [
    {
      id: 123,
      owner: "Open-Inspect",
      name: "Background-Agents",
      fullName: "Open-Inspect/Background-Agents",
      description: null,
      private: true,
      defaultBranch: "main",
      archived: false,
      language: null,
      metadata: { aliases: ["agents"] },
    },
  ],
  cached: false,
  cachedAt: "2026-08-02T00:00:00.000Z",
};

const scope = { linearTeamId: "external-team-1", actorUserId: "user-1" };

describe("getAvailableRepos", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads each team-scoped catalog live without touching KV", async () => {
    const { kv, putCalls } = createFakeKV();
    let reads = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get("channel")).toBe("linear:external-team-1");
      reads += 1;
      const name = `scoped-${reads}`;
      return Response.json({
        ...validReposResponse,
        repos: [{ ...validReposResponse.repos[0], name, fullName: `Open-Inspect/${name}` }],
      });
    });
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });

    const scoped = await getAvailableRepos(env, scope, "trace-1");
    expect(scoped[0]).toMatchObject({ name: "scoped-1", aliases: ["agents"] });
    const descriptions = buildRepoDescriptions(scoped);
    expect(descriptions).toContain("open-inspect/scoped-1");
    expect((await getAvailableRepos(env, scope, "trace-1"))[0].name).toBe("scoped-2");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(kv.get).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it.each(["denied", "unavailable", "network", "malformed", "invalid-json"])(
    "rejects a %s response instead of using an empty catalog",
    async (failure) => {
      const fetch = vi.fn(async () => {
        if (failure === "network") throw new Error("Control plane unavailable");
        if (failure === "invalid-json") return new Response("{not-json");
        if (failure === "malformed") return Response.json({ repos: [{ owner: "Open-Inspect" }] });
        return new Response(null, { status: failure === "denied" ? 403 : 503 });
      });
      const { kv } = createFakeKV();
      const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });

      await expect(getAvailableRepos(env, { linearTeamId: "external-team-1" })).rejects.toThrow();
    }
  );
});

it("formats an empty catalog without fetching repositories", () => {
  expect(buildRepoDescriptions([])).toBe("No repositories are currently available.");
});
