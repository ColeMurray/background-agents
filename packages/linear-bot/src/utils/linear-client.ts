/**
 * Linear API client utilities — OAuth + raw GraphQL.
 */

import type { Env, OAuthTokenResponse, StoredTokenData, LinearIssueDetails } from "../types";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "./crypto";
import { createLogger } from "../logger";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const OAUTH_TOKEN_KEY_PREFIX = "oauth:token:";

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

function getWorkspaceTokenKey(orgId: string): string {
  return `${OAUTH_TOKEN_KEY_PREFIX}${orgId}`;
}

export function buildOAuthAuthorizeUrl(env: Env): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "read,write,app:assignable,app:mentionable");
  authUrl.searchParams.set("actor", "app");
  return authUrl.toString();
}

export async function exchangeCodeForToken(
  env: Env,
  code: string
): Promise<{ orgId: string; orgName: string }> {
  const tokenRes = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      code,
      redirect_uri: `${env.WORKER_URL}/oauth/callback`,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }

  const tokenData = (await tokenRes.json()) as OAuthTokenResponse;
  const workspaceInfo = await getWorkspaceInfo(tokenData.access_token);

  const stored: StoredTokenData = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };
  await env.LINEAR_KV.put(getWorkspaceTokenKey(workspaceInfo.id), JSON.stringify(stored));

  return { orgId: workspaceInfo.id, orgName: workspaceInfo.name };
}

export async function getOAuthToken(env: Env, orgId: string): Promise<string | null> {
  const raw = await env.LINEAR_KV.get(getWorkspaceTokenKey(orgId));
  if (!raw) return null;

  let tokenData: StoredTokenData;
  try {
    tokenData = JSON.parse(raw) as StoredTokenData;
  } catch {
    return null;
  }

  if (Date.now() < tokenData.expires_at - 5 * 60 * 1000) {
    return tokenData.access_token;
  }

  if (!tokenData.refresh_token) return null;

  try {
    log.info("oauth.refresh", { org_id: orgId });
    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        refresh_token: tokenData.refresh_token,
      }),
    });

    if (!res.ok) {
      log.error("oauth.refresh_failed", { org_id: orgId, status: res.status });
      return null;
    }

    const refreshed = (await res.json()) as OAuthTokenResponse;
    const newStored: StoredTokenData = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
    };
    await env.LINEAR_KV.put(getWorkspaceTokenKey(orgId), JSON.stringify(newStored));
    return newStored.access_token;
  } catch (err) {
    log.error("oauth.refresh_error", {
      org_id: orgId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Linear API Client ──────────────────────────────────────────────────────

export interface LinearApiClient {
  accessToken: string;
}

export async function getLinearClient(env: Env, orgId: string): Promise<LinearApiClient | null> {
  const token = await getOAuthToken(env, orgId);
  if (!token) return null;
  return { accessToken: token };
}

/**
 * Execute a GraphQL query against the Linear API.
 */
async function linearGraphQL(
  client: LinearApiClient,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

// ─── Agent Activities ────────────────────────────────────────────────────────

export async function emitAgentActivity(
  client: LinearApiClient,
  agentSessionId: string,
  content: Record<string, unknown>,
  ephemeral?: boolean
): Promise<void> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `,
      {
        input: { agentSessionId, content, ephemeral },
      }
    );
  } catch (err) {
    log.error("linear.emit_activity_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// ─── Issue Details ───────────────────────────────────────────────────────────

/**
 * Fetch full issue details from Linear API.
 */
export async function fetchIssueDetails(
  client: LinearApiClient,
  issueId: string
): Promise<LinearIssueDetails | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query IssueDetails($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          priorityLabel
          labels { nodes { id name } }
          project { id name }
          assignee { id name }
          team { id key name }
          comments(first: 10, orderBy: createdAt) {
            nodes {
              body
              user { name }
            }
          }
        }
      }
    `,
      { id: issueId }
    );

    const issue = (data as { data?: { issue?: Record<string, unknown> } }).data?.issue;
    if (!issue) return null;

    return {
      id: issue.id as string,
      identifier: issue.identifier as string,
      title: issue.title as string,
      description: issue.description as string | null,
      url: issue.url as string,
      priority: issue.priority as number,
      priorityLabel: issue.priorityLabel as string,
      labels: (issue.labels as { nodes: Array<{ id: string; name: string }> })?.nodes || [],
      project: issue.project as { id: string; name: string } | null,
      assignee: issue.assignee as { id: string; name: string } | null,
      team: issue.team as { id: string; key: string; name: string },
      comments:
        (issue.comments as { nodes: Array<{ body: string; user?: { name: string } }> })?.nodes ||
        [],
    };
  } catch (err) {
    log.error("linear.fetch_issue_details", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Agent Session Management ────────────────────────────────────────────────

/**
 * Update an agent session (externalUrls, plan, etc.)
 */
export async function updateAgentSession(
  client: LinearApiClient,
  agentSessionId: string,
  input: Record<string, unknown>
): Promise<void> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }
    `,
      { id: agentSessionId, input }
    );
  } catch (err) {
    log.error("linear.update_session_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Use Linear's built-in repo suggestion API for issue→repo matching.
 */
export async function getRepoSuggestions(
  client: LinearApiClient,
  issueId: string,
  agentSessionId: string,
  candidateRepos: Array<{ hostname: string; repositoryFullName: string }>
): Promise<Array<{ repositoryFullName: string; confidence: number }>> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query RepoSuggestions($issueId: String!, $agentSessionId: String!, $candidateRepositories: [IssueRepositorySuggestionInput!]!) {
        issueRepositorySuggestions(
          issueId: $issueId
          agentSessionId: $agentSessionId
          candidateRepositories: $candidateRepositories
        ) {
          suggestions {
            repositoryFullName
            confidence
          }
        }
      }
    `,
      { issueId, agentSessionId, candidateRepositories: candidateRepos }
    );

    const result = data as {
      data?: {
        issueRepositorySuggestions?: {
          suggestions: Array<{ repositoryFullName: string; confidence: number }>;
        };
      };
    };
    return result.data?.issueRepositorySuggestions?.suggestions || [];
  } catch (err) {
    log.error("linear.repo_suggestions_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

// ─── Webhook Verification ────────────────────────────────────────────────────

export async function verifyLinearWebhook(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;
  const expectedHex = await computeHmacHex(body, secret);
  return timingSafeEqual(signature, expectedHex);
}

// ─── Comment Posting (fallback) ──────────────────────────────────────────────

export async function postIssueComment(
  apiKey: string,
  issueId: string,
  body: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }
      `,
      variables: { input: { issueId, body } },
    }),
  });

  if (!response.ok) return { success: false };
  const result = (await response.json()) as {
    data?: { commentCreate?: { success: boolean } };
  };
  return { success: result.data?.commentCreate?.success ?? false };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function getWorkspaceInfo(accessToken: string): Promise<{ id: string; name: string }> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `query { viewer { organization { id name } } }`,
    }),
  });

  if (!res.ok) throw new Error(`Failed to get workspace info: ${res.statusText}`);

  const data = (await res.json()) as {
    data?: { viewer?: { organization?: { id: string; name: string } } };
  };
  const org = data.data?.viewer?.organization;
  if (!org) throw new Error("No organization found in response");
  return { id: org.id, name: org.name };
}
