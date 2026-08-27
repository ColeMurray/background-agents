import { z } from "zod";
import { repositoryPairInputSchema } from "@open-inspect/shared/types/repositories";

export const secretsRequestBodySchema = z.object({
  secrets: z.record(z.string(), z.string()),
});

export type SecretsRequestBody = z.infer<typeof secretsRequestBodySchema>;

export const environmentSecretsImportBodySchema = repositoryPairInputSchema.extend({
  keys: z.array(z.string()).optional(),
});

export type EnvironmentSecretsImportBody = z.infer<typeof environmentSecretsImportBodySchema>;
