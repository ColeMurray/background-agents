import type { ArtifactResponse, ArtifactType } from "@open-inspect/shared/types/artifacts";

export type NormalizedArtifactResponse = Omit<ArtifactResponse, "updatedAt"> & {
  updatedAt: number;
};

const VALID_ARTIFACT_TYPES = [
  "pr",
  "screenshot",
  "video",
  "preview",
  "branch",
] as const satisfies readonly ArtifactType[];
const VALID_ARTIFACT_TYPE_SET = new Set<string>(VALID_ARTIFACT_TYPES);

function isArtifactType(value: string): value is ArtifactType {
  return VALID_ARTIFACT_TYPE_SET.has(value);
}

export function assertArtifactType(value: string): ArtifactType {
  if (!isArtifactType(value)) {
    throw new Error(`Unsupported artifact type: ${value}`);
  }

  return value;
}
