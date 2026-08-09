import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearApiClient } from "./linear-client";
import { transitionIssueToStarted } from "./issue-start-transition";

const mockLinearGraphQL = vi.hoisted(() => vi.fn());

vi.mock("./linear-client", () => ({ linearGraphQL: mockLinearGraphQL }));

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
  beforeEach(() => {
    mockLinearGraphQL.mockReset();
  });

  it("moves an unstarted issue to the team's first started state", async () => {
    mockLinearGraphQL
      .mockResolvedValueOnce(
        transitionContext("unstarted", [
          { id: "review", name: "In Review", position: 3 },
          { id: "progress", name: "In Progress", position: 2 },
        ])
      )
      .mockResolvedValueOnce({ data: { issueUpdate: { success: true } } });

    await expect(transitionIssueToStarted(client, "issue-1")).resolves.toEqual({
      outcome: "transitioned",
      previousStateType: "unstarted",
      stateId: "progress",
      stateName: "In Progress",
    });
    expect(mockLinearGraphQL.mock.calls[1][2]).toEqual({
      issueId: "issue-1",
      stateId: "progress",
    });
  });

  it.each([
    ["started", "already_started"],
    ["completed", "terminal_completed"],
    ["canceled", "terminal_canceled"],
  ] as const)("does not move an issue in the %s workflow category", async (type, outcome) => {
    mockLinearGraphQL.mockResolvedValue(transitionContext(type));

    await expect(transitionIssueToStarted(client, "issue-1")).resolves.toEqual({
      outcome,
      previousStateType: type,
    });
    expect(mockLinearGraphQL).toHaveBeenCalledOnce();
  });

  it("does not mutate when the team has no started workflow state", async () => {
    mockLinearGraphQL.mockResolvedValue(transitionContext("unstarted", []));

    await expect(transitionIssueToStarted(client, "issue-1")).resolves.toEqual({
      outcome: "no_started_state",
      previousStateType: "unstarted",
    });
    expect(mockLinearGraphQL).toHaveBeenCalledOnce();
  });

  it("classifies a missing issue as a permanent no-op", async () => {
    mockLinearGraphQL.mockResolvedValue({ data: { issue: null } });

    await expect(transitionIssueToStarted(client, "issue-1")).resolves.toEqual({
      outcome: "issue_not_found",
    });
  });

  it("rejects malformed Linear data", async () => {
    mockLinearGraphQL.mockResolvedValue({ data: {} });

    await expect(transitionIssueToStarted(client, "issue-1")).rejects.toThrow();
  });

  it("rejects an unsuccessful mutation", async () => {
    mockLinearGraphQL
      .mockResolvedValueOnce(transitionContext("unstarted"))
      .mockResolvedValueOnce({ data: { issueUpdate: { success: false } } });

    await expect(transitionIssueToStarted(client, "issue-1")).rejects.toThrow();
  });
});
