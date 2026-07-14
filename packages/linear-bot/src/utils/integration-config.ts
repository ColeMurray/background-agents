import { encodeRepositoryPathSegments, parseRepositoryFullName } from "@open-inspect/shared";
import type { Env } from "../types";
import { buildInternalAuthHeaders } from "./internal";

export interface ResolvedLinearConfig {
  model: string | null;
  reasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  emitToolProgressActivities: boolean;
  issueSessionInstructions: string | null;
  enabledRepos: string[] | null;
}

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

  const data = (await response.json()) as { config: ResolvedLinearConfig | null };
  if (!data.config) {
    return DEFAULT_CONFIG;
  }

  return data.config;
}
