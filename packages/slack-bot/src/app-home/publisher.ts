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
import { DEFAULT_HARNESS } from "@open-inspect/shared/harnesses";
import { getAvailableHarnessIds } from "../sessions/control-plane-client";

const log = createLogger("app-home");

export async function publishAppHome(env: Env, userId: string): Promise<void> {
  const [prefs, availableModels, slackConfig, repos, repoBranchPreferences, availableHarnesses] =
    await Promise.all([
      getUserPreferences(env, userId),
      getAvailableModels(env),
      getSlackSettings(env),
      getAvailableRepos(env),
      getUserRepoBranchPreferences(env, userId),
      getAvailableHarnessIds(env),
    ]);
  const workspaceHarness = availableHarnesses.includes(slackConfig.harness)
    ? slackConfig.harness
    : DEFAULT_HARNESS;
  const availablePreferences =
    prefs?.harness && !availableHarnesses.includes(prefs.harness)
      ? { ...prefs, harness: undefined }
      : prefs;
  const current = resolveUserPreferences(
    availablePreferences,
    slackConfig.defaultModel ?? env.DEFAULT_MODEL,
    workspaceHarness
  );
  const view = buildAppHomeView({
    appName: resolveAppName(env),
    availableModels,
    userHarness: availablePreferences?.harness,
    workspaceHarness,
    availableHarnesses,
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
