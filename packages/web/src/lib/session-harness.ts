import {
  harnessSupportsModel,
  isValidHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import type { ModelCategory } from "@open-inspect/shared/models";

/**
 * The harness a session runs on, read from any session projection that
 * carries a `harness` field. Null when the projection predates the field, so
 * callers show nothing rather than mislabel the session.
 */
export function resolveSessionHarness(
  state: { readonly [key: string]: unknown } | null | undefined
): HarnessId | null {
  const value = state?.harness;
  return isValidHarness(value) ? value : null;
}

/** Model picker groups reduced to the models the harness can run. */
export function filterModelOptionsForHarness(
  harness: HarnessId,
  options: ModelCategory[]
): ModelCategory[] {
  return options
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => harnessSupportsModel(harness, model.id)),
    }))
    .filter((group) => group.models.length > 0);
}
