import { encryptTokenPair } from "../auth/crypto";
import { DEFAULT_TOKEN_LIFETIME_MS, UserScmTokenStore } from "../db/user-scm-tokens";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-ws-token");

async function handleSessionWsToken(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = (await request.json()) as {
    userId: string;
    scmUserId?: string;
    scmLogin?: string;
    scmName?: string;
    scmEmail?: string;
    scmToken?: string;
    scmTokenExpiresAt?: number;
    scmRefreshToken?: string;
  };

  if (!body.userId) {
    return error("userId is required");
  }

  const scmUserId = body.scmUserId;
  const scmLogin = body.scmLogin;
  const scmName = body.scmName;
  const scmEmail = body.scmEmail;
  const scmToken = body.scmToken;
  const scmTokenExpiresAt = body.scmTokenExpiresAt;
  const scmRefreshToken = body.scmRefreshToken;

  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      ({
        accessTokenEncrypted: scmTokenEncrypted,
        refreshTokenEncrypted: scmRefreshTokenEncrypted,
      } = await ctx.metrics.time("encrypt_tokens", () =>
        encryptTokenPair(scmToken, scmRefreshToken, env.TOKEN_ENCRYPTION_KEY!)
      ));
    } catch (e) {
      logger.error("Failed to encrypt SCM tokens", {
        error: e instanceof Error ? e.message : String(e),
      });
      return error("Failed to process SCM tokens", 500);
    }
  }

  if (scmUserId && scmToken && scmRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
    ctx.executionCtx?.waitUntil(
      new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY)
        .upsertTokens(
          scmUserId,
          scmToken,
          scmRefreshToken,
          scmTokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS
        )
        .catch((e) =>
          logger.error("Failed to write tokens to D1", {
            error: e instanceof Error ? e : String(e),
          })
        )
    );
  }

  return ctx.metrics.time("do_fetch", () =>
    ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.wsToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: body.userId,
        scmUserId,
        scmLogin,
        scmName,
        scmEmail,
        scmTokenEncrypted,
        scmRefreshTokenEncrypted,
        scmTokenExpiresAt,
      }),
    })
  );
}

export const sessionWsTokenRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/ws-token"),
    handler: handleSessionWsToken,
  }),
];
