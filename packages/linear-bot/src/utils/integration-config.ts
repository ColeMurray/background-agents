import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import { DEFAULT_HARNESS, harnessIdSchema } from "@open-inspect/shared/harnesses";
import { z } from "zod";
import type { Env, LinearChannelScope } from "../types";
import { fetchControlPlaneJson } from "../control-plane";

const resolvedLinearConfigSchema = z.object({
  // Control planes that predate the harness setting omit it.
  harness: harnessIdSchema.default(DEFAULT_HARNESS),
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
  harness: DEFAULT_HARNESS,
  model: null,
  reasoningEffort: null,
  allowUserPreferenceOverride: true,
  allowLabelModelOverride: true,
  emitToolProgressActivities: true,
  issueSessionInstructions: null,
  enabledRepos: null,
};

/**
 * Read one repository's Linear settings for a Linear team. Failed reads throw rather
 * than falling back to defaults; only an unconfigured repository uses defaults.
 */
export async function getLinearConfig(
  env: Env,
  repo: string,
  scope: LinearChannelScope
): Promise<ResolvedLinearConfig> {
  const repository = parseRepositoryFullName(repo);
  if (!repository) throw new Error("Invalid repository for Linear config read");

  const path = `/integration-settings/linear/resolved/${encodeRepositoryPathSegments(repository)}`;
  const body = await fetchControlPlaneJson(env, path, scope);
  return resolvedLinearConfigResponseSchema.parse(body).config ?? DEFAULT_CONFIG;
}
