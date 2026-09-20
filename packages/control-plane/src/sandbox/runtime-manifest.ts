import runtimeManifest from "../../../sandbox-runtime/src/sandbox_runtime/runtime_manifest.json";

const parsedGeneration = /^v(\d+)/.exec(runtimeManifest.runtimeVersion)?.[1];
if (Number(parsedGeneration) !== runtimeManifest.generation) {
  throw new Error("Sandbox runtime manifest version and generation disagree");
}

export const SANDBOX_RUNTIME_VERSION = runtimeManifest.runtimeVersion;
export const SANDBOX_RUNTIME_GENERATION = runtimeManifest.generation;
export const MIN_COMPATIBLE_RUNTIME_GENERATION = runtimeManifest.minimumCompatibleGeneration;
export const MIN_PRESERVATION_RUNTIME_GENERATION = runtimeManifest.minimumPreservationGeneration;
export const MIN_REBUILD_RUNTIME_GENERATION = runtimeManifest.minimumRebuildGeneration;
export const EXECUTION_PROFILE_MIN_RUNTIME_GENERATION =
  runtimeManifest.executionProfileMinimumGeneration;
export function minimumRebuildGenerationForProfile(profile: "default" | "docker-v1"): number {
  return Math.max(
    MIN_REBUILD_RUNTIME_GENERATION,
    profile === "default" ? 0 : EXECUTION_PROFILE_MIN_RUNTIME_GENERATION[profile]
  );
}
/** Per-harness image floors; see minCompatibleRuntimeVersionFor in image-builds/model.ts. */
export const HARNESS_MIN_RUNTIME_GENERATION: Readonly<Partial<Record<string, number>>> =
  runtimeManifest.harnessMinimumGeneration;
