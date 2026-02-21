import type { Env } from "../types";
import { generateInternalToken } from "./internal";

export interface ResolvedLinearConfig {
  model: string | null;
  reasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  repoResolutionMode: "assisted" | "strict";
  emitToolProgressActivities: boolean;
  enabledRepos: string[] | null;
}

interface LinearGlobalDefaults {
  defaults?: {
    repoResolutionMode?: "assisted" | "strict";
  };
}

const DEFAULT_CONFIG: ResolvedLinearConfig = {
  model: null,
  reasoningEffort: null,
  allowUserPreferenceOverride: true,
  allowLabelModelOverride: true,
  repoResolutionMode: "assisted",
  emitToolProgressActivities: true,
  enabledRepos: null,
};

export async function getLinearConfig(env: Env, repo: string): Promise<ResolvedLinearConfig> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return DEFAULT_CONFIG;
  }

  const [owner, name] = repo.split("/");
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/linear/resolved/${owner}/${name}`,
      { headers: { Authorization: `Bearer ${token}` } }
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

  return {
    model: data.config.model,
    reasoningEffort: data.config.reasoningEffort,
    allowUserPreferenceOverride: data.config.allowUserPreferenceOverride,
    allowLabelModelOverride: data.config.allowLabelModelOverride,
    repoResolutionMode: data.config.repoResolutionMode,
    emitToolProgressActivities: data.config.emitToolProgressActivities,
    enabledRepos: data.config.enabledRepos,
  };
}

export async function getLinearGlobalResolutionMode(env: Env): Promise<"assisted" | "strict"> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return "assisted";
  }

  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch("https://internal/integration-settings/linear", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return "assisted";
  }

  if (!response.ok) {
    return "assisted";
  }

  const data = (await response.json()) as { settings: LinearGlobalDefaults | null };
  const mode = data.settings?.defaults?.repoResolutionMode;
  return mode === "strict" ? "strict" : "assisted";
}
