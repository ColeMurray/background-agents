"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  applyModelPreferenceChanges,
  isValidModel,
  normalizeModelId,
  normalizeValidModels,
  type ModelCategory,
  type ModelPreferenceChange,
  type ValidModel,
} from "@open-inspect/shared/models";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";
const INITIAL_MODEL_PREFERENCES_REVISION = 0;

const canonicalModelSchema = z.custom<ValidModel>(
  (value) => typeof value === "string" && isValidModel(value) && normalizeModelId(value) === value
);
const modelPreferencesSchema = z.object({
  enabledModels: z.array(canonicalModelSchema).nonempty(),
  revision: z.number().int().nonnegative(),
});
type ModelPreferencesResponse = z.infer<typeof modelPreferencesSchema>;

function responseError(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  return typeof body.error === "string" ? body.error : null;
}

export function useEnabledModels(): {
  enabledModels: string[];
  enabledModelOptions: ModelCategory[];
  loading: boolean;
  error: unknown;
  saving: boolean;
  updateModels: (changes: readonly ModelPreferenceChange[]) => Promise<void>;
} {
  const { data, error, isLoading, mutate } =
    useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);
  const [activeWrites, setActiveWrites] = useState(0);

  const enabledModels = useMemo<ValidModel[]>(() => {
    if (isLoading) return [];
    const normalized = normalizeValidModels(data?.enabledModels ?? []);
    return normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
  }, [data, isLoading]);

  const enabledModelOptions = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return MODEL_OPTIONS.map((group) => ({
      ...group,
      models: group.models.filter((model) => enabledSet.has(model.id)),
    })).filter((group) => group.models.length > 0);
  }, [enabledModels]);

  const updateModels = useCallback(
    async (changes: readonly ModelPreferenceChange[]): Promise<void> => {
      if (isLoading || error) {
        throw new Error("Model preferences must load before saving");
      }

      const next = applyModelPreferenceChanges(enabledModels, changes);
      if (next.length === 0) throw new Error("At least one model must be enabled");

      setActiveWrites((current) => current + 1);
      try {
        await mutate(
          async () => {
            const res = await browserApiFetch(MODEL_PREFERENCES_KEY, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ changes }),
            });
            const body: unknown = await res.json().catch(() => null);
            if (!res.ok) throw new Error(responseError(body) ?? "Failed to save preferences");
            const parsed = modelPreferencesSchema.safeParse(body);
            if (!parsed.success) throw new Error("Invalid model preferences response");
            return parsed.data;
          },
          {
            optimisticData: {
              enabledModels: next,
              revision: data?.revision ?? INITIAL_MODEL_PREFERENCES_REVISION,
            },
            rollbackOnError: true,
            populateCache: (result, current) =>
              !current || result.revision >= current.revision ? result : current,
            revalidate: false,
          }
        );
      } catch (requestError) {
        await mutate().catch(() => undefined);
        throw requestError;
      } finally {
        setActiveWrites((current) => current - 1);
      }
    },
    [data?.revision, enabledModels, error, isLoading, mutate]
  );

  return {
    enabledModels,
    enabledModelOptions,
    loading: isLoading,
    error,
    saving: activeWrites > 0,
    updateModels,
  };
}
