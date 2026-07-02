import {
  DEFAULT_MODEL,
  createKvCacheStore,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
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
  preferences: {
    model: string | undefined | null;
    reasoningEffort?: string;
    branch?: string;
  },
  defaultModel: string | undefined,
  options: { validateBranch?: boolean; enabledModels?: string[] } = {}
): ResolvedUserPreferences {
  const model = resolveEnabledModel(preferences.model, defaultModel, options.enabledModels);
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

function getNormalizedValidModel(model: string | undefined | null): string | undefined {
  if (model && isValidModel(model)) {
    return normalizeModelId(model);
  }

  return undefined;
}

function resolveEnabledModel(
  model: string | undefined | null,
  defaultModel: string | undefined,
  enabledModels: string[] | undefined
): string {
  const fallback = getValidModelOrDefault(defaultModel ?? DEFAULT_MODEL);
  const desired = getNormalizedValidModel(model) ?? fallback;
  if (!enabledModels || enabledModels.length === 0) {
    return desired;
  }

  const enabled = new Set(enabledModels);
  if (enabled.has(desired)) return desired;
  if (enabled.has(fallback)) return fallback;
  return enabledModels[0] ?? fallback;
}

function mergeUserPreferencesPatch(
  userId: string,
  current: UserPreferences | null,
  patch: UserPreferencesPatch,
  options: UserPreferenceResolutionOptions
): UserPreferences | null {
  const model = hasPreferenceField(patch, "model")
    ? getNormalizedValidModel(patch.model)
    : getNormalizedValidModel(current?.model);
  let reasoningEffort = hasPreferenceField(patch, "reasoningEffort")
    ? patch.reasoningEffort
    : hasPreferenceField(patch, "model")
      ? undefined
      : current?.reasoningEffort;
  const branch = hasPreferenceField(patch, "branch")
    ? normalizeBranchPreference(patch.branch)
    : normalizeBranchPreference(current?.branch);

  if (branch && !isValidBranchName(branch)) {
    log.warn("slack.branch_pref.invalid", {
      user_id: userId,
      branch,
    });
    return null;
  }

  const resolvedModel = resolveEnabledModel(
    model,
    options.defaultModel ?? DEFAULT_MODEL,
    options.enabledModels
  );
  if (reasoningEffort && !isValidReasoningEffort(resolvedModel, reasoningEffort)) {
    reasoningEffort = undefined;
  }

  const prefs: UserPreferences = { userId, updatedAt: Date.now() };
  if (model) prefs.model = model;
  if (reasoningEffort) prefs.reasoningEffort = reasoningEffort;
  if (branch) prefs.branch = branch;
  return prefs;
}

function isValidUserPreferences(data: unknown): data is UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  const obj = data as Record<string, unknown>;
  const modelValid = obj.model === undefined || typeof obj.model === "string";
  const reasoningEffortValid =
    obj.reasoningEffort === undefined || typeof obj.reasoningEffort === "string";
  const branchValid = obj.branch === undefined || typeof obj.branch === "string";

  return (
    typeof obj.userId === "string" &&
    modelValid &&
    reasoningEffortValid &&
    typeof obj.updatedAt === "number" &&
    branchValid
  );
}

export function resolveUserPreferences(
  prefs: UserPreferences | null | undefined,
  defaultModel: string | undefined,
  enabledModels?: string[]
): ResolvedUserPreferences {
  return normalizeResolvedPreferences(
    {
      model: prefs?.model ?? defaultModel ?? DEFAULT_MODEL,
      reasoningEffort: prefs?.reasoningEffort,
      branch: prefs?.branch,
    },
    defaultModel,
    { enabledModels }
  );
}

export interface UserPreferenceResolutionOptions {
  defaultModel?: string;
  enabledModels?: string[];
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
  userId: string,
  options: UserPreferenceResolutionOptions = {}
): Promise<ResolvedUserPreferences> {
  const prefs = await getUserPreferences(env, userId);
  return resolveUserPreferences(
    prefs,
    options.defaultModel ?? env.DEFAULT_MODEL,
    options.enabledModels
  );
}

export async function saveUserPreferences(
  env: Env,
  userId: string,
  preferences: UserPreferences,
  options: UserPreferenceResolutionOptions = {}
): Promise<boolean> {
  try {
    const model = getNormalizedValidModel(preferences.model);
    let reasoningEffort = preferences.reasoningEffort;
    const branch = normalizeBranchPreference(preferences.branch);
    if (branch && !isValidBranchName(branch)) {
      log.warn("slack.branch_pref.invalid", {
        user_id: userId,
        branch,
      });
      return false;
    }
    const resolvedModel = resolveEnabledModel(
      model,
      options.defaultModel ?? env.DEFAULT_MODEL,
      options.enabledModels
    );
    if (reasoningEffort && !isValidReasoningEffort(resolvedModel, reasoningEffort)) {
      reasoningEffort = undefined;
    }

    const prefs: UserPreferences = { userId, updatedAt: Date.now() };
    if (model) prefs.model = model;
    if (reasoningEffort) prefs.reasoningEffort = reasoningEffort;
    if (branch) prefs.branch = branch;

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
  patchOrUpdater: UserPreferencesPatch | UserPreferencesUpdater,
  options: UserPreferenceResolutionOptions = {}
): Promise<boolean> {
  const current = await getUserPreferences(env, userId);
  const resolvedCurrent = resolveUserPreferences(
    current,
    options.defaultModel ?? env.DEFAULT_MODEL,
    options.enabledModels
  );
  const patch =
    typeof patchOrUpdater === "function" ? patchOrUpdater(resolvedCurrent) : patchOrUpdater;
  if (!patch) {
    return false;
  }

  const merged = mergeUserPreferencesPatch(userId, current, patch, {
    defaultModel: options.defaultModel ?? env.DEFAULT_MODEL,
    enabledModels: options.enabledModels,
  });
  return merged ? saveUserPreferences(env, userId, merged, options) : false;
}
