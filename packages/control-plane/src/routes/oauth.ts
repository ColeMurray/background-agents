import { readBodyCapped } from "@open-inspect/shared";
import {
  OAuthProtocolCallbackRedirectError,
  OAuthProtocolGrantError,
  OAuthProtocolRequestError,
  type OAuthProtocolRuntime,
  OAuthProtocolUnavailableError,
} from "../auth/oauth-runtime";
import { isSignInProvider } from "../auth/sign-in-provider";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { HttpError, json, parsePattern, type RequestContext, type Route } from "./shared";

const MAX_OAUTH_FORM_BYTES = 16 * 1024;

export type OAuthProtocolEventLevel = "info" | "warn" | "error";
export type OAuthProtocolEventName =
  | "auth.oauth.authorize_started"
  | "auth.oauth.provider_callback_succeeded"
  | "auth.oauth.provider_callback_rejected"
  | "auth.oauth.code_redeemed"
  | "auth.oauth.code_rejected"
  | "auth.oauth.rate_limiter_unavailable"
  | "auth.browser_session.created"
  | "auth.browser_session.revoked";

export interface OAuthProtocolEventSink {
  emit(
    event: OAuthProtocolEventName,
    fields?: Readonly<Record<string, unknown>>,
    level?: OAuthProtocolEventLevel
  ): void;
}

export interface OAuthRateLimitInput {
  readonly request: Request;
  readonly env: Env;
  readonly routeClass: "authorize" | "callback" | "token" | "revoke";
  readonly clientId: "web" | "unknown";
  readonly requestId: string;
  readonly traceId: string;
}

export interface OAuthProtocolRateLimiter {
  requireAllowance(input: OAuthRateLimitInput): Promise<void>;
}

export class OAuthRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("OAuth request rate limit exceeded");
    this.name = "OAuthRateLimitExceededError";
  }
}

export interface OAuthProtocolRouteDependencies {
  readonly createRuntime: (env: Env, db: SqlDatabase) => OAuthProtocolRuntime;
  readonly rateLimiter: OAuthProtocolRateLimiter;
  readonly events: OAuthProtocolEventSink;
}

const AUTHORIZATION_PARAMETERS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "provider",
] as const;

function uniqueParameters(
  parameters: URLSearchParams,
  allowed: readonly string[]
): Record<string, string> {
  const allowedNames = new Set(allowed);
  const result: Record<string, string> = {};
  for (const [name, value] of parameters) {
    if (!allowedNames.has(name) || result[name] !== undefined) {
      throw new HttpError("invalid_request", 400);
    }
    result[name] = value;
  }
  return result;
}

function parseUrlEncoded(
  input: string,
  allowedParameters: readonly string[]
): Record<string, string> {
  try {
    decodeURIComponent(input);
  } catch {
    throw new HttpError("invalid_request", 400);
  }
  return uniqueParameters(new URLSearchParams(input), allowedParameters);
}

function requireParameter(parameters: Record<string, string>, name: string): string {
  const value = parameters[name];
  if (!value) {
    throw new HttpError("invalid_request", 400);
  }
  return value;
}

function rateLimitClientId(clientId: string | undefined): "web" | "unknown" {
  return clientId === "web" ? "web" : "unknown";
}

function eventFields(
  context: RequestContext,
  fields: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    ...fields,
    request_id: context.request_id,
    trace_id: context.trace_id,
  };
}

async function parseForm(
  request: Request,
  allowedParameters: readonly string[]
): Promise<Record<string, string>> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new HttpError("invalid_request", 415);
  }
  const body = await readBodyCapped(request.body, MAX_OAUTH_FORM_BYTES);
  if (body === null) {
    throw new HttpError("invalid_request", 413);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new HttpError("invalid_request", 400);
  }
  return parseUrlEncoded(text, allowedParameters);
}

function requireWebService(context: RequestContext): void {
  const principal = context.principal;
  if (principal?.kind !== "service" || principal.service !== "web" || principal.actor !== null) {
    throw new HttpError("invalid_client", 401);
  }
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function redirectNoStore(location: URL): Response {
  return noStore(
    new Response(null, {
      status: 302,
      headers: { Location: location.href },
    })
  );
}

function rateLimitResponse(error: OAuthRateLimitExceededError): Response {
  const response = noStore(json({ error: "temporarily_unavailable" }, 429));
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(error.retryAfterSeconds));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function oauthErrorResponse(error: string, status: number): Response {
  return noStore(json({ error }, status));
}

function withOAuthProtocolResponse(
  events: OAuthProtocolEventSink,
  handler: Route["handler"]
): Route["handler"] {
  return async (request, env, match, context) => {
    try {
      return await handler(request, env, match, context);
    } catch (error) {
      if (error instanceof OAuthRateLimitExceededError) {
        return rateLimitResponse(error);
      }
      if (error instanceof OAuthProtocolRequestError) {
        return oauthErrorResponse(error.code, 400);
      }
      if (error instanceof OAuthProtocolGrantError) {
        events.emit(
          "auth.oauth.code_rejected",
          eventFields(context, { client_id: "web", failure: error.rejection }),
          "warn"
        );
        return oauthErrorResponse("invalid_grant", 400);
      }
      if (error instanceof OAuthProtocolUnavailableError) {
        return oauthErrorResponse("temporarily_unavailable", 503);
      }
      if (error instanceof HttpError) {
        return oauthErrorResponse(error.message, error.status);
      }
      throw error;
    }
  };
}

export function createOAuthProtocolRoutes(dependencies: OAuthProtocolRouteDependencies): Route[] {
  return [
    {
      method: "GET",
      pattern: parsePattern("/oauth/authorize"),
      handler: withOAuthProtocolResponse(
        dependencies.events,
        async (request, env, _match, context) => {
          const searchParameters = new URL(request.url).searchParams;
          const clientId = rateLimitClientId(searchParameters.get("client_id") ?? undefined);
          await dependencies.rateLimiter.requireAllowance({
            request,
            env,
            routeClass: "authorize",
            clientId,
            requestId: context.request_id,
            traceId: context.trace_id,
          });
          const parameters = parseUrlEncoded(
            new URL(request.url).search.slice(1),
            AUTHORIZATION_PARAMETERS
          );
          const provider = requireParameter(parameters, "provider");
          const redirect = await dependencies.createRuntime(env, context.db).authorize({
            responseType: requireParameter(parameters, "response_type"),
            clientId: requireParameter(parameters, "client_id"),
            redirectUri: requireParameter(parameters, "redirect_uri"),
            codeChallenge: requireParameter(parameters, "code_challenge"),
            codeChallengeMethod: requireParameter(parameters, "code_challenge_method"),
            state: requireParameter(parameters, "state"),
            provider,
          });
          dependencies.events.emit(
            "auth.oauth.authorize_started",
            eventFields(context, {
              client_id: "web",
              provider,
            })
          );
          return redirectNoStore(redirect);
        }
      ),
    },
    {
      method: "GET",
      pattern: parsePattern("/oauth/callback/:provider"),
      handler: withOAuthProtocolResponse(
        dependencies.events,
        async (request, env, match, context) => {
          await dependencies.rateLimiter.requireAllowance({
            request,
            env,
            routeClass: "callback",
            clientId: "web",
            requestId: context.request_id,
            traceId: context.trace_id,
          });
          const provider = match.groups?.provider;
          if (!isSignInProvider(provider)) {
            throw new HttpError("invalid_request", 404);
          }
          const parameters = parseUrlEncoded(new URL(request.url).search.slice(1), [
            "state",
            "code",
            "error",
            "error_description",
          ]);
          const hasCode = parameters.code !== undefined;
          const hasError = parameters.error !== undefined;
          if (hasCode === hasError || (parameters.error_description !== undefined && !hasError)) {
            throw new HttpError("invalid_request", 400);
          }

          const state = requireParameter(parameters, "state");
          const runtime = dependencies.createRuntime(env, context.db);
          if (hasError) {
            const redirect = await runtime.completeDenial(provider, state);
            dependencies.events.emit(
              "auth.oauth.provider_callback_rejected",
              eventFields(context, {
                client_id: "web",
                provider,
                failure: "provider_denied",
              }),
              "warn"
            );
            return redirectNoStore(redirect);
          }

          try {
            const redirect = await runtime.completeAuthorization(provider, {
              state,
              code: requireParameter(parameters, "code"),
            });
            dependencies.events.emit(
              "auth.oauth.provider_callback_succeeded",
              eventFields(context, {
                client_id: "web",
                provider,
              })
            );
            return redirectNoStore(redirect);
          } catch (error) {
            if (!(error instanceof OAuthProtocolCallbackRedirectError)) {
              throw error;
            }
            dependencies.events.emit(
              "auth.oauth.provider_callback_rejected",
              eventFields(context, {
                client_id: "web",
                provider,
                failure: error.failure,
              }),
              "warn"
            );
            const redirect = new URL(error.redirectUri);
            redirect.searchParams.set("error", error.failure);
            redirect.searchParams.set("state", state);
            return redirectNoStore(redirect);
          }
        }
      ),
    },
    {
      method: "POST",
      pattern: parsePattern("/oauth/token"),
      handler: withOAuthProtocolResponse(
        dependencies.events,
        async (request, env, _match, context) => {
          requireWebService(context);
          const parameters = await parseForm(request, [
            "grant_type",
            "code",
            "redirect_uri",
            "client_id",
            "code_verifier",
          ]);
          const clientId = requireParameter(parameters, "client_id");
          await dependencies.rateLimiter.requireAllowance({
            request,
            env,
            routeClass: "token",
            clientId: rateLimitClientId(clientId),
            requestId: context.request_id,
            traceId: context.trace_id,
          });
          if (requireParameter(parameters, "grant_type") !== "authorization_code") {
            throw new HttpError("unsupported_grant_type", 400);
          }
          if (clientId !== "web") {
            throw new HttpError("invalid_client", 401);
          }

          const redeemed = await dependencies
            .createRuntime(env, context.db)
            .redeemAuthorizationCode({
              code: requireParameter(parameters, "code"),
              clientId: "web",
              redirectUri: requireParameter(parameters, "redirect_uri"),
              codeVerifier: requireParameter(parameters, "code_verifier"),
            });
          dependencies.events.emit(
            "auth.oauth.code_redeemed",
            eventFields(context, { client_id: "web" })
          );
          dependencies.events.emit(
            "auth.browser_session.created",
            eventFields(context, { client_id: "web" })
          );
          return noStore(
            json({
              access_token: redeemed.accessToken,
              token_type: "Bearer",
              expires_in: redeemed.expiresIn,
              idle_expires_in: redeemed.idleExpiresIn,
            })
          );
        }
      ),
    },
    {
      method: "POST",
      pattern: parsePattern("/oauth/revoke"),
      handler: withOAuthProtocolResponse(
        dependencies.events,
        async (request, env, _match, context) => {
          requireWebService(context);
          const parameters = await parseForm(request, ["token", "token_type_hint", "client_id"]);
          const clientId = requireParameter(parameters, "client_id");
          await dependencies.rateLimiter.requireAllowance({
            request,
            env,
            routeClass: "revoke",
            clientId: rateLimitClientId(clientId),
            requestId: context.request_id,
            traceId: context.trace_id,
          });
          if (clientId !== "web") {
            throw new HttpError("invalid_client", 401);
          }
          if (
            parameters.token_type_hint !== undefined &&
            parameters.token_type_hint !== "access_token"
          ) {
            throw new HttpError("unsupported_token_type", 400);
          }

          const revoked = await dependencies
            .createRuntime(env, context.db)
            .revokeBrowserSession(requireParameter(parameters, "token"));
          dependencies.events.emit(
            "auth.browser_session.revoked",
            eventFields(context, {
              client_id: "web",
              outcome: revoked ? "revoked" : "already_absent",
              reason: "logout",
            })
          );
          return noStore(new Response(null, { status: 200 }));
        }
      ),
    },
  ];
}
