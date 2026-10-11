import type { SlackGlobalConfig } from "@open-inspect/shared/types/integrations";
import { DEFAULT_HARNESS, harnessIdSchema, type HarnessId } from "@open-inspect/shared/harnesses";
import { isValidModel } from "@open-inspect/shared/models";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";
import type { Env } from "./types";

const log = createLogger("slack-settings");

const slackSettingsResponseSchema = z.object({
  settings: z
    .object({
      defaults: z
        .object({
          harness: harnessIdSchema.default(DEFAULT_HARNESS),
          model: z.string().optional(),
          sessionInstructions: z.string().optional(),
        })
        .optional(),
    })
    .nullable(),
}) satisfies z.ZodType<{ settings: Pick<SlackGlobalConfig, "defaults"> | null }>;

export interface SlackSettings {
  /** Preferred harness for new sessions; see `resolveHarnessForModel`. */
  harness: HarnessId;
  defaultModel?: string;
  sessionInstructions?: string;
}

// Frozen because every fallback path returns this same object.
const DEFAULT_SLACK_SETTINGS: SlackSettings = Object.freeze({ harness: DEFAULT_HARNESS });

/** Fetch and normalize workspace Slack settings without blocking callers on failure. */
export async function getSlackSettings(env: Env, traceId?: string): Promise<SlackSettings> {
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: "https://internal/integration-settings/slack",
      traceId,
    });
    if (!response.ok) {
      log.warn("slack_settings.fetch_failed", {
        trace_id: traceId,
        http_status: response.status,
        fallback: "defaults",
      });
      return DEFAULT_SLACK_SETTINGS;
    }

    const parsed = slackSettingsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      log.warn("slack_settings.invalid_response", { trace_id: traceId, fallback: "defaults" });
      return DEFAULT_SLACK_SETTINGS;
    }
    const defaults = parsed.data.settings?.defaults;
    if (!defaults) return DEFAULT_SLACK_SETTINGS;
    const { harness, model, sessionInstructions: instructions } = defaults;
    return {
      harness,
      defaultModel: model && isValidModel(model) ? model : undefined,
      sessionInstructions: instructions?.trim() ? instructions : undefined,
    };
  } catch (error) {
    log.warn("slack_settings.fetch_error", {
      trace_id: traceId,
      error: error instanceof Error ? error : new Error(String(error)),
      fallback: "defaults",
    });
    return DEFAULT_SLACK_SETTINGS;
  }
}
