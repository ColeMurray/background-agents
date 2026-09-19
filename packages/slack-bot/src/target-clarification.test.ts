import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env, SlackSessionTarget } from "./types";
import { MAX_REPO_SUGGESTION_OPTIONS } from "./app-home/constants";
import { NO_REPOSITORY_TARGET_VALUE } from "./targets";

const { mockGetAvailableRepos, mockGetAvailableEnvironments, mockGetEnvironmentById } = vi.hoisted(
  () => ({
    mockGetAvailableRepos: vi.fn(),
    mockGetAvailableEnvironments: vi.fn(),
    mockGetEnvironmentById: vi.fn(),
  })
);

vi.mock("./classifier/repos", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getAvailableRepos: mockGetAvailableRepos,
}));

vi.mock("./classifier/environments", () => ({
  getAvailableEnvironments: mockGetAvailableEnvironments,
  getEnvironmentById: mockGetEnvironmentById,
}));

import { filterReposByQuery } from "./classifier/repos";
import {
  MAX_TARGET_QUICK_PICKS,
  SELECT_TARGET_ACTION_ID,
  SELECT_TARGET_QUICK_PICK_ACTION_ID,
  buildTargetClarificationBlocks,
  buildTargetQuickPickButtons,
  baseActionId,
  countClarificationOptions,
  getTargetClarificationOptions,
  parseTargetInteractionRequestId,
  quickPickActionId,
  resolveTargetValue,
  targetPickerBlockId,
  targetQuickPickBlockId,
  targetSelectedText,
} from "./target-clarification";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

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

function environment(id: string, name: string, description: string | null = null): Environment {
  return {
    id,
    name,
    description,
    prebuildEnabled: false,
    createdAt: 1,
    updatedAt: 1,
    repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
  };
}

function repoTarget(fullName: string, displayName?: string): SlackSessionTarget {
  return { kind: "repository", repo: repo(fullName, displayName) };
}

function environmentTarget(id: string, name: string): SlackSessionTarget {
  return { kind: "environment", environment: environment(id, name) };
}

const noRepositoryTarget: SlackSessionTarget = { kind: "none" };

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

  it("maps a no-repository alternative to a button", () => {
    expect(buildTargetQuickPickButtons([noRepositoryTarget])).toEqual([
      {
        type: "button",
        action_id: quickPickActionId(0),
        text: { type: "plain_text", text: "No repository" },
        value: NO_REPOSITORY_TARGET_VALUE,
      },
    ]);
  });

  it("gives each button a unique action_id so Slack accepts the block", () => {
    // Slack requires action_id to be unique within an actions block.
    const buttons = buildTargetQuickPickButtons(
      Array.from({ length: MAX_TARGET_QUICK_PICKS }, (_, idx) => repoTarget(`acme/repo-${idx}`))
    );
    const actionIds = buttons.map((button) => button.action_id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds.every((id) => baseActionId(id) === SELECT_TARGET_QUICK_PICK_ACTION_ID)).toBe(
      true
    );
  });

  it("caps the number of buttons at MAX_TARGET_QUICK_PICKS", () => {
    const alternatives = Array.from({ length: MAX_TARGET_QUICK_PICKS + 3 }, (_, idx) =>
      repoTarget(`acme/repo-${idx}`)
    );
    expect(buildTargetQuickPickButtons(alternatives)).toHaveLength(MAX_TARGET_QUICK_PICKS);
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

  it("resolves no repository without fetching a catalog entity", async () => {
    expect(await resolveTargetValue(env, NO_REPOSITORY_TARGET_VALUE)).toEqual({ kind: "none" });
    expect(mockGetAvailableRepos).not.toHaveBeenCalled();
    expect(mockGetEnvironmentById).not.toHaveBeenCalled();
  });
});

describe("baseActionId", () => {
  it("collapses indexed quick-pick ids to the bare constant, passing others through", () => {
    expect(baseActionId(quickPickActionId(0))).toBe(SELECT_TARGET_QUICK_PICK_ACTION_ID);
    expect(baseActionId(quickPickActionId(4))).toBe(SELECT_TARGET_QUICK_PICK_ACTION_ID);
    // Messages posted before the per-button suffix existed stay clickable.
    expect(baseActionId(SELECT_TARGET_QUICK_PICK_ACTION_ID)).toBe(
      SELECT_TARGET_QUICK_PICK_ACTION_ID
    );
    expect(baseActionId(SELECT_TARGET_ACTION_ID)).toBe(SELECT_TARGET_ACTION_ID);
    expect(baseActionId("view_session")).toBe("view_session");
  });
});

describe("target interaction block ids", () => {
  it("round-trips picker and quick-pick request ids", () => {
    expect(parseTargetInteractionRequestId(targetPickerBlockId(REQUEST_ID), "picker")).toBe(
      REQUEST_ID
    );
    expect(parseTargetInteractionRequestId(targetQuickPickBlockId(REQUEST_ID), "quick_pick")).toBe(
      REQUEST_ID
    );
  });

  it("rejects malformed and mismatched block ids", () => {
    expect(parseTargetInteractionRequestId("target_picker:not-a-uuid", "picker")).toBeNull();
    expect(
      parseTargetInteractionRequestId(targetQuickPickBlockId(REQUEST_ID), "picker")
    ).toBeNull();
    expect(
      parseTargetInteractionRequestId(`${targetPickerBlockId(REQUEST_ID)}:extra`, "picker")
    ).toBeNull();
  });
});

describe("getTargetClarificationOptions", () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue([repo("acme/web"), repo("acme/api")]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
  });

  it("returns flat options while the workspace is repository-only", async () => {
    const response = await getTargetClarificationOptions(env, undefined);
    expect(response).toEqual({
      options: [
        {
          text: { type: "plain_text", text: "No repository" },
          description: { type: "plain_text", text: "Start without cloning a repository" },
          value: NO_REPOSITORY_TARGET_VALUE,
        },
        {
          text: { type: "plain_text", text: "web" },
          description: expect.any(Object),
          value: "acme/web",
        },
        {
          text: { type: "plain_text", text: "api" },
          description: expect.any(Object),
          value: "acme/api",
        },
      ],
    });
    expect(countClarificationOptions(response)).toBe(3);
  });

  it("groups environments above repositories when environments exist", async () => {
    mockGetAvailableEnvironments.mockResolvedValue([
      environment("env_abc123", "full-stack", "web + api"),
    ]);

    const response = await getTargetClarificationOptions(env, undefined);
    expect(response).toEqual({
      option_groups: [
        {
          label: { type: "plain_text", text: "Environments" },
          options: [
            {
              text: { type: "plain_text", text: "full-stack" },
              description: { type: "plain_text", text: "web + api" },
              value: "env:env_abc123",
            },
          ],
        },
        {
          label: { type: "plain_text", text: "Repositories" },
          options: [
            expect.objectContaining({ value: "acme/web" }),
            expect.objectContaining({ value: "acme/api" }),
          ],
        },
        {
          label: { type: "plain_text", text: "Other" },
          options: [expect.objectContaining({ value: NO_REPOSITORY_TARGET_VALUE })],
        },
      ],
    });
    expect(countClarificationOptions(response)).toBe(4);
  });

  it("describes an environment without a description by its repository count", async () => {
    mockGetAvailableEnvironments.mockResolvedValue([environment("env_abc123", "full-stack")]);

    const response = await getTargetClarificationOptions(env, "full");
    if (!("option_groups" in response)) throw new Error("expected groups");
    expect(response.option_groups[0].options[0].description).toEqual({
      type: "plain_text",
      text: "1 repository",
    });
  });

  it("keeps no repository available when the query matches only a repository", async () => {
    mockGetAvailableEnvironments.mockResolvedValue([environment("env_abc123", "full-stack")]);

    const response = await getTargetClarificationOptions(env, "api");
    expect(response).toEqual({
      options: [
        expect.objectContaining({ value: NO_REPOSITORY_TARGET_VALUE }),
        expect.objectContaining({ value: "acme/api" }),
      ],
    });
  });

  it("caps combined options at Slack's per-response limit, environments first", async () => {
    mockGetAvailableEnvironments.mockResolvedValue(
      Array.from({ length: 3 }, (_, idx) => environment(`env_${idx}`, `environment-${idx}`))
    );
    mockGetAvailableRepos.mockResolvedValue(
      Array.from({ length: MAX_REPO_SUGGESTION_OPTIONS }, (_, idx) => repo(`acme/repo-${idx}`))
    );

    const response = await getTargetClarificationOptions(env, undefined);
    expect(countClarificationOptions(response)).toBe(MAX_REPO_SUGGESTION_OPTIONS);
    if (!("option_groups" in response)) throw new Error("expected groups");
    expect(response.option_groups[0].options).toHaveLength(3);
    expect(response.option_groups[1].options).toHaveLength(MAX_REPO_SUGGESTION_OPTIONS - 4);
    expect(response.option_groups[2]).toMatchObject({
      label: { text: "Other" },
      options: [expect.objectContaining({ value: NO_REPOSITORY_TARGET_VALUE })],
    });
  });
});

describe("buildTargetClarificationBlocks", () => {
  it("renders an inline picker when the target list fits in Slack's static option limit", () => {
    const repos = [repo("acme/web"), repo("acme/api")];
    const blocks = buildTargetClarificationBlocks(
      "could not tell which repo",
      undefined,
      { repos, environments: [] },
      REQUEST_ID
    );

    expect(blocks).toHaveLength(2);
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
    expect(blocks).toMatchObject([
      { type: "section", text: { text: expect.stringContaining("could not tell which repo") } },
      {
        type: "section",
        block_id: targetPickerBlockId(REQUEST_ID),
        text: { text: "Which target should I use?" },
        accessory: {
          type: "static_select",
          action_id: SELECT_TARGET_ACTION_ID,
          placeholder: { type: "plain_text", text: "Select a target" },
          options: [
            {
              text: { type: "plain_text", text: "No repository" },
              value: NO_REPOSITORY_TARGET_VALUE,
            },
            { text: { type: "plain_text", text: "web" }, value: "acme/web" },
            { text: { type: "plain_text", text: "api" }, value: "acme/api" },
          ],
        },
      },
    ]);
  });

  it("groups the inline picker when environments exist", () => {
    const repos = [repo("acme/web")];
    const environments = [environment("env_abc123", "full-stack")];
    const blocks = buildTargetClarificationBlocks(
      "unsure",
      undefined,
      { repos, environments },
      REQUEST_ID
    );

    expect(blocks).toMatchObject([
      { type: "section", text: { text: expect.stringContaining("which target") } },
      {
        type: "section",
        block_id: targetPickerBlockId(REQUEST_ID),
        text: { text: "Which target should I use?" },
        accessory: {
          type: "static_select",
          action_id: SELECT_TARGET_ACTION_ID,
          placeholder: { type: "plain_text", text: "Select a target" },
          option_groups: [
            {
              label: { type: "plain_text", text: "Environments" },
              options: [expect.objectContaining({ value: "env:env_abc123" })],
            },
            {
              label: { type: "plain_text", text: "Repositories" },
              options: [expect.objectContaining({ value: "acme/web" })],
            },
            {
              label: { type: "plain_text", text: "Other" },
              options: [expect.objectContaining({ value: NO_REPOSITORY_TARGET_VALUE })],
            },
          ],
        },
      },
    ]);
  });

  it("renders ranked quick-pick buttons above the picker when alternatives exist", () => {
    const repos = [repo("acme/web"), repo("acme/api"), repo("acme/docs")];
    const blocks = buildTargetClarificationBlocks(
      "maybe one of these",
      [repoTarget("acme/web"), repoTarget("acme/api")],
      { repos, environments: [] },
      REQUEST_ID
    );

    expect(blocks).toHaveLength(3);
    expect(blocks).toMatchObject([
      { type: "section" },
      {
        type: "actions",
        block_id: targetQuickPickBlockId(REQUEST_ID),
        elements: [
          { type: "button", action_id: quickPickActionId(0), value: "acme/web" },
          { type: "button", action_id: quickPickActionId(1), value: "acme/api" },
        ],
      },
      {
        type: "section",
        block_id: targetPickerBlockId(REQUEST_ID),
        text: { text: "Or choose another target:" },
        accessory: { type: "static_select", action_id: SELECT_TARGET_ACTION_ID },
      },
    ]);
  });

  it("uses target-neutral copy when an environment is among the alternatives", () => {
    const blocks = buildTargetClarificationBlocks(
      "one of these",
      [repoTarget("acme/web"), environmentTarget("env_abc123", "full-stack")],
      { repos: [repo("acme/web")], environments: [] },
      REQUEST_ID
    );

    expect(blocks[0]).toMatchObject({
      type: "section",
      text: { text: expect.stringContaining("which target") },
    });
    expect(blocks[2]).toMatchObject({
      type: "section",
      text: { text: "Or choose another target:" },
    });
  });

  it("uses the searchable external picker when the target list exceeds Slack's static option limit", () => {
    const repos = Array.from({ length: MAX_REPO_SUGGESTION_OPTIONS + 1 }, (_, idx) =>
      repo(`acme/repo-${idx}`)
    );
    const blocks = buildTargetClarificationBlocks(
      "too many to inline",
      undefined,
      { repos, environments: [] },
      REQUEST_ID
    );

    expect(blocks).toMatchObject([
      { type: "section" },
      {
        type: "section",
        block_id: targetPickerBlockId(REQUEST_ID),
        text: { text: "Which target should I use?" },
        accessory: {
          type: "external_select",
          action_id: SELECT_TARGET_ACTION_ID,
          min_query_length: 0,
        },
      },
    ]);
  });

  it("offers no repository when the catalog is empty", () => {
    const blocks = buildTargetClarificationBlocks(
      "no catalog targets",
      undefined,
      { repos: [], environments: [] },
      REQUEST_ID
    );

    expect(blocks[1]).toMatchObject({
      accessory: {
        type: "static_select",
        options: [expect.objectContaining({ value: NO_REPOSITORY_TARGET_VALUE })],
      },
    });
    expect(blocks[0]).toMatchObject({
      text: { text: expect.stringContaining("if you expected other targets") },
    });
  });
});

describe("targetSelectedText", () => {
  it("names the chosen repository", () => {
    expect(targetSelectedText(repoTarget("acme/web"))).toBe("Using *acme/web*");
  });

  it("names the no-repository choice", () => {
    expect(targetSelectedText(noRepositoryTarget)).toBe("Using *No repository*");
  });

  it("escapes an environment name so it cannot render as a mention", () => {
    expect(targetSelectedText(environmentTarget("env_1", "<!channel> staging"))).toBe(
      "Using *&lt;!channel&gt; staging*"
    );
  });
});
