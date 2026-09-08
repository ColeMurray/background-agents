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
import { ASSERTION_RIGHTS, isActorNamespace, type ActorNamespace } from "../principal";
import type { AuthenticationRequestServices } from "../request-services";
import type { AuthResult } from "../result";
import { serviceAuthSecret } from "./config";

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
    principal: { kind: "service", service, actor: resolvedActor },
    request: handlerRequest,
  };
}
