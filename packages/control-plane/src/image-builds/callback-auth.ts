/**
 * Callback authentication for image builds.
 *
 * Every build callback authenticates with the single-use bearer token minted
 * at trigger time; only its HMAC hash is stored on the build row. The store
 * additionally binds every token to the exact provider session.
 *
 * Helpers here are log-free and throw ImageBuildCallbackAuthError; callers
 * (the workflow) log and map to the route-facing error taxonomy.
 */

import { computeHmacHex } from "@open-inspect/shared/auth";
import type { Env } from "../types";

export const IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const IMAGE_BUILD_CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function generateImageBuildCallbackToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  if (!env.IMAGE_CALLBACK_TOKEN_PEPPER) {
    throw new Error("IMAGE_CALLBACK_TOKEN_PEPPER is required for image build callback hashing");
  }
  return hashWithPepper(token, env.IMAGE_CALLBACK_TOKEN_PEPPER);
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
