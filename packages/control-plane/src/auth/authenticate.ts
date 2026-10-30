/**
 * Edge authentication: resolve every non-public, non-sandbox request to a
 * typed `Principal` before any handler runs.
 *
 * A `sig1` service signature is verified against that service's own secret.
 * User requests additionally require a Better Auth session. A request without
 * a signature may instead present a personal access token, which resolves to
 * the user who issued it. Anything else is not a recognized credential.
 *
 * Sandbox tokens stay router-verified (they need the session id from the
 * path and a DO round-trip), so they are not dispatched here.
 */

import { SERVICE_SIGNATURE_HEADER } from "@open-inspect/shared/service-auth";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import {
  authenticatePersonalAccessToken,
  personalAccessTokenDisplayPrefix,
  readPersonalAccessToken,
} from "./personal-access-token";
import { authenticateSession, SessionIntegrityError } from "./user/session-authenticator";
import { isAuthError, type AuthResult } from "./result";
import { authenticateServiceRequest } from "./service/request-authenticator";
import { createLogger } from "../logger";
import type { AuthenticationRequestServices } from "./request-services";
import type { Env } from "../types";

const logger = createLogger("auth");

export { isAuthError, type AuthResult } from "./result";
export { SERVICE_REQUEST_MAX_BODY_BYTES } from "@open-inspect/shared/service-auth";

export interface AuthenticationRequirement {
  /**
   * Whether a verified service:web request is acting as the service itself or
   * as a user through a Better Auth session.
   */
  readonly webService?: "service" | "user";
}

export async function authenticate(
  request: Request,
  env: Env,
  ctx: AuthenticationRequestServices,
  requirement: AuthenticationRequirement = {}
): Promise<AuthResult> {
  const signatureHeader = request.headers.get(SERVICE_SIGNATURE_HEADER);
  if (signatureHeader !== null) {
    const channel = await authenticateServiceRequest(request, env, ctx, signatureHeader);
    if (
      isAuthError(channel) ||
      channel.principal.kind !== "service" ||
      channel.principal.service !== "web" ||
      requirement.webService !== "user"
    ) {
      return channel;
    }
    if (!ctx.getUserAuth) {
      logger.error("User authentication runtime unavailable", {
        event: "auth.browser.misconfigured",
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        reason: "User authentication is not configured",
        status: 500,
        failedScheme: "browser-session",
      };
    }
    try {
      const userSession = await authenticateSession(ctx.getUserAuth().api, channel.request.headers);
      if (!userSession) {
        return {
          reason: "Unauthorized",
          status: 401,
          failedScheme: "browser-session",
        };
      }
      return {
        principal: { kind: "user", userId: userSession.userId },
        authentication: userSession.authentication,
        request: channel.request,
      };
    } catch (cause) {
      logger.error("User session validation failed", {
        event: "auth.browser.failed",
        failure: cause instanceof SessionIntegrityError ? "integrity" : "runtime",
        error: cause,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        reason: "User authentication failed",
        status: 500,
        failedScheme: "browser-session",
      };
    }
  }

  const personalAccessToken = readPersonalAccessToken(request.headers);
  if (personalAccessToken !== null) {
    return authenticatePersonalAccessTokenRequest(request, ctx, personalAccessToken);
  }

  return { reason: "Unauthorized", status: 401, failedScheme: "none" };
}

async function authenticatePersonalAccessTokenRequest(
  request: Request,
  ctx: AuthenticationRequestServices,
  token: string
): Promise<AuthResult> {
  try {
    const result = await authenticatePersonalAccessToken(
      new PersonalAccessTokenStore(ctx.db),
      new PersonalAccessTokenPolicyStore(ctx.db),
      token,
      Date.now()
    );
    if (result.kind === "disabled") {
      logger.warn("Personal access token refused: tokens are disabled", {
        event: "auth.personal_access_token.disabled",
        token_display_prefix: personalAccessTokenDisplayPrefix(token),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        reason: "Personal access tokens are disabled for this workspace",
        status: 401,
        failedScheme: "personal-access-token",
      };
    }
    if (result.kind === "rejected") {
      logger.warn("Personal access token rejected", {
        event: "auth.personal_access_token.rejected",
        // The non-secret display prefix, so a revoked or expired token still in use is findable.
        token_display_prefix: personalAccessTokenDisplayPrefix(token),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return { reason: "Unauthorized", status: 401, failedScheme: "personal-access-token" };
    }
    // No `authentication`: that field is browser-session provenance, and
    // credential authorities that require it must never see a token as one.
    const { credential } = result;
    return {
      principal: {
        kind: "personal-access-token",
        userId: credential.userId,
        tokenId: credential.id,
        grant: credential.grant,
      },
      request,
    };
  } catch (cause) {
    logger.error("Personal access token validation failed", {
      event: "auth.personal_access_token.failed",
      error: cause,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return {
      reason: "Personal access token authentication failed",
      status: 500,
      failedScheme: "personal-access-token",
    };
  }
}
