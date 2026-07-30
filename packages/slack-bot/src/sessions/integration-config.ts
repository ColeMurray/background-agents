import type { SlackGlobalConfig } from "@open-inspect/shared";
import { signedControlPlaneFetch } from "../internal-auth";
import type { Env } from "../types";

/**
 * Fetch the workspace-wide session instructions configured in the Slack
 * integration settings. Returns undefined when unset or on any fetch failure —
 * instructions are best effort and must never block session creation.
 */
export async function getSlackSessionInstructions(
  env: Env,
  traceId?: string
): Promise<string | undefined> {
  try {
    const url = "https://internal/integration-settings/slack";
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { settings: SlackGlobalConfig | null };
    const instructions = data.settings?.defaults?.sessionInstructions;
    return typeof instructions === "string" && instructions.trim() ? instructions : undefined;
  } catch {
    return undefined;
  }
}
