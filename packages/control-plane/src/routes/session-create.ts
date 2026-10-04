import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RepositoryRef, RepositoryPair } from "@open-inspect/shared/types/repositories";
import {
  checkHarnessCompatibility,
  getValidHarnessOrDefault,
} from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault, isValidReasoningEffort } from "@open-inspect/shared/models";
import type { CreateSessionResponse } from "@open-inspect/shared/types/session-api";
import { generateId } from "../auth/crypto";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import {
  applyIdentityEnforcement,
  requireAdmittedCanonicalUserId,
} from "../routing/identity-enforcement";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import { resolveScmProviderFromEnv } from "../source-control";
import { EnvironmentStore } from "../db/environments";
import { UserStore } from "../db/user-store";
import { TeamMembershipStore } from "../db/team-memberships";
import { createLogger } from "../logger";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import { resolveGitHubEnrichmentForRequest } from "../session/identity";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import { resolvedPin } from "../session/pinned";
import { createSharedMemoryAccess } from "../authorization/memory-access-factory";
import { createSessionMemoryResolver } from "../memory/session-memory-resolver-factory";
import type { Env } from "../types";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { authorizeEnvironmentTarget, authorizeSessionTarget } from "./session-target-authorization";
import { resolveCreationOwnerTeam, teamRequiredResponse } from "./team-ownership";
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

// Defense in depth on top of schema validation — matches git ref charsets.
const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;

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

  let repositoryContext: RepositoryPair | null;
  try {
    repositoryContext = normalizeOptionalRepositoryPair(body, INVALID_SESSION_REQUEST_BODY_ERROR);
  } catch (e) {
    if (e instanceof RepositoryPairValidationError) {
      return error(e.message, 400);
    }
    throw e;
  }

  const targetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId: null,
    environmentId: body.environmentId,
    repositories: (body.repositories ?? (repositoryContext ? [repositoryContext] : [])).map(
      (repository) => ({ owner: repository.repoOwner, name: repository.repoName })
    ),
  });
  if (targetAuthorizationError) return targetAuthorizationError;
  if (body.environmentId) {
    const environmentError = await authorizeEnvironmentTarget(ctx, {
      environmentId: body.environmentId,
      ownerTeamId: body.teamId ?? null,
    });
    if (environmentError) return environmentError;
  }

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
  const teamId = body.teamId ?? null;
  const team = await resolveCreationOwnerTeam(ctx, teamId);
  if (team instanceof Response) return team;
  if (teamId) {
    if (
      !resolvedUserId ||
      !(await new TeamMembershipStore(ctx.db).listForUser(resolvedUserId)).has(teamId)
    ) {
      return json({ error: "Not a team member", code: "not_member" }, 403);
    }
  }
  const resolvedTargetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId,
    environmentId,
    repositories: (
      repositories ?? (repoOwner && repoName ? [{ repoOwner, repoName, repoId }] : [])
    ).map((repository) => ({
      owner: repository.repoOwner,
      name: repository.repoName,
      repoId: repository.repoId,
    })),
  });
  if (resolvedTargetAuthorizationError) return resolvedTargetAuthorizationError;
  const visibility = body.visibility ?? team?.defaultVisibility ?? "workspace";
  if (visibility === "team" && !teamId) return teamRequiredResponse();
  if (visibility === "private" && !resolvedUserId)
    return json({ error: "Session owner required", code: "owner_required" }, 400);

  const githubDeployment = resolveScmProviderFromEnv(env.SCM_PROVIDER) === "github";
  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  // SCM credentials never arrive in the body; enrichment below resolves them
  // through Better Auth using the canonical user.
  let scmUserId: string | undefined;

  // Resolve linked GitHub identity and credentials through Better Auth only
  // when SCM enrichment is needed. A user without a linked GitHub account uses
  // the GitHub App fallback; account linking is intentionally deferred.
  if (githubDeployment) {
    const enrichment = await resolveGitHubEnrichmentForRequest(
      userStore,
      resolvedUserId,
      await resolveGitHubCredentialAuthority(ctx, request.headers)
    );
    if (enrichment) {
      scmUserId = enrichment.scmUserId;
      scmLogin ??= enrichment.scmLogin;
      scmName ??= enrichment.displayName;
      scmEmail ??= enrichment.email;
    }
  }

  // Validate harness, model and reasoning effort once for both DO init and D1 index
  const harness = getValidHarnessOrDefault(body.harness);
  const model = getValidModelOrDefault(body.model);
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
  const scopeMembers =
    repositories ?? (repoOwner && repoName ? [{ repoOwner, repoName, repoId }] : []);
  const { codeServerEnabled, vncEnabled, sandboxSettings } = await resolveSessionScopedSettings(
    ctx.db,
    scopeMembers,
    environmentId
  );

  const sessionId = generateId();
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

  const memoryTarget = await createSharedMemoryAccess(ctx).authorizeTarget({
    userId: resolvedUserId,
    ownerTeamId: teamId,
    repositories: scopeMembers,
    environmentId,
  });
  const memoryManifest = await createSessionMemoryResolver(ctx.db).resolve(
    memoryTarget,
    body.includePersonalMemories
  );

  const input: SessionInitInput = {
    memory: resolvedPin(memoryManifest),
    ownerTeamId: teamId,
    visibility,
    sessionId,
    repoOwner,
    repoName,
    repoId,
    defaultBranch,
    branch: body.branch,
    repositories,
    environmentId,
    title: body.title,
    harness,
    model,
    reasoningEffort,
    participantUserId,
    platformUserId: resolvedUserId,
    participantCanonicalUserId: resolvedUserId,
    scmLogin,
    scmName,
    scmEmail,
    scmUserId,
    codeServerEnabled,
    vncEnabled,
    sandboxSettings,
    spawnSource,
    managedSkills: resolvedPin(managedSkillsManifest),
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
