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

type UserPreferencesPatch = Partial<ResolvedUserPreferences>;
type UserPreferencesUpdater = (
  current: ResolvedUserPreferences
) => UserPreferencesPatch | null | undefined;

function getUserPreferencesKey(userId: string): string {
  return `user_prefs:${userId}`;
}

function hasPreferenceField<K extends keyof UserPreferencesPatch>(
  patch: UserPreferencesPatch,
  field: K
): patch is UserPreferencesPatch & Required<Pick<UserPreferencesPatch, K>> {
  return Object.prototype.hasOwnProperty.call(patch, field);
}

function normalizeResolvedPreferences(
  preferences: ResolvedUserPreferences,
  defaultModel: string | undefined,
  options: { validateBranch?: boolean } = {}
): ResolvedUserPreferences {
  const model = getValidModelOrDefault(preferences.model ?? defaultModel ?? DEFAULT_MODEL);
  const reasoningEffort =
    preferences.reasoningEffort && isValidReasoningEffort(model, preferences.reasoningEffort)
      ? preferences.reasoningEffort
      : getDefaultReasoningEffort(model);
  const branch =
    options.validateBranch === false
      ? normalizeBranchPreference(preferences.branch)
      : getValidatedBranch(preferences.branch);

  return {
    model,
    reasoningEffort,
    branch,
  };
}

function mergeUserPreferencesPatch(
  current: ResolvedUserPreferences,
  patch: UserPreferencesPatch,
  defaultModel: string | undefined
): ResolvedUserPreferences {
  const model = hasPreferenceField(patch, "model") ? (patch.model ?? current.model) : current.model;
  const reasoningEffort = hasPreferenceField(patch, "reasoningEffort")
    ? patch.reasoningEffort
    : hasPreferenceField(patch, "model")
      ? undefined
      : current.reasoningEffort;
  const branch = hasPreferenceField(patch, "branch") ? patch.branch : current.branch;

  return normalizeResolvedPreferences({ model, reasoningEffort, branch }, defaultModel, {
    validateBranch: false,
  });
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
  return normalizeResolvedPreferences(
    {
      model: prefs?.model ?? defaultModel ?? DEFAULT_MODEL,
      reasoningEffort: prefs?.reasoningEffort,
      branch: prefs?.branch,
    },
    defaultModel
  );
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
    const normalizedPreferences = normalizeResolvedPreferences(preferences, env.DEFAULT_MODEL, {
      validateBranch: false,
    });
    const normalizedBranch = normalizeBranchPreference(normalizedPreferences.branch);
    if (normalizedBranch && !isValidBranchName(normalizedBranch)) {
      log.warn("slack.branch_pref.invalid", {
        user_id: userId,
        branch: normalizedBranch,
      });
      return false;
    }

    const prefs: UserPreferences = {
      userId,
      model: normalizedPreferences.model,
      reasoningEffort: normalizedPreferences.reasoningEffort,
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

export async function updateUserPreferences(
  env: Env,
  userId: string,
  patchOrUpdater: UserPreferencesPatch | UserPreferencesUpdater
): Promise<boolean> {
  const current = await getResolvedUserPreferences(env, userId);
  const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(current) : patchOrUpdater;
  if (!patch) {
    return false;
  }

  return saveUserPreferences(
    env,
    userId,
    mergeUserPreferencesPatch(current, patch, env.DEFAULT_MODEL)
  );
}
