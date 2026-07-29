/**
 * Control Plane API utilities.
 *
 * Attaches the request credential and delegates transport (service binding
 * vs. URL-based fetch) to `control-plane-transport.ts`.
 */

import { buildServiceAuthHeaders } from "@open-inspect/shared";
import { cookies } from "next/headers";
import { serializeBrowserSessionCookies } from "@/lib/browser-session-cookie";
import { dispatchControlPlaneFetch, getControlPlaneUrl } from "@/lib/control-plane-transport";
import { createLogger } from "@/lib/logger";
import { getCorrelationLogFields } from "@/lib/request-correlation";
import { getRequestCorrelation } from "@/lib/request-context";

const log = createLogger("control-plane-client");

/**
 * Return the exact body representation accepted by sig1.
 *
 * Fetch can serialize several higher-level BodyInit variants. Reject those
 * here because signing a value before Fetch serializes it would authenticate
 * different bytes than the control plane receives.
 */
function getSignableBody(
  body: BodyInit | null | undefined
): ArrayBuffer | Uint8Array | string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof ArrayBuffer || body instanceof Uint8Array) {
    return body;
  }
  throw new Error("Unsupported control-plane request body");
}

/**
 * Combine web's channel identity with the opaque browser-session credential.
 * Both are required by browser-authenticated control-plane routes.
 */
async function getControlPlaneHeaders(request: {
  method: string;
  url: string;
  traceId: string;
  body: ArrayBuffer | Uint8Array | string | undefined;
}): Promise<Headers | null> {
  const cookieHeader = serializeBrowserSessionCookies((await cookies()).getAll());
  if (!cookieHeader) {
    log.warn("auth.user_session_missing", {
      event: "auth.user_session_missing",
      http_path: new URL(request.url).pathname,
      http_method: request.method,
      trace_id: request.traceId,
    });
    return null;
  }

  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) {
    throw new Error("SERVICE_AUTH_SECRET not configured");
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    Cookie: cookieHeader,
  });
  const serviceHeaders = await buildServiceAuthHeaders({
    service: "web",
    secret,
    method: request.method,
    url: request.url,
    body: request.body,
    traceId: request.traceId,
  });
  for (const [name, value] of Object.entries(serviceHeaders)) {
    headers.set(name, value);
  }
  return headers;
}

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

function mergeAuthenticatedHeaders(
  callerHeaders: HeadersInit | undefined,
  authenticatedHeaders: Headers
): Headers {
  const headers = new Headers(callerHeaders);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("X-OpenInspect-Actor");
  headers.delete("X-OpenInspect-Service");
  headers.delete("X-OpenInspect-Service-Signature");

  const callerContentType = headers.get("Content-Type");
  authenticatedHeaders.forEach((value, name) => headers.set(name, value));
  if (callerContentType !== null) {
    headers.set("Content-Type", callerContentType);
  }
  return headers;
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
    const url = `${getControlPlaneUrl()}${normalizedPath}`;
    const method = options.method ?? "GET";
    const body = getSignableBody(options.body);
    const authenticatedHeaders = await getControlPlaneHeaders({
      method,
      url,
      traceId: correlation.traceId,
      body,
    });
    if (!authenticatedHeaders) return unauthorizedResponse(correlation);

    return await dispatchControlPlaneFetch(
      url,
      {
        ...options,
        headers: mergeAuthenticatedHeaders(options.headers, authenticatedHeaders),
      },
      correlationFields
    );
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
