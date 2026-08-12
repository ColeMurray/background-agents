import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentActivity,
  fetchIssueDetails,
  fetchUser,
  getRepoSuggestions,
  linearGraphQL,
  postIssueComment,
} from "./linear-client";
import type { LinearApiClient } from "./linear-client";

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

describe("linearGraphQL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a GraphQL response that is not an object", async () => {
    mockFetchResponse([]);

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toThrow(
      "Linear GraphQL error: unexpected response shape"
    );
  });

  it("rejects a null GraphQL response", async () => {
    mockFetchResponse(null);

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toThrow(
      "Linear GraphQL error: unexpected response shape"
    );
  });

  it("returns the envelope for a well-formed GraphQL response", async () => {
    mockFetchResponse({ data: { viewer: { id: "user-1" } } });

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).resolves.toEqual({
      data: { viewer: { id: "user-1" } },
    });
  });
});

describe("fetchUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns user with name and email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-1", name: "Alice", email: "alice@example.com" },
      },
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toEqual({
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("returns null email when user has no email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-2", name: "Bob", email: null },
      },
    });

    const result = await fetchUser(client, "user-2");
    expect(result).toEqual({
      id: "user-2",
      name: "Bob",
      email: null,
    });
  });

  it("returns null when user is not found", async () => {
    mockFetchResponse({ data: { user: null } });

    const result = await fetchUser(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null on GraphQL errors payload", async () => {
    mockFetchResponse({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null when the user payload is malformed", async () => {
    mockFetchResponse({ data: { user: { id: "user-1", email: "alice@example.com" } } });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });
});

describe("fetchIssueDetails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns issue details with nullable fields", async () => {
    mockFetchResponse({
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

    await expect(fetchIssueDetails(client, "issue-1")).resolves.toEqual({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix bug",
      description: null,
      url: "https://linear.app/acme/issue/ENG-1",
      priority: 2,
      priorityLabel: "High",
      labels: [{ id: "label-1", name: "bug" }],
      project: null,
      assignee: null,
      team: { id: "team-1", key: "ENG", name: "Engineering" },
      comments: [{ body: "please fix", user: null }],
    });
  });

  it("returns null when the issue payload is malformed", async () => {
    mockFetchResponse({ data: { issue: { id: "issue-1", title: "missing fields" } } });

    await expect(fetchIssueDetails(client, "issue-1")).resolves.toBeNull();
  });
});

describe("getRepoSuggestions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed repo suggestions", async () => {
    mockFetchResponse({
      data: {
        issueRepositorySuggestions: {
          suggestions: [{ repositoryFullName: "acme/api", confidence: 0.92 }],
        },
      },
    });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([
      { repositoryFullName: "acme/api", confidence: 0.92 },
    ]);
  });

  it("returns an empty list when suggestions are null", async () => {
    mockFetchResponse({ data: { issueRepositorySuggestions: null } });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([]);
  });

  it("returns an empty list when suggestions are malformed", async () => {
    mockFetchResponse({
      data: { issueRepositorySuggestions: { suggestions: [{ repositoryFullName: "acme/api" }] } },
    });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([]);
  });
});

describe("emitAgentActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a failed terminal activity delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(
      emitAgentActivity(client, "agent-session-1", {
        type: "response",
        body: "Finished",
      })
    ).resolves.toBe(false);
  });
});

describe("postIssueComment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns success from a valid comment mutation response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: { success: true } } }),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: true,
    });
  });

  it("returns false when the nullable comment mutation result is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: null } }),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });

  it("returns false when the comment mutation response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: { success: "yes" } } }),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });

  it("returns false when the comment mutation response is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });
});
