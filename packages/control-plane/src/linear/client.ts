/**
 * Linear API client (GraphQL).
 *
 * Uses LINEAR_API_KEY for authentication (personal API key: Authorization: <key>).
 */

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
  cursor?: string;
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

interface EnvWithLinear {
  LINEAR_API_KEY?: string;
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

export function listIssues(
  env: EnvWithLinear,
  options: ListIssuesOptions = {}
): Promise<{ issues: LinearIssue[]; cursor: string | null; hasMore: boolean }> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY not configured");
  }

  const limit = Math.min(options.limit ?? 50, 100);

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
  if (options.teamId) filter.team = { id: { eq: options.teamId } };
  if (options.teamKey) filter.team = { key: { eq: options.teamKey } };
  if (options.query) filter.title = { containsIgnoreCase: options.query };

  return linearFetch<LinearIssuesResponse>(apiKey, {
    query,
    variables: {
      first: limit,
      after: options.cursor ?? null,
      filter: Object.keys(filter).length ? filter : {},
    },
  }).then((data) => ({
    issues: data.issues.nodes,
    cursor: data.issues.pageInfo.endCursor,
    hasMore: data.issues.pageInfo.hasNextPage,
  }));
}

export function createIssue(env: EnvWithLinear, input: CreateIssueInput): Promise<LinearIssue> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY not configured");
  }

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

  return linearFetch<{ issueCreate: { issue: LinearIssue } }>(apiKey, {
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

export function updateIssue(
  env: EnvWithLinear,
  issueId: string,
  input: UpdateIssueInput
): Promise<LinearIssue> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY not configured");
  }

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

  return linearFetch<{ issueUpdate: { issue: LinearIssue } }>(apiKey, {
    query: mutation,
    variables: { id: issueId, input: updateInput },
  }).then((data) => data.issueUpdate.issue);
}

export function getIssue(env: EnvWithLinear, issueId: string): Promise<LinearIssue | null> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY not configured");
  }

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

  return linearFetch<{ issue: LinearIssue | null }>(apiKey, {
    query,
    variables: { id: issueId },
  }).then((data) => data.issue);
}

export function listTeams(
  env: EnvWithLinear
): Promise<Array<{ id: string; key: string; name: string }>> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY not configured");
  }

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
    apiKey,
    { query }
  ).then((data) => data.teams.nodes);
}
