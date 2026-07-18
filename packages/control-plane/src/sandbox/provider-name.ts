/**
 * Sandbox backend selection utilities.
 */

export type SandboxBackendName = "modal" | "daytona" | "vercel" | "opencomputer" | "e2b";

/**
 * Resolve the configured sandbox backend.
 *
 * Defaults to Modal to preserve existing deployments.
 */
export function resolveSandboxBackendName(value: string | undefined): SandboxBackendName {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "modal") {
    return "modal";
  }

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

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
}

export function isModalSandboxBackend(value: string | undefined): boolean {
  return resolveSandboxBackendName(value) === "modal";
}
