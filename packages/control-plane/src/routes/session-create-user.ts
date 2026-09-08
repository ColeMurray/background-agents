import {
  externalCreateSessionResponseSchema,
  type ExternalCreateSessionRequest,
  type ExternalCreateSessionResponse,
} from "@open-inspect/shared/types/external-session-api";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import type { RepositoryRef } from "@open-inspect/shared/types/repositories";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { hashToken, hmacToken } from "../auth/crypto";
import { EnvironmentStore } from "../db/environments";
import { SessionIndexStore, type SessionCreationReservation } from "../db/session-index";
import { UserStore } from "../db/user-store";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { createLogger } from "../logger";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import {
  buildSessionBootstrapRequest,
  initializeSession,
  type SessionInitInput,
} from "../session/initialize";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import { resolveGitHubEnrichmentForRequest, type GitHubEnrichment } from "../session/identity";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import { resolveScmProviderFromEnv } from "../source-control";
import { SessionInternalPaths, sessionBootstrapEnsureResponseSchema } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { adaptExternalRuntimeFailure } from "../external-api/runtime-response";
import { enforceExternalRateLimit } from "../external-api/rate-limit";
import type { Env } from "../types";
import { requireExternalSessionIdSecret } from "../env-validation";
import { error, json, resolveRepoOrError, type UserRouteContext } from "./shared";
import { admitPromptModel, dispatchUserSessionPrompt } from "./session-prompt";
import { authorizeSessionTarget } from "./session-target-authorization";

const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;
const logger = createLogger("session:create-user");

type UserSessionBootstrapSnapshot = Omit<
  SessionInitInput,
  | "providerAuth"
  | "managedSkillsManifest"
  | "managedSkillsSourceSessionId"
  | "externalBootstrapSnapshot"
> & { requestFingerprint: string };

async function ensureUserSessionRuntime(
  env: Env,
  ctx: UserRouteContext,
  session: SessionCreationReservation,
  input: UserSessionBootstrapSnapshot
): Promise<Response | null> {
  const reservationError = validateUserSessionReservation(session, ctx.principal.userId, input);
  if (reservationError) return reservationError;

  const runtime = createSessionRuntimeClient(env, ctx);
  const response = await runtime.fetch(session.id, SessionInternalPaths.ensureBootstrap, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSessionBootstrapRequest(input)),
  });
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  const ensured = sessionBootstrapEnsureResponseSchema.parse(await response.json());
  await new SessionIndexStore(ctx.db).updateStatus(session.id, ensured.sessionStatus);
  return null;
}

function permissionError(permission: PermissionId): Response {
  return json({ error: "Forbidden", code: "permission_required", permission }, 403);
}

function hasPermission(ctx: UserRouteContext, permission: PermissionId): boolean {
  return Boolean(ctx.authorization?.permissions.includes(permission));
}

async function prepareUserSession(
  env: Env,
  ctx: UserRouteContext,
  sessionId: string,
  input: ExternalCreateSessionRequest,
  requestFingerprint: string,
  requestHeaders: Headers
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
  let enrichment: GitHubEnrichment | null = null;
  if (
    ctx.authentication?.mechanism === "browser_session" &&
    resolveScmProviderFromEnv(env.SCM_PROVIDER) === "github"
  ) {
    try {
      enrichment = await resolveGitHubEnrichmentForRequest(
        env,
        ctx.db,
        new UserStore(ctx.db),
        ctx.principal.userId,
        await resolveGitHubCredentialAuthority(ctx, requestHeaders)
      );
    } catch (cause) {
      logger.warn("Failed to enrich session with GitHub identity", { error: cause });
    }
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
    scmUserId: enrichment?.scmUserId,
    scmLogin: enrichment?.scmLogin,
    scmName: enrichment?.displayName,
    scmEmail: enrichment?.email,
    scmTokenEncrypted: enrichment?.accessTokenEncrypted ?? null,
    scmRefreshTokenEncrypted: null,
    scmTokenExpiresAt: enrichment?.tokenExpiresAt,
    providerAuth,
    managedSkillsManifest,
    requestFingerprint,
  };
  prepared.externalBootstrapSnapshot = JSON.stringify(toUserSessionBootstrapSnapshot(prepared));
  return prepared;
}

function authorizeUserSessionCreate(
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
  if (
    (input.repositories ?? []).some(
      ({ baseBranch }) => baseBranch && !BRANCH_NAME_PATTERN.test(baseBranch)
    )
  ) {
    return error("Invalid repository branch name", 400);
  }
  if (input.branch && !BRANCH_NAME_PATTERN.test(input.branch)) {
    return error("Invalid branch name", 400);
  }
  return null;
}

function toUserSessionBootstrapSnapshot(
  input: SessionInitInput & { requestFingerprint: string }
): UserSessionBootstrapSnapshot {
  const {
    providerAuth: _providerAuth,
    managedSkillsManifest: _managedSkillsManifest,
    managedSkillsSourceSessionId: _managedSkillsSourceSessionId,
    externalBootstrapSnapshot: _externalBootstrapSnapshot,
    ...snapshot
  } = input;
  return snapshot;
}

function readUserSessionBootstrapSnapshot(
  session: SessionCreationReservation,
  userId: string,
  requestFingerprint: string
): UserSessionBootstrapSnapshot {
  let snapshot: UserSessionBootstrapSnapshot;
  try {
    snapshot = JSON.parse(session.externalBootstrapSnapshot ?? "") as UserSessionBootstrapSnapshot;
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

function validateUserSessionReservation(
  session: SessionCreationReservation,
  userId: string,
  input: { requestFingerprint: string }
): Response | null {
  return session.externalRequestFingerprint !== input.requestFingerprint ||
    session.userId !== userId
    ? error("Idempotency key conflict", 409)
    : null;
}

export async function deriveUserSessionId(
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
export async function createUserSession(
  request: Request,
  env: Env,
  ctx: UserRouteContext,
  input: ExternalCreateSessionRequest
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(ctx, "create");
  if (rateLimit) return rateLimit;

  let installationKey: string;
  try {
    installationKey = requireExternalSessionIdSecret(env);
  } catch {
    return error("External session identity unavailable", 503);
  }
  const requestFingerprint = await hashToken(JSON.stringify(input));
  const sessionId = await deriveUserSessionId(
    ctx.principal.userId,
    input.idempotencyKey,
    installationKey
  );
  const sessionStore = new SessionIndexStore(ctx.db);
  let session = await sessionStore.getCreationReservation(sessionId);
  const reservationInput = { ...input, requestFingerprint };
  if (session) {
    const reservationError = validateUserSessionReservation(
      session,
      ctx.principal.userId,
      reservationInput
    );
    if (reservationError) return reservationError;
  }

  const authorizationError = authorizeUserSessionCreate(ctx, input);
  if (authorizationError) return authorizationError;

  let prepared: UserSessionBootstrapSnapshot;
  let created = false;
  if (session) {
    prepared = readUserSessionBootstrapSnapshot(session, ctx.principal.userId, requestFingerprint);
  } else {
    const resolved = await prepareUserSession(
      env,
      ctx,
      sessionId,
      input,
      requestFingerprint,
      request.headers
    );
    if (resolved instanceof Response) return resolved;
    prepared = toUserSessionBootstrapSnapshot(resolved);
    try {
      await initializeSession(env, resolved, ctx);
      created = true;
    } catch (cause) {
      session = await sessionStore.getCreationReservation(sessionId);
      if (!session) throw cause;
    }
    session ??= await sessionStore.getCreationReservation(sessionId);
  }
  if (!session) throw new Error("External session reservation was not persisted");
  const reservationError = validateUserSessionReservation(
    session,
    ctx.principal.userId,
    reservationInput
  );
  if (reservationError) return reservationError;
  if (!created) {
    prepared = readUserSessionBootstrapSnapshot(session, ctx.principal.userId, requestFingerprint);
    const runtimeError = await ensureUserSessionRuntime(env, ctx, session, prepared);
    if (runtimeError) return runtimeError;
  }
  let result: ExternalCreateSessionResponse = {
    sessionId,
    status: "created",
    url: `${(env.WEB_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}`,
  };
  if (input.initialPrompt !== undefined || input.initialAttachments?.length) {
    const response = await dispatchUserSessionPrompt(
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
