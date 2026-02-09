/**
 * Token encryption using AES-256-GCM.
 *
 * Ported from WebCrypto API to Node.js crypto module.
 *
 * Key management:
 * - TOKEN_ENCRYPTION_KEY stored as environment variable
 * - Generate with: openssl rand -base64 32
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Import the encryption key from base64-encoded secret.
 */
function getEncryptionKeyBuffer(keyBase64: string): Buffer {
  return Buffer.from(keyBase64, "base64");
}

/**
 * Encrypt a token using AES-256-GCM.
 *
 * @param token - Plain text token to encrypt
 * @param encryptionKey - Base64-encoded encryption key
 * @returns Base64-encoded IV + ciphertext + authTag
 */
export async function encryptToken(token: string, encryptionKey: string): Promise<string> {
  const key = getEncryptionKeyBuffer(encryptionKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine IV + ciphertext + authTag
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString("base64");
}

/**
 * Decrypt a token using AES-256-GCM.
 *
 * @param encrypted - Base64-encoded IV + ciphertext + authTag
 * @param encryptionKey - Base64-encoded encryption key
 * @returns Decrypted plain text token
 */
export async function decryptToken(encrypted: string, encryptionKey: string): Promise<string> {
  const key = getEncryptionKeyBuffer(encryptionKey);
  const combined = Buffer.from(encrypted, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Generate a random encryption key (for testing/setup).
 *
 * @returns Base64-encoded 256-bit key
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

/**
 * Generate a random token/ID.
 *
 * @param length - Length in bytes (default 16)
 * @returns Hex-encoded random string
 */
export function generateId(length: number = 16): string {
  return crypto.randomBytes(length).toString("hex");
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
  const hash = crypto.createHash("sha256");
  hash.update(token);
  return hash.digest("hex");
}
