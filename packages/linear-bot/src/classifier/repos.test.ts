import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

function controlPlaneRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    owner: "Acme",
    name: "Widgets",
    fullName: "Acme/Widgets",
    description: null,
    private: false,
    defaultBranch: "main",
    archived: false,
    language: null,
    topics: ["typescript"],
    metadata: {
      description: "Widget service",
      aliases: ["widgets-api"],
      keywords: ["widget"],
    },
    ...overrides,
  };
}

function repoConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme/widgets",
    owner: "acme",
    name: "widgets",
    fullName: "acme/widgets",
    displayName: "widgets",
    description: "Widget service",
    defaultBranch: "main",
    private: false,
    language: null,
    ...overrides,
  };
}

async function loadReposModule() {
  vi.resetModules();
  return import("./repos");
}

describe("getAvailableRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses valid control-plane repos responses", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          repos: [controlPlaneRepo()],
          cached: false,
          cachedAt: "2026-07-04T00:00:00.000Z",
        }),
        { status: 200 }
      )
    );

    const { getAvailableRepos } = await loadReposModule();
    const repos = await getAvailableRepos(env);

    expect(repos).toEqual([
      expect.objectContaining({
        id: "acme/widgets",
        owner: "acme",
        name: "widgets",
        description: "Widget service",
        language: null,
      }),
    ]);
  });

  it("rejects malformed control-plane repos responses and falls back", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(
      new Response(JSON.stringify({ repos: [{ owner: "acme" }], cached: false }), { status: 200 })
    );

    const { getAvailableRepos } = await loadReposModule();

    await expect(getAvailableRepos(env)).resolves.toEqual([]);
  });

  it("parses valid cached repo configs", async () => {
    const { kv } = createFakeKV({ "repos:cache": JSON.stringify([repoConfig()]) });
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(new Response("", { status: 500 }));

    const { getAvailableRepos } = await loadReposModule();

    await expect(getAvailableRepos(env)).resolves.toEqual([repoConfig()]);
  });

  it("rejects malformed cached repo configs", async () => {
    const { kv } = createFakeKV({ "repos:cache": JSON.stringify([{ id: "acme/widgets" }]) });
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(new Response("", { status: 500 }));

    const { getAvailableRepos } = await loadReposModule();

    await expect(getAvailableRepos(env)).resolves.toEqual([]);
  });
});
