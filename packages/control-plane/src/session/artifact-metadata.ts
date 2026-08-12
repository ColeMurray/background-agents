import { z } from "zod";

const artifactMetadataSchema = z.record(z.string(), z.unknown());

export function parseArtifactMetadataJson(raw: string): Record<string, unknown> | null {
  const parsed = artifactMetadataSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}
