/**
 * Token encryption using AES-256-GCM.
 *
 * GitHub OAuth tokens are encrypted at rest using the Web Crypto API
 * available in Cloudflare Workers.
 *
 * Key management:
 * - TOKEN_ENCRYPTION_KEY stored as Cloudflare Worker secret
 * - Generate with: openssl rand -base64 32
 * - Set via Terraform (see terraform.tfvars)
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for GCM

/**
 * Import the encryption key from base64-encoded secret.
 */
async function getEncryptionKey(keyBase64: string): Promise<CryptoKey> {
  const keyData = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey("raw", keyData, { name: ALGORITHM, length: KEY_LENGTH }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a token using AES-256-GCM.
 *
 * @param token - Plain text token to encrypt
 * @param encryptionKey - Base64-encoded encryption key
 * @returns Base64-encoded IV + ciphertext
 */
export async function encryptToken(token: string, encryptionKey: string): Promise<string> {
  const key = await getEncryptionKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(token);

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a token using AES-256-GCM.
 *
 * @param encrypted - Base64-encoded IV + ciphertext
 * @param encryptionKey - Base64-encoded encryption key
 * @returns Decrypted plain text token
 */
export async function decryptToken(encrypted: string, encryptionKey: string): Promise<string> {
  const key = await getEncryptionKey(encryptionKey);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);

  return new TextDecoder().decode(decrypted);
}

/**
 * Generate a random encryption key (for testing/setup).
 *
 * @returns Base64-encoded 256-bit key
 */
export function generateEncryptionKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...key));
}

/**
 * Generate a random token/ID.
 *
 * @param length - Length in bytes (default 32)
 * @returns Hex-encoded random string
 */
export function generateId(length: number = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a token using SHA-256.
 *
 * Used for storing WebSocket auth tokens securely - we store the hash
 * and compare against incoming tokens.
 *
 * @param token - Plain text token to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare two strings in timing-safe style.
 *
 * This avoids early-return comparisons that may leak partial match info.
 * For token verification we compare fixed-length SHA-256 hex strings.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);

  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i++) {
    const aByte = aBytes[i] ?? 0;
    const bByte = bBytes[i] ?? 0;
    diff |= aByte ^ bByte;
  }

  return diff === 0;
}
