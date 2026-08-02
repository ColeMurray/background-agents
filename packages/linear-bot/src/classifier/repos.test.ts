import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearReposLocalCache, getAvailableRepos } from "./repos";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

function controlPlaneFetch(body: unknown, status = 200): Fetcher {
  return { fetch: vi.fn(async () => Response.json(body, { status })) } as unknown as Fetcher;
}

describe("getAvailableRepos", () => {
  beforeEach(() => {
    clearReposLocalCache();
  });

  it("parses a valid control-plane repos response", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({
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
      }),
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

  it("fails open for malformed control-plane repos responses", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ repos: [{ owner: "Open-Inspect" }] }),
    });

    await expect(getAvailableRepos(env)).resolves.toEqual([]);
  });
});
