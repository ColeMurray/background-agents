import { buildServiceAuthHeaders, isBrowserAuthProxyRoute } from "@open-inspect/shared";
import { dispatchControlPlaneFetch, getControlPlaneUrl } from "./control-plane-transport";

const AUTH_PROXY_TIMEOUT_MS = 15_000;

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

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
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

export async function proxyBrowserAuthRequest(request: Request): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!isBrowserAuthProxyRoute(method, incomingUrl.pathname)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) {
    throw new Error("SERVICE_AUTH_SECRET not configured");
  }

  const upstreamUrl = `${getControlPlaneUrl()}${incomingUrl.pathname}` + incomingUrl.search;
  const body =
    method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
  const headers = copyRequestHeaders(request);
  const serviceHeaders = await buildServiceAuthHeaders({
    service: "web",
    secret,
    method,
    url: upstreamUrl,
    body,
    traceId: request.headers.get("x-trace-id") ?? undefined,
  });
  for (const [name, value] of Object.entries(serviceHeaders)) {
    headers.set(name, value);
  }

  const upstream = await dispatchControlPlaneFetch(
    upstreamUrl,
    {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(AUTH_PROXY_TIMEOUT_MS),
    },
    {}
  );

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream.headers),
  });
}
