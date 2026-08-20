import { z } from "zod";

export const secretsRequestBodySchema = z.object({
  secrets: z.record(z.string(), z.string()),
});

export type SecretsRequestBody = z.infer<typeof secretsRequestBodySchema>;

export const environmentSecretsImportBodySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  keys: z.array(z.string()).optional(),
});

export type EnvironmentSecretsImportBody = z.infer<typeof environmentSecretsImportBodySchema>;
