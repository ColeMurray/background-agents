/**
 * Linear API client utilities — OAuth + raw GraphQL.
 */

import type { Env, OAuthTokenResponse, StoredTokenData, LinearIssueDetails } from "../types";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "./crypto";
import { createLogger } from "../logger";
import {
  beginLinearAuthNotification,
  buildLinearAuthNotificationFingerprint,
  completeLinearAuthNotification,
  getLinearAuthState,
  setLinearAuthState,
} from "../kv-store";
import type { LinearWorkspaceAuthStatus } from "../types";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const OAUTH_TOKEN_KEY_PREFIX = "oauth:token:";
const OAUTH_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

type ParsedStoredTokenData = Pick<StoredTokenData, "access_token" | "expires_at"> &
  Partial<Pick<StoredTokenData, "refresh_token">>;

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

function getWorkspaceTokenKey(orgId: string): string {
  return `${OAUTH_TOKEN_KEY_PREFIX}${orgId}`;
}

export async function deleteOAuthToken(env: Env, orgId: string): Promise<void> {
  await env.LINEAR_KV.delete(getWorkspaceTokenKey(orgId));
}

export function buildOAuthAuthorizeUrl(env: Env, state?: string): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "read,write,app:assignable,app:mentionable");
  authUrl.searchParams.set("actor", "app");
  if (state) authUrl.searchParams.set("state", state);
  return authUrl.toString();
}

export async function exchangeCodeForToken(
  env: Env,
  code: string,
  traceId?: string
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
  await setLinearAuthState(env, {
    orgId: workspaceInfo.id,
    status: "connected",
    reason: "oauth_callback",
    traceId,
    installation: {
      orgName: workspaceInfo.name,
      appUserId: workspaceInfo.appUserId,
      appUserName: workspaceInfo.appUserName,
    },
  });

  return { orgId: workspaceInfo.id, orgName: workspaceInfo.name };
}

export type LinearAuthFailureReason =
  | "missing_token"
  | "malformed_token"
  | "missing_refresh_token"
  | "refresh_invalid_grant"
  | "refresh_failed"
  | "refresh_error"
  | "token_read_error"
  | "oauth_app_revoked"
  | "permission_team_access_removed";

export interface LinearAuthFailure {
  reason: LinearAuthFailureReason;
  status?: number;
  oauthError?: string;
  oauthErrorDescription?: string;
}

export class LinearAuthError extends Error implements LinearAuthFailure {
  readonly reason: LinearAuthFailureReason;
  readonly status?: number;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;

  constructor(failure: LinearAuthFailure) {
    super(`Linear auth failed: ${failure.reason}`);
    this.name = "LinearAuthError";
    this.reason = failure.reason;
    this.status = failure.status;
    this.oauthError = failure.oauthError;
    this.oauthErrorDescription = failure.oauthErrorDescription;
  }
}

export type OAuthTokenResult =
  | { ok: true; token: string }
  | (LinearAuthFailure & {
      ok: false;
      reauthorizationRequired: boolean;
      retryable: boolean;
    });

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredTokenData(raw: string): ParsedStoredTokenData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isObjectRecord(parsed)) return null;

  const accessToken = parsed.access_token;
  const refreshToken = parsed.refresh_token;
  const expiresAt = parsed.expires_at;
  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (refreshToken !== undefined && typeof refreshToken !== "string") return null;

  return {
    access_token: accessToken,
    expires_at: expiresAt,
    ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
  };
}

export async function getOAuthTokenOrThrow(env: Env, orgId: string): Promise<string> {
  let raw: string | null;
  try {
    raw = await env.LINEAR_KV.get(getWorkspaceTokenKey(orgId));
  } catch (err) {
    log.error("oauth.token_read_error", {
      org_id: orgId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw new LinearAuthError({
      reason: "token_read_error",
    });
  }

  if (!raw) {
    throw new LinearAuthError({
      reason: "missing_token",
    });
  }

  const tokenData = parseStoredTokenData(raw);
  if (!tokenData) {
    throw new LinearAuthError({
      reason: "malformed_token",
    });
  }

  if (Date.now() < tokenData.expires_at - OAUTH_TOKEN_REFRESH_SKEW_MS) {
    return tokenData.access_token;
  }

  if (!tokenData.refresh_token) {
    throw new LinearAuthError({
      reason: "missing_refresh_token",
    });
  }

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
      // RFC 6749 OAuth error responses carry `error` and `error_description` fields.
      // Extract those so we can distinguish invalid_grant from invalid_client without
      // logging the raw body (which contained client_secret and refresh_token in the
      // request — and could be reflected by a misconfigured upstream).
      const rawBody = await res.text();
      let oauthError: string | undefined;
      let oauthErrorDescription: string | undefined;
      try {
        const parsed = JSON.parse(rawBody) as { error?: unknown; error_description?: unknown };
        if (typeof parsed.error === "string") oauthError = parsed.error;
        if (typeof parsed.error_description === "string") {
          oauthErrorDescription = parsed.error_description;
        }
      } catch {
        // Non-JSON body — fall back to a bounded truncation below.
      }
      log.error("oauth.refresh_failed", {
        org_id: orgId,
        status: res.status,
        oauth_error: oauthError,
        oauth_error_description: oauthErrorDescription,
        body_snippet: oauthError ? undefined : rawBody.slice(0, 500),
      });
      throw new LinearAuthError({
        reason: oauthError === "invalid_grant" ? "refresh_invalid_grant" : "refresh_failed",
        status: res.status,
        oauthError,
        oauthErrorDescription,
      });
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
    if (err instanceof LinearAuthError) throw err;

    log.error("oauth.refresh_error", {
      org_id: orgId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw new LinearAuthError({
      reason: "refresh_error",
    });
  }
}

function reauthorizationRequiredForReason(reason: LinearAuthFailureReason): boolean {
  return (
    reason === "missing_token" ||
    reason === "malformed_token" ||
    reason === "missing_refresh_token" ||
    reason === "refresh_invalid_grant" ||
    reason === "oauth_app_revoked" ||
    reason === "permission_team_access_removed"
  );
}

function authFailureFromError(error: LinearAuthError): Extract<OAuthTokenResult, { ok: false }> {
  const reauthorizationRequired = reauthorizationRequiredForReason(error.reason);
  return {
    ok: false,
    reason: error.reason,
    reauthorizationRequired,
    retryable: !reauthorizationRequired,
    status: error.status,
    oauthError: error.oauthError,
    oauthErrorDescription: error.oauthErrorDescription,
  };
}

export async function getOAuthTokenResult(env: Env, orgId: string): Promise<OAuthTokenResult> {
  try {
    return { ok: true, token: await getOAuthTokenOrThrow(env, orgId) };
  } catch (err) {
    if (err instanceof LinearAuthError) return authFailureFromError(err);
    throw err;
  }
}

// ─── Linear API Client ──────────────────────────────────────────────────────

export interface LinearApiClient {
  accessToken: string;
}

export async function getLinearClientOrThrow(env: Env, orgId: string): Promise<LinearApiClient> {
  return { accessToken: await getOAuthTokenOrThrow(env, orgId) };
}

export type LinearClientResult =
  | { ok: true; client: LinearApiClient }
  | Extract<OAuthTokenResult, { ok: false }>;

export async function getLinearClientResult(env: Env, orgId: string): Promise<LinearClientResult> {
  try {
    return { ok: true, client: await getLinearClientOrThrow(env, orgId) };
  } catch (err) {
    if (err instanceof LinearAuthError) return authFailureFromError(err);
    throw err;
  }
}

export type LinearAuthContext =
  | { ok: true; client: LinearApiClient }
  | (Extract<OAuthTokenResult, { ok: false }> & {
      authStatus: LinearWorkspaceAuthStatus;
      reconnectUrl: string;
    });

function authStatusForFailure(
  failure: Extract<OAuthTokenResult, { ok: false }>
): LinearWorkspaceAuthStatus {
  return failure.reauthorizationRequired ? "reauthorization_required" : "transient_failure";
}

function isLinearAuthFailureReason(value: unknown): value is LinearAuthFailureReason {
  return (
    value === "missing_token" ||
    value === "malformed_token" ||
    value === "missing_refresh_token" ||
    value === "refresh_invalid_grant" ||
    value === "refresh_failed" ||
    value === "refresh_error" ||
    value === "token_read_error" ||
    value === "oauth_app_revoked" ||
    value === "permission_team_access_removed"
  );
}

function authFailureReasonForPersistedState(reason: unknown): LinearAuthFailureReason {
  return isLinearAuthFailureReason(reason) ? reason : "missing_token";
}

export function getLinearReconnectUrl(env: Env): string {
  return `${env.WORKER_URL}/oauth/authorize`;
}

export async function getLinearAuthContext(
  env: Env,
  orgId: string,
  traceId?: string
): Promise<LinearAuthContext> {
  const existing = await getLinearAuthState(env, orgId);
  if (existing?.status === "reauthorization_required") {
    return {
      ok: false,
      reason: authFailureReasonForPersistedState(existing.reason),
      reauthorizationRequired: true,
      retryable: false,
      authStatus: "reauthorization_required",
      reconnectUrl: getLinearReconnectUrl(env),
      status: existing.details?.oauthStatus,
      oauthError: existing.details?.oauthError,
      oauthErrorDescription: existing.details?.oauthErrorDescription,
    };
  }

  const result = await getLinearClientResult(env, orgId);
  if (result.ok) {
    if (!existing || existing.status !== "connected") {
      await setLinearAuthState(env, {
        orgId,
        status: "connected",
        reason: "client_available",
        traceId,
      });
    }
    return result;
  }

  const authStatus = authStatusForFailure(result);
  if (result.reauthorizationRequired && result.reason !== "missing_token") {
    try {
      await deleteOAuthToken(env, orgId);
    } catch (error) {
      log.warn("oauth.delete_invalid_token_failed", {
        org_id: orgId,
        auth_failure_reason: result.reason,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  await setLinearAuthState(env, {
    orgId,
    status: authStatus,
    reason: result.reason,
    traceId,
    details: {
      oauthStatus: result.status,
      oauthError: result.oauthError,
      oauthErrorDescription: result.oauthErrorDescription,
    },
  });
  return {
    ...result,
    authStatus,
    reconnectUrl: getLinearReconnectUrl(env),
  };
}

export async function postAuthFailureCommentFallback(
  env: Env,
  params: {
    orgId: string;
    issueId: string;
    issueIdentifier?: string;
    agentSessionId?: string;
    traceId?: string;
    status: LinearWorkspaceAuthStatus;
    reason: string;
    body: string;
  }
): Promise<{
  outcome: "sent" | "unavailable" | "failed" | "suppressed";
  success: boolean;
}> {
  const fingerprint = buildLinearAuthNotificationFingerprint({
    orgId: params.orgId,
    issueId: params.issueId,
    status: params.status,
    reason: params.reason,
  });
  const started = await beginLinearAuthNotification(env, {
    orgId: params.orgId,
    fingerprint,
    issueId: params.issueId,
    issueIdentifier: params.issueIdentifier,
    agentSessionId: params.agentSessionId,
    traceId: params.traceId,
  });
  if (started.suppressed) return { outcome: "suppressed", success: false };

  if (!env.LINEAR_API_KEY) {
    await completeLinearAuthNotification(env, {
      orgId: params.orgId,
      fingerprint,
      attemptId: started.attemptId,
      outcome: "unavailable",
      failureReason: "missing_linear_api_key",
    });
    return { outcome: "unavailable", success: false };
  }

  try {
    const result = await postIssueComment(env.LINEAR_API_KEY, params.issueId, params.body);
    await completeLinearAuthNotification(env, {
      orgId: params.orgId,
      fingerprint,
      attemptId: started.attemptId,
      outcome: result.success ? "sent" : "failed",
      failureReason: result.success ? undefined : "linear_api_rejected",
      httpStatus: result.status,
    });
    return { outcome: result.success ? "sent" : "failed", success: result.success };
  } catch (error) {
    await completeLinearAuthNotification(env, {
      orgId: params.orgId,
      fingerprint,
      attemptId: started.attemptId,
      outcome: "failed",
      failureReason: "post_exception",
    });
    log.error("linear.auth_failure_comment_fallback_exception", {
      org_id: params.orgId,
      issue_id: params.issueId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { outcome: "failed", success: false };
  }
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

  const json = (await res.json()) as Record<string, unknown>;

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msg = (json.errors[0] as { message?: string }).message ?? "Unknown GraphQL error";
    throw new Error(`Linear GraphQL error: ${msg}`);
  }

  return json;
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

// ─── User Lookup ────────────────────────────────────────────────────────────

/**
 * Fetch a Linear user by ID. Returns name and email for identity linking.
 */
export async function fetchUser(
  client: LinearApiClient,
  userId: string
): Promise<{ id: string; name: string; email: string | null } | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query FetchUser($id: String!) {
        user(id: $id) {
          id
          name
          email
        }
      }
    `,
      { id: userId }
    );

    const user = (data as { data?: { user?: Record<string, unknown> } }).data?.user;
    if (!user) return null;

    return {
      id: user.id as string,
      name: user.name as string,
      email: (user.email as string) ?? null,
    };
  } catch (err) {
    log.error("linear.fetch_user", {
      user_id: userId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
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
): Promise<{ success: boolean; status?: number }> {
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

  if (!response.ok) return { success: false, status: response.status };
  const result = (await response.json()) as {
    data?: { commentCreate?: { success: boolean } };
  };
  return { success: result.data?.commentCreate?.success ?? false, status: response.status };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function getWorkspaceInfo(accessToken: string): Promise<{
  id: string;
  name: string;
  appUserId?: string;
  appUserName?: string;
}> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `query { viewer { id name organization { id name } } }`,
    }),
  });

  if (!res.ok) throw new Error(`Failed to get workspace info: ${res.statusText}`);

  const data = (await res.json()) as {
    data?: {
      viewer?: {
        id?: string;
        name?: string;
        organization?: { id: string; name: string };
      };
    };
  };
  const viewer = data.data?.viewer;
  const org = viewer?.organization;
  if (!org) throw new Error("No organization found in response");
  return { id: org.id, name: org.name, appUserId: viewer?.id, appUserName: viewer?.name };
}
