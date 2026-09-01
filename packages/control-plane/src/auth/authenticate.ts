/**
 * Edge authentication: resolve every non-public, non-sandbox request to a
 * typed `Principal` before any handler runs.
 *
 * A `sig1` service signature is verified against that service's own secret.
 * Browser users require a Better Auth session. Explicit external-user routes
 * instead accept a revocable CLI bearer. Anything else is not recognized.
 *
 * Sandbox tokens stay router-verified (they need the session id from the
 * path and a DO round-trip), so they are not dispatched here.
 */

import { SERVICE_SIGNATURE_HEADER } from "@open-inspect/shared/service-auth";
import {
  CLI_API_VERSION_HEADER,
  CLI_CLIENT_SURFACE_HEADER,
  CLI_CLIENT_VERSION_HEADER,
  CLI_EXTERNAL_API_VERSION,
} from "@open-inspect/shared/types/cli-auth";
import { authenticateSession, SessionIntegrityError } from "./user/session-authenticator";
import { isAuthError, type AuthResult } from "./result";
import { authenticateServiceRequest } from "./service/request-authenticator";
import { authenticateCliBearer } from "./cli-bearer-authenticator";
import { createLogger } from "../logger";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";

const logger = createLogger("auth");

export { isAuthError, type AuthResult } from "./result";
export { SERVICE_REQUEST_MAX_BODY_BYTES } from "./service/request-authenticator";

export interface AuthenticationRequirement {
  /**
   * Whether a verified service:web request is acting as the service itself or
   * as a user through a Better Auth session.
   */
  readonly webService?: "service" | "user";
  /** Direct CLI bearer authentication is enabled only for explicit external routes. */
  readonly userCredential?: "cli";
}

export async function authenticate(
  request: Request,
  env: Env,
  ctx: RequestContext,
  requirement: AuthenticationRequirement = {}
): Promise<AuthResult> {
  const signatureHeader = request.headers.get(SERVICE_SIGNATURE_HEADER);
  if (requirement.userCredential === "cli") {
    if (signatureHeader !== null) {
      return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
    }
    const apiVersion = request.headers.get(CLI_API_VERSION_HEADER);
    const clientVersion = request.headers.get(CLI_CLIENT_VERSION_HEADER);
    const clientSurface = request.headers.get(CLI_CLIENT_SURFACE_HEADER);
    if (apiVersion !== CLI_EXTERNAL_API_VERSION) {
      return { reason: "Incompatible client version", status: 426, failedScheme: "cli-bearer" };
    }
    if (!clientVersion?.trim() || !["cli", "mcp"].includes(clientSurface ?? "")) {
      return { reason: "Invalid client metadata", status: 426, failedScheme: "cli-bearer" };
    }
    try {
      const result = await authenticateCliBearer(request, ctx);
      logger.info("auth.cli.client", {
        event: "auth.cli.client",
        client_version: clientVersion,
        client_surface: clientSurface,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return result;
    } catch (cause) {
      logger.error("CLI credential validation failed", {
        event: "auth.cli.failed",
        error: cause,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        reason: "CLI authentication failed",
        status: 500,
        failedScheme: "cli-bearer",
      };
    }
  }
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
