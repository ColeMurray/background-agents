/**
 * Token issuance for web user identity: the exchange and the
 * refresh grant. Internal, service-authenticated (`web` only) — this is NOT
 * the public OAuth surface (that is P2's job; both feed the same store).
 */

import { z } from "zod";

import { SUBJECT_TOKEN_TYPES } from "../auth/subject-verification";
import { performExchange } from "../auth/token-exchange";
import { WebSessionTokenService, type WebSessionTokenPair } from "../auth/web-session-tokens";
import { ApiTokenStore } from "../db/api-tokens";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

const logger = createLogger("auth-tokens");

const exchangeRequestSchema = z.strictObject({
  subjectTokenType: z.enum(SUBJECT_TOKEN_TYPES),
  subjectToken: z.string().min(1),
  scmRefreshToken: z.string().min(1).optional(),
  scmTokenExpiresAt: z.number().int().positive().optional(),
});

const refreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1),
});

/** Only web's own service credential may mint or refresh user tokens. */
function requireWebServicePrincipal(ctx: RequestContext): Response | null {
  const principal = ctx.principal;
  if (!principal || principal.kind !== "service" || principal.service !== "web") {
    return error("exchange_forbidden", 403);
  }
  return null;
}

function createTokenService(ctx: RequestContext): WebSessionTokenService {
  return new WebSessionTokenService(new ApiTokenStore(ctx.db));
}

/** WebSessionTokenPair is exactly the wire shape — the pair is the body. */
function tokenPairResponse(pair: WebSessionTokenPair): Response {
  return json(pair);
}

async function handleTokenExchange(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const gate = requireWebServicePrincipal(ctx);
  if (gate) return gate;

  const raw: unknown = await request.json().catch(() => null);
  const parsed = exchangeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return error("invalid_request", 400);
  }
  const body = parsed.data;

  const result = await performExchange(
    body,
    ctx.db,
    createTokenService(ctx),
    env.TOKEN_ENCRYPTION_KEY
  );
  if (!result.ok) {
    logger.warn("Token exchange rejected", {
      event: "auth.token.exchange_rejected",
      subject_token_type: body.subjectTokenType,
      failure: result.failure,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return result.failure === "subject_rejected"
      ? error("subject_rejected", 401)
      : error("provider_unavailable", 502);
  }

  logger.info("Web session token pair minted", {
    event: "auth.token.minted",
    user_id: result.userId,
    provider: result.provider,
    token_kind: "web_session",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return tokenPairResponse(result.pair);
}

async function handleTokenRefresh(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const gate = requireWebServicePrincipal(ctx);
  if (gate) return gate;

  const raw: unknown = await request.json().catch(() => null);
  const parsed = refreshRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return error("invalid_request", 400);
  }

  const redemption = await createTokenService(ctx).redeemRefreshToken(parsed.data.refreshToken);
  if (!redemption.ok) {
    if (redemption.failure === "refresh_superseded") {
      // Benign concurrent renewal — the winner's pair is live. Info, not
      // warn: this is expected multi-tab/wake concurrency, not a fault.
      logger.info("Refresh grant superseded by a concurrent renewal", {
        event: "auth.token.refresh_superseded",
        family_id: redemption.familyId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    } else {
      logger.warn("Refresh grant rejected", {
        event:
          redemption.failure === "refresh_reuse_detected"
            ? "auth.token.refresh_reuse_detected"
            : "auth.token.refresh_rejected",
        failure: redemption.failure,
        family_id: redemption.familyId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
    return error(redemption.failure, 401);
  }

  logger.info("Web session token pair refreshed", {
    event: "auth.token.refreshed",
    user_id: redemption.userId,
    family_id: redemption.familyId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return tokenPairResponse(redemption.pair);
}

export const authTokenRoutes: Route[] = [
  { method: "POST", pattern: parsePattern("/auth/tokens/exchange"), handler: handleTokenExchange },
  { method: "POST", pattern: parsePattern("/auth/tokens/refresh"), handler: handleTokenRefresh },
];
