/**
 * Resolves the model and reasoning effort for a single GitHub bot session.
 *
 * Priority (highest first):
 *   1. Inline directive (when allowed and the directive carries a valid model)
 *   2. Resolved integration config (`configModel`)
 *   3. Env-level floor (`envDefaultModel`)
 *
 * Reasoning effort follows the chosen model: a directive reasoning effort can
 * override config reasoning if compatible with whichever model wins. Reasoning
 * that is incompatible with the resolved model is silently dropped (becomes null).
 *
 * Intentionally a near-clone of `packages/linear-bot/src/model-resolution.ts`; the
 * github and linear bots own their resolvers separately so the policies can drift.
 */

import { isValidModel, isValidReasoningEffort, normalizeModelId } from "@open-inspect/shared";

export interface ResolveInput {
  envDefaultModel: string;
  configModel: string | null;
  configReasoningEffort: string | null;
  allowInlineDirectiveOverride: boolean;
  directiveModel?: string;
  directiveReasoningEffort?: string;
}

export interface ResolvedModelSettings {
  model: string;
  reasoningEffort: string | null;
}

export function resolveSessionModelSettings(input: ResolveInput): ResolvedModelSettings {
  const directiveAllowed = input.allowInlineDirectiveOverride === true;

  // Step 1: did the directive supply a valid model?
  let model: string;
  let modelFromDirective = false;
  if (directiveAllowed && input.directiveModel && isValidModel(input.directiveModel)) {
    model = normalizeModelId(input.directiveModel);
    modelFromDirective = true;
  } else {
    // Fall back to config model (if valid) or env default. Note: we honor the
    // *passed-in* env default rather than the shared `DEFAULT_MODEL` constant
    // because Terraform sets the env-level floor explicitly.
    if (input.configModel && isValidModel(input.configModel)) {
      model = normalizeModelId(input.configModel);
    } else {
      model = normalizeModelId(input.envDefaultModel);
    }
  }

  // Step 2: pick reasoning. Directive reasoning wins if allowed and compatible.
  if (
    directiveAllowed &&
    input.directiveReasoningEffort &&
    isValidReasoningEffort(model, input.directiveReasoningEffort)
  ) {
    return { model, reasoningEffort: input.directiveReasoningEffort };
  }

  // If the directive supplied an *incompatible* reasoning along with a model,
  // do not fall back to the config reasoning — the user explicitly asked to override.
  if (modelFromDirective) {
    return { model, reasoningEffort: null };
  }

  // No directive in play: use config reasoning if compatible with the resolved model.
  if (input.configReasoningEffort && isValidReasoningEffort(model, input.configReasoningEffort)) {
    return { model, reasoningEffort: input.configReasoningEffort };
  }

  return { model, reasoningEffort: null };
}
