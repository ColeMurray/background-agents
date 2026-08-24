import { z } from "zod";
import type { Logger } from "../logger";
import type { ArtifactRow } from "./types";

const artifactMetadataSchema = z.record(z.string(), z.unknown());

export function parseArtifactMetadataJson(raw: string): Record<string, unknown> | null {
  const parsed = artifactMetadataSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * Parse a stored artifact's metadata blob, degrading to null on anything
 * unreadable.
 *
 * Metadata is decorative — it enriches an artifact rather than defining it — so
 * a corrupt blob must not fail the read that surfaced it. Both failure modes
 * (bad JSON, and valid JSON of the wrong shape) log the artifact id so a bad
 * writer stays traceable.
 */
export function parseArtifactMetadata(
  artifact: Pick<ArtifactRow, "id" | "metadata">,
  log: Pick<Logger, "warn">
): Record<string, unknown> | null {
  if (!artifact.metadata) {
    return null;
  }

  try {
    const metadata = parseArtifactMetadataJson(artifact.metadata);
    if (!metadata) {
      log.warn("Invalid artifact metadata shape", {
        artifact_id: artifact.id,
      });
      return null;
    }
    return metadata;
  } catch (error) {
    log.warn("Invalid artifact metadata JSON", {
      artifact_id: artifact.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
