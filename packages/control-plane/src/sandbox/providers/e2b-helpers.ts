/**
 * Helpers for the E2B REST-based sandbox provider.
 *
 * The per-session env map itself is assembled by the canonical
 * buildSandboxEnvVars in ../sandbox-env, shared with the other REST-style
 * providers.
 */

import { computeHmacHex } from "@open-inspect/shared";

/**
 * Derive the code-server password for a sandbox (ported from auth.py
 * derive_code_server_password). Must match what code-server inside the
 * sandbox checks — change here and in the runtime in lockstep.
 */
export async function deriveCodeServerPassword(sandboxId: string, secret: string): Promise<string> {
  const digest = await computeHmacHex(`code-server:${sandboxId}`, secret);
  return digest.slice(0, 32);
}
