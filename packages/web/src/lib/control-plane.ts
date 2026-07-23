/**
 * Control Plane API utilities.
 *
 * Attaches the request credential and delegates transport (service binding
 * vs. URL-based fetch) to `control-plane-transport.ts`.
 */

import { buildServiceAuthHeaders } from "@open-inspect/shared";
import { dispatchControlPlaneFetch, getControlPlaneUrl } from "@/lib/control-plane-transport";
import { createLogger } from "@/lib/logger";
import { getOiAccessTokenFromCookies } from "@/lib/oi-session";
import { getCorrelationLogFields } from "@/lib/request-correlation";
import { getRequestCorrelation } from "@/lib/request-context";

const log = createLogger("control-plane-client");

/** A body sig1 can hash: exact bytes or a string. Streams cannot be signed. */
type SignableBody = string | ArrayBuffer | Uint8Array | undefined;

/**
 * Narrow a fetch body to the shapes whose exact bytes can be signed. Every
 * route serializes before calling `controlPlaneFetch` (JSON strings, buffered
 * multipart bytes); a streaming or structured body here is a programming
 * error, surfaced loudly rather than sent unsigned.
 */
function toSignableBody(body: RequestInit["body"]): SignableBody {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string" || body instanceof ArrayBuffer || body instanceof Uint8Array) {
    return body;
  }
  throw new Error(
    "controlPlaneFetch requires a string or buffered binary body so it can be signed"
  );
}

/**
 * Create authenticated headers for a control plane request.
 *
 * Prefers the signed-in user's web session token (`Authorization: Bearer
 * oi_at_…`), which resolves to a verified user principal at the control
 * plane. Without a live token (userless calls, pre-exchange sessions,
 * expired tokens), the request is signed with web's own sig1 service
 * credential — a verified `web` service principal with no participant.
 */
async function getControlPlaneHeaders(request: {
  method: string;
  url: string;
  body: SignableBody;
  traceId: string;
}): Promise<HeadersInit> {
  const oiAccessToken = await getOiAccessTokenFromCookies();
  if (oiAccessToken) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${oiAccessToken}`,
      "x-trace-id": request.traceId,
    };
  }
  const serviceSecret = process.env.SERVICE_AUTH_SECRET;
  if (!serviceSecret) {
    console.error("[control-plane] SERVICE_AUTH_SECRET not configured");
    throw new Error("Control plane credentials not configured");
  }
  return {
    "Content-Type": "application/json",
    ...(await buildServiceAuthHeaders({
      service: "web",
      secret: serviceSecret,
      method: request.method,
      url: request.url,
      body: request.body,
      traceId: request.traceId,
    })),
  };
}

/**
 * Make an authenticated request to the control plane.
 *
 * The credential is applied after caller-supplied headers, so an
 * `Authorization` header in `options` can never override the identity
 * attached here.
 *
 * @param path - API path (e.g., "/sessions")
 * @param options - Fetch options (method, body, etc.)
 * @returns Fetch Response
 */
export async function controlPlaneFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const correlation = await getRequestCorrelation();
  const correlationFields = getCorrelationLogFields(correlation);

  try {
    // The URL and body are fixed before header construction: sig1 signatures
    // bind method, URL, and exact body bytes, so what is signed here is what
    // `dispatchControlPlaneFetch` sends.
    const url = `${getControlPlaneUrl()}${normalizedPath}`;
    const body = toSignableBody(options.body);
    const credentialHeaders = new Headers(
      await getControlPlaneHeaders({
        method: options.method ?? "GET",
        url,
        body,
        traceId: correlation.traceId,
      })
    );

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
