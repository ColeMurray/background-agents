import type { Env, SlackInteractionPayload } from "./types";
import { createLogger } from "./logger";

const log = createLogger("branch-preferences");

export const BRANCH_MODAL_CALLBACK_ID = "branch_preference_modal";
export const REPO_BRANCH_MODAL_CALLBACK_ID = "repo_branch_preference_modal";
export const BRANCH_INPUT_BLOCK_ID = "branch_input";
export const BRANCH_INPUT_ACTION_ID = "branch_value";
export const REPO_BRANCH_SELECTOR_ACTION_ID = "select_repo_branch_override";
export const CLEAR_REPO_BRANCH_ACTION_ID = "clear_repo_branch_override";

export const INVALID_BRANCH_ERROR = "Enter a valid Git branch name.";

const BRANCH_NAME_SPECIAL_CHARS_REGEX = /[\s~^:?*[\\]/;

function getUserRepoBranchKey(userId: string, repoId: string): string {
  return `user_repo_branch:${userId}:${repoId}`;
}

function getUserRepoBranchPrefix(userId: string): string {
  return `user_repo_branch:${userId}:`;
}

export async function getUserRepoBranchPreference(
  env: Env,
  userId: string,
  repoId: string
): Promise<string | undefined> {
  try {
    const key = getUserRepoBranchKey(userId, repoId);
    const value = normalizeBranchPreference((await env.SLACK_KV.get(key)) ?? undefined);
    if (!value) {
      return undefined;
    }

    if (!isValidBranchName(value)) {
      log.warn("kv.get", {
        key_prefix: "user_repo_branch",
        user_id: userId,
        repo_id: repoId,
        outcome: "invalid_branch_value",
      });
      return undefined;
    }

    return value;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "user_repo_branch",
      user_id: userId,
      repo_id: repoId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return undefined;
  }
}

export async function getUserRepoBranchPreferences(
  env: Env,
  userId: string
): Promise<Map<string, string>> {
  const preferences = new Map<string, string>();
  const prefix = getUserRepoBranchPrefix(userId);

  try {
    const listed = await env.SLACK_KV.list({ prefix });

    for (const key of listed.keys) {
      const repoId = key.name.slice(prefix.length);
      if (!repoId) {
        continue;
      }

      const branch = normalizeBranchPreference((await env.SLACK_KV.get(key.name)) ?? undefined);
      if (!branch || !isValidBranchName(branch)) {
        continue;
      }

      preferences.set(repoId, branch);
    }
  } catch (e) {
    log.error("kv.list", {
      key_prefix: "user_repo_branch",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }

  return preferences;
}

export async function saveUserRepoBranchPreference(
  env: Env,
  userId: string,
  repoId: string,
  branch?: string
): Promise<boolean> {
  try {
    const key = getUserRepoBranchKey(userId, repoId);
    const normalizedBranch = normalizeBranchPreference(branch);

    if (!normalizedBranch) {
      await env.SLACK_KV.delete(key);
      return true;
    }

    if (!isValidBranchName(normalizedBranch)) {
      log.warn("slack.repo_branch_pref.invalid", {
        user_id: userId,
        repo_id: repoId,
        branch: normalizedBranch,
      });
      return false;
    }

    await env.SLACK_KV.put(key, normalizedBranch);
    return true;
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "user_repo_branch",
      user_id: userId,
      repo_id: repoId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}

export function normalizeBranchPreference(branch: string | undefined): string | undefined {
  const normalized = branch?.trim();
  return normalized ? normalized : undefined;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function getBranchValidationError(branch: string): string | undefined {
  if (branch.startsWith("-")) {
    return INVALID_BRANCH_ERROR;
  }

  if (branch === "@") {
    return INVALID_BRANCH_ERROR;
  }

  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    hasControlCharacters(branch) ||
    BRANCH_NAME_SPECIAL_CHARS_REGEX.test(branch)
  ) {
    return INVALID_BRANCH_ERROR;
  }

  const segments = branch.split("/");
  if (
    segments.some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    return INVALID_BRANCH_ERROR;
  }

  return undefined;
}

export function isValidBranchName(branch: string): boolean {
  return getBranchValidationError(branch) === undefined;
}

export function isBranchModalCallbackId(callbackId: string | undefined): boolean {
  return callbackId === BRANCH_MODAL_CALLBACK_ID || callbackId === REPO_BRANCH_MODAL_CALLBACK_ID;
}

export function getSubmittedBranch(payload: SlackInteractionPayload): string | undefined {
  const branchRaw =
    payload.view?.state?.values?.[BRANCH_INPUT_BLOCK_ID]?.[BRANCH_INPUT_ACTION_ID]?.value;
  return normalizeBranchPreference(branchRaw);
}

export function getBranchSubmissionValidationError(
  payload: SlackInteractionPayload
): string | undefined {
  if (payload.type !== "view_submission" || !isBranchModalCallbackId(payload.view?.callback_id)) {
    return undefined;
  }

  const branch = getSubmittedBranch(payload);
  if (!branch) {
    return undefined;
  }

  return getBranchValidationError(branch);
}
