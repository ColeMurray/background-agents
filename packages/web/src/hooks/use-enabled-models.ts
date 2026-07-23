import { useMemo } from "react";
import useSWR from "swr";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  normalizeValidModels,
  type ModelCategory,
} from "@open-inspect/shared";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";

interface ModelPreferencesResponse {
  enabledModels: string[];
}

export function useEnabledModels() {
  const { data, isLoading } = useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);

  const enabledModels = useMemo<string[]>(() => {
    if (isLoading) return [];
    const normalized = normalizeValidModels(
      Array.isArray(data?.enabledModels) ? data.enabledModels : []
    );
    return normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
  }, [data?.enabledModels, isLoading]);

  const enabledModelOptions: ModelCategory[] = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return MODEL_OPTIONS.map((group) => ({
      ...group,
      models: group.models.filter((m) => enabledSet.has(m.id)),
    })).filter((group) => group.models.length > 0);
  }, [enabledModels]);

  return { enabledModels, enabledModelOptions, loading: isLoading };
}
