import { publishView } from "@open-inspect/shared/slack";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { getUserRepoBranchPreferences } from "../branch-preferences";
import { getAvailableRepos } from "../classifier/repos";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { getSlackSettings } from "../slack-settings";
import { getUserPreferences, resolveUserPreferences } from "../user-preferences";
import { getAvailableModels } from "./models";
import { buildAppHomeView } from "./view";

const log = createLogger("app-home");

export async function publishAppHome(env: Env, userId: string): Promise<void> {
  const [prefs, availableModels, slackConfig, repos, repoBranchPreferences] = await Promise.all([
    getUserPreferences(env, userId),
    getAvailableModels(env),
    getSlackSettings(env),
    getAvailableRepos(env),
    getUserRepoBranchPreferences(env, userId),
  ]);
  const current = resolveUserPreferences(
    prefs,
    slackConfig.defaultModel ?? env.DEFAULT_MODEL,
    slackConfig.harness
  );
  const view = buildAppHomeView({
    appName: resolveAppName(env),
    availableModels,
    userHarness: prefs?.harness,
    workspaceHarness: slackConfig.harness,
    currentModel: current.model,
    currentEffort: current.reasoningEffort,
    currentBranch: current.branch,
    repos,
    repoBranchPreferences,
  });

  const result = await publishView(env.SLACK_BOT_TOKEN, userId, {
    type: view.type,
    blocks: view.blocks,
  });

  if (!result.ok) {
    log.error("slack.app_home", { user_id: userId, outcome: "error", slack_error: result.error });
  }
}
