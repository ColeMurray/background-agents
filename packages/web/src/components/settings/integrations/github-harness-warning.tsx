import {
  DEFAULT_HARNESS,
  checkHarnessCompatibility,
  getHarnessLabel,
  resolveHarnessForModel,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault } from "@open-inspect/shared/models";

/** Explain harness fallback, including when the deployment model is unknown to the UI. */
export function GitHubHarnessWarning({ harness, model }: { harness: HarnessId; model: string }) {
  if (!model) {
    if (harness === DEFAULT_HARNESS) return null;
    return (
      <p className="text-xs text-warning">
        GitHub sessions use the deployment default model. Set a compatible model to ensure sessions
        run on {getHarnessLabel(harness)}; otherwise they may fall back to{" "}
        {getHarnessLabel(DEFAULT_HARNESS)}.
      </p>
    );
  }

  const canonicalModel = getValidModelOrDefault(model);
  const resolvedHarness = resolveHarnessForModel(harness, canonicalModel);
  if (resolvedHarness === harness) return null;
  return (
    <p className="text-xs text-warning">
      {checkHarnessCompatibility(harness, canonicalModel)?.message} Sessions will run on{" "}
      {getHarnessLabel(resolvedHarness)} until the harness and model are compatible.
    </p>
  );
}
