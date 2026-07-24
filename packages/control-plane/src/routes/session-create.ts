import {
  getValidModelOrDefault,
  isValidReasoningEffort,
  type RepositoryRef,
} from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { applyIdentityEnforcement, resolveCanonicalUserId } from "../auth/identity-enforcement";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import { resolveScmProviderFromEnv } from "../source-control";
import { EnvironmentStore } from "../db/environments";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import { resolveGitHubEnrichment } from "../session/identity";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import type { CreateSessionResponse, Env } from "../types";
import {
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
  type RepositoryPair,
} from "@open-inspect/shared";
import {
  error,
  json,
  parsePattern,
  resolveRepoOrError,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:session-create");
const INVALID_SESSION_REQUEST_BODY_ERROR = "Invalid session request body";

// Defense in depth on top of schema validation — matches git ref charsets.
const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
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

  // Resolve canonical user model ID (for D1 session index) from the verified
  // principal, failing closed; body display fields stay cosmetic.
  const userStore = new UserStore(ctx.db);
  const resolution = await resolveCanonicalUserId(userStore, ctx, enforced, {
    displayName: body.actorDisplayName,
    email: body.actorEmail,
    avatarUrl: body.actorAvatarUrl,
  });
  if (resolution instanceof Response) return resolution;
  const resolvedUserId = resolution.userId;

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

  // On GitHub deployments, enrich the owner with their linked GitHub identity
  // from D1: fill in SCM fields the caller didn't provide (email, display name,
  // OAuth token). Other SCM deployments retain their provider-native identity
  // and credentials unchanged.
  //
  // This intentionally applies even when the session was authenticated via a
  // non-GitHub provider (e.g. Google): if the canonical user has ALSO linked a
  // verified-email GitHub identity, enrichment surfaces THAT identity's token so
  // the same human keeps GitHub-attributed commits/PRs. resolveGitHubEnrichment
  // keys off the linked `provider === "github"` identity, never the Google
  // credential; a user with no linked GitHub identity gets null here and falls
  // back to the App bot. The invariant is "a Google credential is never used as
  // an SCM credential", not "a Google-authenticated session carries no SCM state".
  if (githubDeployment) {
    try {
      const enrichment = await resolveGitHubEnrichment(env, ctx.db, userStore, resolvedUserId);
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

  // Validate model and reasoning effort once for both DO init and D1 index
  const model = getValidModelOrDefault(body.model);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : null;

  // Session-scoped integration settings resolve from the primary member (design
  // §6.2). In list mode that is repositories[0]; otherwise the scalar pair — the
  // two are the same repo by the row-0-mirrors-scalars invariant. Launching
  // from a saved environment layers its overrides on top (design §13.5).
  const scopeMembers = repositories ?? (repoOwner && repoName ? [{ repoOwner, repoName }] : []);
  const { codeServerEnabled, sandboxSettings } = await resolveSessionScopedSettings(
    ctx.db,
    scopeMembers,
    environmentId
  );

  const sessionId = generateId();

  const input: SessionInitInput = {
    sessionId,
    repoOwner,
    repoName,
    repoId,
    defaultBranch,
    branch: body.branch,
    repositories,
    environmentId,
    title: body.title,
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
    sandboxSettings,
    spawnSource,
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

export const sessionCreateRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions"),
    handler: handleCreateSession,
  },
];
