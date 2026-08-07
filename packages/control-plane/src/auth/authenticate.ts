/**
 * Edge authentication: resolve every non-public, non-sandbox request to a
 * typed `Principal` before any handler runs.
 *
 * A `sig1` service signature is verified against that service's own secret.
 * User requests additionally require a Better Auth session. Anything else
 * is not a recognized credential.
 *
 * Sandbox tokens stay router-verified (they need the session id from the
 * path and a DO round-trip), so they are not dispatched here.
 */

import { SERVICE_SIGNATURE_HEADER } from "@open-inspect/shared/service-auth";
import { authenticateSession, SessionIntegrityError } from "./user/session-authenticator";
import { isAuthError, type AuthResult } from "./result";
import { authenticateServiceRequest } from "./service/request-authenticator";
import { createLogger } from "../logger";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";

const logger = createLogger("auth");

export { isAuthError, type AuthError, type AuthResult } from "./result";
export { SERVICE_REQUEST_MAX_BODY_BYTES } from "./service/request-authenticator";

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
  ctx: RequestContext,
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

  return { reason: "Unauthorized", status: 401, failedScheme: "none" };
}
