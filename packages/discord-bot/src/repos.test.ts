import { afterEach, describe, expect, it, vi } from "vitest";
import { signedControlPlaneFetch } from "./internal-auth";
import { listRepos } from "./repos";
import { createEnv, createKv } from "./test-helpers";

vi.mock("./internal-auth", () => ({ signedControlPlaneFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const repo = { owner: "group/subgroup", name: "repo", fullName: "group/subgroup/repo" };

describe("repository cache", () => {
  it("uses the existing key and converts the millisecond TTL at the KV boundary", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });
    vi.mocked(signedControlPlaneFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          repos: [
            {
              ...repo,
              id: 1,
              description: null,
              private: true,
              defaultBranch: "main",
              archived: false,
            },
          ],
          cached: false,
          cachedAt: "2026-09-23T00:00:00Z",
        })
      )
    );
    await expect(listRepos(env)).resolves.toEqual([repo]);
    expect(kv.put).toHaveBeenCalledWith("cache:repos", JSON.stringify([repo]), {
      expirationTtl: 300,
    });
    await expect(listRepos(env)).resolves.toEqual([repo]);
    expect(signedControlPlaneFetch).toHaveBeenCalledOnce();
  });
});
