import {
  DEFAULT_MODEL,
  createKvCacheStore,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
} from "@open-inspect/shared";
import type { Env, UserPreferences } from "./types";
import {
  getValidatedBranch,
  isValidBranchName,
  normalizeBranchPreference,
} from "./branch-preferences";
import { createLogger } from "./logger";

const log = createLogger("user-preferences");

export interface ResolvedUserPreferences {
  model: string;
  reasoningEffort: string | undefined;
  branch: string | undefined;
}

function getUserPreferencesKey(userId: string): string {
  return `user_prefs:${userId}`;
}

function isValidUserPreferences(data: unknown): data is UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  const obj = data as Record<string, unknown>;
  const branchValid = obj.branch === undefined || typeof obj.branch === "string";

  return (
    typeof obj.userId === "string" &&
    typeof obj.model === "string" &&
    typeof obj.updatedAt === "number" &&
    branchValid
  );
}

export function resolveUserPreferences(
  prefs: UserPreferences | null | undefined,
  defaultModel: string | undefined
): ResolvedUserPreferences {
  const model = getValidModelOrDefault(prefs?.model ?? defaultModel ?? DEFAULT_MODEL);
  const reasoningEffort =
    prefs?.reasoningEffort && isValidReasoningEffort(model, prefs.reasoningEffort)
      ? prefs.reasoningEffort
      : getDefaultReasoningEffort(model);

  return {
    model,
    reasoningEffort,
    branch: getValidatedBranch(prefs?.branch),
  };
}

export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  try {
    const key = getUserPreferencesKey(userId);
    const data = await createKvCacheStore(env.SLACK_KV).get(key, "json");
    return isValidUserPreferences(data) ? data : null;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "user_prefs",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

export async function getResolvedUserPreferences(
  env: Env,
  userId: string
): Promise<ResolvedUserPreferences> {
  const prefs = await getUserPreferences(env, userId);
  return resolveUserPreferences(prefs, env.DEFAULT_MODEL);
}

export async function saveUserPreferences(
  env: Env,
  userId: string,
  preferences: ResolvedUserPreferences
): Promise<boolean> {
  try {
    const normalizedBranch = normalizeBranchPreference(preferences.branch);
    if (normalizedBranch && !isValidBranchName(normalizedBranch)) {
      log.warn("slack.branch_pref.invalid", {
        user_id: userId,
        branch: normalizedBranch,
      });
      return false;
    }

    const prefs: UserPreferences = {
      userId,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
      branch: normalizedBranch,
      updatedAt: Date.now(),
    };

    await createKvCacheStore(env.SLACK_KV).put(
      getUserPreferencesKey(userId),
      JSON.stringify(prefs)
    );
    return true;
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "user_prefs",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}
