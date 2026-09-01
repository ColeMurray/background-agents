import {
  externalCreateSessionRequestSchema,
  externalCreateSessionResponseSchema,
  externalFollowUpRequestSchema,
  externalEventFeedQuerySchema,
  externalSessionListQuerySchema,
  externalStopSessionResponseSchema,
  type ExternalCreateSessionRequest,
  type ExternalCreateSessionResponse,
  type ExternalSession,
} from "@open-inspect/shared/types/external-session-api";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import { isSessionInactive } from "@open-inspect/shared/types/session-activity";
import type { RepositoryRef } from "@open-inspect/shared/types/repositories";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { listArtifactsResponseSchema } from "@open-inspect/shared/types/artifacts";
import { buildAgentResponseFromEvents } from "@open-inspect/shared/completion/extractor";
import { listEventsResponseSchema } from "@open-inspect/shared/types/sandbox-events";
import { hashToken, hmacToken } from "../auth/crypto";
import { EnvironmentStore } from "../db/environments";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { listManagedSecretHistory } from "../db/managed-secret-redaction-history";
import { CliAuthStore } from "../db/cli-auth-store";
import { McpServerStore } from "../db/mcp-servers";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { decryptToken } from "../auth/crypto";
import { decryptProviderAccountPayload } from "../auth/provider-account-crypto";
import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { createLogger } from "../logger";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
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
  resolveRepoOrError,
  requirePermission,
  type Route,
  type UserRouteContext,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { admitPromptModel, dispatchSessionPrompt } from "./session-prompt";
import { authorizeSessionTarget } from "./session-target-authorization";

const EXTERNAL_SESSIONS_PATH = "/external/v1/sessions";
const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;
const RATE_LIMIT_WINDOW_MS = 60_000;
const logger = createLogger("router:external-sessions");

type ExternalBootstrapSnapshot = Omit<
  SessionInitInput,
  | "providerAuth"
  | "managedSkillsManifest"
  | "managedSkillsSourceSessionId"
  | "externalBootstrapSnapshot"
> & { requestFingerprint: string };

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

async function dispatchExternalPrompt(
  ctx: SessionRouteContext,
  sessionId: string,
  input: {
    content: string;
    attachments?: SessionAttachmentReference[];
    model?: string;
    reasoningEffort?: string;
    clientRequestId: string;
  },
  preAdmittedModel?: { model: string; reasoningEffort?: string }
): Promise<Response> {
  return dispatchSessionPrompt(
    ctx,
    sessionId,
    {
      content: input.content,
      attachments: input.attachments,
      authorId: ctx.principal?.kind === "user" ? ctx.principal.userId : "anonymous",
      canonicalUserId: ctx.principal?.kind === "user" ? ctx.principal.userId : undefined,
      source: "extension",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      clientRequestId: input.clientRequestId,
    },
    (response) => adaptExternalRuntimeFailure(response) ?? response,
    preAdmittedModel
  );
}

async function ensureExternalSessionRuntime(
  env: Env,
  ctx: UserRouteContext,
  session: SessionEntry,
  input: ExternalBootstrapSnapshot
): Promise<Response | null> {
  const reservationError = validateExternalSessionReservation(session, ctx.principal.userId, input);
  if (reservationError) return reservationError;

  const runtime = createSessionRuntimeClient(env, ctx);
  const response = await runtime.fetch(session.id, SessionInternalPaths.ensureBootstrap, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionName: session.id,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      repoId: input.repoId,
      defaultBranch: input.defaultBranch,
      branch: input.branch,
      repositories: input.repositories ?? [],
      environmentId: input.environmentId ?? null,
      title: input.title,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      userId: input.participantUserId,
      canonicalUserId: input.platformUserId,
      scmLogin: input.scmLogin,
      scmName: input.scmName,
      scmEmail: input.scmEmail,
      scmUserId: input.scmUserId,
      scmTokenEncrypted: input.scmTokenEncrypted,
      scmRefreshTokenEncrypted: input.scmRefreshTokenEncrypted,
      scmTokenExpiresAt: input.scmTokenExpiresAt,
      codeServerEnabled: input.codeServerEnabled,
      vncEnabled: input.vncEnabled,
      sandboxSettings: input.sandboxSettings,
      requestFingerprint: input.requestFingerprint,
    }),
  });
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  const ensured = sessionBootstrapEnsureResponseSchema.parse(await response.json());
  await new SessionIndexStore(ctx.db).updateStatus(session.id, ensured.sessionStatus);
  return null;
}

function permissionError(permission: string): Response {
  return json({ error: "Forbidden", code: "permission_required", permission }, 403);
}

function hasPermission(ctx: UserRouteContext, permission: string): boolean {
  return Boolean(ctx.authorization?.permissions.includes(permission as never));
}

export async function enforceExternalRateLimit(
  request: Request,
  ctx: UserRouteContext | SessionRouteContext,
  bucket: "create" | "mutation" | "events"
): Promise<Response | null> {
  const limits = { create: 30, mutation: 120, events: 600 } as const;
  const userId = ctx.principal?.kind === "user" ? ctx.principal.userId : "unknown";
  const result = await new CliAuthStore(ctx.db).consumeRateLimit({
    key: `external:${bucket}:${userId}`,
    now: Date.now(),
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: limits[bucket],
  });
  if (result.allowed) return null;
  const response = json({ error: "Rate limit exceeded", code: "rate_limited" }, 429);
  response.headers.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1_000)));
  return response;
}

async function prepareExternalSession(
  env: Env,
  ctx: UserRouteContext,
  sessionId: string,
  input: ExternalCreateSessionRequest,
  requestFingerprint: string
): Promise<(SessionInitInput & { requestFingerprint: string }) | Response> {
  let repositories: RepositoryRef[] = [];
  let primaryDefaultBranch: string | null = null;
  if (input.environmentId) {
    const members = await resolveEnvironmentTarget(
      new EnvironmentStore(ctx.db),
      input.environmentId
    );
    repositories = await resolveSessionRepositories(env, members, ctx, logger);
  } else if (input.repositories) {
    repositories = await resolveSessionRepositories(env, input.repositories, ctx, logger);
  } else if (input.repoOwner && input.repoName) {
    const resolved = await resolveRepoOrError(env, input.repoOwner, input.repoName, ctx, logger);
    primaryDefaultBranch = resolved.defaultBranch;
    repositories = [
      {
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        repoId: resolved.repoId,
        baseBranch: input.branch ?? resolved.defaultBranch,
      },
    ];
  }
  const primary = repositories[0];
  const enabledModels = await getEffectiveEnabledModels(ctx.db).catch(() => null);
  if (!enabledModels?.length) return error("Model preferences unavailable", 503);
  const admission = await admitPromptModel(ctx, {
    model: input.model ?? enabledModels[0],
    reasoningEffort: input.reasoningEffort,
  });
  if (admission instanceof Response) return admission;
  const scopeMembers = repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }));
  const { codeServerEnabled, vncEnabled, sandboxSettings } = await resolveSessionScopedSettings(
    ctx.db,
    scopeMembers,
    input.environmentId ?? null
  );
  let providerAuth;
  try {
    providerAuth = await resolveSessionProviderAuth(ctx.db, {
      explicit: input.providerSelections,
      unattended: false,
    });
  } catch (cause) {
    if (cause instanceof ProviderAccountSelectionPolicyError)
      return error(cause.message, cause.status);
    throw cause;
  }
  let managedSkillsManifest;
  try {
    managedSkillsManifest = await resolveManagedSkills(
      ctx.db,
      { repositories: scopeMembers, environmentId: input.environmentId ?? null },
      input.skillSelection ?? { mode: "all" },
      ctx.principal.userId
    );
  } catch (cause) {
    if (cause instanceof SkillResolutionError) return error(cause.message, cause.status);
    throw cause;
  }
  const prepared: SessionInitInput & { requestFingerprint: string } = {
    sessionId,
    repoOwner: primary?.repoOwner ?? null,
    repoName: primary?.repoName ?? null,
    repoId: primary?.repoId ?? null,
    defaultBranch: primaryDefaultBranch ?? primary?.baseBranch ?? null,
    branch: input.repoOwner && input.repoName ? (input.branch ?? null) : null,
    repositories,
    environmentId: input.environmentId ?? null,
    title: input.title,
    model: admission.model,
    reasoningEffort: admission.reasoningEffort ?? null,
    codeServerEnabled,
    vncEnabled,
    sandboxSettings,
    participantUserId: ctx.principal.userId,
    platformUserId: ctx.principal.userId,
    scmTokenEncrypted: null,
    scmRefreshTokenEncrypted: null,
    providerAuth,
    managedSkillsManifest,
    requestFingerprint,
  };
  prepared.externalBootstrapSnapshot = JSON.stringify(toExternalBootstrapSnapshot(prepared));
  return prepared;
}

function authorizeExternalSessionCreate(
  ctx: UserRouteContext,
  input: ExternalCreateSessionRequest
): Response | null {
  const hasRepository = Boolean(input.repoOwner || input.repositories);
  const targetError = authorizeSessionTarget(ctx, {
    environmentId: input.environmentId,
    hasRepository,
  });
  if (targetError) return targetError;
  if (
    (input.initialPrompt !== undefined ||
      input.initialAttachments?.length ||
      input.initialAttachmentCount) &&
    !hasPermission(ctx, "sessions.collaborate")
  ) {
    return permissionError("sessions.collaborate");
  }
  const skillSelection = input.skillSelection ?? { mode: "all" as const };
  if (skillSelection.mode !== "none" && !hasPermission(ctx, "skills.read")) {
    return permissionError("skills.read");
  }
  if (skillSelection.mode === "profile" && !hasPermission(ctx, "skill_profiles.manage_own")) {
    return permissionError("skill_profiles.manage_own");
  }
  if (input.providerSelections && !hasPermission(ctx, "provider_accounts.read")) {
    return permissionError("provider_accounts.read");
  }
  if (input.branch && !BRANCH_NAME_PATTERN.test(input.branch)) {
    return error("Invalid branch name", 400);
  }
  return null;
}

function toExternalBootstrapSnapshot(
  input: SessionInitInput & { requestFingerprint: string }
): ExternalBootstrapSnapshot {
  const {
    providerAuth: _providerAuth,
    managedSkillsManifest: _managedSkillsManifest,
    managedSkillsSourceSessionId: _managedSkillsSourceSessionId,
    externalBootstrapSnapshot: _externalBootstrapSnapshot,
    ...snapshot
  } = input;
  return snapshot;
}

function readExternalBootstrapSnapshot(
  session: SessionEntry,
  userId: string,
  requestFingerprint: string
): ExternalBootstrapSnapshot {
  let snapshot: ExternalBootstrapSnapshot;
  try {
    snapshot = JSON.parse(session.externalBootstrapSnapshot ?? "") as ExternalBootstrapSnapshot;
  } catch {
    throw new Error(`External bootstrap snapshot is unavailable for session ${session.id}`);
  }
  if (
    !snapshot ||
    snapshot.sessionId !== session.id ||
    snapshot.requestFingerprint !== requestFingerprint ||
    snapshot.participantUserId !== userId ||
    snapshot.platformUserId !== userId ||
    typeof snapshot.model !== "string" ||
    !Array.isArray(snapshot.repositories)
  ) {
    throw new Error(`External bootstrap snapshot is invalid for session ${session.id}`);
  }
  return snapshot;
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

function validateExternalSessionReservation(
  session: SessionEntry,
  userId: string,
  input: { requestFingerprint: string }
): Response | null {
  return session.externalRequestFingerprint !== input.requestFingerprint ||
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

/** Creates a target-aware session and resumes deterministic retries after partial initialization. */
async function createExternalSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(request, ctx, "create");
  if (rateLimit) return rateLimit;
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

  const authorizationError = authorizeExternalSessionCreate(ctx, input);
  if (authorizationError) return authorizationError;

  let prepared: ExternalBootstrapSnapshot;
  let created = false;
  if (session) {
    prepared = readExternalBootstrapSnapshot(session, ctx.principal.userId, requestFingerprint);
  } else {
    const resolved = await prepareExternalSession(env, ctx, sessionId, input, requestFingerprint);
    if (resolved instanceof Response) return resolved;
    prepared = toExternalBootstrapSnapshot(resolved);
    try {
      await initializeSession(env, resolved, ctx);
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
  if (!created) {
    prepared = readExternalBootstrapSnapshot(session, ctx.principal.userId, requestFingerprint);
    const runtimeError = await ensureExternalSessionRuntime(env, ctx, session, prepared);
    if (runtimeError) return runtimeError;
  }
  let result: ExternalCreateSessionResponse = {
    sessionId,
    status: "created",
    url: `${(env.WEB_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}`,
  };
  if (input.initialPrompt !== undefined || input.initialAttachments?.length) {
    const response = await dispatchExternalPrompt(
      { ...ctx, sessionRuntime: createSessionRuntimeClient(env, ctx) },
      sessionId,
      {
        content: input.initialPrompt ?? "",
        attachments: input.initialAttachments,
        model: prepared.model,
        reasoningEffort: prepared.reasoningEffort ?? undefined,
        clientRequestId: `external-create:${await hashToken(`${ctx.principal.userId}:${input.idempotencyKey}`)}`,
      },
      { model: prepared.model, reasoningEffort: prepared.reasoningEffort ?? undefined }
    );
    if (!response.ok) {
      const failure: Record<string, unknown> = await response
        .json<Record<string, unknown>>()
        .catch(() => ({}));
      return json(
        {
          ...failure,
          error: typeof failure.error === "string" ? failure.error : "Initial prompt failed",
          sessionId,
          failedStage: "prompt",
        },
        response.status
      );
    }
    const promptResult = sendPromptResponseSchema.parse(await response.json());
    result = externalCreateSessionResponseSchema.parse({
      sessionId,
      ...promptResult,
      url: `${(env.WEB_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}`,
    });
  }
  return json(result, created ? 201 : 200);
}

async function listExternalSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
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
  const result = await new SessionIndexStore(ctx.db).list({
    ...options,
    ...(createdBy ? { createdByUserIds: [createdBy] } : {}),
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
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
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
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(request, ctx, "mutation");
  if (rateLimit) return rateLimit;
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const session = await externalSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = externalFollowUpRequestSchema.safeParse(raw);
  if (!parsed.success) return error("Invalid external follow-up request body", 400);
  return dispatchExternalPrompt(ctx, sessionId, {
    ...parsed.data,
    content: parsed.data.content ?? "",
  });
}

async function stopExternalSession(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(request, ctx, "mutation");
  if (rateLimit) return rateLimit;
  const sessionId = match.groups?.id;
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
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(request, ctx, "events");
  if (rateLimit) return rateLimit;
  const sessionId = match.groups?.id;
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
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
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
