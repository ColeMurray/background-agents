import {
  GITHUB_AUTOFIX_DEFAULTS,
  resolveAppName,
  type GitHubAutofixEnvelope,
  type ResolvedGitHubAutofixSettings,
} from "@open-inspect/shared";
import { getGitHubAppConfig } from "../auth/github-app";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { PrAutofixFeedbackStore } from "../db/pr-autofix-feedback-store";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import type { JobDelivery, JobDeps, JobOutcome } from "../jobs";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { GitHubSourceControlProvider } from "../source-control/providers/github-provider";
import { AutofixJobHandler } from "./job-handler";
import { AutofixService } from "./service";

function completeAutofixSettings(
  settings:
    | {
        enabled?: boolean;
        reviewsEnabled?: boolean;
        prCommentsEnabled?: boolean;
        openInspectReviewsEnabled?: boolean;
        allowedReviewBots?: string[];
        maxAttemptsPerPrPer24Hours?: number | null;
      }
    | undefined
): ResolvedGitHubAutofixSettings {
  return {
    ...GITHUB_AUTOFIX_DEFAULTS,
    ...settings,
    allowedReviewBots: settings?.allowedReviewBots ?? GITHUB_AUTOFIX_DEFAULTS.allowedReviewBots,
  };
}

/** Handler for `github.autofix`: the production service over the delivery's store. */
export async function handleAutofixJob(
  envelope: GitHubAutofixEnvelope,
  delivery: JobDelivery,
  { env, db, correlation }: JobDeps
): Promise<JobOutcome> {
  const feedbackStore = new PrAutofixFeedbackStore(db);
  const integrationSettings = new IntegrationSettingsStore(db);
  const appConfig = getGitHubAppConfig(env);
  const github = new GitHubSourceControlProvider({
    appConfig: appConfig ?? undefined,
    cacheStore: env.REPOS_CACHE,
    userAgent: resolveAppName(env),
  });
  const sessions = createSessionRuntimeClient(env, correlation);
  const service = new AutofixService(
    feedbackStore,
    new SessionPullRequestStore(db),
    {
      async resolve(repoFullName) {
        const resolved = await integrationSettings.getResolvedConfig("github", repoFullName);
        return {
          enabledRepos: resolved.enabledRepos,
          autofix: completeAutofixSettings(resolved.settings.autofix),
        };
      },
    },
    github,
    sessions,
    env.GITHUB_BOT_USERNAME,
    () => Date.now()
  );
  return new AutofixJobHandler(service, feedbackStore, () => Date.now()).handle(envelope, delivery);
}
