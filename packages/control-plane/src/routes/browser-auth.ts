import { BROWSER_AUTH_PROXY_ROUTES } from "@open-inspect/shared/browser-auth-routes";
import { type BetterAuthRuntime, UserAuthConfigurationError } from "../auth/user/runtime";
import { AuthorizationService } from "../authorization/service";
import { createLogger } from "../logger";
import {
  defineRoutes,
  error,
  parsePattern,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type Route,
} from "./shared";

const logger = createLogger("browser-auth");

function responseSessionToken(headers: Headers): string | null {
  const values =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.call(headers) ?? [];
  if (values.length === 0) {
    const value = headers.get("Set-Cookie");
    if (value) values.push(value);
  }
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 0 || !pair.slice(0, separator).endsWith(".session_token")) continue;
    const signedValue = decodeURIComponent(pair.slice(separator + 1));
    return signedValue.split(".", 1)[0] || null;
  }
  return null;
}

async function bootstrapOwnerAfterOAuthCallback(
  request: Request,
  response: Response,
  configuredEmail: string | undefined,
  callbackStartedAt: number,
  ctx: Parameters<Route["handler"]>[3]
): Promise<void> {
  const provider = new URL(request.url).pathname.match(
    /^\/api\/auth\/callback\/(github|google)$/
  )?.[1] as "github" | "google" | undefined;
  if (!provider || !configuredEmail || response.status < 300 || response.status >= 400) return;
  const token = responseSessionToken(response.headers);
  if (!token) return;
  const session = await ctx.db
    .prepare("SELECT userId FROM auth_sessions WHERE token = ? AND expiresAt > ?")
    .bind(token, Date.now())
    .first<{ userId: string }>();
  if (!session) return;
  const evidence = await ctx.db
    .prepare(
      `SELECT evidence.provider_user_id, evidence.email, evidence.observed_at
       FROM browser_sign_in_evidence evidence
       JOIN user_identities identity
         ON identity.provider = evidence.provider
        AND identity.provider_user_id = evidence.provider_user_id
       WHERE identity.user_id = ? AND evidence.provider = ? AND evidence.observed_at >= ?
       ORDER BY evidence.observed_at DESC LIMIT 1`
    )
    .bind(session.userId, provider, callbackStartedAt)
    .first<{ provider_user_id: string; email: string; observed_at: number }>();
  if (!evidence) return;
  await new AuthorizationService(ctx.db).tryBootstrapOwner({
    userId: session.userId,
    provider,
    providerUserId: evidence.provider_user_id,
    verifiedEmail: evidence.email,
    evidenceObservedAt: evidence.observed_at,
    configuredEmail,
    requestId: ctx.request_id,
  });
}

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

const handleBrowserAuth: Route["handler"] = async (request, env, _match, ctx) => {
  try {
    if (!ctx.getUserAuth) {
      throw new UserAuthConfigurationError("User authentication runtime is unavailable");
    }
    const auth = ctx.getUserAuth();
    const callbackStartedAt = Date.now();
    const response = await forwardBrowserAuthRequest(auth, request);
    await bootstrapOwnerAfterOAuthCallback(
      request,
      response,
      env.RBAC_BOOTSTRAP_OWNER_EMAIL,
      callbackStartedAt,
      ctx
    );
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
export const browserAuthRoutes: Route[] = defineRoutes(
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  BROWSER_AUTH_PROXY_ROUTES.map(([method, path]) => ({
    method,
    pattern: parsePattern(path),
    handler: handleBrowserAuth,
  }))
);
