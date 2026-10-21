import { z } from "zod";
import { piFeatureCapabilitySnapshotSchema } from "@open-inspect/shared/pi-feature-capabilities";

export const executionPrincipalResponseSchema = z
  .object({
    snapshot: piFeatureCapabilitySnapshotSchema.nullable(),
    current: piFeatureCapabilitySnapshotSchema,
  })
  .strict();

export type ExecutionPrincipalResponse = z.infer<typeof executionPrincipalResponseSchema>;
