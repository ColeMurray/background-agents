import type { SessionArtifact } from "@open-inspect/shared";
import type { ArtifactType } from "../types";

const VALID_ARTIFACT_TYPES: ReadonlySet<ArtifactType> = new Set([
  "pr",
  "screenshot",
  "preview",
  "branch",
]);

export function assertArtifactType(value: string): ArtifactType {
  if (!VALID_ARTIFACT_TYPES.has(value as ArtifactType)) {
    throw new Error(`Unsupported artifact type: ${value}`);
  }

  return value as ArtifactType;
}

export function buildSessionArtifact(args: {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}): SessionArtifact {
  return {
    id: args.id,
    type: args.type,
    url: args.url,
    metadata: args.metadata,
    createdAt: args.createdAt,
  };
}
