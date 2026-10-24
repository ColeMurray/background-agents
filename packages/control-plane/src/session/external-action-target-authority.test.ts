import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../db/session-index";
import { authorizeExternalActionTarget } from "./external-action-target-authority";

const session: SessionEntry = {
  id: "session-1",
  title: null,
  repoOwner: "acme",
  repoName: "widgets",
  model: "openai/gpt-5.6-sol",
  reasoningEffort: null,
  baseBranch: "main",
  status: "active",
  ownerTeamId: "team-1",
  visibility: "team",
  createdAt: 1,
  updatedAt: 1,
};

function options(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => session),
    isRepositoryAuthorized: vi.fn(async () => true),
    getChannelBinding: vi.fn(async () => ({ teamId: "team-1" })),
    hasLinearIssueContext: vi.fn(() => false),
    ...overrides,
  };
}

const base = {
  sessionId: "session-1",
  operationId: "message-1",
  action: "comment",
};

describe("authorizeExternalActionTarget", () => {
  it("requires GitHub and nested GitLab repositories to belong to the session", async () => {
    const github = options();
    await expect(
      authorizeExternalActionTarget(github, {
        ...base,
        provider: "github",
        target: { owner: "acme", repo: "widgets", number: 7 },
      })
    ).resolves.toBe(true);
    expect(github.isRepositoryAuthorized).toHaveBeenCalledWith("session-1", "acme", "widgets");

    const gitlab = options();
    await expect(
      authorizeExternalActionTarget(gitlab, {
        ...base,
        provider: "gitlab",
        target: { project: "group/subgroup/widgets", number: 7 },
      })
    ).resolves.toBe(true);
    expect(gitlab.isRepositoryAuthorized).toHaveBeenCalledWith(
      "session-1",
      "group/subgroup",
      "widgets"
    );
  });

  it("requires Slack channels to remain bound to the session team", async () => {
    await expect(
      authorizeExternalActionTarget(options(), {
        ...base,
        provider: "slack",
        action: "reply",
        target: { channel: "C123", thread: "1.2" },
      })
    ).resolves.toBe(true);

    await expect(
      authorizeExternalActionTarget(
        options({ getChannelBinding: vi.fn(async () => ({ teamId: "team-2" })) }),
        {
          ...base,
          provider: "slack",
          action: "reply",
          target: { channel: "C123", thread: "1.2" },
        }
      )
    ).resolves.toBe(false);
  });

  it("allows Linear comments only on the issue that originated the active turn", async () => {
    const authorized = options({
      hasLinearIssueContext: vi.fn((issueId: string) => issueId === "issue-1"),
    });
    await expect(
      authorizeExternalActionTarget(authorized, {
        ...base,
        provider: "linear",
        target: { issueId: "issue-1" },
      })
    ).resolves.toBe(true);
    await expect(
      authorizeExternalActionTarget(authorized, {
        ...base,
        provider: "linear",
        target: { issueId: "issue-2" },
      })
    ).resolves.toBe(false);
  });
});
