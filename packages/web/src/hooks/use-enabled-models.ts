import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  normalizeValidModels,
  type ModelCategory,
} from "@open-inspect/shared/models";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";
const MODEL_PREFERENCES_SAVING_KEY = "model-preferences:saving";

const modelPreferencesSchema = z.object({ enabledModels: z.array(z.string()).nonempty() });
type ModelPreferencesResponse = z.infer<typeof modelPreferencesSchema>;

export function useEnabledModels() {
  const { cache } = useSWRConfig();
  const { data, error, isLoading, mutate } =
    useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);
  // Share the write lock across consumers and settings-panel remounts.
  const { data: saving = false, mutate: setSaving } = useSWR<boolean>(
    MODEL_PREFERENCES_SAVING_KEY,
    null
  );

  const saveEnabledModels = async (next: string[]) => {
    if (cache.get(MODEL_PREFERENCES_SAVING_KEY)?.data) return;
    if (isLoading || error) throw new Error("Model preferences must load before saving");
    await setSaving(true, { revalidate: false });
    try {
      await mutate(
        async () => {
          const res = await browserApiFetch(MODEL_PREFERENCES_KEY, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabledModels: next }),
          });
          const response = await res.json();
          if (!res.ok) throw new Error(response?.error || "Failed to save preferences");
          const parsed = modelPreferencesSchema.safeParse(response);
          if (!parsed.success) throw new Error("Invalid model preferences response");
          return parsed.data;
        },
        {
          optimisticData: { enabledModels: next },
          rollbackOnError: true,
          revalidate: false,
        }
      );
    } finally {
      await setSaving(false, { revalidate: false });
    }
  };

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

  return {
    enabledModels,
    enabledModelOptions,
    loading: isLoading,
    error,
    saving,
    saveEnabledModels,
  };
}
