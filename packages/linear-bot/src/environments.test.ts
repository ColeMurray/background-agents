import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearEnvironmentsLocalCache, getAvailableEnvironments } from "./environments";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

function controlPlaneFetch(body: unknown, status = 200): Fetcher {
  return { fetch: vi.fn(async () => Response.json(body, { status })) } as unknown as Fetcher;
}

describe("getAvailableEnvironments", () => {
  beforeEach(() => {
    clearEnvironmentsLocalCache();
  });

  it("parses a valid control-plane environments response with nullable fields", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({
        environments: [
          {
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
          },
        ],
        total: 1,
      }),
    });

    await expect(getAvailableEnvironments(env)).resolves.toEqual([
      expect.objectContaining({ id: "env_abc", description: null }),
    ]);
  });

  it("fails open for malformed control-plane environments responses", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: controlPlaneFetch({ environments: [{ id: "env_abc" }], total: 1 }),
    });

    await expect(getAvailableEnvironments(env)).resolves.toEqual([]);
  });
});
