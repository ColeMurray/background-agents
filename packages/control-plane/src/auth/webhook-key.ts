/**
 * Webhook API key generation, hashing, and verification.
 *
 * Keys are 32 bytes of crypto.getRandomValues data, base64url-encoded.
 * Hashed with SHA-256 (brute-force resistance unnecessary for high-entropy random keys).
 */

import { timingSafeEqual } from "@open-inspect/shared";

export function generateWebhookApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function hashApiKey(key: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyWebhookApiKey(key: string, hash: string): Promise<boolean> {
  const computed = await hashApiKey(key);
  return timingSafeEqual(computed, hash);
}

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
