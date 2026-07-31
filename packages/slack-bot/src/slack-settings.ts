import type { SlackGlobalConfig } from "@open-inspect/shared/types/integrations";
import { isValidModel } from "@open-inspect/shared/models";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

export interface SlackSettings {
  defaultModel?: string;
  sessionInstructions?: string;
}

/** Fetch and normalize workspace Slack settings without blocking callers on failure. */
export async function getSlackSettings(env: Env, traceId?: string): Promise<SlackSettings> {
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: "https://internal/integration-settings/slack",
      traceId,
    });
    if (!response.ok) return {};

    const data = (await response.json()) as { settings: SlackGlobalConfig | null };
    const model = data.settings?.defaults?.model;
    const instructions = data.settings?.defaults?.sessionInstructions;
    return {
      defaultModel: model && isValidModel(model) ? model : undefined,
      sessionInstructions:
        typeof instructions === "string" && instructions.trim() ? instructions : undefined,
    };
  } catch {
    return {};
  }
}
