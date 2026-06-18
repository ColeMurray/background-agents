import { isValidModel, isValidReasoningEffort } from "@open-inspect/shared";
import {
  BRANCH_INPUT_BLOCK_ID,
  BRANCH_MODAL_CALLBACK_ID,
  CLEAR_REPO_BRANCH_ACTION_ID,
  REPO_BRANCH_SELECTOR_ACTION_ID,
  getBranchSubmissionValidationError,
  getSubmittedBranch,
  getUserRepoBranchPreference,
  getUserRepoBranchPreferences,
  isBranchModalCallbackId,
  saveUserRepoBranchPreference,
} from "../branch-preferences";
import { filterReposByQuery, getAvailableRepos } from "../classifier/repos";
import { createLogger } from "../logger";
import type { Env, SlackInteractionPayload } from "../types";
import {
  CLEAR_BRANCH_PREFERENCE_ACTION_ID,
  MAX_REPO_SUGGESTION_OPTIONS,
  OPEN_BRANCH_MODAL_ACTION_ID,
  SELECT_MODEL_ACTION_ID,
  SELECT_REASONING_EFFORT_ACTION_ID,
} from "./constants";
import { decodeRepoBranchModalMetadata } from "./metadata";
import { openBranchPreferenceModal, openRepoBranchPreferenceModal } from "./modals";
import { publishAppHome } from "./publisher";
import type {
  AppHomeInteractionLogContext,
  AppHomeInteractionResponseBody,
  BackgroundTaskScheduler,
  SlackBlockAction,
  SlackSelectOption,
} from "./slack-types";
import { buildRepoBranchSelectOptions } from "./view";
import { getResolvedUserPreferences, updateUserPreferences } from "../user-preferences";

const log = createLogger("app-home");

type AppHomeBlockActionContext = {
  action: SlackBlockAction;
  payload: SlackInteractionPayload;
  env: Env;
  traceId: string | undefined;
  userId: string | undefined;
};

type AppHomeBlockActionHandler = {
  runInline?: boolean;
  handle: (context: AppHomeBlockActionContext) => Promise<void>;
};

type AppHomeBlockActionMatch = {
  action: SlackBlockAction;
  handler: AppHomeBlockActionHandler;
};

export interface AppHomeInteractionRouteResult {
  body: AppHomeInteractionResponseBody;
  logContext: AppHomeInteractionLogContext;
}

const APP_HOME_BLOCK_ACTIONS: Record<string, AppHomeBlockActionHandler> = {
  [SELECT_MODEL_ACTION_ID]: { handle: handleSelectModel },
  [SELECT_REASONING_EFFORT_ACTION_ID]: { handle: handleSelectReasoningEffort },
  [OPEN_BRANCH_MODAL_ACTION_ID]: { runInline: true, handle: handleOpenBranchModal },
  [REPO_BRANCH_SELECTOR_ACTION_ID]: { runInline: true, handle: handleRepoBranchSelection },
  [CLEAR_REPO_BRANCH_ACTION_ID]: { handle: handleClearRepoBranch },
  [CLEAR_BRANCH_PREFERENCE_ACTION_ID]: { handle: handleClearBranchPreference },
};

export async function getRepoBranchSuggestionOptions(
  env: Env,
  userId: string,
  query: string | undefined,
  traceId?: string
): Promise<SlackSelectOption[]> {
  const [repos, repoBranchPreferences] = await Promise.all([
    getAvailableRepos(env, traceId),
    getUserRepoBranchPreferences(env, userId),
  ]);
  const filteredRepos = filterReposByQuery(repos, query);

  return buildRepoBranchSelectOptions(filteredRepos, repoBranchPreferences).slice(
    0,
    MAX_REPO_SUGGESTION_OPTIONS
  );
}

function getAppHomeBlockAction(payload: SlackInteractionPayload): AppHomeBlockActionMatch | null {
  if (payload.type !== "block_actions") {
    return null;
  }

  const action = payload.actions?.[0];
  if (!action) {
    return null;
  }

  const handler = APP_HOME_BLOCK_ACTIONS[action.action_id];
  return handler ? { action, handler } : null;
}

function isAppHomeViewSubmission(payload: SlackInteractionPayload): boolean {
  return payload.type === "view_submission" && isBranchModalCallbackId(payload.view?.callback_id);
}

export async function handleAppHomeInteractionRoute(
  payload: SlackInteractionPayload,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<AppHomeInteractionRouteResult | null> {
  if (payload.type === "block_suggestion") {
    if (payload.action_id !== REPO_BRANCH_SELECTOR_ACTION_ID) {
      return null;
    }

    let options: SlackSelectOption[] = [];
    try {
      options = payload.user?.id
        ? await getRepoBranchSuggestionOptions(env, payload.user.id, payload.value, traceId)
        : [];
    } catch (e) {
      // A repo-lookup failure must not surface as a 500 on /interactions.
      log.error("slack.repo_branch_suggestion_options", {
        trace_id: traceId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }

    return {
      body: { options },
      logContext: {
        interaction_type: payload.type,
        action_id: payload.action_id,
        option_count: options.length,
      },
    };
  }

  const branchValidationError = getBranchSubmissionValidationError(payload);
  if (branchValidationError) {
    const submittedBranch = getSubmittedBranch(payload);
    log.warn("slack.branch_pref.invalid", {
      trace_id: traceId,
      user_id: payload.user?.id,
      branch: submittedBranch ?? "",
    });

    return {
      body: {
        response_action: "errors",
        errors: {
          [BRANCH_INPUT_BLOCK_ID]: branchValidationError,
        },
      },
      logContext: {
        interaction_type: payload.type,
        callback_id: payload.view?.callback_id,
        outcome: "validation_error",
      },
    };
  }

  const blockAction = getAppHomeBlockAction(payload);
  if (!isAppHomeViewSubmission(payload) && !blockAction) {
    return null;
  }

  const actionId = blockAction?.action.action_id ?? payload.action_id;
  const interactionTask = Promise.resolve().then(() =>
    handleAppHomeInteraction(payload, env, traceId)
  );

  if (blockAction?.handler.runInline) {
    await interactionTask;
  } else {
    scheduleBackground(interactionTask);
  }

  return {
    body: isAppHomeViewSubmission(payload) ? { response_action: "clear" } : { ok: true },
    logContext: {
      interaction_type: payload.type,
      action_id: actionId,
      callback_id: payload.view?.callback_id,
    },
  };
}

async function handleAppHomeInteraction(
  payload: SlackInteractionPayload,
  env: Env,
  traceId: string | undefined
): Promise<void> {
  const userId = payload.user?.id;

  if (payload.type === "view_submission") {
    await handleBranchSubmission(payload, env, traceId, userId);
    return;
  }

  const blockAction = getAppHomeBlockAction(payload);
  if (!blockAction) {
    return;
  }

  await blockAction.handler.handle({
    action: blockAction.action,
    payload,
    env,
    traceId,
    userId,
  });
}

async function handleBranchSubmission(
  payload: SlackInteractionPayload,
  env: Env,
  traceId: string | undefined,
  userId: string | undefined
): Promise<void> {
  if (!isBranchModalCallbackId(payload.view?.callback_id) || !userId) {
    return;
  }

  const branch = getSubmittedBranch(payload);

  if (payload.view?.callback_id === BRANCH_MODAL_CALLBACK_ID) {
    await updateUserPreferences(env, userId, { branch });
    await publishAppHome(env, userId);
    return;
  }

  const repoId = getRepoIdFromSubmission(payload, traceId, userId);
  if (!repoId) {
    log.warn("slack.repo_branch_pref.missing_repo", { trace_id: traceId, user_id: userId });
    await publishAppHome(env, userId);
    return;
  }

  const availableRepos = await getAvailableRepos(env, traceId);
  if (!availableRepos.some((repo) => repo.id === repoId)) {
    log.warn("slack.repo_branch_pref.unknown_repo", {
      trace_id: traceId,
      user_id: userId,
      repo_id: repoId,
    });
    await publishAppHome(env, userId);
    return;
  }

  await saveUserRepoBranchPreference(env, userId, repoId, branch);
  await publishAppHome(env, userId);
}

function getRepoIdFromSubmission(
  payload: SlackInteractionPayload,
  traceId: string | undefined,
  userId: string
): string | undefined {
  const decoded = decodeRepoBranchModalMetadata(payload.view?.private_metadata);
  if (!decoded.ok) {
    if (decoded.reason !== "missing") {
      log.warn("slack.repo_branch_pref.bad_metadata", {
        trace_id: traceId,
        user_id: userId,
        reason: decoded.reason,
        ...(decoded.errorMessage ? { error: decoded.errorMessage } : {}),
      });
    }
    return undefined;
  }

  if (decoded.metadata.userId !== userId) {
    log.warn("slack.repo_branch_pref.user_mismatch", {
      trace_id: traceId,
      user_id: userId,
      metadata_user_id: decoded.metadata.userId,
    });
  }

  return decoded.metadata.repoId;
}

async function handleSelectModel({
  action,
  env,
  userId,
}: AppHomeBlockActionContext): Promise<void> {
  const selectedModel = action.selected_option?.value;
  if (!selectedModel || !userId || !isValidModel(selectedModel)) {
    return;
  }

  await updateUserPreferences(env, userId, { model: selectedModel });
  await publishAppHome(env, userId);
}

async function handleSelectReasoningEffort({
  action,
  env,
  userId,
}: AppHomeBlockActionContext): Promise<void> {
  const selectedEffort = action.selected_option?.value;
  if (!selectedEffort || !userId) {
    return;
  }

  const updated = await updateUserPreferences(env, userId, (current) => {
    if (!isValidReasoningEffort(current.model, selectedEffort)) {
      return null;
    }

    return { reasoningEffort: selectedEffort };
  });
  if (!updated) {
    return;
  }

  await publishAppHome(env, userId);
}

async function handleOpenBranchModal({
  payload,
  env,
  userId,
}: AppHomeBlockActionContext): Promise<void> {
  if (!userId || !payload.trigger_id) {
    return;
  }

  const current = await getResolvedUserPreferences(env, userId);
  await openBranchPreferenceModal(env, userId, payload.trigger_id, current.branch);
}

async function handleRepoBranchSelection({
  action,
  payload,
  env,
  traceId,
  userId,
}: AppHomeBlockActionContext): Promise<void> {
  if (!userId || !payload.trigger_id) {
    return;
  }

  const repoId = action.selected_option?.value;
  if (!repoId) {
    return;
  }

  const repos = await getAvailableRepos(env, traceId);
  const repo = repos.find((item) => item.id === repoId);
  if (!repo) {
    log.warn("slack.repo_branch_pref.repo_not_found", {
      trace_id: traceId,
      user_id: userId,
      repo_id: repoId,
    });
    await publishAppHome(env, userId);
    return;
  }

  const currentRepoBranch = await getUserRepoBranchPreference(env, userId, repo.id);
  await openRepoBranchPreferenceModal(env, userId, payload.trigger_id, repo, currentRepoBranch);
}

async function handleClearRepoBranch({
  action,
  env,
  userId,
}: AppHomeBlockActionContext): Promise<void> {
  if (!userId) {
    return;
  }

  const repoId = action.value ?? action.selected_option?.value;
  if (!repoId) {
    return;
  }

  await saveUserRepoBranchPreference(env, userId, repoId, undefined);
  await publishAppHome(env, userId);
}

async function handleClearBranchPreference({
  env,
  userId,
}: AppHomeBlockActionContext): Promise<void> {
  if (!userId) {
    return;
  }

  await updateUserPreferences(env, userId, { branch: undefined });
  await publishAppHome(env, userId);
}
