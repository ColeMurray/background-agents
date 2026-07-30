/**
 * Control Plane API utilities.
 *
 * Attaches the request credential and delegates transport (service binding
 * vs. URL-based fetch) to `control-plane-transport.ts`.
 */

import { cookies } from "next/headers";
import { serializeBrowserSessionCookies } from "@/lib/browser-session-cookie";
import { dispatchWebServiceRequest } from "@/lib/control-plane-service";
import { createLogger } from "@/lib/logger";
import { getCorrelationLogFields } from "@/lib/request-correlation";
import { getRequestCorrelation } from "@/lib/request-context";

const log = createLogger("control-plane-client");

function unauthorizedResponse(correlation: { requestId: string; traceId: string }): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: {
        "x-request-id": correlation.requestId,
        "x-trace-id": correlation.traceId,
      },
    }
  );
}

/**
 * Make a browser-session-authenticated request to the control plane.
 *
 * Every request carries both a fresh `service:web` signature and the opaque
 * Better Auth session cookie. Caller-supplied identity headers are discarded.
 */
export async function controlPlaneUserFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const correlation = await getRequestCorrelation();
  const correlationFields = getCorrelationLogFields(correlation);

  try {
    const method = options.method ?? "GET";
    const cookieHeader = serializeBrowserSessionCookies((await cookies()).getAll());
    if (!cookieHeader) {
      log.warn("auth.user_session_missing", {
        event: "auth.user_session_missing",
        http_path: normalizedPath.split("?", 1)[0],
        http_method: method,
        trace_id: correlation.traceId,
      });
      return unauthorizedResponse(correlation);
    }

    const requestHeaders = new Headers(options.headers);
    requestHeaders.set("Cookie", cookieHeader);
    if (!requestHeaders.has("Content-Type")) {
      requestHeaders.set("Content-Type", "application/json");
    }
    const { method: _method, headers: _headers, body, ...transportOptions } = options;

    return await dispatchWebServiceRequest({
      method,
      path: normalizedPath,
      headers: requestHeaders,
      body,
      traceId: correlation.traceId,
      correlationFields,
      transportOptions,
    });
  } catch (error) {
    log.error("control_plane.fetch_failed", {
      ...correlationFields,
      http_path: normalizedPath,
      http_method: options.method ?? "GET",
      error: error instanceof Error ? error : new Error(String(error)),
    });
    throw error;
  }
}
