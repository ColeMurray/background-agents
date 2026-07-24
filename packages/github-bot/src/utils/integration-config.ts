import { encodeRepositoryPathSegments, parseRepositoryFullName } from "@open-inspect/shared";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import type { Logger } from "../logger";
import { z } from "zod";

export interface ResolvedGitHubConfig {
  model: string;
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
    reasoningEffort: data.config.reasoningEffort,
    autoReviewOnOpen: data.config.autoReviewOnOpen,
    enabledRepos: data.config.enabledRepos,
    allowedTriggerUsers: data.config.allowedTriggerUsers,
    codeReviewInstructions: data.config.codeReviewInstructions,
    commentActionInstructions: data.config.commentActionInstructions,
  };
}
