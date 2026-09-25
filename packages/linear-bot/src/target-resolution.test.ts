import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import { resolveSessionTarget } from "./target-resolution";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";
import type * as LinearClientModule from "./utils/linear-client";
import type { LinearApiClient } from "./utils/linear-client";

const { mockGetAvailableRepos, mockGetRepoSuggestions } = vi.hoisted(() => ({
  mockGetAvailableRepos: vi.fn(),
  mockGetRepoSuggestions: vi.fn(),
}));

vi.mock("./classifier/repos", () => ({ getAvailableRepos: mockGetAvailableRepos }));

vi.mock("./utils/linear-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LinearClientModule>()),
  getRepoSuggestions: mockGetRepoSuggestions,
}));

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: async () => "renewed-token",
};

function repo(owner: string, name: string, scmHost?: string): RepoConfig {
  return {
    id: `${owner}/${name}`,
    owner,
    name,
    fullName: `${owner}/${name}`,
    displayName: name,
    description: name,
    defaultBranch: "main",
    private: true,
    scmHost,
  };
}

function resolve() {
  const { kv } = createFakeKV();
  return resolveSessionTarget({
    env: makeLinearBotEnv(kv),
    client,
    agentSessionId: "agent-session-1",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix the API",
      url: "https://linear.app/acme/issue/ENG-1",
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "team-1", key: "ENG", name: "Engineering" },
    },
    labelNames: [],
    projectInfo: null,
    comment: null,
    traceId: "trace-1",
  });
}

describe("resolveSessionTarget: Linear repo suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends each repository's SCM host as the candidate hostname", async () => {
    mockGetAvailableRepos.mockResolvedValue([repo("group/subgroup", "api", "gitlab.com")]);
    mockGetRepoSuggestions.mockResolvedValue([
      { repositoryFullName: "group/subgroup/api", confidence: 0.9 },
    ]);

    const resolved = await resolve();

    expect(mockGetRepoSuggestions).toHaveBeenCalledWith(client, "issue-1", "agent-session-1", [
      { hostname: "gitlab.com", repositoryFullName: "group/subgroup/api" },
    ]);
    expect(resolved?.target).toMatchObject({
      kind: "repository",
      owner: "group/subgroup",
      name: "api",
    });
  });

  it("assumes github.com for repositories listed without an SCM host", async () => {
    mockGetAvailableRepos.mockResolvedValue([repo("acme", "api")]);
    mockGetRepoSuggestions.mockResolvedValue([{ repositoryFullName: "acme/api", confidence: 0.9 }]);

    await resolve();

    expect(mockGetRepoSuggestions).toHaveBeenCalledWith(client, "issue-1", "agent-session-1", [
      { hostname: "github.com", repositoryFullName: "acme/api" },
    ]);
  });
});
