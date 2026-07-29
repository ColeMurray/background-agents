/**
 * Callback authentication for image builds.
 *
 * Every build callback authenticates with the single-use bearer token minted
 * at trigger time; only its HMAC hash is stored on the build row. Providers
 * that build inside a sandbox (Vercel/OpenComputer) additionally bind the
 * token to the row's provider session; Modal's data-plane builder holds the
 * token in the trusted scheduler function and binds no session.
 *
 * Helpers here are log-free and throw ImageBuildCallbackAuthError; callers
 * (the workflow) log and map to the route-facing error taxonomy.
 */

import { computeHmacHex, type RepositoryShaEntry } from "@open-inspect/shared";
import type { ImageBuildStore } from "../db/image-builds";
import type { Env } from "../types";
import type { ImageBuildProvider, MarkImageBuildReadyResult } from "./model";

export const IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const IMAGE_BUILD_CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function generateImageBuildCallbackToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Peppers for callback token hashes, most-preferred first. A single entry
 * since the retired INTERNAL_CALLBACK_SECRET pepper aged out; the
 * list shape stays so a future pepper rotation is a one-line change.
 */
function callbackTokenPeppers(env: Env): string[] {
  return env.IMAGE_CALLBACK_TOKEN_PEPPER ? [env.IMAGE_CALLBACK_TOKEN_PEPPER] : [];
}

async function hashWithPepper(token: string, pepper: string): Promise<string> {
  // The "repo-image-callback:" domain-separation prefix is WIRE/STORAGE-FROZEN:
  // it is baked into every stored callback_token_hash, so changing it would
  // invalidate all in-flight build callbacks. Only surrounding identifiers
  // rename; the literal never does.
  return computeHmacHex(`repo-image-callback:${token}`, pepper);
}

/** Hash a callback token for STORAGE, always under the primary pepper. */
export async function hashImageBuildCallbackToken(token: string, env: Env): Promise<string> {
  const [primary] = callbackTokenPeppers(env);
  if (!primary) {
    throw new Error("IMAGE_CALLBACK_TOKEN_PEPPER is required for image build callback hashing");
  }
  return hashWithPepper(token, primary);
}

/**
 * Extract a well-formed callback bearer token from the request, or null when
 * the Authorization header is absent or not token-shaped.
 */
export function getImageBuildCallbackBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token || !IMAGE_BUILD_CALLBACK_TOKEN_PATTERN.test(token)) return null;
  return token;
}

/**
 * "rejected" is an authentication failure (missing/expired/forged token);
 * "misconfigured" means the deployment cannot authenticate anything (no
 * callback-token pepper bound).
 */
export type ImageBuildCallbackAuthFailure = "rejected" | "misconfigured";

export class ImageBuildCallbackAuthError extends Error {
  constructor(
    readonly failure: ImageBuildCallbackAuthFailure,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ImageBuildCallbackAuthError";
  }
}

/**
 * Bearer-token identity of a build callback. `providerSessionId` is the
 * row's bound provider session for sandbox builds, and null for Modal
 * builds, which never bind one.
 */
export interface ImageBuildCallbackTokenParams {
  buildId: string;
  provider: ImageBuildProvider;
  providerSessionId: string | null;
  now: number;
}

/**
 * Consume the single-use callback token for a build-complete callback.
 * Throws ImageBuildCallbackAuthError when the token is missing, unhashable,
 * or does not consume (expired, already used, wrong build/session).
 */
export async function consumeImageBuildCallbackTokenOrThrow(
  store: Pick<ImageBuildStore, "consumeCallbackToken">,
  env: Env,
  token: string | null | undefined,
  params: ImageBuildCallbackTokenParams
): Promise<void> {
  for (const tokenHash of await hashRequiredCallbackToken(token, env)) {
    const build = await store.consumeCallbackToken({ ...params, tokenHash });
    if (build) return;
  }
  throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
}

/** Verify a provider-session callback token without consuming it. */
export async function verifyImageBuildCallbackTokenOrThrow(
  store: Pick<ImageBuildStore, "verifyCallbackToken">,
  env: Env,
  token: string | null | undefined,
  params: ImageBuildCallbackTokenParams
): Promise<void> {
  for (const tokenHash of await hashRequiredCallbackToken(token, env)) {
    const verified = await store.verifyCallbackToken({ ...params, tokenHash });
    if (verified) return;
  }
  throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
}

/**
 * Token-authenticated failure mark for provider-session builds: the token
 * consume and the failed transition are one conditional UPDATE in the store.
 * Auth failures throw ImageBuildCallbackAuthError; store errors propagate
 * unwrapped for the caller's update-failure handling.
 */
export async function markImageBuildFailedWithCallbackTokenOrThrow(
  store: Pick<ImageBuildStore, "markBuildFailedWithCallbackToken">,
  env: Env,
  token: string | null | undefined,
  failure: ImageBuildCallbackTokenParams & { errorMessage: string }
): Promise<void> {
  for (const tokenHash of await hashRequiredCallbackToken(token, env)) {
    const updated = await store.markBuildFailedWithCallbackToken({
      buildId: failure.buildId,
      provider: failure.provider,
      providerSessionId: failure.providerSessionId,
      tokenHash,
      error: failure.errorMessage,
      now: failure.now,
    });
    if (updated) return;
  }
  throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
}

/**
 * Token-authenticated ready mark for provider-image builds (Modal): the token
 * consume and the ready/superseded transition are ONE conditional UPDATE in
 * the store, so a transient failure can never burn the single-use token while
 * leaving the build stuck 'building' — the provider's retry stays replayable
 * until readiness durably commits. Mirrors the failure-path helper above.
 *
 * Auth is enforced by the caller's prior verify (require) step; a
 * non-committing result here is treated as a pepper miss during rotation and
 * retried against the next candidate hash, falling through to the store's own
 * `not_accepting_completion` when nothing transitions.
 */
export async function markImageBuildReadyWithCallbackTokenOrThrow(
  store: Pick<ImageBuildStore, "tryMarkImageBuildReady">,
  env: Env,
  token: string | null | undefined,
  params: ImageBuildCallbackTokenParams,
  ready: {
    providerImageId: string;
    repositoryShas: RepositoryShaEntry[];
    runtimeVersion: string;
    buildDurationMs: number;
  }
): Promise<MarkImageBuildReadyResult> {
  let result: MarkImageBuildReadyResult = { type: "not_accepting_completion" };
  for (const tokenHash of await hashRequiredCallbackToken(token, env)) {
    result = await store.tryMarkImageBuildReady(
      params.buildId,
      params.provider,
      ready.providerImageId,
      ready.repositoryShas,
      ready.runtimeVersion,
      ready.buildDurationMs,
      { tokenHash, providerSessionId: params.providerSessionId, now: params.now }
    );
    if (result.type !== "not_accepting_completion") return result;
  }
  return result;
}

/**
 * Token check for late-artifact recording: the build row has already left
 * 'building' (that is the point of the late path), so only the token's hash
 * binding and expiry gate — never the row's status.
 */
export async function verifyImageBuildArtifactCallbackTokenOrThrow(
  store: Pick<ImageBuildStore, "verifyCallbackTokenForArtifactRecording">,
  env: Env,
  token: string | null | undefined,
  params: { buildId: string; provider: ImageBuildProvider; now: number }
): Promise<void> {
  for (const tokenHash of await hashRequiredCallbackToken(token, env)) {
    const verified = await store.verifyCallbackTokenForArtifactRecording({ ...params, tokenHash });
    if (verified) return;
  }
  throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
}

/**
 * The stored-hash candidates a presented token may match, primary pepper
 * first. More than one entry only during the pepper-migration window; misses
 * against the store are harmless (conditional writes keyed on hash equality).
 */
async function hashRequiredCallbackToken(
  token: string | null | undefined,
  env: Env
): Promise<string[]> {
  if (!token) {
    throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
  }
  const peppers = callbackTokenPeppers(env);
  if (peppers.length === 0) {
    throw new ImageBuildCallbackAuthError(
      "misconfigured",
      "Internal authentication not configured"
    );
  }
  return Promise.all(peppers.map((pepper) => hashWithPepper(token, pepper)));
}
