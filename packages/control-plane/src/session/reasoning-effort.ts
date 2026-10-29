/**
 * Validate reasoning effort against a model's allowed values.
 * Returns the validated effort string or null if invalid/absent.
 */

import { isValidHarnessReasoningEffort, type HarnessId } from "@open-inspect/shared/harnesses";
import type { Logger } from "../logger";

export function validateReasoningEffort(
  model: string,
  effort: string | undefined,
  log: Logger,
  harness: HarnessId = "opencode"
): string | null {
  if (!effort) return null;
  if (isValidHarnessReasoningEffort(harness, model, effort)) return effort;
  log.warn("Invalid reasoning effort for model, ignoring", {
    model,
    reasoning_effort: effort,
  });
  return null;
}
