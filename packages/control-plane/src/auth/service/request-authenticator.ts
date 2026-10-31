import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_REQUEST_MAX_BODY_BYTES,
  isServiceName,
  parseServiceSignatureHeader,
  sha256Hex,
  verifyServiceSignature,
  type ServiceName,
} from "@open-inspect/shared/service-auth";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { TOKEN_VALIDITY_MS } from "@open-inspect/shared/auth";
import { UserStore } from "../../db/user-store";
import { createLogger } from "../../logger";
import type { Env } from "../../types";
import {
  SERVICE_PROFILES,
  isActorNamespace,
  type ActorNamespace,
  type ResolvedIdentity,
} from "../principal";
import type { AuthenticationRequestServices } from "../request-services";
import type { AuthResult } from "../result";
import { serviceCredential, type ServiceCredential } from "./config";

const logger = createLogger("auth");

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
 * Best-effort nonce-reuse detection (log-only for now). This is in-isolate
 * state; entries expire with the signature validity window.
 */
const seenNonces = new Map<string, number>();
const SEEN_NONCE_LIMIT = 5000;

function recordNonce(
  service: ServiceName,
  nonce: string,
  ctx: AuthenticationRequestServices
): void {
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
    // Map iteration follows insertion order, which also follows expiry order.
    let excess = seenNonces.size - SEEN_NONCE_LIMIT + 1;
    for (const candidate of seenNonces.keys()) {
      if (excess-- <= 0) break;
      seenNonces.delete(candidate);
    }
  }
  seenNonces.set(key, now + TOKEN_VALIDITY_MS);
}

type ActorResolution =
  | { ok: true; actor: ResolvedIdentity | null }
  | { ok: false; failure: "not_pinned_actor" | "namespace" | "pinned_user_mismatch" };

/**
 * Apply the service's actor policy to the asserted actor header (empty when
 * absent). A pinned actor must match the configured pin, already exist, and
 * still belong to the pinned user: a user merge moves identities to the
 * surviving user, and must not move this credential with them.
 */
async function resolveAssertedActor(
  service: ServiceName,
  actor: string,
  credential: ServiceCredential,
  ctx: AuthenticationRequestServices
): Promise<ActorResolution> {
  const policy = SERVICE_PROFILES[service].actor;
  const pin = policy.kind === "pinned" ? credential.pinnedActor : undefined;
  if (policy.kind === "pinned" && (!pin || actor !== pin.actor)) {
    return { ok: false, failure: "not_pinned_actor" };
  }
  if (actor === "") return { ok: true, actor: null };

  const parsed = parseActor(actor);
  if (!parsed || policy.kind === "none" || policy.namespace !== parsed.provider) {
    return { ok: false, failure: "namespace" };
  }
  const identity = await new UserStore(ctx.db).getIdentity(parsed.provider, parsed.providerUserId);
  if (pin && identity?.userId !== pin.userId) {
    return { ok: false, failure: "pinned_user_mismatch" };
  }
  return {
    ok: true,
    actor: {
      provider: parsed.provider,
      providerUserId: parsed.providerUserId,
      canonicalUserId: identity?.userId ?? null,
      participantUserId: actor,
    },
  };
}

export async function authenticateServiceRequest(
  request: Request,
  env: Env,
  ctx: AuthenticationRequestServices,
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

  const credential = serviceCredential(env, service);
  if (!credential) {
    // A pinned service is off until an operator configures it; treat it like
    // an unknown service rather than a misconfiguration.
    if (SERVICE_PROFILES[service].actor.kind === "pinned") {
      logger.warn("Service auth failed: service not enabled", {
        event: "auth.service_failed",
        failure: "service_disabled",
        service,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
    }
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

  // Reject malformed or stale signatures before buffering the request body.
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
    secret: credential.secret,
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

  const resolved = await resolveAssertedActor(service, actor, credential, ctx);
  if (!resolved.ok) {
    logger.warn("Actor assertion denied", {
      event: "auth.assertion_denied",
      failure: resolved.failure,
      service,
      actor,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { reason: "Unauthorized", status: 401, failedScheme: "per-service" };
  }

  // Rebuild requests whose body was consumed for signature verification.
  const handlerRequest =
    bodyBuffer === null
      ? request
      : new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bodyBuffer,
        });

  return {
    principal: { kind: "service", service, actor: resolved.actor },
    request: handlerRequest,
  };
}
