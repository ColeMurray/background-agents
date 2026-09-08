import { parseJsonBody } from "./body";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  externalCreateSessionRequestSchema,
  externalFollowUpRequestSchema,
  externalEventFeedQuerySchema,
  externalSessionListQuerySchema,
  externalStopSessionResponseSchema,
  type ExternalSession,
} from "@open-inspect/shared/types/external-session-api";
import { isSessionInactive } from "@open-inspect/shared/types/session-activity";
import { listArtifactsResponseSchema } from "@open-inspect/shared/types/artifacts";
import { buildAgentResponseFromEvents } from "@open-inspect/shared/completion/extractor";
import { listEventsResponseSchema } from "@open-inspect/shared/types/sandbox-events";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { listManagedSecretHistory } from "../db/managed-secret-redaction-history";
import { McpServerStore } from "../db/mcp-servers";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { decryptToken } from "../auth/crypto";
import { decryptProviderAccountPayload } from "../auth/provider-account-crypto";
import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import { SessionInternalPaths, sessionEventChangePageSchema } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { projectExternalEventPage } from "../external-api/event-projection";
import { adaptExternalRuntimeFailure } from "../external-api/runtime-response";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
  error,
  json,
  requirePermission,
  type UserRouteContext,
} from "./shared";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import { dispatchUserSessionPrompt } from "./session-prompt";
import { createUserSession } from "./session-create-user";
import { enforceExternalRateLimit } from "../external-api/rate-limit";
import { parseCreatedByFilters } from "./session-list-filter";

const EXTERNAL_SESSIONS_PATH = "/external/v1/sessions";

function projectSession(
  session: SessionEntry,
  sandboxStatus?: string | null,
  webAppUrl?: string
): ExternalSession {
  const base = `${EXTERNAL_SESSIONS_PATH}/${encodeURIComponent(session.id)}`;
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    status: session.status,
    repoOwner: session.repoOwner,
    repoName: session.repoName,
    repositories:
      session.repositories ??
      (session.repoOwner && session.repoName
        ? [
            {
              repoOwner: session.repoOwner,
              repoName: session.repoName,
              repoId: null,
              baseBranch: session.baseBranch ?? "",
            },
          ]
        : []),
    environmentId: session.environmentId ?? null,
    parentSessionId: session.parentSessionId ?? null,
    creatorId: session.userId ?? null,
    archived: session.status === "archived",
    url: `${webAppUrl?.replace(/\/$/, "") ?? ""}/sessions/${encodeURIComponent(session.id)}`,
    ...(sandboxStatus === undefined ? {} : { sandboxStatus }),
    resources: {
      messages: `${base}/messages`,
      events: `${base}/events`,
      artifacts: `${base}/artifacts`,
      diff: `${base}/diff`,
      pullRequests: `${base}/pull-requests`,
      children: `${base}/children`,
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function externalSession(
  ctx: UserRouteContext | SessionRouteContext,
  sessionId: string
): Promise<SessionEntry | Response> {
  return (await new SessionIndexStore(ctx.db).get(sessionId)) ?? error("Session not found", 404);
}

async function currentManagedSecretValues(
  env: Env,
  ctx: UserRouteContext | SessionRouteContext,
  session: Pick<SessionEntry, "id" | "repositories" | "environmentId">
): Promise<string[]> {
  const encryptionKey = env.REPO_SECRETS_ENCRYPTION_KEY;
  if (!encryptionKey) return [];
  const records = await Promise.all([
    new GlobalSecretsStore(ctx.db, encryptionKey).getDecryptedSecrets(),
    ...(session.repositories ?? []).map(({ repoId }) =>
      repoId === null
        ? Promise.resolve({})
        : new RepoSecretsStore(ctx.db, encryptionKey).getDecryptedSecrets(repoId)
    ),
    ...(!session.environmentId
      ? []
      : [
          new EnvironmentSecretsStore(ctx.db, encryptionKey).getDecryptedSecrets(
            session.environmentId
          ),
        ]),
  ]);
  const values = records.flatMap((record) => Object.values(record));
  const repositories = (session.repositories ?? []).map(({ repoOwner, repoName }) => ({
    repoOwner,
    repoName,
  }));
  const mcpServers = await new McpServerStore(ctx.db, encryptionKey).getDecryptedForSession(
    repositories
  );
  values.push(...mcpServers.flatMap(({ env: serverEnv }) => Object.values(serverEnv ?? {})));
  const mcpHistory = await ctx.db
    .prepare("SELECT encrypted_env FROM mcp_credential_redaction_history")
    .all<{ encrypted_env: string }>();
  for (const { encrypted_env } of mcpHistory.results ?? []) {
    collectStrings(JSON.parse(await decryptToken(encrypted_env, encryptionKey)), values);
  }

  const scmTokens = await ctx.db
    .prepare("SELECT access_token_encrypted, refresh_token_encrypted FROM user_scm_tokens")
    .all<{ access_token_encrypted: string; refresh_token_encrypted: string }>();
  for (const row of scmTokens.results ?? []) {
    values.push(
      await decryptToken(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY),
      await decryptToken(row.refresh_token_encrypted, env.TOKEN_ENCRYPTION_KEY)
    );
  }
  const scmHistory = await ctx.db
    .prepare(
      "SELECT access_token_encrypted, refresh_token_encrypted FROM scm_credential_redaction_history"
    )
    .all<{ access_token_encrypted: string; refresh_token_encrypted: string }>();
  for (const row of scmHistory.results ?? []) {
    values.push(
      await decryptToken(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY),
      await decryptToken(row.refresh_token_encrypted, env.TOKEN_ENCRYPTION_KEY)
    );
  }

  const providerBindings = await ctx.db
    .prepare(
      `SELECT provider, provider_account_id
       FROM session_model_provider_auth
       WHERE session_id = ? AND provider_account_id IS NOT NULL`
    )
    .bind(session.id)
    .all<{ provider: ModelProviderId; provider_account_id: string }>();
  const providerStore = new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY);
  for (const binding of providerBindings.results ?? []) {
    const state = await providerStore.readCredentialState(
      binding.provider_account_id,
      binding.provider
    );
    if (state) collectStrings(state.payload, values);
  }
  const providerHistory = await ctx.db
    .prepare(
      `SELECT history.provider_account_id, history.provider,
              history.credential_schema_version, history.encrypted_payload
       FROM provider_credential_redaction_history history
       JOIN session_model_provider_auth binding
         ON binding.provider_account_id = history.provider_account_id
        AND binding.provider = history.provider
       WHERE binding.session_id = ?`
    )
    .bind(session.id)
    .all<{
      provider_account_id: string;
      provider: ModelProviderId;
      credential_schema_version: number;
      encrypted_payload: string;
    }>();
  for (const row of providerHistory.results ?? []) {
    collectStrings(
      await decryptProviderAccountPayload(
        row.encrypted_payload,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY,
        {
          providerAccountId: row.provider_account_id,
          provider: row.provider,
          credentialSchemaVersion: row.credential_schema_version,
        }
      ),
      values
    );
  }
  return values;
}

function collectStrings(value: unknown, target: string[]): void {
  if (typeof value === "string") target.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, target));
  else if (value && typeof value === "object")
    Object.values(value).forEach((entry) => collectStrings(entry, target));
}

async function listExternalSessions(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set([
    "limit",
    "offset",
    "status",
    "excludeStatus",
    "excludeAutomationLineage",
    "createdBy",
  ]);
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1
    )
  ) {
    return error("Invalid external session list query", 400);
  }
  const automationLineage = url.searchParams.get("excludeAutomationLineage");
  if (automationLineage !== null && automationLineage !== "true" && automationLineage !== "false") {
    return error("Invalid external session list query", 400);
  }
  const parsed = externalSessionListQuerySchema.safeParse({
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    ...(url.searchParams.has("offset") ? { offset: Number(url.searchParams.get("offset")) } : {}),
    ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {}),
    ...(url.searchParams.has("excludeStatus")
      ? { excludeStatus: url.searchParams.get("excludeStatus") }
      : {}),
    ...(url.searchParams.has("excludeAutomationLineage")
      ? { excludeAutomationLineage: automationLineage === "true" }
      : {}),
    ...(url.searchParams.has("createdBy") ? { createdBy: url.searchParams.get("createdBy") } : {}),
  });
  if (!parsed.success) return error("Invalid external session list query", 400);
  const offset = parsed.data.offset ?? 0;
  const { createdBy, ...options } = parsed.data;
  const createdByUserIds = parseCreatedByFilters(
    createdBy ? [createdBy] : [],
    ctx.principal.userId
  );
  if (createdByUserIds instanceof Response) return createdByUserIds;
  const result = await new SessionIndexStore(ctx.db).list({
    ...options,
    createdByUserIds,
  });
  return json({
    sessions: result.sessions.map((session) => projectSession(session, undefined, env.WEB_APP_URL)),
    hasMore: result.hasMore,
    ...(result.hasMore ? { continuationOffset: offset + result.sessions.length } : {}),
  });
}

async function getExternalSession(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await externalSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const snapshot = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.snapshot
  );
  let sandboxStatus: string | null = null;
  if (snapshot.ok) {
    const body = (await snapshot.json()) as { sandbox?: { status?: unknown } | null };
    sandboxStatus = typeof body.sandbox?.status === "string" ? body.sandbox.status : null;
  }
  return json(projectSession(session, sandboxStatus, env.WEB_APP_URL));
}

async function followUp(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(ctx, "mutation");
  if (rateLimit) return rateLimit;
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await externalSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const raw = await parseJsonBody(request);
  if (raw instanceof Response) return raw;
  const parsed = externalFollowUpRequestSchema.safeParse(raw);
  if (!parsed.success) return error("Invalid external follow-up request body", 400);
  return dispatchUserSessionPrompt(ctx, sessionId, {
    ...parsed.data,
    content: parsed.data.content ?? "",
  });
}

async function stopExternalSession(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(ctx, "mutation");
  if (rateLimit) return rateLimit;
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await externalSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.stop, {
    method: "POST",
  });
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  return json(externalStopSessionResponseSchema.parse(await response.json()));
}

async function externalEvents(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(ctx, "events");
  if (rateLimit) return rateLimit;
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await externalSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const url = new URL(request.url);
  const allowed = new Set(["after", "cursor", "limit"]);
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1
    )
  ) {
    return error("Invalid external event feed query", 400);
  }
  const rawQuery = {
    ...(url.searchParams.has("after") ? { after: Number(url.searchParams.get("after")) } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
  };
  const query = externalEventFeedQuerySchema.safeParse(rawQuery);
  if (!query.success) {
    return error("Invalid external event feed query", 400);
  }
  const search = new URLSearchParams();
  if (query.data.after !== undefined) search.set("after", String(query.data.after));
  if (query.data.cursor !== undefined) search.set("cursor", query.data.cursor);
  if (query.data.limit !== undefined) search.set("limit", String(query.data.limit));
  const response = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.eventChanges,
    undefined,
    search.size ? `?${search}` : undefined
  );
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  const page = sessionEventChangePageSchema.parse(await response.json());
  if (page.changes.length === 0 || !env.REPO_SECRETS_ENCRYPTION_KEY) {
    return json(projectExternalEventPage(page));
  }
  const encryptionKey = env.REPO_SECRETS_ENCRYPTION_KEY;
  const currentValues = await currentManagedSecretValues(env, ctx, session);
  const managedSecretValues = new Set([
    ...currentValues,
    ...(await listManagedSecretHistory(ctx.db, encryptionKey)),
  ]);
  return json(projectExternalEventPage(page, managedSecretValues));
}

async function waitExternalSession(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await externalSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const settled = isSessionInactive(session.status);
  let artifactIds: string[] = [];
  let pullRequestIds: string[] = [];
  let latestAssistantMessage: { id: string; content: string; completedAt: number | null } | null =
    null;
  if (settled) {
    const runtime = createSessionRuntimeClient(env, ctx);
    const artifactResponse = await runtime.fetch(sessionId, SessionInternalPaths.artifacts);
    if (artifactResponse.ok) {
      const parsed = listArtifactsResponseSchema.safeParse(await artifactResponse.json());
      if (parsed.success) artifactIds = parsed.data.artifacts.map(({ id }) => id);
    }
    pullRequestIds = (await new SessionPullRequestStore(ctx.db).listBySession(sessionId)).map(
      ({ artifactId }) => artifactId
    );
    const messagesResponse = await runtime.fetch(
      sessionId,
      SessionInternalPaths.messages,
      undefined,
      "?limit=50"
    );
    if (messagesResponse.ok) {
      const body = (await messagesResponse.json()) as {
        messages?: Array<{
          id: string;
          status: string;
          completedAt: number | null;
        }>;
      };
      const message = body.messages?.find(
        ({ status }) => status === "completed" || status === "failed"
      );
      if (message) {
        const eventsResponse = await runtime.fetch(
          sessionId,
          SessionInternalPaths.events,
          undefined,
          `?message_id=${encodeURIComponent(message.id)}&limit=200`
        );
        if (eventsResponse.ok) {
          const events = listEventsResponseSchema.safeParse(await eventsResponse.json());
          if (events.success) {
            latestAssistantMessage = {
              id: message.id,
              content: buildAgentResponseFromEvents(events.data.events, []).textContent,
              completedAt: message.completedAt,
            };
          }
        }
      }
    }
  }
  return json({
    sessionId,
    status: session.status,
    settled,
    ...(settled ? { latestAssistantMessage, artifactIds, pullRequestIds } : {}),
  });
}

export const externalSessionsRoutes = new Hono<ControlPlaneHonoEnv>();

externalSessionsRoutes.post(
  EXTERNAL_SESSIONS_PATH,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.create", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) =>
    dispatch(c, async (request, env, _match, ctx) => {
      const raw = await parseJsonBody(request);
      if (raw instanceof Response) return raw;
      const parsed = externalCreateSessionRequestSchema.safeParse(raw);
      if (!parsed.success) return error("Invalid external session request body", 400);
      return createUserSession(request, env, ctx, parsed.data);
    })
);

externalSessionsRoutes.get(
  EXTERNAL_SESSIONS_PATH,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, listExternalSessions)
);

externalSessionsRoutes.get(
  `${EXTERNAL_SESSIONS_PATH}/:id`,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, getExternalSession)
);

externalSessionsRoutes.post(
  `${EXTERNAL_SESSIONS_PATH}/:id/messages`,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.collaborate", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, followUp)
);

externalSessionsRoutes.post(
  `${EXTERNAL_SESSIONS_PATH}/:id/stop`,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.lifecycle", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, stopExternalSession)
);

externalSessionsRoutes.get(
  `${EXTERNAL_SESSIONS_PATH}/:id/events`,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, externalEvents)
);

externalSessionsRoutes.get(
  `${EXTERNAL_SESSIONS_PATH}/:id/wait`,
  admit({
    ...SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, waitExternalSession)
);
