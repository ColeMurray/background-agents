/**
 * Sandbox module exports.
 *
 * Provides a unified interface for sandbox backends (Modal, Cloudflare).
 * The backend is selected via the SANDBOX_BACKEND environment variable.
 */

import type { Env } from "../types";
import type { SandboxManager, SandboxBackend } from "./types";
import { createModalSandboxManager } from "./modal";
import { createCloudflareSandboxManager } from "./cloudflare";

// Re-export types
export type {
  SandboxManager,
  SandboxBackend,
  StartSandboxConfig,
  StartSandboxResult,
  CreateSnapshotConfig,
  CreateSnapshotResult,
  RestoreSnapshotConfig,
} from "./types";

// Re-export implementations for direct use if needed
export { ModalSandboxManager, createModalSandboxManager } from "./modal";
export { CloudflareSandboxManager, createCloudflareSandboxManager } from "./cloudflare";

// Legacy exports for backward compatibility
export {
  ModalClient,
  createModalClient,
  type CreateSandboxRequest,
  type CreateSandboxResponse,
  type WarmSandboxRequest,
  type WarmSandboxResponse,
  type SnapshotInfo,
} from "./client";

/**
 * Create a sandbox manager based on the configured backend.
 *
 * The backend is selected via the SANDBOX_BACKEND environment variable:
 * - "modal" (default): Use Modal's container platform
 * - "cloudflare": Use Cloudflare's container platform
 *
 * @param env - Environment bindings
 * @returns A SandboxManager implementation for the configured backend
 * @throws Error if the backend is not configured correctly
 */
export function createSandboxManager(env: Env): SandboxManager {
  const backend = (env.SANDBOX_BACKEND || "modal") as SandboxBackend;

  switch (backend) {
    case "cloudflare":
      console.log("[sandbox] Using Cloudflare sandbox backend");
      return createCloudflareSandboxManager(env);

    case "modal":
    default:
      console.log("[sandbox] Using Modal sandbox backend");
      return createModalSandboxManager(env);
  }
}

/**
 * Get the configured sandbox backend type.
 */
export function getSandboxBackend(env: Env): SandboxBackend {
  return (env.SANDBOX_BACKEND || "modal") as SandboxBackend;
}
