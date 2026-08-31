import {
  externalCreateSessionRequestSchema,
  externalCreateSessionResponseSchema,
  externalFollowUpRequestSchema,
  externalEventFeedQuerySchema,
  externalStopSessionResponseSchema,
  type ExternalCreateSessionResponse,
  type ExternalSession,
} from "@open-inspect/shared/types/external-session-api";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import { isSessionInactive } from "@open-inspect/shared/types/session-activity";
import { generateId, hashToken } from "../auth/crypto";
import { ExternalSessionCreateOperationStore } from "../db/external-session-create-operations";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { GlobalSecretsStore } from "../db/global-secrets";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { initializeSession } from "../session/initialize";
import {
  SessionInternalPaths,
  sessionBootstrapEnsureResponseSchema,
  sessionEventChangePageSchema,
} from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { projectExternalEventPage } from "../external-api/event-projection";
import { adaptExternalRuntimeFailure } from "../external-api/runtime-response";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  requirePermission,
  type Route,
  type UserRouteContext,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const EXTERNAL_SESSIONS_PATH = "/external/v1/sessions";

function projectSession(session: SessionEntry): ExternalSession {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function repositorylessSession(
  ctx: UserRouteContext | SessionRouteContext,
  sessionId: string
): Promise<SessionEntry | Response> {
  const session = await new SessionIndexStore(ctx.db).get(sessionId);
  if (!session || session.repoOwner !== null || session.repoName !== null) {
    return error("Session not found", 404);
  }
  return session;
}

async function enqueueExternalPrompt(
  ctx: SessionRouteContext,
  sessionId: string,
  input: { content: string; model?: string; reasoningEffort?: string; clientRequestId: string }
): Promise<Response> {
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.prompt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: input.content,
      authorId: ctx.principal?.kind === "user" ? ctx.principal.userId : "anonymous",
      canonicalUserId: ctx.principal?.kind === "user" ? ctx.principal.userId : undefined,
      source: "extension",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      clientRequestId: input.clientRequestId,
    }),
  });
  return adaptExternalRuntimeFailure(response) ?? response;
}

async function ensureExternalSessionRuntime(
  env: Env,
  ctx: UserRouteContext,
  session: SessionEntry,
  input: { title: string; model: string; reasoningEffort: string }
): Promise<Response | null> {
  if (
    session.repoOwner !== null ||
    session.repoName !== null ||
    session.userId !== ctx.principal.userId ||
    session.title !== input.title ||
    session.model !== input.model ||
    session.reasoningEffort !== input.reasoningEffort
  ) {
    return error("External create request conflicts with the reserved session", 409);
  }

  const runtime = createSessionRuntimeClient(env, ctx);
  const response = await runtime.fetch(session.id, SessionInternalPaths.ensureBootstrap, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionName: session.id,
      repoOwner: null,
      repoName: null,
      repoId: null,
      defaultBranch: null,
      branch: null,
      repositories: [],
      environmentId: null,
      title: input.title,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      userId: ctx.principal.userId,
      canonicalUserId: ctx.principal.userId,
      scmTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
    }),
  });
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  const ensured = sessionBootstrapEnsureResponseSchema.parse(await response.json());
  await new SessionIndexStore(ctx.db).updateStatus(session.id, ensured.sessionStatus);
  return null;
}

async function validateEnabledModel(
  ctx: UserRouteContext | SessionRouteContext,
  model: string
): Promise<Response | null> {
  try {
    const enabledModels = await getEffectiveEnabledModels(ctx.db);
    return enabledModels.some((enabledModel) => enabledModel === model)
      ? null
      : error(`Model "${model}" is not enabled`, 400);
  } catch {
    return error("Model preferences unavailable", 503);
  }
}

/** Creates only repository-less sessions and persists progress before any side effect. */
async function createExternalSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = externalCreateSessionRequestSchema.safeParse(raw);
  if (!parsed.success) return error("Invalid external session request body", 400);
  const input = parsed.data;

  const modelError = await validateEnabledModel(ctx, input.model);
  if (modelError) return modelError;

  if (input.initialPrompt && !ctx.authorization?.permissions.includes("sessions.collaborate")) {
    return json(
      {
        error: "Forbidden",
        code: "permission_required",
        permission: "sessions.collaborate",
      },
      403
    );
  }

  const requestHash = await hashToken(JSON.stringify(input));
  const proposedSessionId = generateId();
  const operationStore = new ExternalSessionCreateOperationStore(ctx.db);
  let operation = await operationStore.claim({
    userId: ctx.principal.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    sessionId: proposedSessionId,
  });
  if (operation.requestHash !== requestHash) return error("Idempotency key conflict", 409);
  if (operation.stage === "completed" && operation.result) return json(operation.result);

  if (operation.stage === "reserved") {
    const sessionStore = new SessionIndexStore(ctx.db);
    const existing = await sessionStore.get(operation.sessionId);
    if (existing) {
      const runtimeError = await ensureExternalSessionRuntime(env, ctx, existing, input);
      if (runtimeError) return runtimeError;
    } else {
      const providerAuth = await resolveSessionProviderAuth(ctx.db, { unattended: false });
      try {
        await initializeSession(
          env,
          {
            sessionId: operation.sessionId,
            repoOwner: null,
            repoName: null,
            repoId: null,
            defaultBranch: null,
            branch: null,
            title: input.title,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            participantUserId: ctx.principal.userId,
            platformUserId: ctx.principal.userId,
            scmTokenEncrypted: null,
            scmRefreshTokenEncrypted: null,
            providerAuth,
          },
          ctx
        );
      } catch (cause) {
        const racedSession = await sessionStore.get(operation.sessionId);
        if (!racedSession) throw cause;
        const runtimeError = await ensureExternalSessionRuntime(env, ctx, racedSession, input);
        if (runtimeError) return runtimeError;
      }
    }
    operation = await operationStore.markSessionCreated(operation);
    if (operation.stage === "completed" && operation.result) return json(operation.result);
  }

  let result: ExternalCreateSessionResponse = {
    sessionId: operation.sessionId,
    status: "created",
  };
  if (input.initialPrompt) {
    const response = await enqueueExternalPrompt(
      { ...ctx, sessionRuntime: createSessionRuntimeClient(env, ctx) },
      operation.sessionId,
      {
        content: input.initialPrompt,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        clientRequestId: `external-create:${await hashToken(`${ctx.principal.userId}:${input.idempotencyKey}`)}`,
      }
    );
    if (!response.ok) return response;
    const promptResult = sendPromptResponseSchema.parse(await response.json());
    result = externalCreateSessionResponseSchema.parse({
      sessionId: operation.sessionId,
      ...promptResult,
    });
  }
  operation = await operationStore.complete(operation, result);
  return json(operation.result ?? result, operation.sessionId === proposedSessionId ? 201 : 200);
}

async function listExternalSessions(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const result = await new SessionIndexStore(ctx.db).list({ repositorylessOnly: true });
  return json({ sessions: result.sessions.map(projectSession), hasMore: result.hasMore });
}

async function getExternalSession(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await repositorylessSession(ctx, sessionId);
  return session instanceof Response ? session : json(projectSession(session));
}

async function followUp(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await repositorylessSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = externalFollowUpRequestSchema.safeParse(raw);
  if (!parsed.success) return error("Invalid external follow-up request body", 400);
  if (parsed.data.model !== undefined) {
    const modelError = await validateEnabledModel(ctx, parsed.data.model);
    if (modelError) return modelError;
  }
  return enqueueExternalPrompt(ctx, sessionId, parsed.data);
}

async function stopExternalSession(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await repositorylessSession(ctx, sessionId);
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
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await repositorylessSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const url = new URL(request.url);
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
  const managedSecretValues =
    page.changes.length > 0 && env.REPO_SECRETS_ENCRYPTION_KEY
      ? new Set(
          Object.values(
            await new GlobalSecretsStore(
              ctx.db,
              env.REPO_SECRETS_ENCRYPTION_KEY
            ).getDecryptedSecrets()
          )
        )
      : new Set<string>();
  return json(projectExternalEventPage(page, managedSecretValues));
}

async function waitExternalSession(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await repositorylessSession(ctx, sessionId);
  if (session instanceof Response) return session;
  return json({
    sessionId,
    status: session.status,
    settled: isSessionInactive(session.status),
  });
}

export const externalSessionsRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_EXTERNAL_USER_ROUTE, [
  {
    method: "POST",
    pattern: parsePattern(EXTERNAL_SESSIONS_PATH),
    authorization: requirePermission("sessions.create", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: createExternalSession,
  },
  {
    method: "GET",
    pattern: parsePattern(EXTERNAL_SESSIONS_PATH),
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: listExternalSessions,
  },
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_SESSIONS_PATH}/:id`),
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: getExternalSession,
  },
  sessionRoute({
    method: "POST",
    pattern: parsePattern(`${EXTERNAL_SESSIONS_PATH}/:id/messages`),
    authorization: requirePermission("sessions.collaborate", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: followUp,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern(`${EXTERNAL_SESSIONS_PATH}/:id/stop`),
    authorization: requirePermission("sessions.lifecycle", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: stopExternalSession,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_SESSIONS_PATH}/:id/events`),
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: externalEvents,
  }),
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_SESSIONS_PATH}/:id/wait`),
    authorization: requirePermission("sessions.read", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: waitExternalSession,
  },
]);
