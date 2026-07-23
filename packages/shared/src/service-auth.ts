/**
 * Per-service request authentication (the `sig1` signature format).
 *
 * Replaces the shared claimless bearer for service-to-service traffic: each
 * service signs its requests with its own secret, and the signature binds the
 * full request (method, path, query, body hash, asserted actor) so a captured
 * credential cannot be replayed against a different request.
 *
 * The canonical request string layout is a cross-language contract with
 * `sandbox_runtime/auth/service_auth.py`, pinned by the golden vectors in
 * `test-fixtures/service-auth-vectors.json`. Any change to the layout or the
 * canonicalization rules requires a new format tag (`sig2`), not an edit here.
 */

import { bytesToHex, computeHmacHex, timingSafeEqual, TOKEN_VALIDITY_MS } from "./auth";

export const SERVICE_HEADER = "X-OpenInspect-Service";
export const SERVICE_SIGNATURE_HEADER = "X-OpenInspect-Service-Signature";
export const ACTOR_HEADER = "X-OpenInspect-Actor";
export const SIG1_PREFIX = "sig1";

export const SERVICE_NAMES = ["web", "slack-bot", "github-bot", "linear-bot", "modal"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export function isServiceName(value: string): value is ServiceName {
  return (SERVICE_NAMES as readonly string[]).includes(value);
}

/** Signature verification failure, ordered from cheapest to most specific check. */
export type ServiceSignatureFailure = "format" | "expired" | "mismatch";

/**
 * Successful verification returns the parsed wire components so callers never
 * re-split the header (this module is the sole owner of the sig1 grammar).
 */
export type ServiceSignatureResult =
  | { ok: true; timestampMs: number; nonce: string }
  | { ok: false; reason: ServiceSignatureFailure };

const NONCE_PATTERN = /^[0-9a-f]{1,64}$/;
// Strict ASCII decimal, mirrored by service_auth.py. Number()'s wider grammar
// ("1e3", "0x10", padding) must not classify differently across languages.
const TIMESTAMP_PATTERN = /^[0-9]{1,16}$/;

/**
 * SHA-256 of the raw request body as lowercase hex. Bodyless requests hash
 * the empty byte string.
 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function compareUtf8Bytes(a: string, b: string): number {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const len = Math.min(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    if (aBytes[i] !== bBytes[i]) {
      return aBytes[i] - bBytes[i];
    }
  }
  return aBytes.length - bBytes.length;
}

/**
 * Canonical form of a URL's query string: decoded `key=value` entries sorted
 * bytewise (UTF-8) by `key\0value`, re-encoded with `encodeURIComponent`, and
 * joined with `&`. An empty query canonicalizes to the empty string, so
 * `?a=1&b=2` and `?b=2&a=1` sign identically while `?a=1` and no query do not
 * collide with each other's canonical strings.
 */
export function canonicalizeQuery(search: string): string {
  const params = new URLSearchParams(search);
  const entries = Array.from(params.entries());
  entries.sort((a, b) => compareUtf8Bytes(`${a[0]}\0${a[1]}`, `${b[0]}\0${b[1]}`));
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * The exact byte layout signed by `sig1`. Every field is newline-delimited;
 * `actor` is the empty string when no actor header is sent.
 */
export function buildCanonicalRequestString(p: {
  service: ServiceName;
  timestampMs: number;
  nonce: string;
  method: string;
  pathname: string;
  canonicalQuery: string;
  bodySha256Hex: string;
  actor: string;
}): string {
  return (
    `${SIG1_PREFIX}\n${p.service}\n${p.timestampMs}\n${p.nonce}\n` +
    `${p.method.toUpperCase()}\n${p.pathname}\n${p.canonicalQuery}\n` +
    `${p.bodySha256Hex}\n${p.actor}`
  );
}

function generateNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function signCanonicalRequest(p: {
  service: ServiceName;
  secret: string;
  timestampMs: number;
  nonce: string;
  method: string;
  url: string;
  bodySha256Hex: string;
  actor: string;
}): Promise<string> {
  const parsed = new URL(p.url);
  const canonical = buildCanonicalRequestString({
    service: p.service,
    timestampMs: p.timestampMs,
    nonce: p.nonce,
    method: p.method,
    pathname: parsed.pathname,
    canonicalQuery: canonicalizeQuery(parsed.search),
    bodySha256Hex: p.bodySha256Hex,
    actor: p.actor,
  });
  return computeHmacHex(canonical, p.secret);
}

/**
 * Build the sig1 request headers for an outbound service call.
 *
 * Returns `X-OpenInspect-Service`, `X-OpenInspect-Service-Signature`, plus
 * `X-OpenInspect-Actor` when an actor is asserted and `x-trace-id` when a
 * trace ID is provided. Callers add their own `Content-Type`/`Accept`
 * headers, and must send exactly the body bytes that were signed.
 */
export async function buildServiceAuthHeaders(p: {
  service: ServiceName;
  secret: string;
  method: string;
  url: string;
  body?: ArrayBuffer | Uint8Array | string;
  actor?: string;
  traceId?: string;
}): Promise<Record<string, string>> {
  const timestampMs = Date.now();
  const nonce = generateNonce();
  const actor = p.actor ?? "";
  const bodySha256Hex = await sha256Hex(p.body ?? "");
  const signature = await signCanonicalRequest({
    service: p.service,
    secret: p.secret,
    timestampMs,
    nonce,
    method: p.method,
    url: p.url,
    bodySha256Hex,
    actor,
  });

  const headers: Record<string, string> = {
    [SERVICE_HEADER]: p.service,
    [SERVICE_SIGNATURE_HEADER]: `${SIG1_PREFIX}.${timestampMs}.${nonce}.${signature}`,
  };
  if (actor) {
    headers[ACTOR_HEADER] = actor;
  }
  if (p.traceId) {
    headers["x-trace-id"] = p.traceId;
  }
  return headers;
}

export type ServiceSignatureHeaderParse =
  | { ok: true; timestampMs: number; nonce: string; signature: string }
  | { ok: false; reason: "format" | "expired" };

/**
 * Parse a sig1 signature header and check everything that does not need the
 * request body: grammar, then timestamp freshness. Verifiers call this before
 * buffering the body so a malformed or stale header never costs a body read —
 * only the HMAC comparison itself needs the body hash.
 */
export function parseServiceSignatureHeader(header: string): ServiceSignatureHeaderParse {
  const parts = header.split(".");
  if (parts.length !== 4 || parts[0] !== SIG1_PREFIX) {
    return { ok: false, reason: "format" };
  }
  const [, timestampPart, nonce, signature] = parts;
  if (!TIMESTAMP_PATTERN.test(timestampPart)) {
    return { ok: false, reason: "format" };
  }
  const timestampMs = Number(timestampPart);
  if (timestampMs <= 0) {
    return { ok: false, reason: "format" };
  }
  if (!NONCE_PATTERN.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "format" };
  }
  if (Math.abs(Date.now() - timestampMs) > TOKEN_VALIDITY_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, timestampMs, nonce, signature };
}

/**
 * Verify a sig1 signature header against the named service's secret and the
 * request it claims to sign. The caller supplies the body hash (the body must
 * be buffered exactly once at the edge) and the actor header value (empty
 * string when absent), both of which are covered by the signature.
 */
export async function verifyServiceSignature(p: {
  signatureHeader: string;
  service: ServiceName;
  secret: string;
  method: string;
  url: string;
  bodySha256Hex: string;
  actor: string;
}): Promise<ServiceSignatureResult> {
  const parsed = parseServiceSignatureHeader(p.signatureHeader);
  if (!parsed.ok) {
    return parsed;
  }
  const expected = await signCanonicalRequest({
    service: p.service,
    secret: p.secret,
    timestampMs: parsed.timestampMs,
    nonce: parsed.nonce,
    method: p.method,
    url: p.url,
    bodySha256Hex: p.bodySha256Hex,
    actor: p.actor,
  });
  if (!timingSafeEqual(parsed.signature, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, timestampMs: parsed.timestampMs, nonce: parsed.nonce };
}

/** A sender's outbound credential: sig1 with the sender's own secret. */
export interface OutboundServiceCredential {
  service: ServiceName;
  secret: string;
}

/** The env surface every sender carries. */
export interface OutboundCredentialEnv {
  SERVICE_AUTH_SECRET?: string;
}

export function resolveOutboundCredential(
  service: ServiceName,
  env: OutboundCredentialEnv
): OutboundServiceCredential {
  if (!env.SERVICE_AUTH_SECRET) {
    throw new Error(`SERVICE_AUTH_SECRET is required for outbound ${service} requests`);
  }
  return { service, secret: env.SERVICE_AUTH_SECRET };
}

/**
 * A non-JSON outbound body: the exact serialized bytes plus the content type
 * describing them (e.g. a buffered multipart form with its boundary). Binary
 * bodies must be serialized BEFORE signing — sig1 hashes the exact bytes sent.
 */
export interface OutboundBinaryBody {
  bytes: Uint8Array;
  contentType: string;
}

/** One outbound control-plane request to authenticate. */
export interface OutboundRequestToSign {
  method: string;
  url: string;
  /** The exact body being sent, when there is one: a JSON string, or pre-serialized bytes with their content type. */
  body?: string | OutboundBinaryBody;
  /** External actor this request acts for (`slack:U…`), asserted under the sig1 signature. */
  actor?: string;
  traceId?: string;
}

/** The BodyInit to send for a request's signed body — exactly what was signed. */
function outboundBodyInit(body: OutboundRequestToSign["body"]): string | Uint8Array | undefined {
  return typeof body === "object" ? body.bytes : body;
}

/**
 * Build the auth headers for an outbound control-plane request from the
 * resolved credential. Signatures bind method, URL, body, and actor, so
 * headers are built per request — never shared across calls — and callers
 * must send exactly the body they signed. A `Content-Type` header is included
 * only when a body is present: `application/json` for string bodies, the
 * body's own content type for binary bodies.
 */
export async function buildOutboundAuthHeaders(
  credential: OutboundServiceCredential,
  request: OutboundRequestToSign
): Promise<Record<string, string>> {
  const contentType: Record<string, string> =
    request.body === undefined
      ? {}
      : {
          "Content-Type":
            typeof request.body === "string" ? "application/json" : request.body.contentType,
        };
  return {
    ...contentType,
    ...(await buildServiceAuthHeaders({
      service: credential.service,
      secret: credential.secret,
      method: request.method,
      url: request.url,
      body: outboundBodyInit(request.body),
      actor: request.actor,
      traceId: request.traceId,
    })),
  };
}

/**
 * Minimal interface for the control-plane service binding. Compatible with
 * Cloudflare Workers' `Fetcher` type without depending on
 * `@cloudflare/workers-types`.
 */
export interface ControlPlaneFetcher {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Options a signed control-plane fetch accepts beyond the request being signed. */
export interface SignedFetchInit {
  /** Non-auth headers (e.g. `Accept`); the auth headers always take precedence. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Sign one outbound control-plane request as `service` and send it through
 * the env's `CONTROL_PLANE` service binding. Signing and sending consume the
 * same method/URL/body values, so the bytes sent are exactly the bytes signed
 * by construction — callers never handle the signed body themselves.
 */
export async function signedControlPlaneFetch(
  service: ServiceName,
  env: OutboundCredentialEnv & { CONTROL_PLANE: ControlPlaneFetcher },
  request: OutboundRequestToSign,
  init?: SignedFetchInit
): Promise<Response> {
  const credential = resolveOutboundCredential(service, env);
  const headers = { ...init?.headers, ...(await buildOutboundAuthHeaders(credential, request)) };
  return env.CONTROL_PLANE.fetch(request.url, {
    method: request.method,
    headers,
    body: outboundBodyInit(request.body),
    signal: init?.signal,
  });
}
