import {
  hasInlinePromptOptions,
  type InlinePromptOptions,
  type ParseInlinePromptFlagsResult,
} from "@open-inspect/shared/inline-prompt-flags";
import {
  getReasoningConfig,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  normalizeValidModels,
  type ValidModel,
} from "@open-inspect/shared/models";
import {
  DEFAULT_HARNESS,
  resolveHarnessForModel,
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
      reason: "invalid_inline_flags" | "model_preferences_unavailable";
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
  enabledModels: readonly ValidModel[]
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
    if (!isValidReasoningEffort(model, options.reasoningEffort)) {
      const efforts = getReasoningConfig(model)?.efforts;
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

  const reasoningEffort =
    defaults.reasoningEffort && isValidReasoningEffort(model, defaults.reasoningEffort)
      ? defaults.reasoningEffort
      : null;
  return { ok: true, selection: { model, reasoningEffort } };
}

/**
 * Resolve the harness for a canonical model, warning when the configured
 * harness cannot run it and the built-in default takes over. Cross-level
 * pairs (global harness + repo model) can disagree, as can an inline model
 * override — a trigger must never fail silently on a mismatch the saves
 * could not see.
 */
function resolveHarness(configured: HarnessId, model: string, log: Logger): HarnessId {
  const harness = resolveHarnessForModel(configured, model);
  if (harness !== configured) {
    log.warn("config.harness_model_mismatch", {
      harness: configured,
      model,
      fallback: DEFAULT_HARNESS,
    });
  }
  return harness;
}

/**
 * Resolve the model settings for a new session from the configured defaults
 * and any flags that lead the triggering comment. The model is canonicalized
 * once; the harness and the effort are resolved against that same model, and
 * all three travel together to session creation.
 */
export async function resolveModelSelection(
  env: Env,
  log: Logger,
  traceId: string,
  defaults: ModelSelection,
  flags: ParseInlinePromptFlagsResult | undefined
): Promise<ModelSelectionResult> {
  if (!flags || (flags.ok && !hasInlinePromptOptions(flags.options))) {
    const model = getValidModelOrDefault(defaults.model);
    const reasoningEffort =
      defaults.reasoningEffort && isValidReasoningEffort(model, defaults.reasoningEffort)
        ? defaults.reasoningEffort
        : null;
    return {
      ok: true,
      selection: { model, harness: resolveHarness(defaults.harness, model, log), reasoningEffort },
      overridden: false,
    };
  }
  if (!flags.ok) {
    return { ok: false, reason: "invalid_inline_flags", message: invalidFlagsMessage(flags.error) };
  }

  // Only a model override needs the enabled list; a reasoning-only override
  // keeps the configured model.
  let enabledModels: ValidModel[] = [];
  if (flags.options.model) {
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

  const applied = applyInlineModelOverrides(flags.options, defaults, enabledModels);
  if (!applied.ok) {
    return {
      ok: false,
      reason: "invalid_inline_flags",
      message: invalidFlagsMessage(applied.message),
    };
  }
  const selection = applied.selection;
  return {
    ok: true,
    selection: {
      model: selection.model,
      harness: resolveHarness(defaults.harness, selection.model, log),
      reasoningEffort: selection.reasoningEffort,
    },
    overridden: true,
  };
}
