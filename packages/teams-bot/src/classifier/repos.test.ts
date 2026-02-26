import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getAvailableRepos,
  getRepoByFullName,
  getRepoById,
  getReposByChannel,
  buildRepoDescriptions,
  clearLocalCache,
} from "./repos";
import type { Env, ControlPlaneReposResponse } from "../types";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MOCK_REPOS_RESPONSE: ControlPlaneReposResponse = {
  repos: [
    {
      id: 1,
      owner: "Octocat",
      name: "Hello-World",
      fullName: "Octocat/Hello-World",
      description: "A greeting service",
      private: false,
      defaultBranch: "main",
      metadata: {
        aliases: ["greeter"],
        keywords: ["greeting"],
        channelAssociations: ["channel-1"],
      },
    },
    {
      id: 2,
      owner: "Octocat",
      name: "API-Server",
      fullName: "Octocat/API-Server",
      description: "REST API",
      private: true,
      defaultBranch: "develop",
    },
  ],
  cached: false,
  cachedAt: new Date().toISOString(),
};

function createMockEnv(fetchImpl?: (url: string) => Promise<Response>): Env {
  return {
    CONTROL_PLANE: {
      fetch: vi.fn(fetchImpl ?? (async () => jsonResponse(MOCK_REPOS_RESPONSE))),
    },
    TEAMS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    INTERNAL_CALLBACK_SECRET: "test-secret",
  } as unknown as Env;
}

describe("getAvailableRepos", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("fetches and normalizes repos from control plane", async () => {
    const env = createMockEnv();
    const repos = await getAvailableRepos(env);

    expect(repos).toHaveLength(2);
    expect(repos[0].id).toBe("octocat/hello-world");
    expect(repos[0].owner).toBe("octocat");
    expect(repos[0].name).toBe("hello-world");
    expect(repos[0].fullName).toBe("octocat/hello-world");
    expect(repos[0].displayName).toBe("Hello-World");
    expect(repos[0].aliases).toEqual(["greeter"]);
    expect(repos[0].channelAssociations).toEqual(["channel-1"]);

    expect(repos[1].id).toBe("octocat/api-server");
    expect(repos[1].private).toBe(true);
    expect(repos[1].defaultBranch).toBe("develop");
  });

  it("returns cached repos on subsequent calls within TTL", async () => {
    const env = createMockEnv();

    const repos1 = await getAvailableRepos(env);
    const repos2 = await getAvailableRepos(env);

    expect(repos1).toEqual(repos2);
    // Control plane should only be called once
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(1);
  });

  it("writes to KV cache after successful fetch", async () => {
    const env = createMockEnv();
    await getAvailableRepos(env);

    expect(env.TEAMS_KV.put).toHaveBeenCalledWith("repos:cache", expect.any(String), {
      expirationTtl: 300,
    });
  });

  it("falls back to KV cache when control plane fails", async () => {
    const cachedRepos = [
      {
        id: "cached/repo",
        owner: "cached",
        name: "repo",
        fullName: "cached/repo",
        displayName: "repo",
        description: "Cached",
        defaultBranch: "main",
        private: false,
      },
    ];

    const env = createMockEnv(async () => jsonResponse({ error: "unavailable" }, 500));
    (env.TEAMS_KV.get as ReturnType<typeof vi.fn>).mockResolvedValue(cachedRepos);

    const repos = await getAvailableRepos(env);

    expect(repos).toEqual(cachedRepos);
  });

  it("falls back to KV cache when fetch throws", async () => {
    const cachedRepos = [
      {
        id: "cached/repo",
        owner: "cached",
        name: "repo",
        fullName: "cached/repo",
        displayName: "repo",
        description: "Cached",
        defaultBranch: "main",
        private: false,
      },
    ];

    const env = createMockEnv(async () => {
      throw new Error("Network error");
    });
    (env.TEAMS_KV.get as ReturnType<typeof vi.fn>).mockResolvedValue(cachedRepos);

    const repos = await getAvailableRepos(env);

    expect(repos).toEqual(cachedRepos);
  });

  it("returns empty array when both control plane and KV fail", async () => {
    const env = createMockEnv(async () => jsonResponse({ error: "down" }, 500));
    (env.TEAMS_KV.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const repos = await getAvailableRepos(env);

    expect(repos).toEqual([]);
  });
});

describe("getRepoByFullName", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("finds repo by fullName case-insensitively", async () => {
    const env = createMockEnv();
    const repo = await getRepoByFullName(env, "Octocat/Hello-World");

    expect(repo).toBeDefined();
    expect(repo!.id).toBe("octocat/hello-world");
  });

  it("returns undefined for unknown repo", async () => {
    const env = createMockEnv();
    const repo = await getRepoByFullName(env, "unknown/repo");

    expect(repo).toBeUndefined();
  });
});

describe("getRepoById", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("finds repo by ID case-insensitively", async () => {
    const env = createMockEnv();
    const repo = await getRepoById(env, "Octocat/API-Server");

    expect(repo).toBeDefined();
    expect(repo!.name).toBe("api-server");
  });
});

describe("getReposByChannel", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("returns repos associated with a channel", async () => {
    const env = createMockEnv();
    const repos = await getReposByChannel(env, "channel-1");

    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe("octocat/hello-world");
  });

  it("returns empty array for unassociated channel", async () => {
    const env = createMockEnv();
    const repos = await getReposByChannel(env, "channel-999");

    expect(repos).toHaveLength(0);
  });
});

describe("buildRepoDescriptions", () => {
  beforeEach(() => {
    clearLocalCache();
    vi.clearAllMocks();
  });

  it("formats repo descriptions for classifier prompt", async () => {
    const env = createMockEnv();
    const descriptions = await buildRepoDescriptions(env);

    expect(descriptions).toContain("octocat/hello-world");
    expect(descriptions).toContain("A greeting service");
    expect(descriptions).toContain("greeter");
    expect(descriptions).toContain("octocat/api-server");
  });

  it("returns message when no repos are available", async () => {
    const env = createMockEnv(async () => jsonResponse({ repos: [], cached: false, cachedAt: "" }));

    const descriptions = await buildRepoDescriptions(env);

    expect(descriptions).toBe("No repositories are currently available.");
  });
});
