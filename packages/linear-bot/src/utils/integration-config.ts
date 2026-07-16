import { encodeRepositoryPathSegments, parseRepositoryFullName } from "@open-inspect/shared";
import { z } from "zod";
import type { Env } from "../types";
import { buildInternalAuthHeaders } from "./internal";

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

export async function getLinearConfig(env: Env, repo: string): Promise<ResolvedLinearConfig> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return DEFAULT_CONFIG;
  }

  const repository = parseRepositoryFullName(repo);
  if (!repository) {
    return DEFAULT_CONFIG;
  }

  const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/linear/resolved/${encodeRepositoryPathSegments(repository)}`,
      { headers }
    );
  } catch {
    return DEFAULT_CONFIG;
  }

  if (!response.ok) {
    return DEFAULT_CONFIG;
  }

  const parsed = resolvedLinearConfigResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.config) {
    return DEFAULT_CONFIG;
  }

  return parsed.data.config;
}
