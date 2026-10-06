import { z } from "zod";
import { sandboxSettingsSchema } from "@open-inspect/shared/types/integrations";

export const sandboxGlobalSettingsResponseSchema = z.object({
  integrationId: z.literal("sandbox"),
  settings: z
    .object({
      defaults: sandboxSettingsSchema.optional(),
      enabledRepos: z.array(z.string()).nullable().optional(),
    })
    .nullable(),
});

type GlobalSettingsResponse = z.infer<typeof sandboxGlobalSettingsResponseSchema>;

export const sandboxRepoSettingsResponseSchema = z.object({
  integrationId: z.literal("sandbox"),
  repo: z.string(),
  settings: sandboxSettingsSchema.nullable(),
});

type RepoSettingsResponse = z.infer<typeof sandboxRepoSettingsResponseSchema>;

export const sandboxEnvironmentSettingsResponseSchema = z.object({
  integrationId: z.literal("sandbox"),
  environmentId: z.string(),
  settings: sandboxSettingsSchema.nullable(),
});

type EnvironmentSettingsResponse = z.infer<typeof sandboxEnvironmentSettingsResponseSchema>;

export function parseSandboxGlobalSettingsResponse(
  value: unknown
): GlobalSettingsResponse | undefined {
  const parsed = sandboxGlobalSettingsResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseSandboxRepoSettingsResponse(value: unknown): RepoSettingsResponse | undefined {
  const parsed = sandboxRepoSettingsResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseSandboxEnvironmentSettingsResponse(
  value: unknown
): EnvironmentSettingsResponse | undefined {
  const parsed = sandboxEnvironmentSettingsResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
