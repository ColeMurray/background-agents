import { BrowserAuthConfigurationError } from "../auth/browser-auth-runtime";
import { createLogger } from "../logger";
import { error, parsePattern, type Route } from "./shared";

const logger = createLogger("browser-auth");

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
    if (!ctx.getBrowserAuth) {
      throw new BrowserAuthConfigurationError("Browser authentication runtime is unavailable");
    }
    const response = await ctx.getBrowserAuth().handler(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (cause) {
    if (cause instanceof BrowserAuthConfigurationError) {
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
export const browserAuthRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/auth/sign-in/social"),
    handler: requireWebService(handleBrowserAuth),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/auth/callback/github"),
    handler: requireWebService(handleBrowserAuth),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/auth/callback/google"),
    handler: requireWebService(handleBrowserAuth),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/auth/get-session"),
    handler: requireWebService(handleBrowserAuth),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/auth/sign-out"),
    handler: requireWebService(handleBrowserAuth),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/auth/error"),
    handler: requireWebService(handleBrowserAuth),
  },
];

export function isBrowserAuthProxyRoute(method: string, path: string): boolean {
  return browserAuthRoutes.some((route) => route.method === method && route.pattern.test(path));
}
