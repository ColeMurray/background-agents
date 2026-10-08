import {
  getDefaultReasoningEffort,
  getReasoningConfig,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { InlinePromptOptions } from "@open-inspect/shared/inline-prompt-flags";
import { escapeMrkdwnText } from "@open-inspect/shared/slack";
import { z } from "zod";

const validModelSchema = z.custom<ValidModel>(
  (value) => typeof value === "string" && isValidModel(value) && normalizeModelId(value) === value
);
const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
const modelSelectionSchema = z.object({
  model: validModelSchema,
  reasoningEffort: reasoningEffortSchema.optional(),
});

export const resolvedTurnPlanSchema = z
  .object({
    sessionDefaults: modelSelectionSchema,
    promptOverrides: z.object({
      model: validModelSchema.optional(),
      reasoningEffort: reasoningEffortSchema.optional(),
    }),
    effective: modelSelectionSchema,
  })
  .superRefine((plan, ctx) => {
    const effectiveModel = plan.promptOverrides.model ?? plan.sessionDefaults.model;
    if (plan.effective.model !== effectiveModel) {
      ctx.addIssue({ code: "custom", message: "Effective model does not match prompt plan" });
    }
    for (const [model, effort] of [
      [plan.sessionDefaults.model, plan.sessionDefaults.reasoningEffort],
      [effectiveModel, plan.promptOverrides.reasoningEffort],
      [plan.effective.model, plan.effective.reasoningEffort],
    ] as const) {
      if (effort && !isValidReasoningEffort(model, effort)) {
        ctx.addIssue({ code: "custom", message: `Invalid reasoning effort for ${model}` });
      }
    }
    if (
      plan.promptOverrides.reasoningEffort !== undefined &&
      plan.promptOverrides.reasoningEffort !== plan.effective.reasoningEffort
    ) {
      ctx.addIssue({ code: "custom", message: "Effective reasoning does not match prompt plan" });
    }
  });

export type ResolvedTurnPlan = z.infer<typeof resolvedTurnPlanSchema>;

/**
 * The model settings a session launch asked for. `sessionDefaults` is
 * persisted and inherited by every later follow-up; the opening prompt runs
 * on it too. Callers express intent here; the launcher is the authority that
 * checks it against the models enabled at launch time. Records saved before
 * opening-prompt overrides were removed may still carry `promptOverrides`;
 * parsing drops it.
 */
export const sessionLaunchPlanSchema = z.object({
  sessionDefaults: modelSelectionSchema,
});

export type SessionLaunchPlan = z.infer<typeof sessionLaunchPlanSchema>;

export type ResolveInlinePromptOptionsResult =
  { ok: true; turnPlan: ResolvedTurnPlan } | { ok: false; error: string };

/** A model paired with the reasoning effort it runs at. */
export interface ModelSelection {
  model: ValidModel;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Coerce stored preferences — which are plain strings from KV, D1, or a Slack
 * thread mapping — into a valid model and a reasoning effort that model
 * supports. Does not consider which models are currently enabled.
 */
export function normalizeModelSelection(defaults: {
  model: string;
  reasoningEffort?: string;
}): ModelSelection {
  const model = getValidModelOrDefault(defaults.model);
  const reasoningEffort =
    defaults.reasoningEffort && isValidReasoningEffort(model, defaults.reasoningEffort)
      ? (defaults.reasoningEffort as ReasoningEffort)
      : getDefaultReasoningEffort(model);
  return { model, reasoningEffort };
}

export function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  return a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}

/**
 * Resolve one-turn overrides against the session defaults and enabled model
 * list. Only an explicit `!model` must be enabled; the session defaults are
 * kept as given. New-session launches separately refuse disabled models;
 * existing-thread follow-ups keep their session model unless explicitly overridden.
 */
export function resolveInlinePromptOptions(
  options: InlinePromptOptions,
  defaults: { model: string; reasoningEffort?: string },
  enabledModels: readonly ValidModel[]
): ResolveInlinePromptOptionsResult {
  const { model: sessionModel, reasoningEffort: sessionReasoningEffort } =
    normalizeModelSelection(defaults);
  let modelOverride: ValidModel | undefined;
  if (options.model) {
    if (!isValidModel(options.model)) {
      return { ok: false, error: `Unknown model "${escapeMrkdwnText(options.model)}".` };
    }
    modelOverride = normalizeModelId(options.model) as ValidModel;
    if (!enabledModels.includes(modelOverride)) {
      return { ok: false, error: `Model "${modelOverride}" is not enabled.` };
    }
  }

  const effectiveModel = modelOverride ?? sessionModel;
  if (options.reasoningEffort && !isValidReasoningEffort(effectiveModel, options.reasoningEffort)) {
    const efforts = getReasoningConfig(effectiveModel)?.efforts;
    const suffix = efforts?.length
      ? ` Supported values: ${efforts.join(", ")}.`
      : " This model does not support reasoning controls.";
    return {
      ok: false,
      error: `Reasoning effort "${escapeMrkdwnText(options.reasoningEffort)}" is not valid for "${effectiveModel}".${suffix}`,
    };
  }

  const reasoningOverride = options.reasoningEffort as ReasoningEffort | undefined;
  const effectiveReasoningEffort = reasoningOverride
    ? reasoningOverride
    : modelOverride
      ? sessionReasoningEffort && isValidReasoningEffort(modelOverride, sessionReasoningEffort)
        ? sessionReasoningEffort
        : getDefaultReasoningEffort(modelOverride)
      : sessionReasoningEffort;

  const promptOverrides: ResolvedTurnPlan["promptOverrides"] = {};
  if (modelOverride) promptOverrides.model = modelOverride;
  if ((reasoningOverride || modelOverride) && effectiveReasoningEffort) {
    promptOverrides.reasoningEffort = effectiveReasoningEffort;
  }

  return {
    ok: true,
    turnPlan: {
      sessionDefaults: {
        model: sessionModel,
        reasoningEffort: sessionReasoningEffort,
      },
      promptOverrides,
      effective: {
        model: effectiveModel,
        reasoningEffort: effectiveReasoningEffort,
      },
    },
  };
}
