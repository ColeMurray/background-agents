import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearReposLocalCache, getAvailableRepos } from "./repos";
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
});
