import { BROWSER_AUTH_PROXY_ROUTES } from "@open-inspect/shared/browser-auth-routes";
import { Hono } from "hono";
import { type BetterAuthRuntime, UserAuthConfigurationError } from "../auth/user/runtime";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  error,
  NO_AUTHORIZATION,
  type RequestContext,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
} from "./shared";

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

async function handleBrowserAuth(
  request: Request,
  _env: Env,
  _params: Record<string, never>,
  ctx: RequestContext
): Promise<Response> {
  try {
    if (!ctx.getUserAuth) {
      throw new UserAuthConfigurationError("User authentication runtime is unavailable");
    }
    const auth = ctx.getUserAuth();
    const response = await forwardBrowserAuthRequest(auth, request);
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
}

/**
 * The browser can reach only this positive Better Auth allowlist, and only
 * through a freshly signed service:web proxy request.
 */
export const browserAuthRoutes = new Hono<ControlPlaneHonoEnv>();

const BROWSER_AUTH = admit({ ...SCM_AGNOSTIC_WEB_SERVICE_ROUTE, authorization: NO_AUTHORIZATION });

for (const [method, path] of BROWSER_AUTH_PROXY_ROUTES) {
  browserAuthRoutes.on(method, path, BROWSER_AUTH, (c) => dispatch(c, handleBrowserAuth));
}
