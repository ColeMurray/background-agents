/**
 * Control Plane API utilities.
 *
 * Attaches the request credential and delegates transport (service binding
 * vs. URL-based fetch) to `control-plane-transport.ts`.
 */

import { dispatchControlPlaneFetch, getControlPlaneUrl } from "@/lib/control-plane-transport";
import { createLogger } from "@/lib/logger";
import { getOiAccessTokenFromCookies } from "@/lib/oi-session";
import { getCorrelationLogFields } from "@/lib/request-correlation";
import { getRequestCorrelation } from "@/lib/request-context";

const log = createLogger("control-plane-client");

/**
 * Create authenticated headers for a control plane request.
 *
 * Returns the signed-in user's web session token (`Authorization: Bearer
 * oi_at_…`), which resolves to a verified user principal at the control
 * plane. User-facing calls never fall back to web's broad service credential:
 * without a live token the caller receives a local 401 and must reauthenticate.
 */
async function getControlPlaneHeaders(request: {
  method: string;
  url: string;
  traceId: string;
}): Promise<HeadersInit | null> {
  const oiAccessToken = await getOiAccessTokenFromCookies();
  if (oiAccessToken) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${oiAccessToken}`,
      "x-trace-id": request.traceId,
    };
  }
  log.warn("auth.user_session_missing", {
    event: "auth.user_session_missing",
    http_path: new URL(request.url).pathname,
    http_method: request.method,
    trace_id: request.traceId,
  });
  return null;
}

/**
 * Make a user-authenticated request to the control plane.
 *
 * The credential is applied after caller-supplied headers, so an
 * `Authorization` header in `options` can never override the identity
 * attached here.
 *
 * @param path - API path (e.g., "/sessions")
 * @param options - Fetch options (method, body, etc.)
 * @returns Fetch Response
 */
export async function controlPlaneUserFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const correlation = await getRequestCorrelation();
  const correlationFields = getCorrelationLogFields(correlation);

  try {
    const url = `${getControlPlaneUrl()}${normalizedPath}`;
    const credentialHeaderValues = await getControlPlaneHeaders({
      method: options.method ?? "GET",
      url,
      traceId: correlation.traceId,
    });
    if (!credentialHeaderValues) {
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
    const credentialHeaders = new Headers(credentialHeaderValues);

    // Caller headers first, credential headers on top: the credential wins
    // over any caller-supplied Authorization or signature header. Content-Type
    // is the one caller-overridable credential header — it defaults to JSON
    // and is not signature-covered (e.g. buffered multipart uploads).
    const mergedHeaders = new Headers(options.headers);
    const callerContentType = mergedHeaders.get("Content-Type");
    credentialHeaders.forEach((value, key) => {
      mergedHeaders.set(key, value);
    });
    if (callerContentType !== null) {
      mergedHeaders.set("Content-Type", callerContentType);
    }

    const fetchOptions: RequestInit = {
      ...options,
      headers: mergedHeaders,
    };

    return await dispatchControlPlaneFetch(url, fetchOptions, correlationFields);
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
