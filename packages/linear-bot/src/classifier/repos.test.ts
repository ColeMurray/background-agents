import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRepoDescriptions, clearReposLocalCache, getAvailableRepos } from "./repos";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

function controlPlaneFetch(body: unknown, status = 200): Fetcher {
  return { fetch: vi.fn(async () => Response.json(body, { status })) } as unknown as Fetcher;
}

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

const cachedRepoConfig = {
  id: "open-inspect/background-agents",
  owner: "open-inspect",
  name: "background-agents",
  fullName: "open-inspect/background-agents",
  displayName: "Background-Agents",
  description: "Background-Agents",
  defaultBranch: "main",
  private: true,
  language: null,
  aliases: ["agents"],
};

describe("getAvailableRepos", () => {
  beforeEach(() => {
    clearReposLocalCache();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid control-plane repos response", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch(validReposResponse),
    });

    await expect(getAvailableRepos(env)).resolves.toEqual([
      expect.objectContaining({
        id: "open-inspect/background-agents",
        owner: "open-inspect",
        name: "background-agents",
        aliases: ["agents"],
      }),
    ]);
  });

  it("serves the KV last-known-good copy when the fresh response is malformed", async () => {
    const { kv, putCalls } = createFakeKV({
      "repos:cache": JSON.stringify([cachedRepoConfig]),
    });
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ repos: [{ owner: "Open-Inspect" }] }),
    });

    await expect(getAvailableRepos(env)).resolves.toEqual([cachedRepoConfig]);
    // The last-known-good copy must survive a malformed fresh response.
    expect(putCalls).toEqual([]);
  });

  it("ignores a malformed KV copy and falls back to an empty list", async () => {
    const { kv } = createFakeKV({
      "repos:cache": JSON.stringify([{ id: "open-inspect/background-agents" }]),
    });
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ repos: [{ owner: "Open-Inspect" }] }),
    });

    await expect(getAvailableRepos(env)).resolves.toEqual([]);
  });

  it("fails open to an empty list when the response is malformed and no KV copy exists", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ repos: [{ owner: "Open-Inspect" }] }),
    });

    await expect(getAvailableRepos(env)).resolves.toEqual([]);
  });

  it("reads scoped catalogs fresh without reading or replacing either unscoped cache", async () => {
    const { kv, putCalls } = createFakeKV({
      "repos:cache": JSON.stringify([cachedRepoConfig]),
    });
    let scopedReads = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("channel")) return Response.json(validReposResponse);
      expect(url.searchParams.get("channel")).toBe("linear:external-team-1");
      scopedReads += 1;
      const name = `scoped-${scopedReads}`;
      return Response.json({
        ...validReposResponse,
        repos: [{ ...validReposResponse.repos[0], name, fullName: `Open-Inspect/${name}` }],
      });
    });
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });
    const unscoped = await getAvailableRepos(env);
    vi.mocked(kv.get).mockClear();
    putCalls.length = 0;
    const scope = { linearTeamId: "external-team-1", actorUserId: "user-1" };

    const scoped = await getAvailableRepos(env, "trace-1", scope);
    expect(scoped[0].name).toBe("scoped-1");
    const descriptions = buildRepoDescriptions(scoped);
    expect(descriptions).toContain("open-inspect/scoped-1");
    expect(descriptions).not.toContain("open-inspect/background-agents");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getAvailableRepos(env, "trace-1", scope))[0].name).toBe("scoped-2");
    expect(await getAvailableRepos(env)).toBe(unscoped);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(kv.get).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it.each(["denied", "unavailable", "network", "malformed", "invalid-json"])(
    "rejects a scoped %s response instead of using stale repositories",
    async (failure) => {
      const { kv, putCalls } = createFakeKV({
        "repos:cache": JSON.stringify([cachedRepoConfig]),
      });
      const fetch = vi.fn(async (input: string | URL | Request) => {
        if (!new URL(String(input)).searchParams.has("channel")) {
          return Response.json(validReposResponse);
        }
        if (failure === "network") throw new Error("Control plane unavailable");
        if (failure === "invalid-json") return new Response("{not-json");
        if (failure === "malformed") return Response.json({ repos: [{ owner: "Open-Inspect" }] });
        return new Response(null, { status: failure === "denied" ? 403 : 503 });
      });
      const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });
      await getAvailableRepos(env);
      vi.mocked(kv.get).mockClear();
      putCalls.length = 0;

      await expect(
        getAvailableRepos(env, undefined, { linearTeamId: "external-team-1" })
      ).rejects.toThrow();
      expect(kv.get).not.toHaveBeenCalled();
      expect(putCalls).toEqual([]);
    }
  );
});

it("formats an empty catalog without fetching repositories", () => {
  expect(buildRepoDescriptions([])).toBe("No repositories are currently available.");
});
