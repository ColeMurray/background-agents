/**
 * Validate reasoning effort against a model's allowed values.
 * Returns the validated effort string or null if invalid/absent.
 */

import { isValidReasoningEffort } from "@open-inspect/shared";
import type { Logger } from "../logger";

export function validateReasoningEffort(
  model: string,
  effort: string | undefined,
  log: Logger
): string | null {
  if (!effort) return null;
  if (isValidReasoningEffort(model, effort)) return effort;
  log.warn("Invalid reasoning effort for model, ignoring", {
    model,
    reasoning_effort: effort,
  });
  return null;
}
