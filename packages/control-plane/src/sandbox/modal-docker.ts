import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { EnvConfig } from "../types";
import { resolveSandboxBackendName } from "./provider-name";

/**
 * Modal-local policy for Docker-enabled sandboxes.
 *
 * A session whose frozen sandbox settings carry `dockerEnabled: true` launches
 * on Modal's Docker-capable VM runtime instead of the default gVisor sandbox.
 * Everything Docker-specific in the control plane hangs off this one boolean:
 * admission (provider + operator gate), the resources frozen alongside it, and
 * the artifact variant that keeps Docker and default prepared images and
 * snapshots from crossing over.
 */

/** Resources frozen for a Docker session when its settings leave them unset. */
export const DOCKER_SANDBOX_DEFAULT_CPU_CORES = 2;
export const DOCKER_SANDBOX_DEFAULT_MEMORY_MIB = 4096;

/**
 * Compatibility discriminator recorded on prepared images and session
 * snapshots. Artifacts of one variant are never selected for the other.
 */
export const SANDBOX_ARTIFACT_VARIANTS = ["default", "modal-docker-v1"] as const;
export type SandboxArtifactVariant = (typeof SANDBOX_ARTIFACT_VARIANTS)[number];

export function isSandboxArtifactVariant(value: unknown): value is SandboxArtifactVariant {
  return (SANDBOX_ARTIFACT_VARIANTS as readonly unknown[]).includes(value);
}

/** Whether frozen settings select the Docker-capable launch. Missing means the default. */
export function isDockerSandbox(
  settings: Pick<SandboxSettings, "dockerEnabled"> | undefined
): boolean {
  return settings?.dockerEnabled === true;
}

export function sandboxArtifactVariantFor(
  settings: Pick<SandboxSettings, "dockerEnabled"> | undefined
): SandboxArtifactVariant {
  return isDockerSandbox(settings) ? "modal-docker-v1" : "default";
}

export type DockerSandboxAdmissionClosedReason = "docker_not_allowed" | "docker_not_available";

export type DockerSandboxAdmission =
  | { admitted: true }
  | { admitted: false; reason: DockerSandboxAdmissionClosedReason; message: string };

/**
 * Whether this deployment admits a new Docker session, child, or build right
 * now. Admission is separate from provisioning: closing it never affects
 * sessions that were already admitted, which keep restoring and cleaning up.
 */
export function resolveDockerSandboxAdmission(
  env: Pick<EnvConfig, "SANDBOX_PROVIDER" | "ENABLE_MODAL_VM_SANDBOXES">
): DockerSandboxAdmission {
  if (resolveSandboxBackendName(env.SANDBOX_PROVIDER) !== "modal") {
    return {
      admitted: false,
      reason: "docker_not_allowed",
      message: "Docker sessions require the Modal sandbox provider",
    };
  }
  const flag = env.ENABLE_MODAL_VM_SANDBOXES?.trim().toLowerCase();
  if (flag !== "true" && flag !== "1") {
    return {
      admitted: false,
      reason: "docker_not_available",
      message: "Docker sessions are not enabled on this deployment",
    };
  }
  return { admitted: true };
}

export class DockerSandboxAdmissionError extends Error {
  constructor(
    readonly reason: DockerSandboxAdmissionClosedReason,
    message: string
  ) {
    super(message);
    this.name = "DockerSandboxAdmissionError";
  }
}

/** Throw when a Docker launch is requested and admission is closed. */
export function assertDockerSandboxAdmitted(
  env: Pick<EnvConfig, "SANDBOX_PROVIDER" | "ENABLE_MODAL_VM_SANDBOXES">,
  settings: Pick<SandboxSettings, "dockerEnabled"> | undefined
): void {
  if (!isDockerSandbox(settings)) return;
  const admission = resolveDockerSandboxAdmission(env);
  if (!admission.admitted) {
    throw new DockerSandboxAdmissionError(admission.reason, admission.message);
  }
}

/**
 * Refuse to store `dockerEnabled: true` while Docker sessions are not admitted.
 * A stored default would otherwise make every session in that scope fail
 * admission, not just the ones that wanted Docker.
 */
export function assertDockerSettingsWriteAdmitted(
  env: Pick<EnvConfig, "SANDBOX_PROVIDER" | "ENABLE_MODAL_VM_SANDBOXES">,
  settings: unknown
): void {
  if (!settings || typeof settings !== "object") return;
  const record = settings as { defaults?: unknown; dockerEnabled?: unknown };
  const layer = record.defaults && typeof record.defaults === "object" ? record.defaults : record;
  assertDockerSandboxAdmitted(env, layer as Pick<SandboxSettings, "dockerEnabled">);
}

/**
 * Resolve the effective Docker choice once and freeze it into the settings a
 * session is created with.
 *
 * The default stays represented as absence, so a standard session's persisted
 * settings keep their existing shape. A Docker session records `dockerEnabled:
 * true` together with the CPU and memory it launches with, because Modal sizes
 * VM memory at create time and children must inherit the same contract.
 */
export function freezeDockerSandboxSettings(
  settings: SandboxSettings,
  override?: boolean
): SandboxSettings {
  const dockerEnabled = override ?? settings.dockerEnabled ?? false;
  if (!dockerEnabled) {
    const { dockerEnabled: _omitted, ...standard } = settings;
    return standard;
  }
  return {
    ...settings,
    dockerEnabled: true,
    cpuCores: settings.cpuCores ?? DOCKER_SANDBOX_DEFAULT_CPU_CORES,
    memoryMib: settings.memoryMib ?? DOCKER_SANDBOX_DEFAULT_MEMORY_MIB,
  };
}
