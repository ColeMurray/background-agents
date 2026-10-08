import {
  artifactTypeSchema,
  type ArtifactResponse,
  type ArtifactType,
} from "@open-inspect/shared/types/artifacts";

export type NormalizedArtifactResponse = Omit<ArtifactResponse, "updatedAt"> & {
  updatedAt: number;
};

export function assertArtifactType(value: string): ArtifactType {
  const parsed = artifactTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unsupported artifact type: ${value}`);
  }

  return parsed.data;
}
