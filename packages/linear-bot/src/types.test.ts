import { describe, expect, it } from "vitest";
import {
  linearIssueDetailsResponseSchema,
  linearRepoSuggestionsResponseSchema,
  linearUserResponseSchema,
} from "./types";

describe("Linear response schemas", () => {
  it("parses issue details and preserves nullable Linear fields", () => {
    const result = linearIssueDetailsResponseSchema.safeParse({
      data: {
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Fix bug",
          description: null,
          url: "https://linear.app/acme/issue/ENG-1",
          priority: 2,
          priorityLabel: "High",
          labels: { nodes: [{ id: "label-1", name: "bug" }] },
          project: null,
          assignee: null,
          team: { id: "team-1", key: "ENG", name: "Engineering" },
          comments: { nodes: [{ body: "please fix", user: null }] },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.data?.issue?.labels).toEqual([
      { id: "label-1", name: "bug" },
    ]);
    expect(result.success && result.data.data?.issue?.comments).toEqual([
      { body: "please fix", user: null },
    ]);
  });

  it("rejects malformed issue details", () => {
    const result = linearIssueDetailsResponseSchema.safeParse({
      data: { issue: { id: "issue-1", title: "missing required fields" } },
    });

    expect(result.success).toBe(false);
  });

  it("parses nullable repo suggestions and user responses", () => {
    expect(
      linearRepoSuggestionsResponseSchema.safeParse({
        data: { issueRepositorySuggestions: null },
      }).success
    ).toBe(true);
    expect(linearUserResponseSchema.safeParse({ data: { user: null } }).success).toBe(true);
  });
});
