import type { Env } from "../types";
import { generateInternalToken } from "./internal";

export interface ResolvedGitHubConfig {
  model: string;
  reasoningEffort: string | null;
  autoReviewOnOpen: boolean;
  enabledRepos: string[] | null;
  allowedTriggerUsers: string[] | null;
  codeReviewInstructions: string | null;
  commentActionInstructions: string | null;
}

const FAIL_CLOSED: Omit<ResolvedGitHubConfig, "model"> = {
  reasoningEffort: null,
  autoReviewOnOpen: false,
  enabledRepos: [],
  allowedTriggerUsers: [],
  codeReviewInstructions: null,
  commentActionInstructions: null,
};

export async function getGitHubConfig(env: Env, repo: string): Promise<ResolvedGitHubConfig> {
  const [owner, name] = repo.split("/");
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/github/resolved/${owner}/${name}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {
    return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
  }

  if (!response.ok) {
    return { ...FAIL_CLOSED, model: env.DEFAULT_MODEL };
  }

  const data = (await response.json()) as {
    config: {
      model: string | null;
      reasoningEffort: string | null;
      autoReviewOnOpen: boolean;
      enabledRepos: string[] | null;
      allowedTriggerUsers: string[] | null;
      codeReviewInstructions: string | null;
      commentActionInstructions: string | null;
    } | null;
  };

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
