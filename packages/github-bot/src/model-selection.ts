import {
  hasInlinePromptOptions,
  type InlinePromptOptions,
  type ParseInlinePromptFlagsResult,
} from "@open-inspect/shared/inline-prompt-flags";
import {
  getValidModelOrDefault,
  isValidModel,
  normalizeModelId,
  normalizeValidModels,
  type ValidModel,
} from "@open-inspect/shared/models";
import {
  checkHarnessCompatibility,
  DEFAULT_HARNESS,
  getHarnessReasoningConfig,
  HARNESS_IDS,
  isValidHarnessReasoningEffort,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Logger } from "./logger";
import type { Env } from "./types";

export interface ModelSelection {
  model: string;
  harness: HarnessId;
  reasoningEffort: string | null;
}

export type ModelSelectionResult =
  | { ok: true; selection: ModelSelection; overridden: boolean }
  | {
      ok: false;
      reason:
        "invalid_inline_flags" | "model_preferences_unavailable" | "harness_model_incompatible";
      message: string;
    };

const MODEL_PREFERENCES_UNAVAILABLE_MESSAGE =
  "I couldn't check which models are enabled, so I didn't start a session. Please try again.";

function invalidFlagsMessage(detail: string): string {
  return `I couldn't start a session. ${detail}`;
}

const enabledModelsResponseSchema = z.object({ enabledModels: z.array(z.string()) });

/** Render a user-supplied value as inline code so GitHub shows it literally. */
function inlineCode(value: string): string {
  const longestBacktickRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestBacktickRun + 1);
  return longestBacktickRun > 0 ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

async function getEnabledModels(
  env: Env,
  log: Logger,
  traceId: string
): Promise<ValidModel[] | null> {
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: "https://internal/model-preferences?strict=true",
      traceId,
    });
    if (!response.ok) {
      log.warn("model_preferences.fetch_failed", { trace_id: traceId, status: response.status });
      return null;
    }
    const parsed = enabledModelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      log.warn("model_preferences.invalid_response", { trace_id: traceId });
      return null;
    }
    const enabledModels = normalizeValidModels(parsed.data.enabledModels);
    return enabledModels.length > 0 ? enabledModels : null;
  } catch (err) {
    log.warn("model_preferences.fetch_failed", {
      trace_id: traceId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

/**
 * Apply `!model` / `!reasoning` flags to the configured defaults. A GitHub
 * comment always starts a new session, so the flags become that session's
 * model settings. A model override keeps the configured reasoning effort when
 * the new model supports it.
 */
export function applyInlineModelOverrides(
  options: InlinePromptOptions,
  defaults: Omit<ModelSelection, "harness">,
  enabledModels: readonly ValidModel[],
  harness: HarnessId
): { ok: true; selection: Omit<ModelSelection, "harness"> } | { ok: false; message: string } {
  let model = getValidModelOrDefault(defaults.model);
  if (options.model) {
    if (!isValidModel(options.model)) {
      return { ok: false, message: `Unknown model ${inlineCode(options.model)}.` };
    }
    model = normalizeModelId(options.model) as ValidModel;
    if (!enabledModels.includes(model)) {
      return {
        ok: false,
        message: `Model ${inlineCode(model)} is not enabled. Enable it under Settings › Models.`,
      };
    }
  }

  if (options.reasoningEffort) {
    if (!isValidHarnessReasoningEffort(harness, model, options.reasoningEffort)) {
      const efforts = getHarnessReasoningConfig(harness, model)?.efforts;
      const suffix = efforts?.length
        ? ` Supported values: ${efforts.map(inlineCode).join(", ")}.`
        : " This model does not support reasoning controls.";
      return {
        ok: false,
        message: `Reasoning effort ${inlineCode(options.reasoningEffort)} is not valid for ${inlineCode(model)}.${suffix}`,
      };
    }
    return { ok: true, selection: { model, reasoningEffort: options.reasoningEffort } };
  }

  // Keep recognized configured efforts for launch admission to validate against
  // the resolved harness; malformed values retain the existing null fallback.
  const configuredEffort = defaults.reasoningEffort;
  const reasoningEffort =
    configuredEffort &&
    (options.model
      ? isValidHarnessReasoningEffort(harness, model, configuredEffort)
      : HARNESS_IDS.some((candidate) =>
          isValidHarnessReasoningEffort(candidate, model, configuredEffort)
        ))
      ? configuredEffort
      : null;
  return { ok: true, selection: { model, reasoningEffort } };
}

/**
 * Resolve the model settings for a new session from the configured defaults
 * and any flags that lead the triggering comment. Check the configured harness
 * against the canonical model rather than switching harnesses at launch.
 */
export async function resolveModelSelection(
  env: Env,
  log: Logger,
  traceId: string,
  defaults: ModelSelection,
  flags: ParseInlinePromptFlagsResult | undefined
): Promise<ModelSelectionResult> {
  if (flags && !flags.ok) {
    return { ok: false, reason: "invalid_inline_flags", message: invalidFlagsMessage(flags.error) };
  }

  // Only a model override needs the enabled list; a reasoning-only override
  // keeps the configured model.
  let enabledModels: ValidModel[] = [];
  if (flags?.options.model) {
    const fetched = await getEnabledModels(env, log, traceId);
    if (!fetched) {
      return {
        ok: false,
        reason: "model_preferences_unavailable",
        message: MODEL_PREFERENCES_UNAVAILABLE_MESSAGE,
      };
    }
    enabledModels = fetched;
  }

  const harness = defaults.harness ?? DEFAULT_HARNESS;
  const applied = applyInlineModelOverrides(flags?.options ?? {}, defaults, enabledModels, harness);
  if (!applied.ok) {
    return {
      ok: false,
      reason: "invalid_inline_flags",
      message: invalidFlagsMessage(applied.message),
    };
  }

  const { selection } = applied;
  const compatibilityError = checkHarnessCompatibility(
    harness,
    selection.model,
    undefined,
    selection.reasoningEffort
  );
  if (compatibilityError) {
    return {
      ok: false,
      reason: "harness_model_incompatible",
      message: `I couldn't start a session. ${compatibilityError.message} Choose a compatible model with \`!model\`, update the default model, or change the GitHub integration harness, then try again.`,
    };
  }
  return {
    ok: true,
    selection: { ...selection, harness },
    overridden: flags ? hasInlinePromptOptions(flags.options) : false,
  };
}
