/**
 * Eager environment validation shared by worker routes and the session graph.
 *
 * Misconfigured deployments fail loudly at the first touch instead of running
 * degraded (the #1602 posture). Secrets-at-rest encryption in particular must
 * never silently fall back to plaintext: Terraform requires the keys, so their
 * absence always means a broken deployment.
 */

import type { EnvConfig } from "./types";

/** Strict base64 — rejects whitespace and stray characters `atob` may accept. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const AES_256_KEY_BYTES = 32;
const KEY_GENERATION_HINT = "generate with: openssl rand -base64 32";

/**
 * Validates the full key contract, not just presence: `encryptToken` imports
 * the base64-decoded bytes as raw AES material, so a malformed key would
 * otherwise survive graph construction and throw at the first secret write —
 * mid-spawn — while a short key would silently downgrade to AES-128/192.
 */
function requireEncryptionKey(key: string | undefined, name: string, protects: string): string {
  if (!key) {
    throw new Error(
      `${name} is not configured; refusing to operate on ${protects} without encryption at rest`
    );
  }
  let decodedBytes: number | null = null;
  if (BASE64_PATTERN.test(key)) {
    try {
      decodedBytes = atob(key).length;
    } catch {
      decodedBytes = null;
    }
  }
  if (decodedBytes === null) {
    throw new Error(`${name} is not valid base64 (${KEY_GENERATION_HINT})`);
  }
  if (decodedBytes !== AES_256_KEY_BYTES) {
    throw new Error(
      `${name} must decode to ${AES_256_KEY_BYTES} bytes for AES-256, got ${decodedBytes} (${KEY_GENERATION_HINT})`
    );
  }
  return key;
}

export function requireRepoSecretsEncryptionKey(
  env: Pick<EnvConfig, "REPO_SECRETS_ENCRYPTION_KEY">
): string {
  return requireEncryptionKey(
    env.REPO_SECRETS_ENCRYPTION_KEY,
    "REPO_SECRETS_ENCRYPTION_KEY",
    "secrets"
  );
}

export function requireTokenEncryptionKey(env: Pick<EnvConfig, "TOKEN_ENCRYPTION_KEY">): string {
  return requireEncryptionKey(env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY", "OAuth tokens");
}
