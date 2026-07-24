/**
 * Edge authentication: resolve every non-public, non-sandbox request to a
 * typed `Principal` before any handler runs.
 *
 * Dispatch order: a `sig1` service signature (verified against
 * that service's own secret — a failed attempt is terminal), then an
 * `oi_at_` web session token. Anything else is not a recognized credential.
 *
 * Sandbox tokens stay router-verified (they need the session id from the
 * path and a DO round-trip), so they are not dispatched here.
 */

import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  TOKEN_VALIDITY_MS,
  isServiceName,
  parseServiceSignatureHeader,
  readBodyCapped,
  sha256Hex,
  verifyServiceSignature,
  type ServiceName,
} from "@open-inspect/shared";

import {
  ASSERTION_RIGHTS,
  isActorNamespace,
  type ActorNamespace,
  type Principal,
} from "./principal";
import { ACCESS_TOKEN_PREFIX, WebSessionTokenService } from "./web-session-tokens";
import { ApiTokenStore } from "../db/api-tokens";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";

const logger = createLogger("auth");

export interface AuthError {
  /** Response body message (also the log detail). Never carries token material. */
  reason: string;
  status: 401 | 413 | 500;
  /**
   * Which scheme was attempted and failed. A per-service or user-token
   * attempt is terminal; "none" means no recognized credential was presented
   * at all, and the router may still try sandbox auth on sandbox routes.
   */
  failedScheme: "per-service" | "user-token" | "none";
}

/**
 * Hard cap on a service-signed request body. The signature covers the body
 * hash, so the body must be buffered and hashed before verification can
 * finish — this cap bounds what an unauthenticated sender can make the edge
 * buffer. The largest legitimate signed body is a session-attachment
 * multipart upload (see SESSION_ATTACHMENT_MAX_REQUEST_BYTES, ~10MB); sandbox
 * media uploads authenticate with sandbox tokens and never pass through here.
 */
export const SERVICE_REQUEST_MAX_BODY_BYTES = 16 * 1024 * 1024;

export type AuthResult = { principal: Principal; request: Request } | AuthError;

export function isAuthError(result: AuthResult): result is AuthError {
  return !("principal" in result);
}

/** The per-service verification keys the CP holds. */
export interface ServiceKeyEnv {
  SERVICE_AUTH_SECRET_WEB?: string;
  SERVICE_AUTH_SECRET_SLACK_BOT?: string;
  SERVICE_AUTH_SECRET_GITHUB_BOT?: string;
  SERVICE_AUTH_SECRET_LINEAR_BOT?: string;
  SERVICE_AUTH_SECRET_MODAL?: string;
}

/** The verification key the CP holds for each service (also the signing key for CP→bot callbacks). */
export function serviceAuthSecret(env: ServiceKeyEnv, service: ServiceName): string | undefined {
  switch (service) {
    case "web":
      return env.SERVICE_AUTH_SECRET_WEB;
    case "slack-bot":
      return env.SERVICE_AUTH_SECRET_SLACK_BOT;
    case "github-bot":
      return env.SERVICE_AUTH_SECRET_GITHUB_BOT;
    case "linear-bot":
      return env.SERVICE_AUTH_SECRET_LINEAR_BOT;
    case "modal":
      return env.SERVICE_AUTH_SECRET_MODAL;
  }
}

/** Parse `<namespace>:<id>` into a typed actor reference; null when malformed. */
function parseActor(actor: string): { provider: ActorNamespace; providerUserId: string } | null {
  const separator = actor.indexOf(":");
  if (separator <= 0) return null;
  const namespace = actor.slice(0, separator);
  const providerUserId = actor.slice(separator + 1);
  if (providerUserId === "" || !isActorNamespace(namespace)) return null;
  return { provider: namespace, providerUserId };
}

/**
 * Best-effort nonce-reuse detection (log-only for now; a future change may
 * reject). In-isolate only — a replay against a different isolate is not
 * observed. Entries expire with the signature validity window.
 */
const seenNonces = new Map<string, number>();
const SEEN_NONCE_LIMIT = 5000;

function recordNonce(service: ServiceName, nonce: string, ctx: RequestContext): void {
  const now = Date.now();
  const key = `${service}:${nonce}`;
  const expiresAt = seenNonces.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    logger.warn("Service auth nonce reused", {
      event: "auth.nonce_reuse",
      service,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return;
  }
  if (seenNonces.size >= SEEN_NONCE_LIMIT) {
    for (const [candidate, expiry] of seenNonces) {
      if (expiry <= now) seenNonces.delete(candidate);
    }
    // Still over cap: shed the oldest entries (Map iteration is insertion
    // order, and entries are inserted with monotonically increasing expiry).
    // A flood must degrade detection gradually, never erase all memory.
    let excess = seenNonces.size - SEEN_NONCE_LIMIT + 1;
    for (const candidate of seenNonces.keys()) {
      if (excess-- <= 0) break;
      seenNonces.delete(candidate);
    }
  }
  seenNonces.set(key, now + TOKEN_VALIDITY_MS);
}

async function authenticateServiceCredential(
  request: Request,
  env: Env,
  ctx: RequestContext,
  signatureHeader: string
): Promise<AuthResult> {
  const serviceHeader = request.headers.get(SERVICE_HEADER) ?? "";
  if (!isServiceName(serviceHeader)) {
    logger.warn("Service auth failed: unknown service", {
      event: "auth.service_failed",
      failure: "unknown_service",
      service: serviceHeader,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
  }
  const service = serviceHeader;

  const secret = serviceAuthSecret(env, service);
  if (!secret) {
    logger.error("Service auth secret not configured - rejecting request", {
      event: "auth.misconfigured",
      service,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return {
      reason: "Service authentication not configured",
      status: 500,
      failedScheme: "per-service",
    };
  }

  // Reject everything rejectable before paying for the body: a malformed or
  // stale header must not cost a body buffer + hash.
  const parsedSignature = parseServiceSignatureHeader(signatureHeader);
  if (!parsedSignature.ok) {
    logger.warn("Service auth failed: signature rejected", {
      event: "auth.service_failed",
      failure: parsedSignature.reason,
      service,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
  }

  let bodyBuffer: Uint8Array | null = null;
  if (request.body !== null) {
    bodyBuffer = await readBodyCapped(request.body, SERVICE_REQUEST_MAX_BODY_BYTES);
    if (bodyBuffer === null) {
      logger.warn("Service auth failed: body over size cap", {
        event: "auth.service_failed",
        failure: "body_too_large",
        service,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return { reason: "Request body too large", status: 413, failedScheme: "per-service" };
    }
  }
  const bodySha256Hex = await sha256Hex(bodyBuffer ?? "");
  const actor = request.headers.get(ACTOR_HEADER) ?? "";

  const verification = await verifyServiceSignature({
    signatureHeader,
    service,
    secret,
    method: request.method,
    url: request.url,
    bodySha256Hex,
    actor,
  });
  if (!verification.ok) {
    logger.warn("Service auth failed: signature rejected", {
      event: "auth.service_failed",
      failure: verification.reason,
      service,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
  }

  recordNonce(service, verification.nonce, ctx);

  let resolvedActor = null;
  if (actor !== "") {
    const parsed = parseActor(actor);
    if (!parsed || ASSERTION_RIGHTS[service] !== parsed.provider) {
      logger.warn("Actor assertion denied", {
        event: "auth.assertion_denied",
        service,
        actor,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
    }
    const identity = await new UserStore(ctx.db).getIdentity(
      parsed.provider,
      parsed.providerUserId
    );
    resolvedActor = {
      provider: parsed.provider,
      providerUserId: parsed.providerUserId,
      canonicalUserId: identity?.userId ?? null,
      participantUserId: actor,
    };
  }

  // The body was consumed to hash it; hand the handler a request that can
  // still be read. Bodyless requests pass through untouched. Built from
  // parts deliberately: the `new Request(request, { body })` copy-constructor
  // throws in workerd once the source request's body has been disturbed.
  const handlerRequest =
    bodyBuffer === null
      ? request
      : new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bodyBuffer,
        });

  return {
    principal: { kind: "service", service, actor: resolvedActor },
    request: handlerRequest,
  };
}

async function authenticateWebSessionToken(
  token: string,
  request: Request,
  ctx: RequestContext
): Promise<AuthResult> {
  const store = new ApiTokenStore(ctx.db);
  const verification = await new WebSessionTokenService(store).verifyAccessToken(token);
  if (!verification.ok) {
    logger.warn("Web session token rejected", {
      event: "auth.user_token_failed",
      failure: verification.failure,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { reason: "Unauthorized", status: 401, failedScheme: "user-token" };
  }

  ctx.executionCtx?.waitUntil(
    store.touchLastUsed(verification.tokenId).catch(() => {
      // Best-effort usage stamp; never block or fail the request for it.
    })
  );

  return {
    principal: {
      kind: "user",
      user: {
        provider: verification.provider,
        providerUserId: verification.providerUserId,
        canonicalUserId: verification.userId,
        // Web users participate under their bare canonical id.
        participantUserId: verification.userId,
      },
      tokenId: verification.tokenId,
    },
    request,
  };
}

export async function authenticate(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<AuthResult> {
  const signatureHeader = request.headers.get(SERVICE_SIGNATURE_HEADER);
  if (signatureHeader !== null) {
    return authenticateServiceCredential(request, env, ctx, signatureHeader);
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith(`Bearer ${ACCESS_TOKEN_PREFIX}`)) {
    return authenticateWebSessionToken(authHeader.slice("Bearer ".length), request, ctx);
  }

  // No recognized credential. The shared bearer is retired — a
  // legacy internal token is just another unrecognized Authorization value.
  return { reason: "Unauthorized", status: 401, failedScheme: "none" };
}
