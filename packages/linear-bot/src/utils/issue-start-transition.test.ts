import { describe, expect, it, vi } from "vitest";
import type { LinearApiClient } from "./linear-client";
import { transitionIssueToStarted } from "./issue-start-transition";

type LinearGraphQLExecutor = NonNullable<Parameters<typeof transitionIssueToStarted>[2]>;

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

function transitionContext(
  type: string,
  states = [{ id: "progress", name: "In Progress", position: 2 }]
) {
  return {
    data: {
      issue: {
        state: { type },
        team: { states: { nodes: states } },
      },
    },
  };
}

describe("transitionIssueToStarted", () => {
  it("moves an unstarted issue to the team's first started state", async () => {
    const execute = vi
      .fn<LinearGraphQLExecutor>()
      .mockResolvedValueOnce(
        transitionContext("unstarted", [
          { id: "review", name: "In Review", position: 3 },
          { id: "progress", name: "In Progress", position: 2 },
        ])
      )
      .mockResolvedValueOnce({ data: { issueUpdate: { success: true } } });

    await expect(transitionIssueToStarted(client, "issue-1", execute)).resolves.toEqual({
      outcome: "transitioned",
      previousStateType: "unstarted",
      stateId: "progress",
      stateName: "In Progress",
    });
    expect(execute.mock.calls[1][2]).toEqual({ issueId: "issue-1", stateId: "progress" });
  });

  it.each([
    ["started", "already_started"],
    ["completed", "terminal_completed"],
    ["canceled", "terminal_canceled"],
  ] as const)("does not move an issue in the %s workflow category", async (type, outcome) => {
    const execute = vi.fn<LinearGraphQLExecutor>().mockResolvedValue(transitionContext(type));

    await expect(transitionIssueToStarted(client, "issue-1", execute)).resolves.toEqual({
      outcome,
      previousStateType: type,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not mutate when the team has no started workflow state", async () => {
    const execute = vi
      .fn<LinearGraphQLExecutor>()
      .mockResolvedValue(transitionContext("unstarted", []));

    await expect(transitionIssueToStarted(client, "issue-1", execute)).resolves.toEqual({
      outcome: "no_started_state",
      previousStateType: "unstarted",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("classifies a missing issue as a permanent no-op", async () => {
    const execute = vi.fn<LinearGraphQLExecutor>().mockResolvedValue({ data: { issue: null } });

    await expect(transitionIssueToStarted(client, "issue-1", execute)).resolves.toEqual({
      outcome: "issue_not_found",
    });
  });

  it("rejects malformed Linear data", async () => {
    const execute = vi.fn<LinearGraphQLExecutor>().mockResolvedValue({ data: {} });

    await expect(transitionIssueToStarted(client, "issue-1", execute)).rejects.toThrow();
  });

  it("rejects an unsuccessful mutation", async () => {
    const execute = vi
      .fn<LinearGraphQLExecutor>()
      .mockResolvedValueOnce(transitionContext("unstarted"))
      .mockResolvedValueOnce({ data: { issueUpdate: { success: false } } });

    await expect(transitionIssueToStarted(client, "issue-1", execute)).rejects.toThrow();
  });
});
