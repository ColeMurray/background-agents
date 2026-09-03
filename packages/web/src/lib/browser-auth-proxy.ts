import {
  BROWSER_AUTH_CLIENT_IP_HEADER,
  isBrowserAuthProxyRoute,
} from "@open-inspect/shared/browser-auth-routes";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { SERVICE_REQUEST_MAX_BODY_BYTES } from "@open-inspect/shared/service-auth";
import { dispatchWebServiceRequest } from "./control-plane-service";

const REQUEST_HEADERS = [
  "Accept",
  "Accept-Language",
  "Content-Type",
  "Cookie",
  "Origin",
  "User-Agent",
] as const;

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DECODED_BODY_RESPONSE_HEADERS = new Set(["content-encoding", "content-length"]);

function requestBodyTooLarge(): Response {
  return Response.json(
    { error: "Request body is too large" },
    { status: 413, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

/**
 * A logical browser-auth request for server code that has no incoming URL.
 * The dispatcher resolves the configured control-plane origin before signing.
 */
export interface BrowserAuthDispatchRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search?: string;
  readonly headers?: HeadersInit;
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly clientIp?: string | null;
}

function copyRequestHeaders(source: Headers, clientIp?: string | null): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (clientIp != null) {
    headers.set(BROWSER_AUTH_CLIENT_IP_HEADER, clientIp);
  }
  return headers;
}

function trustedClientIp(request: Request): string | null {
  if (process.env.VERCEL === "1") {
    return request.headers.get("X-Vercel-Forwarded-For");
  }
  return "cf" in request ? request.headers.get("CF-Connecting-IP") : null;
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = withGetSetCookie.getSetCookie?.() ?? [];
  if (values.length > 0) return values;
  const singleValue = headers.get("Set-Cookie");
  return singleValue ? [singleValue] : [];
}

function copyResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName !== "set-cookie" &&
      !HOP_BY_HOP_RESPONSE_HEADERS.has(normalizedName) &&
      !DECODED_BODY_RESPONSE_HEADERS.has(normalizedName)
    ) {
      headers.append(name, value);
    }
  });
  for (const value of getSetCookieValues(upstream)) {
    headers.append("Set-Cookie", value);
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return headers;
}

async function dispatchAllowedBrowserAuthRequest(
  request: BrowserAuthDispatchRequest
): Promise<Response> {
  const method = request.method;
  const sourceHeaders = new Headers(request.headers);
  const headers = copyRequestHeaders(sourceHeaders, request.clientIp);
  const upstream = await dispatchWebServiceRequest({
    method,
    path: `${request.pathname}${request.search ?? ""}`,
    headers,
    body: request.body,
    traceId: sourceHeaders.get("x-trace-id") ?? undefined,
    transportOptions: {
      redirect: "manual",
      cache: "no-store",
    },
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream.headers),
  });
}

export async function dispatchBrowserAuthRequest(
  request: BrowserAuthDispatchRequest
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!isBrowserAuthProxyRoute(method, request.pathname)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return dispatchAllowedBrowserAuthRequest({ ...request, method });
}

export async function proxyBrowserAuthRequest(request: Request): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!isBrowserAuthProxyRoute(method, incomingUrl.pathname)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const contentLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > SERVICE_REQUEST_MAX_BODY_BYTES) {
      return requestBodyTooLarge();
    }
    const buffered = await readBodyCapped(request.body, SERVICE_REQUEST_MAX_BODY_BYTES);
    if (buffered === null) {
      return requestBodyTooLarge();
    }
    body = buffered;
  }
  return dispatchAllowedBrowserAuthRequest({
    method,
    pathname: incomingUrl.pathname,
    search: incomingUrl.search,
    headers: request.headers,
    body,
    clientIp: trustedClientIp(request),
  });
}
