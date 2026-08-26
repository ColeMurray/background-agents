/**
 * Eager environment validation shared by worker routes and the session graph.
 *
 * Misconfigured deployments fail loudly at the first touch instead of running
 * degraded (the #1602 posture). Secrets-at-rest encryption in particular must
 * never silently fall back to plaintext: Terraform requires the key, so its
 * absence always means a broken deployment.
 */

import type { Env } from "./types";

export function requireRepoSecretsEncryptionKey(env: Env): string {
  const key = env.REPO_SECRETS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "REPO_SECRETS_ENCRYPTION_KEY is not configured; refusing to operate on secrets without encryption at rest"
    );
  }
  return key;
}
