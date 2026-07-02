import { describe, expect, it } from "vitest";
import type { RepoConfig } from "./types";
import { MAX_REPO_SUGGESTION_OPTIONS } from "./app-home/constants";
import { filterReposByQuery } from "./classifier/repos";
import {
  MAX_REPO_QUICK_PICKS,
  SELECT_REPO_ACTION_ID,
  SELECT_REPO_QUICK_PICK_ACTION_ID,
  buildRepoClarificationBlocks,
  buildRepoQuickPickButtons,
  baseActionId,
  quickPickActionId,
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

describe("buildRepoQuickPickButtons", () => {
  it("maps alternatives to quick-pick buttons carrying the repo id", () => {
    expect(buildRepoQuickPickButtons([repo("acme/web"), repo("acme/api")])).toEqual([
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

  it("gives each button a unique action_id so Slack accepts the block", () => {
    // Slack requires action_id to be unique within an actions block.
    const buttons = buildRepoQuickPickButtons(
      Array.from({ length: MAX_REPO_QUICK_PICKS }, (_, idx) => repo(`acme/repo-${idx}`))
    );
    const actionIds = buttons.map((button) => button.action_id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds.every((id) => baseActionId(id) === SELECT_REPO_QUICK_PICK_ACTION_ID)).toBe(
      true
    );
  });

  it("caps the number of buttons at MAX_REPO_QUICK_PICKS", () => {
    const alternatives = Array.from({ length: MAX_REPO_QUICK_PICKS + 3 }, (_, idx) =>
      repo(`acme/repo-${idx}`)
    );
    expect(buildRepoQuickPickButtons(alternatives)).toHaveLength(MAX_REPO_QUICK_PICKS);
  });

  it("truncates long button labels to Slack's 75-character limit", () => {
    const [button] = buildRepoQuickPickButtons([repo("acme/long", "x".repeat(100))]);
    expect(button.text.text).toHaveLength(75);
    expect(button.text.text.endsWith("…")).toBe(true);
  });

  it("falls back to fullName for picks that share a display name", () => {
    const buttons = buildRepoQuickPickButtons([
      repo("acme/web", "web"),
      repo("other/web", "web"),
      repo("acme/api", "api"),
    ]);

    expect(buttons.map((button) => button.text.text)).toEqual(["acme/web", "other/web", "api"]);
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
    const blocks = buildRepoClarificationBlocks("maybe one of these", repos.slice(0, 2), repos);

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
