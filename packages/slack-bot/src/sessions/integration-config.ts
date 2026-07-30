import type { SlackGlobalConfig } from "@open-inspect/shared";
import { isValidModel } from "@open-inspect/shared/models";
import { signedControlPlaneFetch } from "../internal-auth";
import type { Env } from "../types";

export interface SlackSessionConfig {
  /** Workspace default model for Slack-created sessions, when configured and valid. */
  defaultModel?: string;
  /** Workspace-wide instructions appended to the first prompt of new sessions. */
  sessionInstructions?: string;
}

/**
 * Fetch the Slack integration settings a session launch needs, in one
 * control-plane roundtrip. Fields are best effort: on any fetch failure the
 * config is empty — missing settings must never block session creation.
 */
export async function getSlackSessionConfig(
  env: Env,
  traceId?: string
): Promise<SlackSessionConfig> {
  try {
    const url = "https://internal/integration-settings/slack";
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });

    if (!response.ok) {
      return {};
    }

    const data = (await response.json()) as { settings: SlackGlobalConfig | null };
    const defaults = data.settings?.defaults;
    const model = defaults?.model;
    const instructions = defaults?.sessionInstructions;
    return {
      defaultModel: model && isValidModel(model) ? model : undefined,
      sessionInstructions:
        typeof instructions === "string" && instructions.trim() ? instructions : undefined,
    };
  } catch {
    return {};
  }
}
