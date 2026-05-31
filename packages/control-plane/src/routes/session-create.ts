import { getValidModelOrDefault, isValidReasoningEffort } from "@open-inspect/shared";
import { encryptTokenPair, generateId } from "../auth/crypto";
import { DEFAULT_TOKEN_LIFETIME_MS, UserScmTokenStore } from "../db/user-scm-tokens";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  deriveUserId,
  resolveGitHubEnrichment,
  resolveProviderIdentity,
} from "../session/identity";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
} from "../session/integration-settings-resolution";
import type { CreateSessionRequest, CreateSessionResponse, Env, SpawnSource } from "../types";
import {
  error,
  json,
  parsePattern,
  resolveRepoOrError,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:session-create");

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = (await request.json()) as CreateSessionRequest & {
    scmToken?: string;
    scmRefreshToken?: string;
    scmTokenExpiresAt?: number;
    scmUserId?: string;
    userId?: string;
    scmLogin?: string;
    scmName?: string;
    scmEmail?: string;
    spawnSource?: SpawnSource;
    actorUserId?: string;
    actorDisplayName?: string;
    actorEmail?: string;
    actorAvatarUrl?: string;
  };

  if (!body.repoOwner || !body.repoName) {
    return error("repoOwner and repoName are required");
  }

  // Validate branch name if provided (defense in depth)
  if (body.branch && !/^[\w.\-/]+$/.test(body.branch)) {
    return error("Invalid branch name");
  }

  // Normalize repo identifiers to lowercase for consistent storage
  const repoOwner = body.repoOwner.toLowerCase();
  const repoName = body.repoName.toLowerCase();

  const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);
  if (resolved instanceof Response) return resolved;

  const { repoId, defaultBranch } = resolved;

  const userId = deriveUserId(body);

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

  // Enrich owner participant with linked GitHub identity from D1.
  // Fills in SCM fields the bot didn't provide (email, display name, OAuth tokens).
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
    participantUserId: userId,
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
