import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import { z } from "zod";
import type { Env, LinearChannelScope } from "../types";
import { fetchControlPlaneJson } from "../control-plane";

const resolvedLinearConfigSchema = z.object({
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  allowUserPreferenceOverride: z.boolean(),
  allowLabelModelOverride: z.boolean(),
  emitToolProgressActivities: z.boolean(),
  issueSessionInstructions: z.string().nullable(),
  enabledRepos: z.array(z.string()).nullable(),
});

const resolvedLinearConfigResponseSchema = z.object({
  config: resolvedLinearConfigSchema.nullable(),
});

export type ResolvedLinearConfig = z.infer<typeof resolvedLinearConfigSchema>;

const DEFAULT_CONFIG: ResolvedLinearConfig = {
  model: null,
  reasoningEffort: null,
  allowUserPreferenceOverride: true,
  allowLabelModelOverride: true,
  emitToolProgressActivities: true,
  issueSessionInstructions: null,
  enabledRepos: null,
};

export async function getLinearConfig(
  env: Env,
  repo: string,
  scope?: LinearChannelScope
): Promise<ResolvedLinearConfig> {
  if (!env.SERVICE_AUTH_SECRET && !scope) {
    return DEFAULT_CONFIG;
  }

  const repository = parseRepositoryFullName(repo);
  if (!repository) {
    if (scope) throw new Error("Invalid repository for scoped Linear config read");
    return DEFAULT_CONFIG;
  }

  const path = `/integration-settings/linear/resolved/${encodeRepositoryPathSegments(repository)}`;

  try {
    const body = await fetchControlPlaneJson(env, path, undefined, scope);
    return resolvedLinearConfigResponseSchema.parse(body).config ?? DEFAULT_CONFIG;
  } catch (error) {
    if (scope) throw error;
    return DEFAULT_CONFIG;
  }
}
