/**
 * Sandbox backend selection utilities.
 */

import {
  isSandboxProviderName,
  type SandboxProviderName,
} from "@open-inspect/shared/types/integrations";

export type SandboxBackendName = SandboxProviderName;

/**
 * Resolve the configured sandbox backend.
 *
 * Defaults to Modal to preserve existing deployments.
 */
export function resolveSandboxBackendName(value: string | undefined): SandboxBackendName {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return "modal";
  if (isSandboxProviderName(normalized)) return normalized;

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
}
