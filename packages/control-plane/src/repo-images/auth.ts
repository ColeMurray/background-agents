import { computeHmacHex } from "@open-inspect/shared";
import type { Env } from "../types";

export const REPO_IMAGE_CALLBACK_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const REPO_IMAGE_CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function generateRepoImageCallbackToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashRepoImageCallbackToken(token: string, env: Env): Promise<string> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    throw new Error("INTERNAL_CALLBACK_SECRET is required for repo image callback hashing");
  }
  return computeHmacHex(`repo-image-callback:${token}`, env.INTERNAL_CALLBACK_SECRET);
}
