import type { ArtifactResponse } from "@open-inspect/shared/types/artifacts";

export type NormalizedArtifactResponse = Omit<ArtifactResponse, "updatedAt"> & {
  updatedAt: number;
};
