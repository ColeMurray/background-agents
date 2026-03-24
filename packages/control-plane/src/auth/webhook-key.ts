/**
 * Webhook API key generation, hashing, and verification.
 *
 * Keys are 32 bytes of crypto.getRandomValues data, base64url-encoded.
 * Hashed with SHA-256 (brute-force resistance unnecessary for high-entropy random keys).
 */

import { timingSafeEqual } from "@open-inspect/shared";
import { encryptToken, decryptToken } from "./crypto";

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

/** Encrypt a Sentry client secret for storage (AES-256-GCM). */
export async function encryptSentrySecret(secret: string, encryptionKey: string): Promise<string> {
  return encryptToken(secret, encryptionKey);
}

/** Decrypt a stored Sentry client secret. */
export async function decryptSentrySecret(
  encrypted: string,
  encryptionKey: string
): Promise<string> {
  return decryptToken(encrypted, encryptionKey);
}

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
