import { z } from "zod";
import { piFeatureCapabilitySnapshotSchema } from "@open-inspect/shared/pi-feature-capabilities";

export const piCapabilityAuthorityResponseSchema = z
  .object({
    snapshot: piFeatureCapabilitySnapshotSchema.nullable(),
    current: piFeatureCapabilitySnapshotSchema,
  })
  .strict();

export type PiCapabilityAuthorityResponse = z.infer<typeof piCapabilityAuthorityResponseSchema>;
