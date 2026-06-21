import { DEFAULT_MODEL, getValidModelOrDefault } from "@open-inspect/shared";

/**
 * Pick the model the automation form should actually use, given a desired model
 * (a blank-create default, a saved automation's model, or a template
 * suggestion) and the user's currently enabled models.
 *
 * The form's model selector only lists enabled models, so a model the user has
 * not enabled would render an unselected control and be submitted verbatim. This
 * coerces to a model that is actually enabled, preferring the desired model,
 * then the system default, then the first enabled model. `getValidModelOrDefault`
 * also normalizes legacy/bare ids and falls back for unknown ones.
 */
export function resolveEnabledModel(model: string, enabledModels: string[]): string {
  const desired = getValidModelOrDefault(model);
  const enabled = new Set(enabledModels);
  if (enabled.has(desired)) return desired;
  if (enabled.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return enabledModels[0] ?? DEFAULT_MODEL;
}
