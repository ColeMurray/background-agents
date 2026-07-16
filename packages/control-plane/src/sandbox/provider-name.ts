/**
 * Sandbox backend selection utilities.
 */

export type SandboxBackendName = "modal" | "daytona" | "vercel" | "opencomputer" | "islo";

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

  if (normalized === "islo") {
    return "islo";
  }

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
}

export function isModalSandboxBackend(value: string | undefined): boolean {
  return resolveSandboxBackendName(value) === "modal";
}

export function supportsRepoImageBackend(value: string | undefined): boolean {
  const backend = resolveSandboxBackendName(value);
  return backend === "modal" || backend === "vercel" || backend === "opencomputer";
}
