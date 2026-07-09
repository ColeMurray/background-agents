import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RepoConfig, SlackSessionTarget } from "./types";
import { MAX_REPO_SUGGESTION_OPTIONS } from "./app-home/constants";

const { mockGetAvailableRepos, mockGetEnvironmentById } = vi.hoisted(() => ({
  mockGetAvailableRepos: vi.fn(),
  mockGetEnvironmentById: vi.fn(),
}));

vi.mock("./classifier/repos", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getAvailableRepos: mockGetAvailableRepos,
}));

vi.mock("./classifier/environments", () => ({
  getEnvironmentById: mockGetEnvironmentById,
}));

import { filterReposByQuery } from "./classifier/repos";
import {
  MAX_REPO_QUICK_PICKS,
  SELECT_REPO_ACTION_ID,
  SELECT_REPO_QUICK_PICK_ACTION_ID,
  buildRepoClarificationBlocks,
  buildTargetQuickPickButtons,
  baseActionId,
  quickPickActionId,
  resolveTargetValue,
} from "./repo-clarification";

function repo(fullName: string, displayName?: string): RepoConfig {
  const [owner, name] = fullName.split("/");
  return {
    id: fullName,
    owner: owner ?? "acme",
    name: name ?? fullName,
    fullName,
    displayName: displayName ?? name ?? fullName,
    description: fullName,
    defaultBranch: "main",
    private: true,
  };
}

function repoTarget(fullName: string, displayName?: string): SlackSessionTarget {
  return { kind: "repository", repo: repo(fullName, displayName) };
}

function environmentTarget(id: string, name: string): SlackSessionTarget {
  return {
    kind: "environment",
    environment: {
      id,
      name,
      description: null,
      prebuildEnabled: false,
      createdAt: 1,
      updatedAt: 1,
      repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
    },
  };
}

describe("filterReposByQuery", () => {
  const repos = [repo("acme/web"), repo("acme/api"), repo("other/web-utils")];

  it("returns all repos for an empty, undefined, or whitespace query", () => {
    expect(filterReposByQuery(repos, undefined)).toHaveLength(3);
    expect(filterReposByQuery(repos, "")).toHaveLength(3);
    expect(filterReposByQuery(repos, "   ")).toHaveLength(3);
  });

  it("filters by case-insensitive substring of the full name", () => {
    expect(filterReposByQuery(repos, "WEB").map((r) => r.id)).toEqual([
      "acme/web",
      "other/web-utils",
    ]);
    expect(filterReposByQuery(repos, "acme/").map((r) => r.id)).toEqual(["acme/web", "acme/api"]);
  });

  it("returns no repos when nothing matches", () => {
    expect(filterReposByQuery(repos, "nope")).toEqual([]);
  });
});

describe("buildTargetQuickPickButtons", () => {
  it("maps alternatives to quick-pick buttons carrying the repo id", () => {
    expect(buildTargetQuickPickButtons([repoTarget("acme/web"), repoTarget("acme/api")])).toEqual([
      {
        type: "button",
        action_id: quickPickActionId(0),
        text: { type: "plain_text", text: "web" },
        value: "acme/web",
      },
      {
        type: "button",
        action_id: quickPickActionId(1),
        text: { type: "plain_text", text: "api" },
        value: "acme/api",
      },
    ]);
  });

  it("maps an environment alternative to a button carrying the env: value", () => {
    expect(buildTargetQuickPickButtons([environmentTarget("env_abc123", "full-stack")])).toEqual([
      {
        type: "button",
        action_id: quickPickActionId(0),
        text: { type: "plain_text", text: "full-stack" },
        value: "env:env_abc123",
      },
    ]);
  });

  it("gives each button a unique action_id so Slack accepts the block", () => {
    // Slack requires action_id to be unique within an actions block.
    const buttons = buildTargetQuickPickButtons(
      Array.from({ length: MAX_REPO_QUICK_PICKS }, (_, idx) => repoTarget(`acme/repo-${idx}`))
    );
    const actionIds = buttons.map((button) => button.action_id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds.every((id) => baseActionId(id) === SELECT_REPO_QUICK_PICK_ACTION_ID)).toBe(
      true
    );
  });

  it("caps the number of buttons at MAX_REPO_QUICK_PICKS", () => {
    const alternatives = Array.from({ length: MAX_REPO_QUICK_PICKS + 3 }, (_, idx) =>
      repoTarget(`acme/repo-${idx}`)
    );
    expect(buildTargetQuickPickButtons(alternatives)).toHaveLength(MAX_REPO_QUICK_PICKS);
  });

  it("truncates long button labels to Slack's 75-character limit", () => {
    const [button] = buildTargetQuickPickButtons([repoTarget("acme/long", "x".repeat(100))]);
    expect(button.text.text).toHaveLength(75);
    expect(button.text.text.endsWith("…")).toBe(true);
  });

  it("falls back to fullName for picks that share a display name", () => {
    const buttons = buildTargetQuickPickButtons([
      repoTarget("acme/web", "web"),
      repoTarget("other/web", "web"),
      repoTarget("acme/api", "api"),
    ]);

    expect(buttons.map((button) => button.text.text)).toEqual(["acme/web", "other/web", "api"]);
  });

  it("disambiguates an environment that shares its name with a repo", () => {
    const buttons = buildTargetQuickPickButtons([
      repoTarget("acme/web", "web"),
      environmentTarget("env_abc123", "web"),
    ]);

    expect(buttons.map((button) => button.text.text)).toEqual(["acme/web", "web (environment)"]);
  });
});

describe("resolveTargetValue", () => {
  const env = {} as Env;
  const target = repoTarget("acme/web");
  const envTarget = environmentTarget("env_abc123", "full-stack");

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue([target.kind === "repository" ? target.repo : null]);
    mockGetEnvironmentById.mockResolvedValue(undefined);
  });

  it("resolves a repository value against the live repo list", async () => {
    expect(await resolveTargetValue(env, "acme/web")).toEqual(target);
  });

  it("resolves an env: value against the live environments", async () => {
    mockGetEnvironmentById.mockResolvedValue(
      envTarget.kind === "environment" ? envTarget.environment : null
    );
    expect(await resolveTargetValue(env, "env:env_abc123")).toEqual(envTarget);
    expect(mockGetEnvironmentById).toHaveBeenCalledWith(env, "env_abc123", undefined);
  });

  it("returns null for a repository or environment that no longer exists", async () => {
    expect(await resolveTargetValue(env, "acme/gone")).toBeNull();
    expect(await resolveTargetValue(env, "env:env_deleted")).toBeNull();
  });
});

describe("baseActionId", () => {
  it("collapses indexed quick-pick ids to the bare constant, passing others through", () => {
    expect(baseActionId(quickPickActionId(0))).toBe(SELECT_REPO_QUICK_PICK_ACTION_ID);
    expect(baseActionId(quickPickActionId(4))).toBe(SELECT_REPO_QUICK_PICK_ACTION_ID);
    // Messages posted before the per-button suffix existed stay clickable.
    expect(baseActionId(SELECT_REPO_QUICK_PICK_ACTION_ID)).toBe(SELECT_REPO_QUICK_PICK_ACTION_ID);
    expect(baseActionId(SELECT_REPO_ACTION_ID)).toBe(SELECT_REPO_ACTION_ID);
    expect(baseActionId("view_session")).toBe("view_session");
  });
});

describe("buildRepoClarificationBlocks", () => {
  it("renders an inline picker when the repo list fits in Slack's static option limit", () => {
    const repos = [repo("acme/web"), repo("acme/api")];
    const blocks = buildRepoClarificationBlocks("could not tell which repo", undefined, repos);

    expect(blocks).toHaveLength(2);
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
    expect(blocks).toMatchObject([
      { type: "section", text: { text: expect.stringContaining("could not tell which repo") } },
      {
        type: "section",
        text: { text: "Which repository should I work with?" },
        accessory: {
          type: "static_select",
          action_id: SELECT_REPO_ACTION_ID,
          options: [
            { text: { type: "plain_text", text: "web" }, value: "acme/web" },
            { text: { type: "plain_text", text: "api" }, value: "acme/api" },
          ],
        },
      },
    ]);
  });

  it("renders ranked quick-pick buttons above the picker when alternatives exist", () => {
    const repos = [repo("acme/web"), repo("acme/api"), repo("acme/docs")];
    const blocks = buildRepoClarificationBlocks(
      "maybe one of these",
      [repoTarget("acme/web"), repoTarget("acme/api")],
      repos
    );

    expect(blocks).toHaveLength(3);
    expect(blocks).toMatchObject([
      { type: "section" },
      {
        type: "actions",
        block_id: "repo_quick_picks",
        elements: [
          { type: "button", action_id: quickPickActionId(0), value: "acme/web" },
          { type: "button", action_id: quickPickActionId(1), value: "acme/api" },
        ],
      },
      {
        type: "section",
        text: { text: "Or choose another repository:" },
        accessory: { type: "static_select", action_id: SELECT_REPO_ACTION_ID },
      },
    ]);
  });

  it("uses the searchable external picker when the repo list exceeds Slack's static option limit", () => {
    const repos = Array.from({ length: MAX_REPO_SUGGESTION_OPTIONS + 1 }, (_, idx) =>
      repo(`acme/repo-${idx}`)
    );
    const blocks = buildRepoClarificationBlocks("too many to inline", undefined, repos);

    expect(blocks).toMatchObject([
      { type: "section" },
      {
        type: "section",
        text: { text: "Which repository should I work with?" },
        accessory: {
          type: "external_select",
          action_id: SELECT_REPO_ACTION_ID,
          min_query_length: 0,
        },
      },
    ]);
  });
});
