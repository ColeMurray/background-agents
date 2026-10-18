import {
  createPiFeatureCapabilitySnapshot,
  piFeatureCapabilitySnapshotSchema,
  type PiFeatureCapabilitySnapshot,
} from "@open-inspect/shared/pi-feature-capabilities";

export const PI_FEATURE_CAPABILITY_SNAPSHOT_KEY = "open-inspect:feature-capabilities";

export interface PiFeatureCapabilityStorage {
  get(key: string): Promise<unknown>;
}

export const PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT = createPiFeatureCapabilitySnapshot({});

/** Read durable authority without inferring anything from the current deployment. */
export async function readPiFeatureCapabilitySnapshot(
  storage: PiFeatureCapabilityStorage
): Promise<PiFeatureCapabilitySnapshot | undefined> {
  const stored = await storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY);
  return stored === undefined ? undefined : piFeatureCapabilitySnapshotSchema.parse(stored);
}
