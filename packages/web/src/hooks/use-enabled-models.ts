import { useMemo } from "react";
import useSWR from "swr";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PLAN_MODEL,
  type ModelCategory,
} from "@open-inspect/shared";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";

interface ModelPreferencesResponse {
  enabledModels: string[];
  defaultModel?: string;
  defaultPlanModel?: string;
}

export function useEnabledModels() {
  const { data, isLoading } = useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);

  const enabledModels = useMemo(
    () => data?.enabledModels ?? (isLoading ? [] : (DEFAULT_ENABLED_MODELS as string[])),
    [data?.enabledModels, isLoading]
  );

  const enabledModelOptions: ModelCategory[] = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return MODEL_OPTIONS.map((group) => ({
      ...group,
      models: group.models.filter((m) => enabledSet.has(m.id)),
    })).filter((group) => group.models.length > 0);
  }, [enabledModels]);

  // Deployment-wide defaults (env vars on control-plane, mirrored from the bot
  // workers). Fall back to the shared constants until the API responds.
  const defaultModel = data?.defaultModel ?? DEFAULT_MODEL;
  const defaultPlanModel = data?.defaultPlanModel ?? DEFAULT_PLAN_MODEL;

  return {
    enabledModels,
    enabledModelOptions,
    defaultModel,
    defaultPlanModel,
    loading: isLoading,
  };
}
