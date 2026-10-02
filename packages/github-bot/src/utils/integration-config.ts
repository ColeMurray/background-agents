import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import type { Logger } from "../logger";
import { z } from "zod";
import {
  checkHarnessCompatibility,
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  harnessIdSchema,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault } from "@open-inspect/shared/models";

export interface ResolvedGitHubConfig {
  model: string;
  harness: HarnessId | null;
  reasoningEffort: string | null;
  autoReviewOnOpen: boolean;
  enabledRepos: string[] | null;
  allowedTriggerUsers: string[] | null;
  codeReviewInstructions: string | null;
  commentActionInstructions: string | null;
}

const resolvedGitHubConfigResponseSchema = z.object({
  config: z
    .object({
      model: z.string().nullable(),
      // Optional (not just nullable): an older control plane predating the
      // harness setting answers without this key, and the whole config must
      // not fall back to fail-closed over one missing field.
      harness: harnessIdSchema.nullable().optional(),
      reasoningEffort: z.string().nullable(),
      autoReviewOnOpen: z.boolean(),
      enabledRepos: z.array(z.string()).nullable(),
      allowedTriggerUsers: z.array(z.string()).nullable(),
      codeReviewInstructions: z.string().nullable(),
      commentActionInstructions: z.string().nullable(),
    })
    .nullable(),
});

const FAIL_CLOSED: Omit<ResolvedGitHubConfig, "model"> = {
  harness: DEFAULT_HARNESS,
  reasoningEffort: null,
  autoReviewOnOpen: false,
  enabledRepos: [],
  allowedTriggerUsers: [],
  codeReviewInstructions: null,
  commentActionInstructions: null,
};

export async function getGitHubConfig(
  env: Env,
  repo: string,
  log?: Logger
): Promise<ResolvedGitHubConfig> {
  // Owners may be nested namespaces — split on the last slash and encode the
  // owner as a single route segment (see the repo-owner gotcha in AGENTS.md).
  const repository = parseRepositoryFullName(repo);
  if (!repository) {
    log?.warn("config.invalid_repo", { repo, fallback: "fail_closed" });
    return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
  }
  const url = `https://internal/integration-settings/github/resolved/${encodeRepositoryPathSegments(repository)}`;

  let response: Response;
  try {
    response = await signedControlPlaneFetch(env, { method: "GET", url });
  } catch (err) {
    log?.warn("config.fetch_error", {
      repo,
      error: err instanceof Error ? err : new Error(String(err)),
      fallback: "fail_closed",
    });
    return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
  }

  if (!response.ok) {
    log?.warn("config.fetch_failed", {
      repo,
      status: response.status,
      fallback: "fail_closed",
    });
    return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
  }

  let data: z.infer<typeof resolvedGitHubConfigResponseSchema>;
  try {
    const parsed = resolvedGitHubConfigResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      log?.warn("config.invalid_response", {
        repo,
        fallback: "fail_closed",
      });
      return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
    }
    data = parsed.data;
  } catch (err) {
    log?.warn("config.invalid_response", {
      repo,
      error: err instanceof Error ? err : new Error(String(err)),
      fallback: "fail_closed",
    });
    return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
  }

  if (!data.config) {
    return {
      model: env.DEFAULT_MODEL,
      harness: null,
      reasoningEffort: null,
      autoReviewOnOpen: true,
      enabledRepos: null,
      allowedTriggerUsers: null,
      codeReviewInstructions: null,
      commentActionInstructions: null,
    };
  }

  return {
    model: data.config.model ?? env.DEFAULT_MODEL,
    harness: data.config.harness ?? null,
    reasoningEffort: data.config.reasoningEffort,
    autoReviewOnOpen: data.config.autoReviewOnOpen,
    enabledRepos: data.config.enabledRepos,
    allowedTriggerUsers: data.config.allowedTriggerUsers,
    codeReviewInstructions: data.config.codeReviewInstructions,
    commentActionInstructions: data.config.commentActionInstructions,
  };
}

/**
 * Resolve the harness to send for a new GitHub-triggered session, or null to
 * omit it (the server then resolves the built-in default, exactly as today).
 * Compatibility is evaluated against the canonical model session creation
 * will actually run (`getValidModelOrDefault`), not the raw configured value:
 * a stale or out-of-catalog model falls back to the default model server-side,
 * so judging the raw string would omit a harness the resolved session honors.
 * A resolved pair the harness cannot run — possible when global and repo
 * levels set harness and model separately — is omitted with a warning, so a
 * trigger never fails silently on a mismatch the saves could not see.
 */
export function resolveGitHubSessionHarness(
  config: Pick<ResolvedGitHubConfig, "harness" | "model">,
  log?: Logger
): HarnessId | null {
  if (config.harness === null) return null;
  const harness = getValidHarnessOrDefault(config.harness);
  const incompatibility = checkHarnessCompatibility(harness, getValidModelOrDefault(config.model));
  if (incompatibility) {
    log?.warn("config.harness_model_mismatch", {
      harness,
      model: config.model,
      fallback: DEFAULT_HARNESS,
    });
    return null;
  }
  return harness;
}
