import runtimeManifest from "../../../sandbox-runtime/src/sandbox_runtime/runtime_manifest.json";

const parsedGeneration = /^v(\d+)/.exec(runtimeManifest.runtimeVersion)?.[1];
if (Number(parsedGeneration) !== runtimeManifest.generation) {
  throw new Error("Sandbox runtime manifest version and generation disagree");
}

export const SANDBOX_RUNTIME_VERSION = runtimeManifest.runtimeVersion;
export const SANDBOX_RUNTIME_GENERATION = runtimeManifest.generation;
export const MIN_COMPATIBLE_RUNTIME_GENERATION = runtimeManifest.minimumCompatibleGeneration;
export const MIN_REBUILD_RUNTIME_GENERATION = runtimeManifest.minimumRebuildGeneration;
export const SANDBOX_CONTROL_PROTOCOL_V2_MINIMUM_RUNTIME_GENERATION =
  runtimeManifest.sandboxControlProtocolV2MinimumGeneration;

export function resolveSandboxControlProtocolVersion(value: string | undefined): 2 | undefined {
  if (value?.trim().toLowerCase() !== "true") return undefined;
  if (
    MIN_COMPATIBLE_RUNTIME_GENERATION < SANDBOX_CONTROL_PROTOCOL_V2_MINIMUM_RUNTIME_GENERATION ||
    MIN_REBUILD_RUNTIME_GENERATION < SANDBOX_CONTROL_PROTOCOL_V2_MINIMUM_RUNTIME_GENERATION
  ) {
    throw new Error(
      "Early sandbox control channel requires snapshot and image compatibility floors at the v2 runtime generation"
    );
  }
  return 2;
}
