/**
 * Sandbox backend selection utilities.
 */

import {
  isSandboxProviderName,
  type SandboxProviderName,
} from "@open-inspect/shared/types/integrations";

export type SandboxBackendName = SandboxProviderName;

export const DEFAULT_SANDBOX_BACKEND_NAME: SandboxBackendName = "modal";

/**
 * Resolve the configured sandbox backend.
 *
 * Defaults to DEFAULT_SANDBOX_BACKEND_NAME to preserve existing deployments.
 */
export function resolveSandboxBackendName(value: string | undefined): SandboxBackendName {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return DEFAULT_SANDBOX_BACKEND_NAME;
  if (isSandboxProviderName(normalized)) return normalized;

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
}
