/**
 * Sandbox access helpers: credential verification, credential decryption, and
 * the provider dashboard link.
 *
 * These read only platform scalars (the stored row, the encryption key, the
 * configured backend), never Durable Object state, so they are unit-testable
 * without a Workers runtime.
 */

import { timingSafeEqual } from "@open-inspect/shared/auth";
import { decryptToken, hashToken } from "../auth/crypto";
import { buildModalSandboxDashboardUrl } from "../sandbox/client";
import { resolveSandboxBackendName } from "../sandbox/provider-name";
import type { Logger } from "../logger";
import type { SandboxRow } from "./types";

/**
 * Verify a provided sandbox token against stored credentials.
 *
 * Preferred path uses auth_token_hash. Plaintext auth_token is only used
 * as a compatibility fallback for older rows.
 */
export async function isValidSandboxToken(
  token: string | null,
  sandbox: SandboxRow | null
): Promise<boolean> {
  if (!token || !sandbox) {
    return false;
  }

  if (sandbox.auth_token_hash) {
    const tokenHash = await hashToken(token);
    return timingSafeEqual(tokenHash, sandbox.auth_token_hash);
  }

  if (sandbox.auth_token) {
    return timingSafeEqual(token, sandbox.auth_token);
  }

  return false;
}

/**
 * Decrypt a stored sandbox access credential (code-server password, VNC
 * password, ttyd token).
 *
 * A deployment without an encryption key stores these in the clear, so the
 * value passes through untouched. A value that fails to decrypt resolves to
 * null rather than throwing: the caller omits that one access channel instead
 * of failing the whole access response.
 */
export async function decryptStoredAccessValue(
  value: string | null,
  encryptionKey: string | undefined,
  log: Pick<Logger, "warn">
): Promise<string | null> {
  if (!value) return null;
  if (!encryptionKey) return value;
  try {
    return await decryptToken(value, encryptionKey);
  } catch (error) {
    log.warn("Failed to decrypt stored sandbox access value", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The configured sandbox backend plus the Modal coordinates its dashboard link needs. */
export interface SandboxDashboardSettings {
  sandboxProvider: string | undefined;
  modalWorkspace: string | undefined;
  modalEnvironment: string | undefined;
}

/**
 * The provider dashboard link for a sandbox, or null when the deployment runs a
 * backend with no such link (only Modal has one).
 */
export function resolveSandboxDashboardUrl(
  settings: SandboxDashboardSettings,
  providerObjectId: string | null | undefined
): string | null {
  if (resolveSandboxBackendName(settings.sandboxProvider) !== "modal") return null;
  return buildModalSandboxDashboardUrl({
    workspace: settings.modalWorkspace,
    modalEnvironment: settings.modalEnvironment,
    providerObjectId,
  });
}
