import { useState, useEffect, useMemo } from "react";
import { MODEL_OPTIONS, DEFAULT_ENABLED_MODELS, type ModelCategory } from "@open-inspect/shared";

let cachedEnabledModels: string[] | null = null;
let fetchPromise: Promise<string[]> | null = null;

function fetchEnabledModels(): Promise<string[]> {
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch("/api/model-preferences")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const models: string[] = data?.enabledModels ?? DEFAULT_ENABLED_MODELS;
      cachedEnabledModels = models;
      return models;
    })
    .catch(() => {
      return DEFAULT_ENABLED_MODELS as string[];
    })
    .finally(() => {
      fetchPromise = null;
    });

  return fetchPromise;
}

export function useEnabledModels() {
  const [enabledModels, setEnabledModels] = useState<string[]>(
    cachedEnabledModels ?? (DEFAULT_ENABLED_MODELS as string[])
  );
  const [loading, setLoading] = useState(!cachedEnabledModels);

  useEffect(() => {
    fetchEnabledModels().then((models) => {
      setEnabledModels(models);
      setLoading(false);
    });
  }, []);

  const enabledModelOptions: ModelCategory[] = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return MODEL_OPTIONS.map((group) => ({
      ...group,
      models: group.models.filter((m) => enabledSet.has(m.id)),
    })).filter((group) => group.models.length > 0);
  }, [enabledModels]);

  return { enabledModels, enabledModelOptions, loading };
}

/**
 * Invalidate the cached enabled models so the next hook mount re-fetches.
 * Call after saving model preferences in the settings page.
 */
export function invalidateEnabledModelsCache() {
  cachedEnabledModels = null;
}
