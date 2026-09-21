import runtimeManifest from "../../../sandbox-runtime/src/sandbox_runtime/runtime_manifest.json";

const parsedGeneration = /^v(\d+)/.exec(runtimeManifest.runtimeVersion)?.[1];
if (Number(parsedGeneration) !== runtimeManifest.generation) {
  throw new Error("Sandbox runtime manifest version and generation disagree");
}

/**
 * The manifest carries four independent floors. They are one character apart in
 * a small JSON file and do very different things, so raising the wrong one is
 * an easy and expensive mistake:
 *
 * - `minimumCompatibleGeneration` retires **snapshots and images**. Raising it
 *   discards the stored filesystem of every session still on an older runtime;
 *   on a provider without persistent resume the snapshot is the only
 *   continuity path, so those sessions resume from a clean checkout with no
 *   conversation history. Bump only for a breaking runtime change.
 * - `minimumPreservationGeneration` gates the **confirmed-shutdown protocol**,
 *   and is additionally AND-ed into prebuilt-image selection (see
 *   `evaluateImageBuildForSpawn`), so raising it also invalidates every cached
 *   image below it until a compliant one is built. Raise it together with an
 *   image rebuild, or every spawn misses to the base image until one is ready.
 * - `minimumRebuildGeneration` only triggers rebuilds. It never invalidates a
 *   live session, and is the right field for a routine runtime advance.
 * - `harnessMinimumGeneration` raises the image floor for one harness.
 *
 * A generation cannot promise a protocol that the runtime it names does not
 * implement, so the preservation floor may never exceed the current
 * generation; that combination would mark every sandbox we can build as
 * protocol-incapable.
 */
if (runtimeManifest.minimumPreservationGeneration > runtimeManifest.generation) {
  throw new Error(
    "Sandbox runtime manifest preservation floor exceeds the current runtime generation"
  );
}

export const SANDBOX_RUNTIME_VERSION = runtimeManifest.runtimeVersion;
export const SANDBOX_RUNTIME_GENERATION = runtimeManifest.generation;
export const MIN_COMPATIBLE_RUNTIME_GENERATION = runtimeManifest.minimumCompatibleGeneration;
export const MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION =
  runtimeManifest.minimumPreservationGeneration;
export const MIN_REBUILD_RUNTIME_GENERATION = runtimeManifest.minimumRebuildGeneration;
/** Per-harness image floors; see minCompatibleRuntimeVersionFor in image-builds/model.ts. */
export const HARNESS_MIN_RUNTIME_GENERATION: Readonly<Partial<Record<string, number>>> =
  runtimeManifest.harnessMinimumGeneration;
