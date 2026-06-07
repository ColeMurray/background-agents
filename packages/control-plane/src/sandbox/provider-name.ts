/**
 * Sandbox backend selection utilities.
 */

export type SandboxBackendName = "islo" | "modal" | "daytona";

/**
 * Resolve the configured sandbox backend.
 *
 * Defaults to Islo for new deployments.
 */
export function resolveSandboxBackendName(value: string | undefined): SandboxBackendName {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "islo") {
    return "islo";
  }

  if (normalized === "modal") {
    return "modal";
  }

  if (normalized === "daytona") {
    return "daytona";
  }

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
}

export function isModalSandboxBackend(value: string | undefined): boolean {
  return resolveSandboxBackendName(value) === "modal";
}
