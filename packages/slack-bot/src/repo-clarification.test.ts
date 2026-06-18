import { describe, expect, it } from "vitest";
import type { RepoConfig } from "./types";
import { filterReposByQuery } from "./classifier/repos";
import {
  MAX_REPO_QUICK_PICKS,
  SELECT_REPO_QUICK_PICK_ACTION_ID,
  buildRepoClarificationBlocks,
  buildRepoQuickPickButtons,
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
        action_id: SELECT_REPO_QUICK_PICK_ACTION_ID,
        text: { type: "plain_text", text: "web" },
        value: "acme/web",
      },
      {
        type: "button",
        action_id: SELECT_REPO_QUICK_PICK_ACTION_ID,
        text: { type: "plain_text", text: "api" },
        value: "acme/api",
      },
    ]);
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
});

describe("buildRepoClarificationBlocks", () => {
  it("renders only the searchable picker when there are no alternatives", () => {
    const blocks = buildRepoClarificationBlocks("could not tell which repo", undefined);

    expect(blocks).toHaveLength(2);
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
    expect(blocks).toMatchObject([
      { type: "section", text: { text: expect.stringContaining("could not tell which repo") } },
      {
        type: "section",
        text: { text: "Which repository should I work with?" },
        accessory: { type: "external_select", action_id: "select_repo", min_query_length: 0 },
      },
    ]);
  });

  it("renders ranked quick-pick buttons above the picker when alternatives exist", () => {
    const blocks = buildRepoClarificationBlocks("maybe one of these", [
      repo("acme/web"),
      repo("acme/api"),
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks).toMatchObject([
      { type: "section" },
      {
        type: "actions",
        block_id: "repo_quick_picks",
        elements: [
          { type: "button", action_id: SELECT_REPO_QUICK_PICK_ACTION_ID, value: "acme/web" },
          { type: "button", action_id: SELECT_REPO_QUICK_PICK_ACTION_ID, value: "acme/api" },
        ],
      },
      {
        type: "section",
        text: { text: "Or search for another repository:" },
        accessory: { type: "external_select", action_id: "select_repo" },
      },
    ]);
  });
});
