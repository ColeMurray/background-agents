import { BROWSER_AUTH_PROXY_ROUTES } from "@open-inspect/shared";
import { type BetterAuthRuntime, UserAuthConfigurationError } from "../auth/user/runtime";
import { createLogger } from "../logger";
import { error, parsePattern, type Route } from "./shared";

const logger = createLogger("browser-auth");

function copyBrowserAuthResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") {
      headers.append(name, value);
    }
  });
  const getSetCookie = (upstream as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookieValues = getSetCookie?.call(upstream) ?? [];
  if (setCookieValues.length === 0) {
    const value = upstream.get("Set-Cookie");
    if (value) setCookieValues.push(value);
  }
  for (const value of setCookieValues) {
    headers.append("Set-Cookie", value);
  }
  return headers;
}

/**
 * Better Auth's direct API establishes its request-state context explicitly.
 * Use it for session reads because Cloudflare Workers can lose the HTTP
 * handler's AsyncLocalStorage state before session-refresh policy is read.
 */
export async function forwardBrowserAuthRequest(
  auth: BetterAuthRuntime,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/auth/get-session") {
    return auth.api.getSession({
      headers: request.headers,
      asResponse: true,
    });
  }
  return auth.handler(request);
}

function requireWebService(route: Route["handler"]): Route["handler"] {
  return async (request, env, match, ctx) => {
    if (ctx.principal?.kind !== "service" || ctx.principal.service !== "web") {
      return error("Unauthorized", 401);
    }
    return route(request, env, match, ctx);
  };
}

const handleBrowserAuth: Route["handler"] = async (request, _env, _match, ctx) => {
  try {
    if (!ctx.getUserAuth) {
      throw new UserAuthConfigurationError("User authentication runtime is unavailable");
    }
    const response = await forwardBrowserAuthRequest(ctx.getUserAuth(), request);
    const headers = copyBrowserAuthResponseHeaders(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (cause) {
    if (cause instanceof UserAuthConfigurationError) {
      logger.error("Browser authentication is not configured", {
        event: "auth.browser.misconfigured",
        error: cause,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Browser authentication is not configured", 503);
    }
    throw cause;
  }
};

/**
 * The browser can reach only this positive Better Auth allowlist, and only
 * through a freshly signed service:web proxy request.
 */
export const browserAuthRoutes: Route[] = BROWSER_AUTH_PROXY_ROUTES.map(([method, path]) => ({
  method,
  pattern: parsePattern(path),
  handler: requireWebService(handleBrowserAuth),
}));
