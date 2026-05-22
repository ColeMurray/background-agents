import type { Env } from "../types";
import type { Logger } from "../logger";
import { buildInternalAuthHeaders, fetchModelDefaults } from "@open-inspect/shared";

export interface ResolvedGitHubConfig {
  model: string;
  reasoningEffort: string | null;
  autoReviewOnOpen: boolean;
  autoApproveOnOpen: boolean;
  enabledRepos: string[] | null;
  allowedTriggerUsers: string[] | null;
  codeReviewInstructions: string | null;
  commentActionInstructions: string | null;
}

const FAIL_CLOSED: Omit<ResolvedGitHubConfig, "model"> = {
  reasoningEffort: null,
  autoReviewOnOpen: false,
  autoApproveOnOpen: false,
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
  const [owner, name] = repo.split("/");
  const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);
  const { defaultModel } = await fetchModelDefaults(env);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/github/resolved/${owner}/${name}`,
      { headers }
    );
  } catch (err) {
    log?.warn("config.fetch_error", {
      repo,
      error: err instanceof Error ? err : new Error(String(err)),
      fallback: "fail_closed",
    });
    return { ...FAIL_CLOSED, model: defaultModel };
  }

  if (!response.ok) {
    log?.warn("config.fetch_failed", {
      repo,
      status: response.status,
      fallback: "fail_closed",
    });
    return { ...FAIL_CLOSED, model: defaultModel };
  }

  const data = (await response.json()) as {
    config: {
      model: string | null;
      reasoningEffort: string | null;
      autoReviewOnOpen: boolean;
      autoApproveOnOpen: boolean;
      enabledRepos: string[] | null;
      allowedTriggerUsers: string[] | null;
      codeReviewInstructions: string | null;
      commentActionInstructions: string | null;
    } | null;
  };

  if (!data.config) {
    return {
      model: defaultModel,
      reasoningEffort: null,
      autoReviewOnOpen: true,
      autoApproveOnOpen: false,
      enabledRepos: null,
      allowedTriggerUsers: null,
      codeReviewInstructions: null,
      commentActionInstructions: null,
    };
  }

  return {
    model: data.config.model ?? defaultModel,
    reasoningEffort: data.config.reasoningEffort,
    autoReviewOnOpen: data.config.autoReviewOnOpen,
    autoApproveOnOpen: data.config.autoApproveOnOpen ?? false,
    enabledRepos: data.config.enabledRepos,
    allowedTriggerUsers: data.config.allowedTriggerUsers,
    codeReviewInstructions: data.config.codeReviewInstructions,
    commentActionInstructions: data.config.commentActionInstructions,
  };
}
