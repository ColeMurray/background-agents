import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import {
  checkHarnessCompatibility,
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  harnessIdSchema,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault } from "@open-inspect/shared/models";
import { z } from "zod";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import type { Logger } from "../logger";

const resolvedLinearConfigSchema = z.object({
  model: z.string().nullable(),
  // Optional (not just nullable): an older control plane predating the
  // harness setting answers without this key, and the whole config must
  // not fall back to fail-closed over one missing field.
  harness: harnessIdSchema.nullable().optional(),
  reasoningEffort: z.string().nullable(),
  allowUserPreferenceOverride: z.boolean(),
  allowLabelModelOverride: z.boolean(),
  emitToolProgressActivities: z.boolean(),
  issueSessionInstructions: z.string().nullable(),
  enabledRepos: z.array(z.string()).nullable(),
});

const resolvedLinearConfigResponseSchema = z.object({
  config: resolvedLinearConfigSchema.nullable(),
});

export type ResolvedLinearConfig = z.infer<typeof resolvedLinearConfigSchema>;

const DEFAULT_CONFIG: ResolvedLinearConfig = {
  model: null,
  harness: null,
  reasoningEffort: null,
  allowUserPreferenceOverride: true,
  allowLabelModelOverride: true,
  emitToolProgressActivities: true,
  issueSessionInstructions: null,
  enabledRepos: null,
};

export async function getLinearConfig(env: Env, repo: string): Promise<ResolvedLinearConfig> {
  if (!env.SERVICE_AUTH_SECRET) {
    return DEFAULT_CONFIG;
  }

  const repository = parseRepositoryFullName(repo);
  if (!repository) {
    return DEFAULT_CONFIG;
  }

  const url = `https://internal/integration-settings/linear/resolved/${encodeRepositoryPathSegments(repository)}`;

  let response: Response;
  try {
    response = await signedControlPlaneFetch(env, { method: "GET", url });
  } catch {
    return DEFAULT_CONFIG;
  }

  if (!response.ok) {
    return DEFAULT_CONFIG;
  }

  const parsed = resolvedLinearConfigResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success || !parsed.data.config) {
    return DEFAULT_CONFIG;
  }

  return parsed.data.config;
}

/**
 * Resolve the harness to send for a new Linear-triggered session, or null to
 * omit it (the server then resolves the built-in default, exactly as today).
 * Compatibility is evaluated against the canonical model session creation
 * will actually run (`getValidModelOrDefault`), not the raw configured value:
 * a stale or out-of-catalog model falls back to the default model server-side,
 * so judging the raw string would omit a harness the resolved session honors.
 * A resolved pair the harness cannot run — possible when global and repo
 * levels set harness and model separately, or when user/label overrides supply
 * the model — is omitted with a warning, so a trigger never fails silently on
 * a mismatch the saves could not see.
 */
export function resolveLinearSessionHarness(
  harness: HarnessId | null | undefined,
  model: string,
  log?: Logger
): HarnessId | null {
  if (harness == null) return null;
  const resolved = getValidHarnessOrDefault(harness);
  const incompatibility = checkHarnessCompatibility(resolved, getValidModelOrDefault(model));
  if (incompatibility) {
    log?.warn("config.harness_model_mismatch", {
      harness: resolved,
      model,
      fallback: DEFAULT_HARNESS,
    });
    return null;
  }
  return resolved;
}
