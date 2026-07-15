/**
 * Callback authentication for image builds.
 *
 * Two modes, decided per provider (provider-policy.ts):
 * - provider_image (Modal): the data-plane builder calls back with the
 *   deployment-wide internal HMAC token.
 * - provider_session (Vercel/OpenComputer): the build sandbox calls back with
 *   a single-use bearer token minted at trigger time; only its HMAC hash is
 *   stored, bound to the build row and its provider session.
 *
 * Helpers here are log-free and throw ImageBuildCallbackAuthError; callers
 * (the workflow) log and map to the route-facing error taxonomy.
 */

import { computeHmacHex } from "@open-inspect/shared";
import { verifyInternalToken } from "../auth/internal";
import type { ImageBuildStore } from "../db/image-builds";
import type { Env } from "../types";
import type { ImageBuildProvider } from "./model";

export const IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const IMAGE_BUILD_CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function generateImageBuildCallbackToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashImageBuildCallbackToken(token: string, env: Env): Promise<string> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    throw new Error("INTERNAL_CALLBACK_SECRET is required for image build callback hashing");
  }
  // The "repo-image-callback:" domain-separation prefix is WIRE/STORAGE-FROZEN:
  // it is baked into every stored callback_token_hash, so changing it would
  // invalidate all in-flight build callbacks. Only surrounding identifiers
  // rename; the literal never does.
  return computeHmacHex(`repo-image-callback:${token}`, env.INTERNAL_CALLBACK_SECRET);
}

/**
 * Extract a well-formed callback bearer token from the request, or null when
 * the Authorization header is absent or not token-shaped (internal-HMAC
 * callbacks also arrive as Bearer values and must not be consumed here).
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
 * "misconfigured" means the deployment cannot authenticate anything
 * (INTERNAL_CALLBACK_SECRET absent).
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

/** Bearer-token identity of a provider-session callback. */
export interface ImageBuildCallbackTokenParams {
  buildId: string;
  provider: ImageBuildProvider;
  providerSessionId: string;
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
  const tokenHash = await hashRequiredCallbackToken(token, env);
  const build = await store.consumeCallbackToken({ ...params, tokenHash });
  if (!build) {
    throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
  }
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
  const tokenHash = await hashRequiredCallbackToken(token, env);
  const updated = await store.markBuildFailedWithCallbackToken({
    buildId: failure.buildId,
    provider: failure.provider,
    providerSessionId: failure.providerSessionId,
    tokenHash,
    error: failure.errorMessage,
    now: failure.now,
  });
  if (!updated) {
    throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
  }
}

/** Internal-HMAC auth for provider_image callbacks (and late-artifact recording). */
export async function requireInternalImageBuildCallbackAuth(
  env: Env,
  authorizationHeader: string | null | undefined
): Promise<void> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    throw new ImageBuildCallbackAuthError(
      "misconfigured",
      "Internal authentication not configured"
    );
  }

  const authorized = await verifyInternalToken(
    authorizationHeader ?? null,
    env.INTERNAL_CALLBACK_SECRET
  );
  if (!authorized) {
    throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
  }
}

async function hashRequiredCallbackToken(
  token: string | null | undefined,
  env: Env
): Promise<string> {
  if (!token) {
    throw new ImageBuildCallbackAuthError("rejected", "Unauthorized");
  }
  try {
    return await hashImageBuildCallbackToken(token, env);
  } catch (e) {
    throw new ImageBuildCallbackAuthError(
      "misconfigured",
      "Internal authentication not configured",
      e
    );
  }
}
