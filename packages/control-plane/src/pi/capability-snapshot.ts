import {
  createPiFeatureCapabilitySnapshot,
  piFeatureCapabilitySnapshotSchema,
  type PiFeatureCapabilityInput,
  type PiFeatureCapabilitySnapshot,
} from "@open-inspect/shared/pi-feature-capabilities";

export const PI_FEATURE_CAPABILITY_SNAPSHOT_KEY = "open-inspect:feature-capabilities";

export interface PiFeatureCapabilityStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** Latch admission flags once; later deployment changes cannot uninstall replay code. */
export async function latchPiFeatureCapabilitySnapshot(
  storage: PiFeatureCapabilityStorage,
  input: PiFeatureCapabilityInput
): Promise<PiFeatureCapabilitySnapshot> {
  const stored = await storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY);
  if (stored !== undefined) return piFeatureCapabilitySnapshotSchema.parse(stored);

  const snapshot = createPiFeatureCapabilitySnapshot(input);
  await storage.put(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY, snapshot);
  return snapshot;
}
