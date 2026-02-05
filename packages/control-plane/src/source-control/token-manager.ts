/**
 * Token manager implementation for source control providers.
 *
 * Wraps encryption/decryption operations for OAuth and API tokens.
 */

import { decryptToken, encryptToken } from "../auth/crypto";
import type { SourceControlTokenManager } from "./types";

/**
 * Default token manager implementation using AES-256-GCM.
 *
 * Wraps the existing crypto functions from auth/crypto.ts.
 */
export class DefaultTokenManager implements SourceControlTokenManager {
  constructor(private readonly encryptionKey: string) {}

  async decrypt(encryptedToken: string): Promise<string> {
    return decryptToken(encryptedToken, this.encryptionKey);
  }

  async encrypt(plainToken: string): Promise<string> {
    return encryptToken(plainToken, this.encryptionKey);
  }
}

/**
 * Create a token manager instance.
 *
 * @param encryptionKey - Base64-encoded encryption key
 * @returns Token manager instance
 */
export function createTokenManager(encryptionKey: string): SourceControlTokenManager {
  return new DefaultTokenManager(encryptionKey);
}
