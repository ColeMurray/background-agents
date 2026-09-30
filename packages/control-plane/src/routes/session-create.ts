import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RepositoryRef, RepositoryPair } from "@open-inspect/shared/types/repositories";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import {
  checkHarnessCompatibility,
  getValidHarnessOrDefault,
} from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault, isValidReasoningEffort } from "@open-inspect/shared/models";
import type { CreateSessionResponse } from "@open-inspect/shared/types/session-api";
import { generateId } from "../auth/crypto";
import type { ActorNamespace } from "../auth/principal";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import {
  applyIdentityEnforcement,
  requireAdmittedCanonicalUserId,
} from "../routing/identity-enforcement";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import { resolveScmProviderFromEnv } from "../source-control";
import { EnvironmentStore } from "../db/environments";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import { resolveGitHubEnrichmentForRequest } from "../session/identity";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import type { Env } from "../types";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { authorizeSessionTarget } from "./session-target-authorization";
import {
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
} from "@open-inspect/shared/types/repositories";
import {
  error,
  json,
  resolveRepoOrError,
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  requirePermission,
  type ServiceActorClaimsResult,
} from "./shared";

const logger = createLogger("router:session-create");
const INVALID_SESSION_REQUEST_BODY_ERROR = "Invalid session request body";
const MANAGED_SESSION_ID_FORBIDDEN_ERROR =
  "A preallocated session id is not accepted from this caller";

/**
 * Whether this request's verified principal may reserve its own session id.
 *
 * Only the Linear bot acting through a verified Linear actor, or Agent World
 * acting through a verified GitHub actor, may preallocate a session id: each
 * persists the UUID before issuing the create, so a lost response leaves a
 * known identity to reconcile. Every other principal — humans, other services,
 * and actorless callers — has a supplied `managedSessionId` rejected and
 * otherwise gets a generated id.
 */
const MANAGED_SESSION_ID_ACTOR_PROVIDERS: Partial<Record<ServiceName, ActorNamespace>> = {
  "linear-bot": "linear",
  "agent-world": "github",
};

function isManagedSessionIdentityPrincipal(ctx: RequestContext): boolean {
  const principal = ctx.principal;
  return (
    principal?.kind === "service" &&
    principal.actor !== null &&
    MANAGED_SESSION_ID_ACTOR_PROVIDERS[principal.service] === principal.actor.provider &&
    principal.actor.participantUserId.length > 0
  );
}

// Defense in depth on top of schema validation — matches git ref charsets.
const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;

/**
 * Fold an optional request-scoped cost limit into the resolved sandbox
 * settings. A request may only lower a configured limit, never raise or remove
 * one; omission leaves the settings untouched. The init handler seeds
 * `max_cost_usd` from `sandboxSettings.maxSessionCostUsd`, so no separate budget
 * plumbing is needed.
 */
function withRequestedMaxSessionCostUsd(
  sandboxSettings: SandboxSettings,
  requestedMaxCostUsd: number | undefined
): SandboxSettings {
  if (requestedMaxCostUsd === undefined) return sandboxSettings;
  const configured = sandboxSettings.maxSessionCostUsd;
  return {
    ...sandboxSettings,
    maxSessionCostUsd:
      configured === undefined ? requestedMaxCostUsd : Math.min(configured, requestedMaxCostUsd),
  };
}

async function extractSessionActorProfileClaims(
  request: Request,
  ctx: RequestContext
): Promise<ServiceActorClaimsResult> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return { kind: "rejected", response: error(parsed.message, 400) };

  // Keep the admission-time claim view aligned with the handler's raw-body
  // identity guard; the same rejection ends admission before enrollment.
  const enforcement = applyIdentityEnforcement(ctx, "session-create", parsed.raw);
  if (enforcement.rejection) return { kind: "rejected", response: enforcement.rejection };

  return {
    kind: "claims",
    claims: {
      displayName: parsed.input.actorDisplayName,
      email: parsed.input.actorEmail,
      avatarUrl: parsed.input.actorAvatarUrl,
    },
  };
}

export async function handleCreateSession(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return error(parsed.message, 400);
  const body = parsed.input;

  // Identity comes from the verified principal; caller-asserted identity/SCM
  // body fields are rejected. SCM credentials flow only through
  // server-side enrichment from the token store.
  const enforcement = applyIdentityEnforcement(ctx, "session-create", parsed.raw);
  if (enforcement.rejection) return enforcement.rejection;
  const enforced = enforcement.enforced;

  // A caller may reserve its session id only through the trusted managed-work
  // path, and only before any repository lookup or sandbox allocation. The id
  // seeds this create and is persisted like any other session id (D1 and the
  // session coordinator); the API just does not treat it as an automatic replay
  // key. D1's unique sessions.id insert stays the single creation guard, so a
  // duplicate managed id fails closed instead of initializing an existing
  // session.
  if (body.managedSessionId !== undefined && !isManagedSessionIdentityPrincipal(ctx)) {
    logger.warn("Preallocated session id rejected", {
      event: "session.create.managed_id_rejected",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(MANAGED_SESSION_ID_FORBIDDEN_ERROR, 403);
  }

  let repositoryContext: RepositoryPair | null;
  try {
    repositoryContext = normalizeOptionalRepositoryPair(body, INVALID_SESSION_REQUEST_BODY_ERROR);
  } catch (e) {
    if (e instanceof RepositoryPairValidationError) {
      return error(e.message, 400);
    }
    throw e;
  }

  const targetAuthorizationError = authorizeSessionTarget(ctx, {
    environmentId: body.environmentId,
    hasRepository: Boolean(repositoryContext || body.repositories),
  });
  if (targetAuthorizationError) return targetAuthorizationError;

  // Validate branch names if provided (defense in depth)
  if (body.branch && !BRANCH_NAME_PATTERN.test(body.branch)) {
    return error("Invalid branch name");
  }
  for (const entry of body.repositories ?? []) {
    if (entry.baseBranch && !BRANCH_NAME_PATTERN.test(entry.baseBranch)) {
      return error(`Invalid branch name for ${entry.repoOwner}/${entry.repoName}`);
    }
  }

  let repoId: number | null = null;
  let defaultBranch: string | null = null;
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repositories: RepositoryRef[] | undefined;
  let environmentId: string | null = null;
  // Environment and ad-hoc list modes both produce a resolved member list;
  // scalar mode stays a single lookup. The three are mutually exclusive by
  // schema (hasExclusiveSessionTarget).
  if (body.environmentId) {
    // Snapshot the environment's members and resolve them like any other list
    // (design §7.6); environment_id records provenance on the session.
    const envInputs = await resolveEnvironmentTarget(
      new EnvironmentStore(ctx.db),
      body.environmentId
    );
    repositories = await resolveSessionRepositories(env, envInputs, ctx, logger);
    environmentId = body.environmentId;
  } else if (body.repositories) {
    repositories = await resolveSessionRepositories(env, body.repositories, ctx, logger);
  }

  if (repositories) {
    // The primary entry is mirrored into the scalar columns so filters,
    // settings resolution, and pre-list consumers keep working unchanged.
    const primary = repositories[0];
    repoOwner = primary.repoOwner;
    repoName = primary.repoName;
    repoId = primary.repoId;
    defaultBranch = primary.baseBranch;
  } else if (repositoryContext) {
    repoOwner = repositoryContext.repoOwner;
    repoName = repositoryContext.repoName;
    const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);

    repoId = resolved.repoId;
    defaultBranch = resolved.defaultBranch;
  }

  const participantUserId = enforced.participantUserId;
  const spawnSource = enforced.spawnSource ?? undefined;

  // Admission finalized the canonical subject before RBAC. The handler may
  // consume only that exact subject; it must never perform late identity
  // selection from body profile fields.
  const userStore = new UserStore(ctx.db);
  const resolution = requireAdmittedCanonicalUserId(ctx, enforced);
  if (resolution instanceof Response) return resolution;
  const resolvedUserId = resolution;

  const githubDeployment = resolveScmProviderFromEnv(env.SCM_PROVIDER) === "github";
  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  // SCM credentials never arrive in the body; enrichment below fills them
  // from the token store via the canonical user.
  let scmTokenExpiresAt: number | undefined;
  let scmUserId: string | undefined;
  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  // Browser sessions resolve a linked GitHub identity/token through Better
  // Auth only when SCM enrichment is needed. Transitional callers retain the
  // legacy D1 lookup. A user without a linked GitHub account uses the GitHub
  // App bot fallback; account linking is intentionally deferred.
  if (githubDeployment) {
    try {
      const enrichment = await resolveGitHubEnrichmentForRequest(
        env,
        ctx.db,
        userStore,
        resolvedUserId,
        await resolveGitHubCredentialAuthority(ctx, request.headers)
      );
      if (enrichment) {
        scmUserId = enrichment.scmUserId;
        scmLogin ??= enrichment.scmLogin;
        scmName ??= enrichment.displayName;
        scmEmail ??= enrichment.email;
        scmTokenEncrypted = enrichment.accessTokenEncrypted ?? null;
        scmRefreshTokenEncrypted = enrichment.refreshTokenEncrypted ?? null;
        scmTokenExpiresAt = enrichment.tokenExpiresAt;
      }
    } catch (e) {
      logger.warn("Failed to enrich session with GitHub identity", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  // Validate harness, model and reasoning effort once for both DO init and D1 index
  const harness = getValidHarnessOrDefault(body.harness);
  const model = getValidModelOrDefault(body.model);
  if (
    body.executionProfile === "investigation" &&
    (harness !== "opencode" ||
      !model.startsWith("openrouter/") ||
      (env.SANDBOX_PROVIDER ?? "modal") !== "modal" ||
      body.environmentId ||
      (repositories?.length ?? (repoOwner && repoName ? 1 : 0)) !== 1)
  ) {
    return error(
      "Investigation requires Modal, OpenCode, OpenRouter and exactly one repository",
      400
    );
  }
  const harnessModelIncompatibility = checkHarnessCompatibility(harness, model);
  if (harnessModelIncompatibility) return error(harnessModelIncompatibility.message, 400);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : null;

  // Session-scoped integration settings resolve from the primary member (design
  // §6.2). In list mode that is repositories[0]; otherwise the scalar pair — the
  // two are the same repo by the row-0-mirrors-scalars invariant. Launching
  // from a saved environment layers its overrides on top (design §13.5).
  const scopeMembers = repositories ?? (repoOwner && repoName ? [{ repoOwner, repoName }] : []);
  const { codeServerEnabled, vncEnabled, sandboxSettings } = await resolveSessionScopedSettings(
    ctx.db,
    scopeMembers,
    environmentId
  );
  const effectiveSandboxSettings = withRequestedMaxSessionCostUsd(sandboxSettings, body.maxCostUsd);

  const sessionId = body.managedSessionId ?? generateId();
  let providerAuth;
  try {
    providerAuth = await resolveSessionProviderAuth(ctx.db, {
      explicit: body.providerSelections,
      unattended: spawnSource !== undefined && spawnSource !== "user",
      harness,
    });
  } catch (e) {
    if (e instanceof ProviderAccountSelectionPolicyError) return error(e.message, e.status);
    throw e;
  }
  const harnessAuthIncompatibility = checkHarnessCompatibility(
    harness,
    model,
    Object.fromEntries(providerAuth.map((auth) => [auth.provider, auth.authMode]))
  );
  if (harnessAuthIncompatibility) return error(harnessAuthIncompatibility.message, 400);

  let managedSkillsManifest;
  try {
    managedSkillsManifest = await resolveManagedSkills(
      ctx.db,
      {
        repositories: scopeMembers,
        environmentId,
      },
      body.skillSelection ?? { mode: "all" },
      resolvedUserId
    );
  } catch (e) {
    if (e instanceof SkillResolutionError) return error(e.message, e.status);
    throw e;
  }

  const input: SessionInitInput = {
    sessionId,
    repoOwner,
    repoName,
    repoId,
    defaultBranch,
    branch: body.branch,
    repositories,
    environmentId,
    executionProfile: body.executionProfile,
    title: body.title,
    harness,
    model,
    reasoningEffort,
    participantUserId,
    platformUserId: resolvedUserId,
    scmLogin,
    scmName,
    scmEmail,
    scmUserId,
    scmTokenEncrypted,
    scmRefreshTokenEncrypted,
    scmTokenExpiresAt,
    codeServerEnabled,
    vncEnabled,
    sandboxSettings: effectiveSandboxSettings,
    spawnSource,
    managedSkillsManifest,
    providerAuth,
  };

  try {
    await initializeSession(env, input, ctx);
  } catch (e) {
    logger.error("Failed to initialize session", {
      error: e instanceof Error ? e.message : String(e),
      session_id: sessionId,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create session", 500);
  }

  const result: CreateSessionResponse = {
    sessionId,
    status: "created",
  };

  return json(result, 201);
}

export const sessionCreateRoutes = new Hono<ControlPlaneHonoEnv>();

sessionCreateRoutes.post(
  "/sessions",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.create"),
    serviceActorClaims: extractSessionActorProfileClaims,
  }),
  (c) => dispatch(c, handleCreateSession)
);
