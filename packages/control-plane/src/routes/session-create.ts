import { getValidModelOrDefault, isValidReasoningEffort } from "@open-inspect/shared";
import { encryptTokenPair, generateId } from "../auth/crypto";
import { DEFAULT_TOKEN_LIFETIME_MS, UserScmTokenStore } from "../db/user-scm-tokens";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  deriveParticipantUserId,
  resolveGitHubEnrichment,
  resolveProviderIdentity,
} from "../session/identity";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
} from "../session/integration-settings-resolution";
import type { CreateSessionResponse, Env } from "../types";
import {
  error,
  json,
  normalizeOptionalRepositoryContext,
  parsePattern,
  resolveRepoOrError,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:session-create");
const INVALID_SESSION_REQUEST_BODY_ERROR = "Invalid session request body";

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return error(parsed.message, 400);
  const body = parsed.input;

  const repositoryContext = normalizeOptionalRepositoryContext(
    body,
    INVALID_SESSION_REQUEST_BODY_ERROR
  );
  if (!repositoryContext.ok) return error(repositoryContext.message, 400);

  // Validate branch name if provided (defense in depth)
  if (body.branch && !/^[\w.\-/]+$/.test(body.branch)) {
    return error("Invalid branch name");
  }

  let repoId: number | null = null;
  let defaultBranch: string | null = null;
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  if (repositoryContext.repository) {
    repoOwner = repositoryContext.repository.repoOwner;
    repoName = repositoryContext.repository.repoName;
    const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);
    if (resolved instanceof Response) return resolved;

    repoId = resolved.repoId;
    defaultBranch = resolved.defaultBranch;
  }

  const participantUserId = deriveParticipantUserId(body);

  // Resolve canonical user model ID (for D1 session index).
  // Best-effort: if resolution fails, the session is created without a user_id.
  const userStore = new UserStore(env.DB);
  let resolvedUserId: string | null = null;
  const providerIdentity = resolveProviderIdentity(body.spawnSource ?? "user", body);
  if (providerIdentity) {
    try {
      const resolvedUser = await userStore.resolveOrCreateUser(providerIdentity);
      resolvedUserId = resolvedUser.id;
    } catch (e) {
      logger.warn("Failed to resolve user identity, session will have no user_id", {
        error: e instanceof Error ? e : String(e),
        provider: providerIdentity.provider,
      });
    }
  }

  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  const scmToken = body.scmToken;
  const scmRefreshToken = body.scmRefreshToken;
  let scmTokenExpiresAt = body.scmTokenExpiresAt;
  let scmUserId = body.scmUserId;
  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      ({
        accessTokenEncrypted: scmTokenEncrypted,
        refreshTokenEncrypted: scmRefreshTokenEncrypted,
      } = await encryptTokenPair(scmToken, scmRefreshToken, env.TOKEN_ENCRYPTION_KEY));
    } catch (e) {
      logger.error("Failed to encrypt SCM token", {
        error: e instanceof Error ? e.message : String(e),
      });
      return error("Failed to process SCM token", 500);
    }
  }

  // Enrich the owner with their linked GitHub identity from D1: fill in SCM
  // fields the caller didn't provide (email, display name, OAuth token).
  //
  // This intentionally applies even when the session was authenticated via a
  // non-GitHub provider (e.g. Google): if the canonical user has ALSO linked a
  // verified-email GitHub identity, enrichment surfaces THAT identity's token so
  // the same human keeps GitHub-attributed commits/PRs. resolveGitHubEnrichment
  // keys off the linked `provider === "github"` identity, never the Google
  // credential; a user with no linked GitHub identity gets null here and falls
  // back to the App bot. The invariant is "a Google credential is never used as
  // an SCM credential", not "a Google-authenticated session carries no SCM state".
  if (resolvedUserId) {
    try {
      const enrichment = await resolveGitHubEnrichment(env, userStore, resolvedUserId);
      if (enrichment) {
        scmUserId ??= enrichment.scmUserId;
        scmLogin ??= enrichment.scmLogin;
        scmName ??= enrichment.displayName;
        scmEmail ??= enrichment.email;
        if (!scmTokenEncrypted) {
          scmTokenEncrypted = enrichment.accessTokenEncrypted ?? null;
          scmRefreshTokenEncrypted = enrichment.refreshTokenEncrypted ?? null;
          scmTokenExpiresAt = enrichment.tokenExpiresAt;
        }
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

  // Resolve code-server integration setting and sandbox settings for this repo
  const [codeServerEnabled, sandboxSettings] = await Promise.all([
    resolveCodeServerEnabled(env.DB, repoOwner, repoName),
    resolveSandboxSettings(env.DB, repoOwner, repoName),
  ]);

  const sessionId = generateId();

  const input: SessionInitInput = {
    sessionId,
    repoOwner,
    repoName,
    repoId,
    defaultBranch,
    branch: body.branch,
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
    spawnSource: body.spawnSource,
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

  // Populate D1 with the user's SCM tokens (non-blocking) so centralized refresh works
  if (scmUserId && scmToken && scmRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
    ctx.executionCtx?.waitUntil(
      new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY)
        .upsertTokens(
          scmUserId,
          scmToken,
          scmRefreshToken,
          scmTokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
          resolvedUserId
        )
        .catch((e) =>
          logger.error("Failed to write tokens to D1", {
            error: e instanceof Error ? e : String(e),
          })
        )
    );
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
