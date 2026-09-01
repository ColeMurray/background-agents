import {
  externalCreateSessionRequestSchema,
  externalCreateSessionResponseSchema,
  externalFollowUpRequestSchema,
  externalEventFeedQuerySchema,
  externalSessionListQuerySchema,
  externalStopSessionResponseSchema,
  type ExternalCreateSessionResponse,
  type ExternalSession,
} from "@open-inspect/shared/types/external-session-api";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import { isSessionInactive } from "@open-inspect/shared/types/session-activity";
import { hashToken, hmacToken } from "../auth/crypto";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import {
  SessionInternalPaths,
  sessionBootstrapEnsureResponseSchema,
  sessionEventChangePageSchema,
} from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { projectExternalEventPage } from "../external-api/event-projection";
import { adaptExternalRuntimeFailure } from "../external-api/runtime-response";
import type { Env } from "../types";
import { requireExternalSessionIdSecret } from "../env-validation";
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
import { admitPromptModel, dispatchSessionPrompt } from "./session-prompt";

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

async function dispatchExternalPrompt(
  ctx: SessionRouteContext,
  sessionId: string,
  input: { content: string; model?: string; reasoningEffort?: string; clientRequestId: string }
): Promise<Response> {
  return dispatchSessionPrompt(
    ctx,
    sessionId,
    {
      content: input.content,
      authorId: ctx.principal?.kind === "user" ? ctx.principal.userId : "anonymous",
      canonicalUserId: ctx.principal?.kind === "user" ? ctx.principal.userId : undefined,
      source: "extension",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      clientRequestId: input.clientRequestId,
    },
    (response) => adaptExternalRuntimeFailure(response) ?? response
  );
}

async function ensureExternalSessionRuntime(
  env: Env,
  ctx: UserRouteContext,
  session: SessionEntry,
  input: {
    title: string;
    model: string;
    reasoningEffort?: string;
    requestFingerprint: string;
  }
): Promise<Response | null> {
  const reservationError = validateExternalSessionReservation(session, ctx.principal.userId, input);
  if (reservationError) return reservationError;

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
      requestFingerprint: input.requestFingerprint,
    }),
  });
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  const ensured = sessionBootstrapEnsureResponseSchema.parse(await response.json());
  await new SessionIndexStore(ctx.db).updateStatus(session.id, ensured.sessionStatus);
  return null;
}

function validateExternalSessionReservation(
  session: SessionEntry,
  userId: string,
  input: { requestFingerprint: string }
): Response | null {
  return session.externalRequestFingerprint !== input.requestFingerprint ||
    session.repoOwner !== null ||
    session.repoName !== null ||
    session.userId !== userId
    ? error("Idempotency key conflict", 409)
    : null;
}

export async function deriveExternalSessionId(
  userId: string,
  idempotencyKey: string,
  secret: string
): Promise<string> {
  const digest = await hmacToken(
    `open-inspect.external-session-id.v1\0${userId}\0${idempotencyKey}`,
    secret
  );
  return `external-${digest.slice(0, 32)}`;
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

  let installationKey: string;
  try {
    installationKey = requireExternalSessionIdSecret(env);
  } catch {
    return error("External session identity unavailable", 503);
  }
  const requestFingerprint = await hashToken(JSON.stringify(input));
  const sessionId = await deriveExternalSessionId(
    ctx.principal.userId,
    input.idempotencyKey,
    installationKey
  );
  const sessionStore = new SessionIndexStore(ctx.db);
  let session = await sessionStore.get(sessionId);
  const reservationInput = { ...input, requestFingerprint };
  if (session) {
    const reservationError = validateExternalSessionReservation(
      session,
      ctx.principal.userId,
      reservationInput
    );
    if (reservationError) return reservationError;
  }

  const admission = await admitPromptModel(ctx, {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  });
  if (admission instanceof Response) return admission;

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

  let created = false;
  if (!session) {
    const now = Date.now();
    const providerAuth = await resolveSessionProviderAuth(ctx.db, { unattended: false });
    try {
      await sessionStore.create({
        id: sessionId,
        title: input.title,
        repoOwner: null,
        repoName: null,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        baseBranch: null,
        environmentId: null,
        status: "created",
        userId: ctx.principal.userId,
        createdAt: now,
        updatedAt: now,
        providerAuth,
        externalRequestFingerprint: requestFingerprint,
      });
      created = true;
    } catch (cause) {
      session = await sessionStore.get(sessionId);
      if (!session) throw cause;
    }
    session ??= await sessionStore.get(sessionId);
  }
  if (!session) throw new Error("External session reservation was not persisted");
  const reservationError = validateExternalSessionReservation(
    session,
    ctx.principal.userId,
    reservationInput
  );
  if (reservationError) return reservationError;
  const runtimeError = await ensureExternalSessionRuntime(env, ctx, session, reservationInput);
  if (runtimeError) return runtimeError;

  let result: ExternalCreateSessionResponse = {
    sessionId,
    status: "created",
  };
  if (input.initialPrompt) {
    const response = await dispatchExternalPrompt(
      { ...ctx, sessionRuntime: createSessionRuntimeClient(env, ctx) },
      sessionId,
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
      sessionId,
      ...promptResult,
    });
  }
  return json(result, created ? 201 : 200);
}

async function listExternalSessions(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = externalSessionListQuerySchema.safeParse({
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    ...(url.searchParams.has("offset") ? { offset: Number(url.searchParams.get("offset")) } : {}),
  });
  if (!parsed.success) return error("Invalid external session list query", 400);
  const offset = parsed.data.offset ?? 0;
  const result = await new SessionIndexStore(ctx.db).list({
    repositorylessOnly: true,
    ...parsed.data,
  });
  return json({
    sessions: result.sessions.map(projectSession),
    hasMore: result.hasMore,
    ...(result.hasMore ? { continuationOffset: offset + result.sessions.length } : {}),
  });
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
  return dispatchExternalPrompt(ctx, sessionId, parsed.data);
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
  _env: Env,
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
  return json(projectExternalEventPage(page));
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
