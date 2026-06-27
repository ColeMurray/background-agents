import { publishView, resolveAppName } from "@open-inspect/shared";
import { getUserRepoBranchPreferences } from "../branch-preferences";
import { getAvailableRepos } from "../classifier/repos";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { getUserPreferences, resolveUserPreferences } from "../user-preferences";
import { getAvailableModels, getSlackDefaultModel } from "./models";
import { buildAppHomeView } from "./view";

const log = createLogger("app-home");

export async function publishAppHome(env: Env, userId: string): Promise<void> {
  const [prefs, availableModels, slackDefaultModel, repos, repoBranchPreferences] =
    await Promise.all([
      getUserPreferences(env, userId),
      getAvailableModels(env),
      getSlackDefaultModel(env),
      getAvailableRepos(env),
      getUserRepoBranchPreferences(env, userId),
    ]);
  const current = resolveUserPreferences(
    prefs,
    slackDefaultModel ?? env.DEFAULT_MODEL,
    availableModels.map((model) => model.value)
  );
  const view = buildAppHomeView({
    appName: resolveAppName(env),
    availableModels,
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
