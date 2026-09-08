import type { SlackGlobalConfig } from "@open-inspect/shared/types/integrations";
import { isValidModel } from "@open-inspect/shared/models";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

const slackSettingsResponseSchema = z.object({
  settings: z
    .object({
      defaults: z
        .object({
          model: z.string().optional(),
          sessionInstructions: z.string().optional(),
        })
        .optional(),
    })
    .nullable(),
}) satisfies z.ZodType<{ settings: Pick<SlackGlobalConfig, "defaults"> | null }>;

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

    const parsed = slackSettingsResponseSchema.safeParse(await response.json());
    if (!parsed.success) return {};
    const data = parsed.data;
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
