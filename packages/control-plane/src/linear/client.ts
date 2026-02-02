import type { LinearPort } from "../ports/linear-port";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  state?: { id: string; name: string } | null;
  team?: { id: string; key: string; name: string } | null;
}

export interface LinearIssuesResponse {
  issues: {
    nodes: LinearIssue[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface ListIssuesOptions {
  teamId?: string;
  teamKey?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description?: string | null;
}

export interface UpdateIssueInput {
  stateId?: string | null;
  assigneeId?: string | null;
  title?: string | null;
  description?: string | null;
}

function getAuthHeader(apiKey: string): string {
  return apiKey;
}

async function linearFetch<T>(
  apiKey: string,
  body: { query: string; variables?: Record<string, unknown> }
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader(apiKey),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 429) {
      throw new Error("Linear rate limit exceeded");
    }
    throw new Error(`Linear API error: ${response.status} ${text}`);
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("Linear API: no data in response");
  }

  return json.data as T;
}

export class LinearClient implements LinearPort {
  constructor(private apiKey: string) {
    if (!apiKey) {
      throw new Error("LinearClient requires LINEAR_API_KEY");
    }
  }

  async listIssues(
    teamId: string,
    filters: ListIssuesOptions = {}
  ): Promise<{ issues: LinearIssue[]; cursor: string | null; hasMore: boolean }> {
    const limit = Math.min(filters.limit ?? 50, 100);

    const query = `
      query ListIssues($first: Int!, $after: String, $filter: IssueFilter) {
        issues(first: $first, after: $after, filter: $filter) {
          nodes {
            id
            identifier
            title
            description
            url
            state { id name }
            team { id key name }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const filter: Record<string, unknown> = {};
    if (teamId) filter.team = { id: { eq: teamId } };
    if (filters.teamKey) filter.team = { key: { eq: filters.teamKey } };
    if (filters.query) filter.title = { containsIgnoreCase: filters.query };

    return linearFetch<LinearIssuesResponse>(this.apiKey, {
      query,
      variables: {
        first: limit,
        after: filters.cursor ?? null,
        filter: Object.keys(filter).length ? filter : {},
      },
    }).then((data) => ({
      issues: data.issues.nodes,
      cursor: data.issues.pageInfo.endCursor,
      hasMore: data.issues.pageInfo.hasNextPage,
    }));
  }

  async createIssue(input: CreateIssueInput): Promise<LinearIssue> {
    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
            identifier
            title
            description
            url
            state { id name }
            team { id key name }
          }
        }
      }
    `;

    return linearFetch<{ issueCreate: { issue: LinearIssue } }>(this.apiKey, {
      query: mutation,
      variables: {
        input: {
          teamId: input.teamId,
          title: input.title,
          description: input.description ?? null,
        },
      },
    }).then((data) => data.issueCreate.issue);
  }

  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<LinearIssue> {
    const mutation = `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          issue {
            id
            identifier
            title
            description
            url
            state { id name }
            team { id key name }
          }
        }
      }
    `;

    const updateInput: Record<string, unknown> = {};
    if (input.stateId !== undefined) updateInput.stateId = input.stateId;
    if (input.assigneeId !== undefined) updateInput.assigneeId = input.assigneeId;
    if (input.title !== undefined) updateInput.title = input.title;
    if (input.description !== undefined) updateInput.description = input.description;

    return linearFetch<{ issueUpdate: { issue: LinearIssue } }>(this.apiKey, {
      query: mutation,
      variables: { id: issueId, input: updateInput },
    }).then((data) => data.issueUpdate.issue);
  }

  async getIssue(issueId: string): Promise<LinearIssue | null> {
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          state { id name }
          team { id key name }
        }
      }
    `;

    return linearFetch<{ issue: LinearIssue | null }>(this.apiKey, {
      query,
      variables: { id: issueId },
    }).then((data) => data.issue);
  }

  async listTeams(): Promise<Array<{ id: string; key: string; name: string }>> {
    const query = `
      query ListTeams {
        teams {
          nodes {
            id
            key
            name
          }
        }
      }
    `;

    return linearFetch<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
      this.apiKey,
      { query }
    ).then((data) => data.teams.nodes);
  }
}

// Keep standalone functions for backward compatibility if needed, or remove them.
// Removing them as we are refactoring to use the class.
