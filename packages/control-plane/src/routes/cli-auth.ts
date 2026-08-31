import {
  CLI_EXTERNAL_API_V1_PATH,
  approveCliDeviceAuthorizationRequestSchema,
  cliDeviceAuthorizationExchangeRequestSchema,
  revokeCliDeviceAuthorizationRequestSchema,
  startCliDeviceAuthorizationRequestSchema,
} from "@open-inspect/shared/types/cli-auth";
import { ZodError } from "zod";
import { generateId, hashToken } from "../auth/crypto";
import type { AuthenticationContext } from "../auth/principal";
import {
  CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
  CliDeviceAuthorizationError,
  CliDeviceAuthorizationService,
} from "../cli-auth/device-authorization-service";
import { CliAuthStore } from "../db/cli-auth-store";
import { UserStore } from "../db/user-store";
import type { Env } from "../types";
import {
  ACTIVE_SELF,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  type RequestContext,
  type Route,
  type UserRouteContext,
} from "./shared";

const POLL_INTERVAL_MS = 1_000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MINUTE_MS = 60_000;
const EXCHANGE_POLL_MARGIN = 30;
const EXCHANGE_POLLS_PER_LIFETIME =
  Math.ceil(CLI_DEVICE_AUTHORIZATION_LIFETIME_MS / POLL_INTERVAL_MS) + EXCHANGE_POLL_MARGIN;

export const CLI_AUTH_RATE_LIMITS = {
  startPerIp: { windowMs: MINUTE_MS, limit: 10 },
  exchangeBurstPerSecret: { windowMs: POLL_INTERVAL_MS, limit: 2 },
  exchangePerSecret: {
    windowMs: CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
    limit: EXCHANGE_POLLS_PER_LIFETIME,
  },
  exchangePerIp: {
    windowMs: CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
    limit: EXCHANGE_POLLS_PER_LIFETIME * 2,
  },
  lookupPerUser: { windowMs: 10 * MINUTE_MS, limit: 30 },
  approvalPerUser: { windowMs: 10 * MINUTE_MS, limit: 10 },
  capabilityRevokePerSecret: { windowMs: 10 * MINUTE_MS, limit: 10 },
  capabilityRevokePerIp: { windowMs: 10 * MINUTE_MS, limit: 100 },
} as const;

function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(
    bytes,
    (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  ).join("");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function deviceAuthorizationService(ctx: RequestContext): CliDeviceAuthorizationService {
  return new CliDeviceAuthorizationService(new CliAuthStore(ctx.db), {
    now: Date.now,
    generateSecret: () => generateId(32),
    generateUserCode,
    generateId: () => generateId(16),
    hash: hashToken,
  });
}

function serviceError(cause: unknown): Response {
  if (cause instanceof CliDeviceAuthorizationError) return error(cause.message, cause.status);
  if (cause instanceof ZodError) return error("Invalid request body", 400);
  throw cause;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function enforceRateLimits(
  ctx: RequestContext,
  limits: readonly {
    scope: string;
    identity: string;
    windowMs: number;
    limit: number;
  }[]
): Promise<Response | null> {
  const store = new CliAuthStore(ctx.db);
  const now = Date.now();
  const outcomes = await Promise.all(
    limits.map(async (limit) =>
      store.consumeRateLimit({
        key: `${limit.scope}:${await hashToken(limit.identity)}`,
        now,
        windowMs: limit.windowMs,
        limit: limit.limit,
      })
    )
  );
  const blocked = outcomes.filter((outcome) => !outcome.allowed);
  if (blocked.length === 0) return null;
  const retryAfterSeconds = Math.ceil(
    Math.max(...blocked.map((outcome) => outcome.retryAfterMs)) / 1000
  );
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

async function startAuthorization(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const limited = await enforceRateLimits(ctx, [
    {
      scope: "start-ip",
      identity: `${env.DEPLOYMENT_NAME}:${clientIp(request)}`,
      ...CLI_AUTH_RATE_LIMITS.startPerIp,
    },
  ]);
  if (limited) return limited;
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  try {
    const input = startCliDeviceAuthorizationRequestSchema.parse(body);
    const started = await deviceAuthorizationService(ctx).start(input.deviceName);
    const webBaseUrl = (env.WEB_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
    return json(
      {
        ...started,
        verificationUrl: `${webBaseUrl}/cli/authorize?user_code=${encodeURIComponent(started.userCode)}`,
        pollIntervalMs: POLL_INTERVAL_MS,
      },
      201
    );
  } catch (cause) {
    return serviceError(cause);
  }
}

async function exchangeAuthorization(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  try {
    const input = cliDeviceAuthorizationExchangeRequestSchema.parse(body);
    const limited = await enforceRateLimits(ctx, [
      {
        scope: "exchange-secret-burst",
        identity: input.deviceSecret,
        ...CLI_AUTH_RATE_LIMITS.exchangeBurstPerSecret,
      },
      {
        scope: "exchange-secret",
        identity: input.deviceSecret,
        ...CLI_AUTH_RATE_LIMITS.exchangePerSecret,
      },
      {
        scope: "exchange-ip",
        identity: `${env.DEPLOYMENT_NAME}:${clientIp(request)}`,
        ...CLI_AUTH_RATE_LIMITS.exchangePerIp,
      },
    ]);
    if (limited) return limited;
    const exchanged = await deviceAuthorizationService(ctx).exchange(input.deviceSecret);
    return json(exchanged, exchanged.status === "pending" ? 202 : 200);
  } catch (cause) {
    return serviceError(cause);
  }
}

async function revokeIssuedCredential(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  try {
    const input = revokeCliDeviceAuthorizationRequestSchema.parse(body);
    const limited = await enforceRateLimits(ctx, [
      {
        scope: "capability-revoke-secret",
        identity: input.deviceSecret,
        ...CLI_AUTH_RATE_LIMITS.capabilityRevokePerSecret,
      },
      {
        scope: "capability-revoke-ip",
        identity: `${env.DEPLOYMENT_NAME}:${clientIp(request)}`,
        ...CLI_AUTH_RATE_LIMITS.capabilityRevokePerIp,
      },
    ]);
    if (limited) return limited;
    await deviceAuthorizationService(ctx).revokeIssuedCredential(input.deviceSecret);
    return new Response(null, { status: 204 });
  } catch (cause) {
    return serviceError(cause);
  }
}

async function getPendingAuthorization(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  try {
    const input = approveCliDeviceAuthorizationRequestSchema.parse({
      userCode: new URL(request.url).searchParams.get("user_code") ?? "",
    });
    const limited = await enforceRateLimits(ctx, [
      {
        scope: "lookup-user",
        identity: ctx.principal.userId,
        ...CLI_AUTH_RATE_LIMITS.lookupPerUser,
      },
    ]);
    if (limited) return limited;
    return json(await deviceAuthorizationService(ctx).getPendingAuthorization(input.userCode));
  } catch (cause) {
    return serviceError(cause);
  }
}

async function approveAuthorization(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  try {
    const input = approveCliDeviceAuthorizationRequestSchema.parse(body);
    const limited = await enforceRateLimits(ctx, [
      {
        scope: "approval-user",
        identity: ctx.principal.userId,
        ...CLI_AUTH_RATE_LIMITS.approvalPerUser,
      },
    ]);
    if (limited) return limited;
    await deviceAuthorizationService(ctx).approve(input.userCode, ctx.principal.userId);
    return new Response(null, { status: 204 });
  } catch (cause) {
    return serviceError(cause);
  }
}

function cliAuthentication(
  ctx: UserRouteContext
): Extract<AuthenticationContext, { mechanism: "cli_credential" }> {
  if (ctx.authentication?.mechanism !== "cli_credential") {
    throw new Error("Missing CLI authentication context");
  }
  return ctx.authentication;
}

async function getMe(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const authentication = cliAuthentication(ctx);
  const user = await new UserStore(ctx.db).getUserById(ctx.principal.userId);
  if (!user) return error("User not found", 404);
  return json({
    installation: { name: env.DEPLOYMENT_NAME },
    user: { id: user.id, displayName: user.displayName, email: user.email },
    credential: { id: authentication.credentialId, expiresAt: authentication.expiresAt },
  });
}

async function revokeCurrent(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const authentication = cliAuthentication(ctx);
  await new CliAuthStore(ctx.db).revoke(
    authentication.credentialId,
    ctx.principal.userId,
    Date.now()
  );
  return new Response(null, { status: 204 });
}

const publicRoutes: Route[] = [
  {
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/device-authorizations$`),
    authorization: NO_AUTHORIZATION,
    cacheControl: "no-store",
    handler: startAuthorization,
  },
  {
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/exchange$`),
    authorization: NO_AUTHORIZATION,
    cacheControl: "no-store",
    handler: exchangeAuthorization,
  },
  {
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/revoke$`),
    authorization: NO_AUTHORIZATION,
    cacheControl: "no-store",
    handler: revokeIssuedCredential,
  },
];

export const cliAuthRoutes: Route[] = [
  ...publicRoutes,
  ...defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
    {
      method: "GET",
      pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/pending$`),
      authorization: ACTIVE_SELF,
      cacheControl: "private, no-store",
      handler: getPendingAuthorization,
    },
    {
      method: "POST",
      pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/approve$`),
      authorization: ACTIVE_SELF,
      cacheControl: "private, no-store",
      handler: approveAuthorization,
    },
  ]),
  ...defineRoutes(SCM_AGNOSTIC_EXTERNAL_USER_ROUTE, [
    {
      method: "GET",
      pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/me$`),
      authorization: ACTIVE_SELF,
      cacheControl: "private, no-store",
      handler: getMe,
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^${CLI_EXTERNAL_API_V1_PATH}/credentials/current$`),
      authorization: ACTIVE_SELF,
      cacheControl: "private, no-store",
      handler: revokeCurrent,
    },
  ]),
];
