/**
 * Sandbox backend selection utilities.
 */

export type SandboxBackendName =
  | "modal"
  | "daytona"
  | "vercel"
  | "opencomputer"
  | "e2b"
  | "sandbox0";

export const DEFAULT_SANDBOX_BACKEND_NAME: SandboxBackendName = "modal";

/**
 * Resolve the configured sandbox backend.
 *
 * Defaults to DEFAULT_SANDBOX_BACKEND_NAME to preserve existing deployments.
 */
export function resolveSandboxBackendName(value: string | undefined): SandboxBackendName {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return DEFAULT_SANDBOX_BACKEND_NAME;
  }

  if (normalized === "modal") return "modal";

  if (normalized === "daytona") {
    return "daytona";
  }

  if (normalized === "vercel") {
    return "vercel";
  }

  if (normalized === "opencomputer") {
    return "opencomputer";
  }

  if (normalized === "e2b") {
    return "e2b";
  }
  if (normalized === "sandbox0") return "sandbox0";

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
}
