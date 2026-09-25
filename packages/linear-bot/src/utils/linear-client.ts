/**
 * Linear API client utilities — OAuth + raw GraphQL.
 */

import {
  linearIssueDetailsResponseSchema,
  linearRepoSuggestionsResponseSchema,
  linearUserResponseSchema,
  type Env,
  type LinearIssueDetails,
} from "../types";
import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared/auth";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { createLogger } from "../logger";
import {
  getClientCredentialsTokenOrThrow,
  LINEAR_CLIENT_CREDENTIALS_SCOPE,
  LinearAuthError,
} from "./linear-credentials";
import { z } from "zod";
import { abortable } from "./abortable";
import { LINEAR_DOCUMENTS, type LinearDocument } from "./linear-documents";

export {
  completeLinearOAuthInstallation,
  getClientCredentialsTokenOrThrow,
  LinearAuthError,
} from "./linear-credentials";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_GRAPHQL_TIMEOUT_MS = 15_000;
/** Largest non-2xx response body read to recover Linear's error messages. */
const LINEAR_ERROR_BODY_MAX_BYTES = 16 * 1024;

const linearCommentCreateResponseSchema = z.object({
  data: z
    .object({
      commentCreate: z
        .object({
          success: z.boolean(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const linearGraphQLErrorSchema = z.object({
  message: z.string().optional(),
});

const linearGraphQLResponseSchema = z
  .object({
    errors: z.array(linearGraphQLErrorSchema).optional(),
  })
  .passthrough();

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

export function buildOAuthAuthorizeUrl(env: Env): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", LINEAR_CLIENT_CREDENTIALS_SCOPE);
  authUrl.searchParams.set("actor", "app");
  return authUrl.toString();
}

// ─── Linear API Client ──────────────────────────────────────────────────────

export interface LinearApiClient {
  accessToken: string;
  organizationId: string;
  renewAccessToken: () => Promise<string>;
}

export async function getLinearClient(
  env: Env,
  orgId: string,
  expectedAppUserId: string
): Promise<LinearApiClient | null> {
  try {
    return await getLinearClientOrThrow(env, orgId, expectedAppUserId);
  } catch (err) {
    if (err instanceof LinearAuthError) return null;
    throw err;
  }
}

export async function getLinearClientOrThrow(
  env: Env,
  orgId: string,
  expectedAppUserId: string
): Promise<LinearApiClient> {
  return {
    accessToken: await getClientCredentialsTokenOrThrow(env, orgId, { expectedAppUserId }),
    organizationId: orgId,
    renewAccessToken: () =>
      getClientCredentialsTokenOrThrow(env, orgId, {
        forceRenew: true,
        expectedAppUserId,
      }),
  };
}

/**
 * Execute a GraphQL query against the Linear API.
 */
export async function linearGraphQL(
  client: LinearApiClient,
  query: LinearDocument,
  variables: Record<string, unknown>,
  callerSignal?: AbortSignal
): Promise<Record<string, unknown>> {
  const deadlineSignal = AbortSignal.timeout(LINEAR_GRAPHQL_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal;
  const body = JSON.stringify({ query, variables });
  const send = (accessToken: string) =>
    fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body,
      signal,
    });

  let res = await send(client.accessToken);
  if (res.status === 401) {
    log.warn("linear.graphql.unauthorized", { org_id: client.organizationId });
    let renewedToken: string;
    try {
      renewedToken = await abortable(client.renewAccessToken(), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof LinearAuthError) throw error;
      throw new LinearAuthError({ reason: "client_credentials_error" });
    }
    client.accessToken = renewedToken;
    res = await send(renewedToken);
    if (res.status === 401) {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
      throw new LinearAuthError({
        reason: "client_credentials_rejected",
        status: res.status,
      });
    }
    if (res.ok) {
      log.info("linear.graphql.retry_succeeded", {
        org_id: client.organizationId,
        status: res.status,
      });
    } else {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
    }
  }

  if (!res.ok) {
    // Callers log the thrown error, so the detail reaches their log lines too.
    const detail = await readLinearErrorDetail(res);
    throw new Error(
      detail ? `Linear API error: ${res.status}: ${detail}` : `Linear API error: ${res.status}`
    );
  }

  const parsed = linearGraphQLResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error("Linear GraphQL error: unexpected response shape");
  }
  const json = parsed.data;

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msg = json.errors[0]?.message ?? "Unknown GraphQL error";
    throw new Error(`Linear GraphQL error: ${msg}`);
  }

  return json;
}

/**
 * Recover the GraphQL `errors[].message` list from a non-2xx response. Linear
 * reports query validation failures (e.g. an unknown variable type) as HTTP
 * 400 with the reason only in the body. Returns undefined when the body is
 * oversized, unreadable, or carries no messages.
 */
async function readLinearErrorDetail(res: Response): Promise<string | undefined> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(res.body, LINEAR_ERROR_BODY_MAX_BYTES);
  } catch {
    return undefined;
  }
  if (!bytes) return undefined;

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  const parsed = linearGraphQLResponseSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const messages = (parsed.data.errors ?? []).flatMap((e) => (e.message ? [e.message] : []));
  return messages.length > 0 ? messages.join("; ") : undefined;
}

// ─── Agent Activities ────────────────────────────────────────────────────────

export async function emitAgentActivity(
  client: LinearApiClient,
  agentSessionId: string,
  content: Record<string, unknown>,
  ephemeral?: boolean
): Promise<boolean> {
  try {
    await linearGraphQL(client, LINEAR_DOCUMENTS.AgentActivityCreate, {
      input: { agentSessionId, content, ephemeral },
    });
    return true;
  } catch (err) {
    log.error("linear.emit_activity_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
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
    const data = await linearGraphQL(client, LINEAR_DOCUMENTS.IssueDetails, { id: issueId });

    const parsed = linearIssueDetailsResponseSchema.safeParse(data);
    if (!parsed.success) return null;

    const issue = parsed.data.data?.issue;
    if (!issue) return null;

    return issue;
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
    await linearGraphQL(client, LINEAR_DOCUMENTS.AgentSessionUpdate, { id: agentSessionId, input });
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
    const data = await linearGraphQL(client, LINEAR_DOCUMENTS.RepoSuggestions, {
      issueId,
      agentSessionId,
      candidateRepositories: candidateRepos,
    });

    const parsed = linearRepoSuggestionsResponseSchema.safeParse(data);
    if (!parsed.success) return [];

    return parsed.data.data?.issueRepositorySuggestions?.suggestions || [];
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
    const data = await linearGraphQL(client, LINEAR_DOCUMENTS.FetchUser, { id: userId });

    const parsed = linearUserResponseSchema.safeParse(data);
    if (!parsed.success) return null;

    const user = parsed.data.data?.user;
    if (!user) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email ?? null,
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
): Promise<{ success: boolean }> {
  try {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: LINEAR_DOCUMENTS.CommentCreate,
        variables: { input: { issueId, body } },
      }),
      signal: AbortSignal.timeout(LINEAR_GRAPHQL_TIMEOUT_MS),
    });

    if (!response.ok) return { success: false };
    const result = linearCommentCreateResponseSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!result.success) return { success: false };
    return { success: result.data.data?.commentCreate?.success ?? false };
  } catch {
    return { success: false };
  }
}
