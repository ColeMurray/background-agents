import { useMemo } from "react";
import useSWR from "swr";
import { MODEL_OPTIONS, DEFAULT_ENABLED_MODELS, type ModelCategory } from "@open-inspect/shared";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";

interface ModelPreferencesResponse {
  enabledModels: string[];
}

export function useEnabledModels() {
  const { data, isLoading } = useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);

  const enabledModels = data?.enabledModels ?? (DEFAULT_ENABLED_MODELS as string[]);

  const enabledModelOptions: ModelCategory[] = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return MODEL_OPTIONS.map((group) => ({
      ...group,
      models: group.models.filter((m) => enabledSet.has(m.id)),
    })).filter((group) => group.models.length > 0);
  }, [enabledModels]);

  return { enabledModels, enabledModelOptions, loading: isLoading };
}
