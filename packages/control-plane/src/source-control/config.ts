import { SourceControlProviderError } from "./errors";
import type { SourceControlProviderName } from "./types";

export const DEFAULT_SCM_PROVIDER: SourceControlProviderName = "github";

export function resolveScmProviderFromEnv(value: string | undefined): SourceControlProviderName {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return DEFAULT_SCM_PROVIDER;
  }

  if (normalized === "github" || normalized === "bitbucket") {
    return normalized;
  }

  throw new SourceControlProviderError(
    `Invalid SCM_PROVIDER value '${normalized}'. Supported values: github, bitbucket.`,
    "permanent"
  );
}
